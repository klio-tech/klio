// Subcommand dispatcher and handlers for `klio project ...`.
//
// Split out of main.go because anticipated siblings (`klio project list`,
// `klio project info`) will share the same auth + cloud-client bootstrap.
// Keeping the dispatch in one file means main.go's top-level switch stays
// a one-liner per command family and new subcommands land here without
// re-touching main.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/cloud"
	"github.com/klio-tech/bridge/internal/config"
	"github.com/klio-tech/bridge/internal/project"
)

// runProject dispatches `klio project <subcommand> [args...]`.
//
// Exits the process directly (os.Exit) on failure rather than returning
// an error so the dispatch shape matches the other top-level commands
// in main.go (runInit, runConfigure, runReembed, etc.). All inner
// handlers return errors which this layer formats + exits on.
func runProject(args []string) {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr,
			"usage: klio project promote <remote-or-uuid> "+
				"(--space=<uuid> | --embedding=<model>)")
		os.Exit(2)
	}
	switch args[0] {
	case "promote":
		if err := runProjectPromote(args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, "klio project promote:", err)
			// Flag parse errors and the XOR-validation error are
			// "the caller invoked me wrong", which conventionally
			// exits 2. Everything else (network, engine, auth) is
			// a runtime failure → exit 1.
			if isUsageError(err) {
				os.Exit(2)
			}
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown project subcommand:", args[0])
		fmt.Fprintln(os.Stderr,
			"usage: klio project promote <remote-or-uuid> "+
				"(--space=<uuid> | --embedding=<model>)")
		os.Exit(2)
	}
}

// usageError tags a returned error as caller-misuse rather than a
// runtime failure. The dispatcher maps it to exit code 2 (the POSIX
// convention for "bad arguments"); everything else is exit 1.
//
// Using a typed sentinel rather than a plain string match avoids the
// classic "error message changed and the dispatcher started returning
// the wrong code" trap.
type usageError struct{ err error }

func (u usageError) Error() string { return u.err.Error() }
func (u usageError) Unwrap() error { return u.err }

func isUsageError(err error) bool {
	var u usageError
	return errors.As(err, &u)
}

// runProjectPromote handles `klio project promote <remote-or-uuid>
// (--space=<uuid> | --embedding=<model>)`.
//
// Steps:
//  1. Parse flags. Require exactly one of --space / --embedding.
//  2. Resolve the positional arg: if it's already a UUID, use it.
//     Otherwise treat it as a git remote URL and call EnsureProject
//     to get the project_id.
//  3. Refresh credentials (mirrors the runReembed pattern — every
//     authed CLI command does a Refresh round-trip up front so the
//     access token is fresh for the actual mutation).
//  4. Call PromoteProject with the resolved id + the chosen flag.
//  5. Print a confirmation line with the dedicated space id.
func runProjectPromote(args []string) error {
	// Go's stdlib `flag` package terminates flag parsing at the first
	// non-flag token, so `klio project promote <remote> --space=X`
	// would leave --space unparsed. Reorder so all flag-shaped tokens
	// (anything starting with "-") come first; this lets users pass
	// the positional in either position, which is the universal CLI
	// convention. We keep the relative order of flags and of
	// positionals stable so error messages quote the right tokens.
	args = reorderFlagsFirst(args)

	fs := flag.NewFlagSet("promote", flag.ContinueOnError)
	// ContinueOnError instead of ExitOnError so flag parse failures
	// surface as returned errors. The dispatcher maps usage errors
	// to exit code 2; ExitOnError would bypass that mapping and
	// emit flag.Parse's own (uncontrolled) error formatting.
	spaceID := fs.String(
		"space", "",
		"existing space UUID to assign as the dedicated space",
	)
	embedding := fs.String(
		"embedding", "",
		"embedding model id; creates a new dedicated space pinned to it",
	)
	// Silence flag's default usage dump on parse errors. The
	// dispatcher prints its own usage line on exit 2; doubling up
	// would clutter stderr.
	fs.SetOutput(noopWriter{})
	if err := fs.Parse(args); err != nil {
		return usageError{err: err}
	}
	rest := fs.Args()
	if len(rest) != 1 {
		return usageError{err: errors.New(
			"must pass exactly one positional argument " +
				"(<remote-or-uuid>)")}
	}
	// XOR: `(spaceID == "") == (embedding == "")` is true when both
	// are empty OR both are set. Either case is ambiguous.
	if (*spaceID == "") == (*embedding == "") {
		return usageError{err: errors.New(
			"must pass exactly one of --space or --embedding")}
	}
	if *spaceID != "" {
		if _, err := uuid.Parse(*spaceID); err != nil {
			return usageError{err: fmt.Errorf(
				"--space %q is not a valid UUID: %w", *spaceID, err)}
		}
	}

	ident := rest[0]

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	keys := buildKeychain()
	rt, err := keys.Get("refresh_token")
	if err != nil || len(rt) == 0 {
		return errors.New(
			"no Klio credentials found — run `klio init` first")
	}

	ctx := context.Background()
	c := cloud.NewClient(cfg.CloudURL)
	c.SetRefreshToken(string(rt))
	if err := c.Refresh(ctx); err != nil {
		return fmt.Errorf("refresh: %w", err)
	}
	// Persist the rotated refresh token so the daemon picks it up on
	// next boot. Matches the runReembed + runBackfill pattern.
	_ = keys.Set("refresh_token", []byte(c.RefreshToken()))

	projectID, err := resolveProjectIdent(ctx, c, ident)
	if err != nil {
		return err
	}

	resp, err := c.PromoteProject(ctx, projectID, *spaceID, *embedding)
	if err != nil {
		return fmt.Errorf("promote: %w", err)
	}
	fmt.Printf(
		"klio: project %s promoted\n  dedicated space: %s\n",
		resp.ProjectID, resp.DedicatedSpaceID,
	)
	return nil
}

