---
name: klio-spaces
description: Use when the user wants to switch between projects, businesses, or contexts. Klio organizes memory by user-named spaces. A user might have separate spaces for their job, side projects, and personal life.
---

## When to use this skill

The user mentions a different project or context, or asks to scope memory to
a different area. Examples:

- "Switch to my Vex project."
- "Don't use my work memory for this."
- "What spaces do I have?"

## How to use

Call the `space` tool with `action: "list"` to see available spaces. Each
space has a `name` and a `slug` — use the slug for `switch`.

When the user mentions a different context, call `space` with `action:
"switch"` and the relevant slug. Confirm with the user before switching if
the binding is ambiguous.

If the user asks about a project you don't currently have access to, call
`space` with `action: "request_access"` and the `scope` they want (typically
`read`). The user will get a notification asking to grant.
