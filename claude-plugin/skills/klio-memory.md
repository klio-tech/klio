---
name: klio-memory
description: Use when the user mentions remembering, forgetting, or recalling something. Trigger phrases include "remember", "don't forget", "what did I tell you about", "from now on", "you should know that". When triggered, use the Klio MCP server's `remember` and `recall` tools.
---

## When to use this skill

The user has explicitly asked you to remember a fact, recall something they
told you previously, or expressed a stable preference. Examples:

- "Remember that I use Bun, not npm."
- "Don't forget the auth library is jose."
- "What did I tell you about deployment?"
- "From now on, prefer functional components."

## How to use

When the user states a fact to remember, call the `remember` tool from the
Klio MCP server with the fact as `content`. Confirm what was stored:

> "Got it, I'll remember that you use Bun."

When the user asks what you remember about a topic, call `recall` with the
topic as the `query`. Cite the entries' `created_at` timestamps so the user
can verify currency.

When you're about to make a non-trivial decision (library choice, naming
convention, deployment target), call `recall` first with a short query
describing the decision. Use what comes back to inform your choice.

## What NOT to do

- Don't call `remember` for ephemeral statements like "I'm tired" or "let's start over".
- Don't call `recall` on every prompt — only when context suggests prior memory matters.
- Don't surface raw Klio entries to the user verbatim — synthesize them into your answer.
