---
name: remember
description: Store a stable fact via the Klio MCP server
arguments:
  - name: fact
    required: true
---

Call the Klio MCP server's `remember` tool with `content: "{{fact}}"`.
Confirm what was stored to the user.
