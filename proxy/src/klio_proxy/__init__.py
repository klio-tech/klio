"""Klio compression proxy.

A local HTTP server that sits between an AI coding agent (Claude Code,
Codex) and the Anthropic Messages API. Stage 3 of the Klio Compression
design ships it as a **pure pass-through**: it changes nothing about the
traffic it carries.

That is deliberate. The riskiest thing in the compression design is
being in the request path at all — once ``ANTHROPIC_BASE_URL`` points at
localhost, a proxy that is down, slow, or subtly wrong does not degrade
the agent, it kills it. So the plumbing ships and gets proven survivable
while the blast radius is zero, and the compressors plug into the seam
in :mod:`klio_proxy.seam` afterwards.
"""

__all__ = ["__version__"]

__version__ = "0.0.1"
