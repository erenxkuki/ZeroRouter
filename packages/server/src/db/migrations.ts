/**
 * Forward-only migrations. Each entry runs exactly once inside a transaction.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001_init',
    sql: `
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  adapter TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  base_url TEXT,
  auth_type TEXT NOT NULL DEFAULT 'bearer' CHECK (auth_type IN ('bearer','x_api_key','custom_header','none')),
  auth_header TEXT,
  credentials_enc TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  timeout_ms INTEGER NOT NULL DEFAULT 120000,
  retry_max INTEGER NOT NULL DEFAULT 1,
  test_status TEXT NOT NULL DEFAULT 'untested' CHECK (test_status IN ('untested','ok','failed')),
  test_message TEXT,
  last_test_at INTEGER,
  discovery_status TEXT NOT NULL DEFAULT 'untested' CHECK (discovery_status IN ('untested','connecting','discovering','completed','partial','failed','manual')),
  last_discovery TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE models (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  user_meta TEXT,
  context_length INTEGER,
  input_modalities TEXT,
  output_modalities TEXT,
  supported_parameters TEXT,
  streaming INTEGER CHECK (streaming IS NULL OR streaming IN (0,1)),
  tools INTEGER CHECK (tools IS NULL OR tools IN (0,1)),
  reasoning INTEGER CHECK (reasoning IS NULL OR reasoning IN (0,1)),
  pricing TEXT,
  status TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('verified','untested','error','unknown')),
  source TEXT NOT NULL DEFAULT 'discovered' CHECK (source IN ('discovered','manual')),
  meta TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, upstream_id)
);
CREATE INDEX idx_models_provider ON models(provider_id);

CREATE TABLE aliases (
  alias TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  params_json TEXT,
  fallbacks_json TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

CREATE TABLE request_logs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'gateway' CHECK (source IN ('gateway','playground','admin','discovery','connection_test')),
  client_key_id TEXT,
  provider_id TEXT,
  provider_name TEXT,
  model TEXT,
  alias TEXT,
  stream INTEGER NOT NULL DEFAULT 0 CHECK (stream IN (0,1)),
  status INTEGER NOT NULL,
  duration_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  error_code TEXT,
  error_message TEXT,
  body_json TEXT
);
CREATE INDEX idx_logs_ts ON request_logs(ts DESC);
CREATE INDEX idx_logs_provider ON request_logs(provider_id);
CREATE INDEX idx_logs_status ON request_logs(status);

CREATE TABLE provider_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connection_test','discovery','enable','disable','credentials','auth_issue')),
  status TEXT,
  message TEXT,
  latency_ms INTEGER
);
CREATE INDEX idx_provider_events ON provider_events(provider_id, ts DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`,
  },
  {
    id: '0002_index_aliases_model',
    sql: `
CREATE INDEX idx_aliases_model ON aliases(provider_id, model);
`,
  },
  {
    // Owner dashboard credential (single row, scrypt-hashed) + login abuse
    // counters. Provisioned via the owner CLI, never over HTTP.
    id: '0003_owner_credential',
    sql: `
CREATE TABLE owner_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE login_throttle (
  key_hash TEXT PRIMARY KEY,
  attempt_window_start INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_window_start INTEGER NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0
);
`,
  },
];
