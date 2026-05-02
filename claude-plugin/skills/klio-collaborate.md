---
name: klio-collaborate
description: Use when the user asks what other agents have done, when planning multi-agent work, or when posting work for another agent to pick up. Klio is the shared workspace where Claude, Cursor, Codex, and other agents coordinate.
---

## When to use this skill

The user is working in a project that has multiple agents involved (Claude,
Cursor, Codex). Examples:

- "What did Cursor change in the auth module?"
- "Make a plan for Cursor to implement."
- "Pick up where Cursor left off yesterday."

## How to use

To see what other agents have done, call `recall` with a query about the
relevant area; entries from other agents have a different `agent_id` than
yours. The `created_at` timestamp tells you when the work happened.

When making a plan that another agent will execute, call the `plan` tool to
post it. Other agents in the same space see the plan in real-time and can
work from it.

When making a decision with rationale, call `decide` with both the decision
and the rationale fields. Other agents reading the space see your reasoning,
not just the conclusion.

## Provenance matters

Always cite the source of cross-agent context: "Following the plan Cursor
posted at 14:32...", "Per the decision Claude made yesterday...". Users want
to know who did what.
