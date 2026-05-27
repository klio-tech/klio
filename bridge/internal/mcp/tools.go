package mcp

// Tools returns the seven Klio MCP tools exposed to agents.
//
// Distinct verbs (recall/remember/observe/plan/decide/note/space) measurably
// improve LLM tool selection vs. one generic "write(kind, content)" tool.
func Tools() []Tool {
	return []Tool{
		{
			Name: "recall",
			Description: "Retrieve relevant entries from the user's Klio space using a natural-language query. " +
				"Use when the user asks 'what did I tell you about X', 'do you remember Y', or before " +
				"making decisions that should be informed by past context.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query": map[string]any{
						"type":        "string",
						"description": "Natural-language description of what to recall.",
					},
					"space": map[string]any{
						"type":        "string",
						"description": "Optional space slug. Defaults to active space.",
					},
					"kind": map[string]any{
						"type": "string",
						"enum": []string{"memory", "observation", "plan", "decision", "note"},
					},
					"limit": map[string]any{"type": "integer", "default": 10, "minimum": 1, "maximum": 100},
					"project": map[string]any{
						"type": "string",
						"description": "Optional project filter. When omitted, defaults to the " +
							"current project (auto-detected from the agent's working directory) " +
							"if the bridge tagged this call, otherwise recall is cross-project. " +
							"Pass the literal 'any' to widen recall to ALL projects the user has " +
							"memories in — useful when the user asks 'how did we do X in that " +
							"other repo'. Pass a specific git remote URL (e.g. " +
							"'git@github.com:org/repo.git') to scope to a named other project.",
					},
				},
				"required": []string{"query"},
			},
		},
		{
			Name: "remember",
			Description: "Store a stable fact about the user, project, or context. Use this when the user says " +
				"'remember', 'don't forget', 'from now on', or states a preference clearly.",
			InputSchema: contentSchema("Stable fact to remember (under 500 chars)."),
		},
		{
			Name: "observe",
			Description: "Log something the agent did or saw during the session. Other agents subscribed to the " +
				"same space see this in real-time.",
			InputSchema: contentSchema("What the agent did or saw."),
		},
		{
			Name: "plan",
			Description: "Post a forward-looking plan or intent. Use when the user agrees to a multi-step " +
				"approach. Other agents in the space can pick up the plan and execute steps.",
			InputSchema: contentSchema("Plan content. Multi-step plans should be one entry."),
		},
		{
			Name: "decide",
			Description: "Record a chosen path along with rationale. Use when the user explicitly chooses " +
				"between options or commits to a direction.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"content":   map[string]any{"type": "string", "description": "The decision."},
					"rationale": map[string]any{"type": "string", "description": "Why this was chosen."},
					"space":     map[string]any{"type": "string", "description": "Optional space slug."},
				},
				"required": []string{"content"},
			},
		},
		{
			Name:        "note",
			Description: "Free-form annotation. Use for ad-hoc notes that don't fit memory/plan/decision/observation.",
			InputSchema: contentSchema("Note text."),
		},
		{
			Name: "space",
			Description: "Multiplexed space management. action='list' lists accessible spaces, action='switch' " +
				"sets the active space for this agent's session, action='info' returns details, " +
				"action='request_access' asks the user to grant access to a space.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"action": map[string]any{
						"type": "string",
						"enum": []string{"list", "switch", "info", "request_access"},
					},
					"name":  map[string]any{"type": "string"},
					"scope": map[string]any{"type": "string", "enum": []string{"read", "write", "admin"}},
				},
				"required": []string{"action"},
			},
		},
	}
}

func contentSchema(contentDesc string) map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"content":  map[string]any{"type": "string", "description": contentDesc},
			"space":    map[string]any{"type": "string", "description": "Optional space slug."},
			"metadata": map[string]any{"type": "object", "description": "Optional metadata."},
		},
		"required": []string{"content"},
	}
}