// resolveProjectIdent turns the positional `<remote-or-uuid>` arg into
// a canonical project UUID string suitable for the engine's
// /v1/projects/{id}/promote path parameter.
//
// If the arg parses as a UUID, it's used directly — no EnsureProject
// round-trip, which would be wasteful (and would 404 if the caller
// happened to type a UUID for a project they don't own).
//
// Otherwise the arg is treated as a git remote URL and EnsureProject
// is called to get the (get-or-create) project_id. The display name is
// derived from the remote via project.DisplayNameFromRemote so we
// never send `""` (engine schema gate: min_length=1).
//
// Note: we deliberately do NOT pass repo_root_path here. The CLI may
// be invoked from anywhere (the user's home dir, a CI runner, etc.),
// and the engine dedupes on git_remote first when it's present.
// Sending a stray cwd as repo_root_path could create a spurious
// duplicate project for repos with no remote — but those don't reach
// this code path (they'd fail uuid.Parse + lack a remote to ensure on).
func resolveProjectIdent(
	ctx context.Context, c *cloud.Client, ident string,
) (string, error) {
	if id, err := uuid.Parse(ident); err == nil {
		return id.String(), nil
	}
	display := project.DisplayNameFromRemote(ident)
	id, err := c.EnsureProject(ctx, ident, "", display)
	if err != nil {
		return "", fmt.Errorf("ensure project for %q: %w", ident, err)
	}
	return id.String(), nil
}

// noopWriter discards all writes. Used to silence flag.FlagSet's
// default error/usage output so the dispatcher controls stderr.
type noopWriter struct{}

func (noopWriter) Write(p []byte) (int, error) { return len(p), nil }

// reorderFlagsFirst returns args with all flag tokens moved before
// all positional tokens, preserving the relative order within each
// group.
//
// The standard `flag` package stops parsing at the first non-flag
// token, which means `klio project promote <remote> --space=X` would
// leave --space unparsed and bury the failure as "missing positional".
// Reordering lets us keep the natural CLI ergonomic of flag-anywhere
// while staying on the stdlib `flag` package (rather than pulling in
// spf13/pflag for one subcommand).
//
// Recognised flag shapes:
//   - `-flag` / `--flag`            (boolean flag; one token)
//   - `-flag=value` / `--flag=val`  (one token)
//   - `-flag value` / `--flag val`  (two tokens; must stay paired)
//
// The two-token case is detected by the absence of `=` AND the
// presence of a non-flag-looking next token. This matches what
// `flag.Parse` itself does, so we never mis-pair a flag and a
// downstream positional. The lone `--` terminator is treated as a
// flag (forces remaining args to be positional, mirroring stdlib);
// everything after it stays in its original position.
//
// Out of scope: we don't validate the flag names here — that's
// `fs.Parse`'s job. We're only deciding which tokens are flag-shaped
// for reordering purposes.
func reorderFlagsFirst(args []string) []string {
	flags := make([]string, 0, len(args))
	positional := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		// `--` terminator: everything after it is positional. Append
		// the terminator + remaining args to positional and stop.
		if a == "--" {
			positional = append(positional, args[i:]...)
			break
		}
		if !strings.HasPrefix(a, "-") || a == "-" {
			positional = append(positional, a)
			continue
		}
		// Flag-shaped. Inline form (`--k=v`) is self-contained.
		if strings.Contains(a, "=") {
			flags = append(flags, a)
			continue
		}
		// Bareword flag (`--k`). It MAY take a value as the next
		// token. We can't know without consulting the FlagSet, so
		// we conservatively pull the next token along if it's not
		// itself flag-shaped. If the flag turns out to be boolean,
		// `flag.Parse` will leave the trailing value as args[0] of
		// fs.Args() — which is fine because we already require
		// exactly one positional and would catch the surplus there.
		flags = append(flags, a)
		if i+1 < len(args) {
			next := args[i+1]
			if !strings.HasPrefix(next, "-") || next == "-" {
				flags = append(flags, next)
				i++
			}
		}
	}
	return append(flags, positional...)
}
