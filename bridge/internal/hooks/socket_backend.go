package hooks

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
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
//
// projectID, when non-Nil, is serialised into the tool arguments as
// `project_id` (string form). The daemon side reads it and threads it into
// the engine's recall filter — entries explicitly tagged for the project
// plus all NULL-tagged entries (B2's "always surface" invariant) come back.
// uuid.Nil omits the argument entirely, which leaves the daemon's recall
// in its legacy unfiltered behaviour.
func (s *SocketBackend) Recall(
	query string, limit int, projectID uuid.UUID,
) ([]map[string]any, error) {
	if query == "" {
		// Daemon doesn't support empty query; recall with a generic prompt.
		query = "recent context"
	}
	if limit <= 0 {
		limit = 10
	}
	args := map[string]any{
		"query": query,
		"limit": limit,
	}
	if projectID != uuid.Nil {
		args["project_id"] = projectID.String()
	}
	resp, err := s.call("tools/call", map[string]any{
		"name":      "recall",
		"arguments": args,
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
//
// projectID is serialised as `project_id` in the tool arguments when
// non-Nil. The daemon reads it and passes it to cloud.WriteEntry, which
// the engine persists to entries.project_id. uuid.Nil omits the field,
// which the engine maps to NULL (the safe "no project" default).
func (s *SocketBackend) WriteEntry(
	kind, content string, metadata map[string]any, projectID uuid.UUID,
) (map[string]any, error) {
	if content == "" {
		return nil, errors.New("content empty")
	}
	args := map[string]any{"content": content}
	if metadata != nil {
		args["metadata"] = metadata
	}
	if projectID != uuid.Nil {
		args["project_id"] = projectID.String()
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
//
// projectID is accepted for interface symmetry; will be threaded through
// when the dedicated transcript endpoint lands in Phase K.
func (s *SocketBackend) IngestTranscript(
	_ string, _ []map[string]any, _ uuid.UUID,
) (map[string]any, error) {
	// Phase K wires the dedicated /v1/spaces/{id}/ingest/transcript path
	// through the daemon. For now this is a soft no-op.
	return nil, nil
}

// EnsureProject calls the daemon's klio.ensure_project RPC, which delegates
// to cloud.Client.EnsureProject. The daemon is the only component holding
// the cloud client; the hook subprocess MUST route this through the
// socket. The returned uuid is the engine's project_id, suitable for
// passing into WriteEntry / Recall.
//
// At least one of gitRemote or repoRootPath must be non-empty (the engine
// 422s otherwise). The runner enforces this before calling; SocketBackend
// itself does not pre-validate.
func (s *SocketBackend) EnsureProject(
	_ context.Context, gitRemote, repoRootPath, displayName string,
) (uuid.UUID, error) {
	args := map[string]any{
		"display_name": displayName,
	}
	if gitRemote != "" {
		args["git_remote"] = gitRemote
	}
	if repoRootPath != "" {
		args["repo_root_path"] = repoRootPath
	}
	resp, err := s.call("klio.ensure_project", args)
	if err != nil {
		return uuid.Nil, err
	}
	idStr, _ := resp["project_id"].(string)
	if idStr == "" {
		return uuid.Nil, errors.New("daemon: ensure_project: empty project_id")
	}
	id, err := uuid.Parse(idStr)
	if err != nil {
		return uuid.Nil, fmt.Errorf("daemon: ensure_project: parse project_id: %w", err)
	}
	return id, nil
}
