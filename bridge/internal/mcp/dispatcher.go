package mcp

import (
	"context"
	"encoding/json"
	"fmt"
)

// Backend abstracts the daemon's domain operations.
type Backend interface {
	Recall(ctx context.Context, query, spaceSlug, kind string, limit int) ([]map[string]any, error)
	WriteEntry(ctx context.Context, kind, content, spaceSlug string, metadata map[string]any) (map[string]any, error)
	ListSpaces(ctx context.Context) ([]map[string]any, error)
	SwitchSpace(ctx context.Context, slug string) error
	RequestAccess(ctx context.Context, slug, scope string) error
	ActiveSpaceInfo(ctx context.Context) (map[string]any, error)
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
	rows, err := d.backend.Recall(ctx, query, space, kind, limit)
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
	entry, err := d.backend.WriteEntry(ctx, kind, content, space, metadata)
	if err != nil {
		return errorResp(id, -32000, err.Error(), nil)
	}
	return ok(id, toCallResult(formatEntry(entry)))
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
