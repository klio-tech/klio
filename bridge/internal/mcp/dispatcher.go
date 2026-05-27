package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

// Backend abstracts the daemon's domain operations.
//
// projectID parameters carry the engine project_id resolved by the hook
// runner (via project.Cache + EnsureProject). uuid.Nil is the "no project
// tag" sentinel: the daemon's cloud-client adapter MUST translate uuid.Nil
// into an omitted JSON `project_id` field on the wire, which the engine
// maps to NULL — and NULL-tagged entries always surface under any project
// recall filter (B2's invariant). See cloud.EntryWrite for the wire shape.
type Backend interface {
	Recall(
		ctx context.Context,
		query, spaceSlug, kind string,
		limit int,
		projectID uuid.UUID,
	) ([]map[string]any, error)
	WriteEntry(
		ctx context.Context,
		kind, content, spaceSlug string,
		metadata map[string]any,
		projectID uuid.UUID,
	) (map[string]any, error)
	ListSpaces(ctx context.Context) ([]map[string]any, error)
	SwitchSpace(ctx context.Context, slug string) error
	RequestAccess(ctx context.Context, slug, scope string) error
	ActiveSpaceInfo(ctx context.Context) (map[string]any, error)
	// EnsureProject is the daemon's per-cwd identity bridge: it accepts a
	// project.Key projection from the hook subprocess and returns the
	// engine project_id (creating one if this is the first time the
	// engine has seen this remote/root). E2's hook runner calls this
	// before each write/recall so the resulting tag follows the user's
	// actual project boundary, not their cwd boundary.
	EnsureProject(
		ctx context.Context, gitRemote, repoRootPath, displayName string,
	) (uuid.UUID, error)
}

// Dispatcher routes MCP requests to a Backend.
type Dispatcher struct {
	backend Backend
}

func NewDispatcher(b Backend) *Dispatcher {
	return &Dispatcher{backend: b}
}

// Handle parses one JSON-RPC request line and returns one response line.
func (d *Dispatcher) Handle(line []byte) []byte {
	var req Request
	if err := json.Unmarshal(line, &req); err != nil {
		return errorResp(nil, -32700, "parse error", nil)
	}
	switch req.Method {
	case "initialize":
		return d.handleInitialize(req)
	case "notifications/initialized":
		// MCP handshake notification; no response.
		return nil
	case "tools/list":
		return d.handleToolsList(req)
	case "tools/call":
		return d.handleToolsCall(req)
	case "klio.ensure_project":
		// Custom JSON-RPC method (not an MCP tool) called by the hook
		// runner before every write/recall. The hook subprocess does
		// not own the cloud client, so EnsureProject must transit the
		// socket → daemon → cloud path. Exposing it as a top-level
		// method (rather than a synthetic tool) keeps it out of the
		// LLM-facing tool surface: nothing in `tools/list` should
		// suggest the LLM call this directly.
		return d.handleEnsureProject(req)
	case "ping":
		return ok(req.ID, map[string]any{})
	}
	return errorResp(req.ID, -32601, "method not found: "+req.Method, nil)
}

func (d *Dispatcher) handleInitialize(req Request) []byte {
	return ok(req.ID, map[string]any{
		"protocolVersion": ProtocolVersion,
		"serverInfo":      map[string]any{"name": "klio", "version": "0.0.1"},
		"capabilities": map[string]any{
			"tools": map[string]any{},
		},
	})
}

func (d *Dispatcher) handleToolsList(req Request) []byte {
	return ok(req.ID, map[string]any{"tools": Tools()})
}

func (d *Dispatcher) handleToolsCall(req Request) []byte {
	var params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return errorResp(req.ID, -32602, "invalid params: "+err.Error(), nil)
	}
	ctx := context.Background()
	switch params.Name {
	case "recall":
		return d.callRecall(ctx, req.ID, params.Arguments)
	case "remember", "observe", "plan", "decide", "note":
		return d.callWrite(ctx, req.ID, params.Name, params.Arguments)
	case "space":
		return d.callSpace(ctx, req.ID, params.Arguments)
	default:
		return errorResp(req.ID, -32601, "unknown tool: "+params.Name, nil)
	}
}

func (d *Dispatcher) callRecall(ctx context.Context, id json.RawMessage, args map[string]any) []byte {
	query, _ := args["query"].(string)
	if query == "" {
		return errorResp(id, -32602, "query is required", nil)
	}
	space, _ := args["space"].(string)
	kind, _ := args["kind"].(string)
	limit := 10
	if l, ok := args["limit"].(float64); ok {
		limit = int(l)
	}
	projectID := parseProjectID(args)
	rows, err := d.backend.Recall(ctx, query, space, kind, limit, projectID)
	if err != nil {
		return errorResp(id, -32000, err.Error(), nil)
	}
	return ok(id, toCallResult(formatRecall(rows)))
}

func (d *Dispatcher) callWrite(
	ctx context.Context, id json.RawMessage, kind string, args map[string]any,
) []byte {
	content, _ := args["content"].(string)
	if content == "" {
		return errorResp(id, -32602, "content is required", nil)
	}
	space, _ := args["space"].(string)
	metadata, _ := args["metadata"].(map[string]any)
	if rationale, ok := args["rationale"].(string); ok && kind == "decide" {
		if metadata == nil {
			metadata = map[string]any{}
		}
		metadata["rationale"] = rationale
	}
	projectID := parseProjectID(args)
	entry, err := d.backend.WriteEntry(ctx, kind, content, space, metadata, projectID)
	if err != nil {
		return errorResp(id, -32000, err.Error(), nil)
	}
	return ok(id, toCallResult(formatEntry(entry)))
}

