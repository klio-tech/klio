package hooks

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

// maxObservationFieldChars caps each tool I/O field independently in the
// observation summary. The total per-observation budget is therefore
// roughly 2 * maxObservationFieldChars plus framing.
//
// Why 2000: large enough to carry a typical bash stdin/stdout, an Edit
// patch, or a Write payload in one piece — the things that the curator's
// FactExtractor needs full context to reason about. Small enough that
// the eventual ciphertext stays well under typical request limits.
//
// Bumping this requires no schema change — the bridge writes plain
// observation `content` strings; the engine encrypts opaquely.
const maxObservationFieldChars = 2000

// SessionStart hooks: pull recent context for the active space and emit it
// as additionalContext that Claude Code prepends to its system prompt.
//
// projectID scopes the recall to the resolved project (with NULL-tagged
// entries always surfacing per B2's invariant). When uuid.Nil — non-git
// cwd, resolve failure, or EnsureProject failure — recall runs across the
// space's full entry set, which is the safe default for a non-project cwd.
func SessionStart(b Backend, _ Payload, projectID uuid.UUID) (Response, error) {
	// empty query -> daemon falls back to cache list-by-active-space
	rows, err := b.Recall("", 12, projectID)
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

func UserPromptSubmit(b Backend, p Payload, projectID uuid.UUID) (Response, error) {
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
			}, projectID)
			return Response{}, nil
		}
	}
	return Response{}, nil
}

// PreToolUse: only fires for Bash/Edit/Write per the install matcher.
// Recall with the tool's input and warn if a strong "never run X" memory exists.
func PreToolUse(b Backend, p Payload, projectID uuid.UUID) (Response, error) {
	if p.ToolName == "" {
		return Response{}, nil
	}
	query := fmt.Sprintf("safety constraint about %s", p.ToolName)
	rows, err := b.Recall(query, 3, projectID)
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
//
// The observation captures BOTH the tool input and the tool response,
// each independently truncated to maxObservationFieldChars. This is the
// upstream signal the curator's FactExtractor consumes — losing it
// (which pre-0.5.4 silently did for any input >= 400 bytes, and for
// every tool response unconditionally) starves extraction.
func PostToolUse(b Backend, p Payload, projectID uuid.UUID) (Response, error) {
	if p.ToolName == "" {
		return Response{}, nil
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Used tool %s\n", p.ToolName))
	sb.WriteString("input: ")
	sb.WriteString(formatObservationField(p.ToolInput))
	sb.WriteString("\nresponse: ")
	sb.WriteString(formatObservationField(p.ToolResponse))
	_, _ = b.WriteEntry("observe", sb.String(), map[string]any{
		"tool":       p.ToolName,
		"session_id": p.SessionID,
	}, projectID)
	return Response{}, nil
}

// formatObservationField renders one tool I/O field for the observation
// summary. Empty/nil fields render as the literal "(none)" so downstream
// consumers can distinguish "absent" from "truncated to nothing".
//
// Truncation is byte-naive on purpose: the LLM-backed extractor handles
// partial JSON well, and the regex-stub fallback doesn't care about
// JSON shape. We always append a marker recording the original size so
// future readers (and the curator) can tell signal was dropped.
func formatObservationField(raw []byte) string {
	if len(raw) == 0 {
		return "(none)"
	}
	if len(raw) <= maxObservationFieldChars {
		return string(raw)
	}
	return fmt.Sprintf(
		"%s... (truncated, original %d bytes)",
		string(raw[:maxObservationFieldChars]),
		len(raw),
	)
}

// SubagentStop: capture subagent's final report as an observation.
func SubagentStop(b Backend, p Payload, projectID uuid.UUID) (Response, error) {
	if p.UserMessage == "" {
		return Response{}, nil
	}
	_, _ = b.WriteEntry("observe", p.UserMessage, map[string]any{
		"kind":       "subagent_finding",
		"session_id": p.SessionID,
	}, projectID)
	return Response{}, nil
}

// SessionStop: ingest the full transcript for extraction.
func SessionStop(b Backend, p Payload, projectID uuid.UUID) (Response, error) {
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
	_, _ = b.IngestTranscript(p.SessionID, messages, projectID)
	return Response{}, nil
}
