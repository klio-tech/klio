---
name: space
description: List spaces or switch the active space
arguments:
  - name: action
    required: false
  - name: name
    required: false
---

If `{{action}}` is empty or `list`, call the Klio MCP `space` tool with
`action: "list"` and show the user's spaces.

If `{{action}}` is `switch` and `{{name}}` is provided, call `space` with
`action: "switch", name: "{{name}}"`.
