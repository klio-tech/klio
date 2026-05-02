-- Initialize Klio Postgres extensions on first boot.
-- Migrations (Alembic) run application-level schema; this file just
-- ensures the required extensions are present from the moment Postgres
-- accepts connections.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
