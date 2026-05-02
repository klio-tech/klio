// Package agentadapters detects installed MCP-capable agents and patches
// their configuration files to register the Klio MCP server.
package agentadapters

// Adapter is the contract every detection+patch implementation satisfies.
type Adapter interface {
	// Name returns a stable identifier.
	Name() string
	// Installed reports whether the agent is detected on this machine.
	Installed() bool
	// Install backs up the agent's config and patches it to add Klio.
	Install(klioMcpBinary string) error
	// Uninstall restores the agent's config from the most recent backup.
	Uninstall() error
}

// All returns the adapter list. Call Installed() to filter.
func All() []Adapter {
	return []Adapter{
		NewClaudeCodeAdapter(),
	}
}
