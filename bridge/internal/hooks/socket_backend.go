package hooks

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"
)

// SocketBackend is the production Backend that talks to the running daemon
// over the unix socket. Each call opens a short-lived connection, sends a
// single MCP tools/call request, reads one line of response, and closes.
type SocketBackend struct {
	socketPath string
	timeout    time.Duration
	idCounter  atomic.Int64
}

func NewSocketBackend() *SocketBackend {
	path := os.Getenv("KLIO_SOCKET_PATH")
	if path == "" {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, ".klio", "bridge.sock")
	}
	return &SocketBackend{socketPath: path, timeout: 3 * time.Second}
}

func (s *SocketBackend) call(method string, params map[string]any) (map[string]any, error) {
	conn, err := s.dial()
	if err != nil {
		return nil, err
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(s.timeout))

	id := s.idCounter.Add(1)
	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	body = append(body, '\n')
	if _, err := conn.Write(body); err != nil {
		return nil, err
	}
	r := bufio.NewReader(conn)
	line, err := r.ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return nil, err
	}
	var resp struct {
		Result map[string]any `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("decode: %w", err)
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("daemon error: %s", resp.Error.Message)
	}
	return resp.Result, nil
}

func (s *SocketBackend) dial() (net.Conn, error) {
	if runtime.GOOS == "windows" {
		return net.DialTimeout("tcp", s.socketPath, s.timeout)
	}
	return net.DialTimeout("unix", s.socketPath, s.timeout)
}

// Recall calls tools/call name=recall.
func (s *SocketBackend) Recall(query string, limit int) ([]map[string]any, error) {
	if query == "" {
		// Daemon doesn't support empty query; recall with a generic prompt.
		query = "recent context"
	}
	if limit <= 0 {
		limit = 10
	}
	resp, err := s.call("tools/call", map[string]any{
		"name": "recall",
		"arguments": map[string]any{
			"query": query,
			"limit": limit,
		},
	})
	if err != nil {
		return nil, err
	}
	// The daemon returns the recall result text-formatted in
	// CallResult.content[0].text. We don't have structured rows from this
	// path; for hooks we just need "is there *anything*". Return a single
	// pseudo-row containing the text so SessionStart can format it.
	content, _ := resp["content"].([]any)
	if len(content) == 0 {
		return nil, nil
	}
	// Synthesize a row from the text payload — sufficient for SessionStart's needs.
	first, _ := content[0].(map[string]any)
	text, _ := first["text"].(string)
	if text == "No relevant entries found." || text == "" {
		return nil, nil
	}
	return []map[string]any{{"kind": "context", "content": text}}, nil
}

// WriteEntry calls tools/call with the given kind as the tool name.
func (s *SocketBackend) WriteEntry(
	kind, content string, metadata map[string]any,
) (map[string]any, error) {
	if content == "" {
		return nil, errors.New("content empty")
	}
	args := map[string]any{"content": content}
	if metadata != nil {
		args["metadata"] = metadata
	}
	resp, err := s.call("tools/call", map[string]any{
		"name":      kind,
		"arguments": args,
	})
	if err != nil {
		return nil, err
	}
	return resp, nil
}

// IngestTranscript currently posts via the same channel as a write — for
// v0 we wire this through a separate daemon endpoint in Phase K.
func (s *SocketBackend) IngestTranscript(
	_ string, _ []map[string]any,
) (map[string]any, error) {
	// Phase K wires the dedicated /v1/spaces/{id}/ingest/transcript path
	// through the daemon. For now this is a soft no-op.
	return nil, nil
}
