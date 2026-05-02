// Package mcp implements the Model Context Protocol JSON-RPC envelope and
// the Klio-specific tool schemas.
package mcp

import "encoding/json"

const ProtocolVersion = "2024-11-05"

// Request is an MCP JSON-RPC request frame.
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response is an MCP JSON-RPC response frame.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// Tool describes a single Klio MCP tool surfaced to agents.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// Content is the MCP content block returned in a tools/call result.
type Content struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// CallResult is the standard MCP tools/call result envelope.
type CallResult struct {
	Content []Content `json:"content"`
	IsError bool      `json:"isError,omitempty"`
}
