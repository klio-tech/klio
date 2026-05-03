// Package agentadapters detects installed MCP-capable agents and patches
// their configuration files to register the Klio MCP server.
package agentadapters

// Config carries everything an adapter needs to write a working agent
// configuration. We do NOT assume `klio` or `klio-mcp` are on PATH;
// agents like Claude Code spawn hooks via `posix_spawn` with a minimal
// PATH, so absolute paths are required.
type Config struct {
	// KlioBinary is the absolute path to the `klio` binary used by hook
	// commands (e.g. `<KlioBinary> hook user-prompt`).
	KlioBinary string

	// KlioMcpBinary is the absolute path to the `klio-mcp` binary used
	// as the MCP server entry's `command`.
	KlioMcpBinary string

	// Env is the environment block applied to both the MCP server entry
	// and every hook command. Must include at least `KLIO_SOCKET_PATH`
	// so the children find the daemon's UDS.
	Env map[string]string
}

// Adapter is the contract every detection+patch implementation satisfies.
type Adapter interface {
	// Name returns a stable identifier.
	Name() string
	// Installed reports whether the agent is detected on this machine.
	Installed() bool
	// Install backs up the agent's config and patches it to add Klio.
	Install(cfg Config) error
	// Uninstall restores the agent's config from the most recent backup.
	Uninstall() error
}

// All returns the adapter list. Call Installed() to filter.
//
// Order is significant only for the human-facing report ("configured
// agents: [...]"). Detection + install are independent per adapter.
func All() []Adapter {
	return []Adapter{
		NewClaudeCodeAdapter(),
		NewCursorAdapter(),
		NewCodexAdapter(),
	}
}
