package hooks

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"

	"github.com/klio-tech/bridge/internal/project"
)

// Handler is the per-hook entrypoint signature.
//
// resolvedProjectID is the engine project_id the runner resolved for this
// hook's Payload.Cwd before dispatching the handler. It is uuid.Nil when:
//
//  1. Payload.Cwd is empty (some hook events don't carry cwd).
//  2. project.Resolve produced an absent GitRemote AND RepoRootPath
//     (i.e. a non-git directory like ~) — by contract these never go to
//     EnsureProject, so no project_id is available.
//  3. EnsureProject failed (network, 5xx, refresh exhausted). The runner
//     fails open: the handler still runs, the write still goes through,
//     just without a project tag. Losing a tag is acceptable; losing the
//     entry is not.
//
// Handlers MUST pass this value verbatim into the matching Backend method
// (WriteEntry, IngestTranscript, Recall). The Backend's `omitempty`-tagged
// project_id JSON field turns uuid.Nil into an absent wire field, which the
// engine maps to NULL — and recall surfaces NULL entries in every project's
// scope (B2's "always surface NULLs" guarantee).
type Handler func(b Backend, p Payload, resolvedProjectID uuid.UUID) (Response, error)

var registry = map[string]Handler{
	"session-start": SessionStart,
	"user-prompt":   UserPromptSubmit,
	"pre-tool":      PreToolUse,
	"post-tool":     PostToolUse,
	"subagent-stop": SubagentStop,
	"session-stop":  SessionStop,
}

// ensureProjectTimeout caps the EnsureProject roundtrip from a hook fire.
// At 3s the bridge already has a tight budget for the whole hook (the
// daemon's SocketBackend timeout is 3s); EnsureProject must complete well
// inside that. Failing open after the cap means the write proceeds with
// uuid.Nil, which is the safe degradation path.
const ensureProjectTimeout = 2 * time.Second

// Run dispatches the named hook, reading stdin and writing stdout/stderr.
// Returns the process exit code (0 = ok, 2 = soft failure).
//
// cache resolves Payload.Cwd into a project.Key once per process. When
// non-nil and Cwd is non-empty, the runner ALSO calls Backend.EnsureProject
// to obtain an engine project_id, which it threads into the dispatched
// Handler. Passing nil cache disables both — handlers receive uuid.Nil and
// writes go untagged (the legacy pre-0.7 behaviour). The cache is nil in a
// small number of fallback paths in production (when the daemon is offline)
// and across most test code paths.
func Run(
	name string,
	backend Backend,
	cache *project.Cache,
	stdin io.Reader,
	stdout, stderr io.Writer,
) int {
	body, err := io.ReadAll(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "klio hook: read stdin: %v\n", err)
		return 2
	}
	var payload Payload
	if len(body) > 0 {
		if err := json.Unmarshal(body, &payload); err != nil {
			fmt.Fprintf(stderr, "klio hook: parse payload: %v\n", err)
			return 2
		}
	}

	handler, ok := registry[name]
	if !ok {
		fmt.Fprintf(stderr, "klio hook: unknown event %q\n", name)
		return 2
	}

	projectID := resolveProjectID(backend, cache, payload, stderr)

	resp, err := handler(backend, payload, projectID)
	if err != nil {
		// Soft fail: hooks must never block the user's workflow.
		fmt.Fprintln(stderr, "klio hook:", err)
		return 0
	}
	if resp.HookSpecificOutput != nil || resp.Decision != "" {
		out, _ := json.Marshal(resp)
		_, _ = stdout.Write(out)
	}
	return 0
}

// resolveProjectID runs the resolve → ensure ladder, returning uuid.Nil
// (the "no project tag" sentinel) on every fail-open branch. The function
// never returns an error: every failure path is logged to stderr and
// degrades to uuid.Nil so the handler can still write.
//
// Layered fail-open contract:
//   - cache == nil          -> uuid.Nil (caller opted out)
//   - Cwd == ""             -> uuid.Nil (event has no project anchor)
//   - Resolve errors        -> uuid.Nil (e.g. filepath.Abs broken)
//   - Key non-git           -> uuid.Nil (no engine project to ensure)
//   - EnsureProject errors  -> uuid.Nil (network, 5xx, auth)
func resolveProjectID(
	backend Backend, cache *project.Cache, payload Payload, stderr io.Writer,
) uuid.UUID {
	if cache == nil || payload.Cwd == "" {
		return uuid.Nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), ensureProjectTimeout)
	defer cancel()

	key, err := cache.Resolve(ctx, payload.Cwd)
	if err != nil {
		fmt.Fprintln(stderr, "klio hook: project.Resolve:", err)
		return uuid.Nil
	}

	// Non-git directories produce a Key with empty GitRemote AND empty
	// RepoRootPath. The engine 422s on POST /v1/projects/ensure when both
	// are absent, so we short-circuit here with uuid.Nil. The write still
	// goes through, untagged — which is exactly what the user wants when
	// editing in a scratch directory like ~.
	if key.GitRemote == "" && key.RepoRootPath == "" {
		return uuid.Nil
	}

	projectID, err := backend.EnsureProject(ctx, key.GitRemote, key.RepoRootPath, key.DisplayName)
	if err != nil {
		// Fail open: log the error but do not block the write. Losing a
		// project tag is preferable to losing the entry. The next hook
		// fire will retry through the same path; transient failures
		// (token refresh, brief 5xx) self-heal without operator action.
		fmt.Fprintln(stderr, "klio hook: EnsureProject:", err)
		return uuid.Nil
	}
	return projectID
}
