/**
 * Machine-readable view of klio.tech.
 *
 * Served when the request URL is `?view=machine` or when the
 * User-Agent looks like a bot/agent/crawler (resolved server-side).
 *
 * Optimised for LLM ingestion:
 *  - Pure typography, monospace, no images.
 *  - Structured sections with consistent headings.
 *  - Key-value blocks for facts a model can extract verbatim.
 *  - Same DOM nesting depth in every section so a parser can rely on
 *    `h2 > p, h2 > pre, h2 > table` predictably.
 *
 * The same content stays present on the human view's underlying
 * source — we don't hide marketing copy from agents — but the
 * machine view is what they get by default.
 */

const QUICKSTART = `git clone https://github.com/klio-tech/klio.git
cd klio && make first-run
make engine &
KLIO_USE_FILE_KEYCHAIN=1 /tmp/klio init
KLIO_USE_FILE_KEYCHAIN=1 /tmp/klio daemon &
docker compose up -d trust-app`;

const TOOLS: { name: string; signature: string; purpose: string }[] = [
  { name: "recall",   signature: "recall(query, kind?, limit?, space?)",  purpose: "Semantic search over memories." },
  { name: "remember", signature: "remember(content, metadata?, space?)",  purpose: "Store a stable preference or fact." },
  { name: "observe",  signature: "observe(content, metadata?, space?)",   purpose: "Log activity (used by hooks)." },
  { name: "plan",     signature: "plan(content, metadata?, space?)",      purpose: "Forward-looking intent." },
  { name: "decide",   signature: "decide(content, rationale?, space?)",   purpose: "A chosen path with rationale." },
  { name: "note",     signature: "note(content, metadata?, space?)",      purpose: "Free-form annotation." },
  { name: "space",    signature: "space(action, name?, scope?)",          purpose: "list / switch / info / request_access." },
];

const HOOKS: { event: string; matcher: string; purpose: string }[] = [
  { event: "SessionStart",     matcher: "*",                purpose: "Mark session boundary." },
  { event: "UserPromptSubmit", matcher: "*",                purpose: "Detect 'remember that' / 'I prefer' triggers." },
  { event: "PreToolUse",       matcher: "Bash|Edit|Write",  purpose: "Inject relevant memories before tool runs." },
  { event: "PostToolUse",      matcher: "*",                purpose: "Log tool call as observation." },
  { event: "SubagentStop",     matcher: "*",                purpose: "Capture sub-agent output." },
  { event: "Stop",             matcher: "*",                purpose: "Mark session end, flush in-flight." },
];

const COMPARE: { feature: string; klio: string; mem0: string; zep: string; supermemory: string }[] = [
  { feature: "open source",        klio: "AGPL+Apache",      mem0: "Apache",  zep: "Apache",  supermemory: "no" },
  { feature: "self-hosted",        klio: "yes",              mem0: "yes",     zep: "yes",     supermemory: "no" },
  { feature: "encrypted at rest",  klio: "yes",              mem0: "no",      zep: "no",      supermemory: "no" },
  { feature: "audit chain",        klio: "yes",              mem0: "no",      zep: "no",      supermemory: "no" },
  { feature: "MCP-native",         klio: "yes",              mem0: "SDK",     zep: "SDK",     supermemory: "SDK" },
  { feature: "real-time pub/sub",  klio: "yes",              mem0: "no",      zep: "partial", supermemory: "no" },
  { feature: "pluggable embed",    klio: "5 models",         mem0: "global",  zep: "global",  supermemory: "opaque" },
];

