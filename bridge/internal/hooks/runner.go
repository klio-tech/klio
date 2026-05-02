package hooks

import (
	"encoding/json"
	"fmt"
	"io"
)

// Handler is the per-hook entrypoint signature.
type Handler func(b Backend, p Payload) (Response, error)

var registry = map[string]Handler{
	"session-start":  SessionStart,
	"user-prompt":    UserPromptSubmit,
	"pre-tool":       PreToolUse,
	"post-tool":      PostToolUse,
	"subagent-stop":  SubagentStop,
	"session-stop":   SessionStop,
}

// Run dispatches the named hook, reading stdin and writing stdout/stderr.
// Returns the process exit code (0 = ok, 2 = soft failure).
func Run(name string, backend Backend, stdin io.Reader, stdout, stderr io.Writer) int {
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
	resp, err := handler(backend, payload)
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
