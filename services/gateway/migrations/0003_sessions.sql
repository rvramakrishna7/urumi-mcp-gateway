-- 0003_sessions: dashboard login (docs/architecture.md, decisions 35 and 36).
-- Adds two tables and one nullable column. No existing row is changed and no existing table is rewritten.

-- ---------------------------------------------------------------------------------------------------------
-- sessions: one row per signed-in browser. The cookie holds 32 random bytes; only their SHA-256 is stored here, the
-- same as for API keys. Deleting the row (logout, user disabled, new invite) ends the session at once.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE sessions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   bytea       NOT NULL CHECK (octet_length(token_hash) = 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The idle limit is measured from here. The application writes it at most once a minute.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- The absolute limit. The application sets it when the session is created.
  expires_at   timestamptz NOT NULL,
  CONSTRAINT sessions_expiry_order CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------------------------------------
-- login_throttle: failed logins per key, so that guessing a password is slowed down. The key is the SHA-256 of
-- "email:<address>" (an unknown address is counted too, so the table does not tell which emails exist). Nothing in
-- this table can be turned back into an email.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE login_throttle (
  key_hash          bytea       PRIMARY KEY CHECK (octet_length(key_hash) = 32),
  failures          integer     NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  -- While this time is in the future, the key may not log in, even with a correct password.
  locked_until      timestamptz
);

-- When the user last signed in with a password. Null for a user who never did. Shown to admins.
ALTER TABLE users ADD COLUMN last_login_at timestamptz;