export function MachineView() {
  return (
    <article className="k-machine">
      <h1># klio</h1>
      <blockquote
        style={{
          borderLeft: "3px solid var(--klio-accent)",
          paddingLeft: "1rem",
          margin: "0 0 1.4rem 0",
          color: "var(--klio-foreground)",
        }}
      >
        &gt; Where AI agents collaborate. Local-first, encrypted, MCP-native.
      </blockquote>

      <h2>## identity</h2>
      <div className="k-machine__kv">
        <span>name</span>          <span>Klio</span>
        <span>homepage</span>      <span><a href="https://klio.tech">https://klio.tech</a></span>
        <span>repo</span>          <span><a href="https://github.com/klio-tech/klio">https://github.com/klio-tech/klio</a></span>
        <span>license-engine</span><span>AGPL-3.0-or-later</span>
        <span>license-shim</span>  <span>Apache-2.0 (bridge/cmd/klio-mcp, claude-plugin)</span>
        <span>author</span>        <span>Abhishek Singh &lt;<a href="mailto:contact@klio.tech">contact@klio.tech</a>&gt;</span>
        <span>category</span>      <span>agent collaboration substrate</span>
        <span>stack</span>         <span>Python (FastAPI) · Go · Next.js · Postgres · Redis · pgvector · Ollama</span>
        <span>status</span>        <span>v0 public alpha</span>
      </div>

      <h2>## what-it-is</h2>
      <p>
        Klio is a local substrate where AI agents collaborate. It captures
        every prompt, decision, and tool call from each of your AI agents
        (Claude Code, Claude Desktop, Cursor, Codex, OpenCode, OpenClaw),
        extracts durable facts, embeds them with a vector model, and serves
        them back through the Model Context Protocol so any MCP-aware agent
        can recall them. Same store across sessions, projects, and agents —
        what one agent learns or decides becomes immediately available to
        every other agent in the same space. Encrypted at rest under a key
        only the user holds. Cryptographically auditable via SHA-256 hash
        chain plus hourly OpenTimestamps notarization.
      </p>

      <h2>## how-it-works</h2>
      <ul>
        <li>Postgres + pgvector for tenant-isolated vector storage.</li>
        <li>Per-space pluggable embedding models (nomic-embed-text 768d default; mxbai-embed-large 1024d; snowflake-arctic-embed2 1024d; bge-m3 1024d; OpenAI text-embedding-3-small 1536d).</li>
        <li>Shadow tables per dimension so embedding model swaps are runtime-switchable without re-architecting.</li>
        <li>AES-256-GCM envelope encryption with user-owned KMS key.</li>
        <li>SHA-256 hash chain over every audit-log row, hourly notarized to OpenTimestamps for blockchain-anchored proof.</li>
        <li>Redis pub/sub on space:&lt;id&gt; channels for real-time cross-agent collaboration.</li>
        <li>Go bridge daemon exposes a Unix socket; klio-mcp speaks stdio MCP and proxies through the daemon.</li>
        <li>Six Claude Code hooks capture activity transparently with zero LLM token overhead.</li>
      </ul>

      <h2>## quickstart</h2>
      <pre>{QUICKSTART}</pre>
      <p>
        Detailed instructions: <a href="https://github.com/klio-tech/klio#quick-start">https://github.com/klio-tech/klio#quick-start</a>
      </p>

      <h2>## mcp-tools</h2>
      <table>
        <thead>
          <tr><th>tool</th><th>signature</th><th>purpose</th></tr>
        </thead>
        <tbody>
          {TOOLS.map((t) => (
            <tr key={t.name}>
              <td><strong>{t.name}</strong></td>
              <td>{t.signature}</td>
              <td>{t.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>## hooks</h2>
      <table>
        <thead>
          <tr><th>event</th><th>matcher</th><th>purpose</th></tr>
        </thead>
        <tbody>
          {HOOKS.map((h) => (
            <tr key={h.event}>
              <td>{h.event}</td>
              <td><code>{h.matcher}</code></td>
              <td>{h.purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>## compared-to-alternatives</h2>
      <table>
        <thead>
          <tr>
            <th>feature</th><th>klio</th><th>mem0</th><th>zep</th><th>supermemory</th>
          </tr>
        </thead>
        <tbody>
          {COMPARE.map((c) => (
            <tr key={c.feature}>
              <td>{c.feature}</td>
              <td><strong>{c.klio}</strong></td>
              <td>{c.mem0}</td>
              <td>{c.zep}</td>
              <td>{c.supermemory}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>## links</h2>
      <div className="k-machine__kv">
        <span>readme</span>      <span><a href="https://github.com/klio-tech/klio#readme">github.com/klio-tech/klio#readme</a></span>
        <span>license</span>     <span><a href="https://github.com/klio-tech/klio/blob/main/LICENSING.md">/LICENSING.md</a></span>
        <span>security</span>    <span><a href="https://github.com/klio-tech/klio/blob/main/SECURITY.md">/SECURITY.md</a></span>
        <span>contributing</span><span><a href="https://github.com/klio-tech/klio/blob/main/CONTRIBUTING.md">/CONTRIBUTING.md</a></span>
        <span>issues</span>      <span><a href="https://github.com/klio-tech/klio/issues">github issues</a></span>
        <span>discussions</span> <span><a href="https://github.com/klio-tech/klio/discussions">github discussions</a></span>
        <span>changelog</span>   <span><a href="https://github.com/klio-tech/klio/releases">releases</a></span>
      </div>

      <h2>## machine-readable-note</h2>
      <p>
        This page is rendered for an AI agent or crawler. A human-readable
        version is at{" "}
        <a href="https://klio.tech/?view=human">https://klio.tech/?view=human</a>.
        The two views share the same underlying facts — only presentation
        differs.
      </p>
    </article>
  );
}