// parseProjectID reads the optional `project_id` argument from a tools/call
// payload. Returns uuid.Nil for absent, empty, or unparseable values — the
// safe "no project tag" sentinel that lets the engine apply NULL handling.
// An unparseable value is intentionally NOT a hard error: the hook runner
// is fail-open by design, and surfacing a 400 here would short-circuit the
// underlying write/recall. The expected real-world frequency of bad
// project_ids is zero; we still want the underlying operation to win.
func parseProjectID(args map[string]any) uuid.UUID {
	raw, _ := args["project_id"].(string)
	if raw == "" {
		return uuid.Nil
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		return uuid.Nil
	}
	return id
}

// handleEnsureProject services the `klio.ensure_project` JSON-RPC method
// sent by the hook subprocess. The hook resolved cwd → project.Key
// locally; the daemon translates that Key projection into a cloud-side
// ensure call and returns the resulting project_id.
//
// Param shape (mirrors cloud.ensureProjectRequest):
//
//	{
//	  "git_remote":      optional string,
//	  "repo_root_path":  optional string,
//	  "display_name":    string (required by engine, runner enforces non-empty)
//	}
//
// At least one of git_remote / repo_root_path must be non-empty — the
// engine 422s otherwise, but the hook runner skips the call entirely in
// that case (non-git cwd → uuid.Nil), so the daemon never sees it. The
// daemon does not re-validate beyond what the cloud client surfaces.
func (d *Dispatcher) handleEnsureProject(req Request) []byte {
	var params struct {
		GitRemote    string `json:"git_remote"`
		RepoRootPath string `json:"repo_root_path"`
		DisplayName  string `json:"display_name"`
	}
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResp(req.ID, -32602, "invalid params: "+err.Error(), nil)
		}
	}
	ctx := context.Background()
	id, err := d.backend.EnsureProject(
		ctx, params.GitRemote, params.RepoRootPath, params.DisplayName,
	)
	if err != nil {
		return errorResp(req.ID, -32000, err.Error(), nil)
	}
	return ok(req.ID, map[string]any{"project_id": id.String()})
}

func (d *Dispatcher) callSpace(ctx context.Context, id json.RawMessage, args map[string]any) []byte {
	action, _ := args["action"].(string)
	switch action {
	case "list":
		spaces, err := d.backend.ListSpaces(ctx)
		if err != nil {
			return errorResp(id, -32000, err.Error(), nil)
		}
		return ok(id, toCallResult(formatSpaces(spaces)))
	case "switch":
		name, _ := args["name"].(string)
		if name == "" {
			return errorResp(id, -32602, "name is required for switch", nil)
		}
		if err := d.backend.SwitchSpace(ctx, name); err != nil {
			return errorResp(id, -32000, err.Error(), nil)
		}
		return ok(id, toCallResult(fmt.Sprintf("switched to %s", name)))
	case "info":
		info, err := d.backend.ActiveSpaceInfo(ctx)
		if err != nil {
			return errorResp(id, -32000, err.Error(), nil)
		}
		return ok(id, toCallResult(fmt.Sprintf("%v", info)))
	case "request_access":
		name, _ := args["name"].(string)
		scope, _ := args["scope"].(string)
		if scope == "" {
			scope = "read"
		}
		if err := d.backend.RequestAccess(ctx, name, scope); err != nil {
			return errorResp(id, -32000, err.Error(), nil)
		}
		return ok(id, toCallResult(fmt.Sprintf("requested %s access to %s", scope, name)))
	default:
		return errorResp(id, -32602, "unknown action: "+action, nil)
	}
}

func ok(id json.RawMessage, result any) []byte {
	out, _ := json.Marshal(Response{JSONRPC: "2.0", ID: id, Result: result})
	return out
}

func errorResp(id json.RawMessage, code int, msg string, data any) []byte {
	out, _ := json.Marshal(Response{
		JSONRPC: "2.0", ID: id, Error: &Error{Code: code, Message: msg, Data: data},
	})
	return out
}

func toCallResult(text string) CallResult {
	return CallResult{Content: []Content{{Type: "text", Text: text}}}
}

func formatRecall(rows []map[string]any) string {
	if len(rows) == 0 {
		return "No relevant entries found."
	}
	out := fmt.Sprintf("Found %d relevant entries:\n", len(rows))
	for i, r := range rows {
		out += fmt.Sprintf("%d. [%v] %v\n", i+1, r["kind"], r["content"])
	}
	return out
}

func formatEntry(e map[string]any) string {
	return fmt.Sprintf("Stored as %v entry %v", e["kind"], e["id"])
}

func formatSpaces(spaces []map[string]any) string {
	out := fmt.Sprintf("%d spaces:\n", len(spaces))
	for _, s := range spaces {
		out += fmt.Sprintf("  - %v (%v)\n", s["name"], s["slug"])
	}
	return out
}
