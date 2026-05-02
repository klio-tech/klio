package hooks

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
)

// readTranscript parses a Claude Code session JSONL file into the
// {role, content} message shape the engine's ingest endpoint expects.
//
// Claude Code session lines have evolved across versions; this parser is
// permissive: it tries `content` (string), `text` (string), and the
// `content` array of `{type:"text", text:...}` blocks.
func readTranscript(path string) ([]map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	var out []map[string]any
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal(line, &raw); err != nil {
			continue
		}
		role, _ := raw["role"].(string)
		if role == "" {
			role, _ = raw["type"].(string)
		}
		if role == "" {
			continue
		}
		content := extractContent(raw)
		if content == "" {
			continue
		}
		out = append(out, map[string]any{"role": role, "content": content})
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return out, err
	}
	return out, nil
}

func extractContent(raw map[string]any) string {
	if c, ok := raw["content"].(string); ok {
		return c
	}
	if c, ok := raw["text"].(string); ok {
		return c
	}
	if arr, ok := raw["content"].([]any); ok {
		var parts []string
		for _, item := range arr {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if t, ok := m["text"].(string); ok {
				parts = append(parts, t)
			}
		}
		return joinNonEmpty(parts)
	}
	return ""
}

func joinNonEmpty(parts []string) string {
	out := ""
	for _, p := range parts {
		if p == "" {
			continue
		}
		if out != "" {
			out += "\n"
		}
		out += p
	}
	return out
}
