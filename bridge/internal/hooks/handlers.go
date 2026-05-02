package hooks

import (
	"fmt"
	"regexp"
	"strings"
)

// SessionStart hooks: pull recent context for the active space and emit it
// as additionalContext that Claude Code prepends to its system prompt.
func SessionStart(b Backend, _ Payload) (Response, error) {
	rows, err := b.Recall("", 12) // empty query -> daemon falls back to cache list-by-active-space
	if err != nil {
		return Response{}, nil // soft fail
	}
	if len(rows) == 0 {
		return Response{}, nil
	}
	return Response{
		HookSpecificOutput: map[string]any{
			"hookEventName":     "SessionStart",
			"additionalContext": formatContext(rows),
		},
	}, nil
}

func formatContext(rows []map[string]any) string {
	var sb strings.Builder
	sb.WriteString("## Klio context for this session\n\n")
	for _, r := range rows {
		kind := fmt.Sprintf("%v", r["kind"])
		content := fmt.Sprintf("%v", r["content"])
		sb.WriteString(fmt.Sprintf("- [%s] %s\n", kind, content))
	}
	sb.WriteString("\nUse the `recall` tool to query for more context.\n")
	return sb.String()
}

// UserPromptSubmit: scan for trigger phrases and capture as a `memory`.
var triggerPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\bremember\s+(?:that\s+)?(.+?)$`),
	regexp.MustCompile(`(?i)\bdon[''']t\s+forget\s+(?:that\s+)?(.+?)$`),
	regexp.MustCompile(`(?i)\bfrom\s+now\s+on,?\s+(.+?)$`),
	regexp.MustCompile(`(?i)\bnote\s+that\s+(.+?)$`),
}

func UserPromptSubmit(b Backend, p Payload) (Response, error) {
	if p.UserMessage == "" {
		return Response{}, nil
	}
	for _, re := range triggerPatterns {
		match := re.FindStringSubmatch(p.UserMessage)
		if len(match) >= 2 {
			fact := strings.TrimSpace(match[1])
			fact = strings.TrimRight(fact, ".")
			if fact == "" {
				continue
			}
			_, _ = b.WriteEntry("remember", fact, map[string]any{
				"source":     "user-trigger-phrase",
				"session_id": p.SessionID,
			})
			return Response{}, nil
		}
	}
	return Response{}, nil
}

// PreToolUse: only fires for Bash/Edit/Write per the install matcher.
// Recall with the tool's input and warn if a strong "never run X" memory exists.
func PreToolUse(b Backend, p Payload) (Response, error) {
	if p.ToolName == "" {
		return Response{}, nil
	}
	query := fmt.Sprintf("safety constraint about %s", p.ToolName)
	rows, err := b.Recall(query, 3)
	if err != nil || len(rows) == 0 {
		return Response{}, nil
	}
	// Surface as a warning. We don't outright block; that's a Phase L tightening.
	var notes []string
	for _, r := range rows {
		notes = append(notes, fmt.Sprintf("- %v", r["content"]))
	}
	return Response{
		HookSpecificOutput: map[string]any{
			"hookEventName": "PreToolUse",
			"additionalContext": fmt.Sprintf(
				"Klio: relevant prior constraints — review before running:\n%s",
				strings.Join(notes, "\n"),
			),
		},
	}, nil
}

// PostToolUse: log an observation entry for cross-agent visibility.
// Best-effort, async; never blocks the user's session.
func PostToolUse(b Backend, p Payload) (Response, error) {
	if p.ToolName == "" {
		return Response{}, nil
	}
	summary := fmt.Sprintf("Used tool %s", p.ToolName)
	if len(p.ToolInput) > 0 && len(p.ToolInput) < 400 {
		summary += " input=" + string(p.ToolInput)
	}
	_, _ = b.WriteEntry("observe", summary, map[string]any{
		"tool":       p.ToolName,
		"session_id": p.SessionID,
	})
	return Response{}, nil
}

// SubagentStop: capture subagent's final report as an observation.
func SubagentStop(b Backend, p Payload) (Response, error) {
	if p.UserMessage == "" {
		return Response{}, nil
	}
	_, _ = b.WriteEntry("observe", p.UserMessage, map[string]any{
		"kind":       "subagent_finding",
		"session_id": p.SessionID,
	})
	return Response{}, nil
}

// SessionStop: ingest the full transcript for extraction.
func SessionStop(b Backend, p Payload) (Response, error) {
	if p.SessionID == "" {
		return Response{}, nil
	}
	if p.TranscriptPath == "" {
		// Without the transcript file we can't ingest. Quietly succeed.
		return Response{}, nil
	}
	messages, err := readTranscript(p.TranscriptPath)
	if err != nil || len(messages) == 0 {
		return Response{}, nil
	}
	_, _ = b.IngestTranscript(p.SessionID, messages)
	return Response{}, nil
}
