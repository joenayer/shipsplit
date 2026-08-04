-- ShipSplit backend schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,      -- stored lowercased/trimmed
  pw_salt    TEXT NOT NULL,             -- base64
  pw_hash    TEXT NOT NULL,             -- base64, PBKDF2-SHA256
  iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- one-time recovery codes; only the hash is kept, so a DB leak cannot reveal a usable code
CREATE TABLE IF NOT EXISTS recovery_codes (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at   INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the opaque cookie value
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- plan.data holds the EXACT JSON the client already uses, so no client data migration is needed
CREATE TABLE IF NOT EXISTS plans (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,                   -- soft delete; replaces the __deleted__ tombstone map
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_user_name ON plans(user_id, name);

-- failed sign-in attempts, for back-off
CREATE TABLE IF NOT EXISTS login_attempts (
  id      TEXT PRIMARY KEY,
  key     TEXT NOT NULL,                -- "email:<addr>" or "ip:<addr>"
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_key ON login_attempts(key, at);
