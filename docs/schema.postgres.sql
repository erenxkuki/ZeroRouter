-- ZeroRouter — Postgres schema (Supabase)
-- Translated from db/migrations.ts (0001_init, 0002_index_aliases_model,
-- 0003_owner_credential). Type-mapping policy:
--   * ms-epoch INTEGER timestamps → BIGINT (all Date.now() logic unchanged)
--   * 0/1 INTEGER booleans       → SMALLINT with the same CHECKs (repo logic unchanged)
--   * AUTOINCREMENT              → GENERATED ALWAYS AS IDENTITY
--   * JSON columns stay TEXT     (repos parse; JSONB is a later nicety)
-- When the code migration (docs/postgres-migration.md §2 Phase 2) lands, the
-- in-code migration runner should own this file's contents instead.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  enabled SMALLINT NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  base_url TEXT,
  auth_type TEXT NOT NULL DEFAULT 'bearer' CHECK (auth_type IN ('bearer','x_api_key','custom_header','none')),
  auth_header TEXT,
  credentials_enc TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  timeout_ms BIGINT NOT NULL DEFAULT 120000,
  retry_max INTEGER NOT NULL DEFAULT 1,
  test_status TEXT NOT NULL DEFAULT 'untested' CHECK (test_status IN ('untested','ok','failed')),
  test_message TEXT,
  last_test_at BIGINT,
  discovery_status TEXT NOT NULL DEFAULT 'untested' CHECK (discovery_status IN ('untested','connecting','discovering','completed','partial','failed','manual')),
  last_discovery TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  user_meta TEXT,
  context_length BIGINT,
  input_modalities TEXT,
  output_modalities TEXT,
  supported_parameters TEXT,
  streaming SMALLINT CHECK (streaming IS NULL OR streaming IN (0,1)),
  tools SMALLINT CHECK (tools IS NULL OR tools IN (0,1)),
  reasoning SMALLINT CHECK (reasoning IS NULL OR reasoning IN (0,1)),
  pricing TEXT,
  status TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('verified','untested','error','unknown')),
  source TEXT NOT NULL DEFAULT 'discovered' CHECK (source IN ('discovered','manual')),
  meta TEXT,
  last_seen_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (provider_id, upstream_id)
);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);

CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  enabled SMALLINT NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  params_json TEXT,
  fallbacks_json TEXT,
  notes TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_model ON aliases(provider_id, model);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT,
  last_used_at BIGINT
);

CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  ts BIGINT NOT NULL,
  source TEXT NOT NULL DEFAULT 'gateway' CHECK (source IN ('gateway','playground','admin','discovery','connection_test')),
  client_key_id TEXT,
  provider_id TEXT,
  provider_name TEXT,
  model TEXT,
  alias TEXT,
  stream SMALLINT NOT NULL DEFAULT 0 CHECK (stream IN (0,1)),
  status INTEGER NOT NULL,
  duration_ms BIGINT,
  prompt_tokens BIGINT,
  completion_tokens BIGINT,
  error_code TEXT,
  error_message TEXT,
  body_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON request_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_provider ON request_logs(provider_id);
CREATE INDEX IF NOT EXISTS idx_logs_status ON request_logs(status);

CREATE TABLE IF NOT EXISTS provider_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connection_test','discovery','enable','disable','credentials','auth_issue')),
  status TEXT,
  message TEXT,
  latency_ms BIGINT
);
CREATE INDEX IF NOT EXISTS idx_provider_events ON provider_events(provider_id, ts DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_throttle (
  key_hash TEXT PRIMARY KEY,
  attempt_window_start BIGINT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_window_start BIGINT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until BIGINT NOT NULL DEFAULT 0
);
