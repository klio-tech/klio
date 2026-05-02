---
name: recall
description: Search Klio for entries matching a natural-language query
arguments:
  - name: query
    required: true
---

Call the Klio MCP server's `recall` tool with `query: "{{query}}"`. Show the
top results to the user, with their kind, age, and content.
