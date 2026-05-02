CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT,
    confidence REAL NOT NULL DEFAULT 1.0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_space_created
    ON entries(space_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pending_writes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT,
    queued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS acl_cache (
    space_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    refreshed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (space_id, agent_id)
);

CREATE TABLE IF NOT EXISTS subscription_state (
    space_id TEXT PRIMARY KEY,
    last_acked_frame_id TEXT
);

CREATE TABLE IF NOT EXISTS agent_bindings (
    cwd_pattern TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    space_id TEXT NOT NULL,
    confirmed BOOLEAN NOT NULL DEFAULT 0,
    PRIMARY KEY (cwd_pattern, agent_kind)
);
