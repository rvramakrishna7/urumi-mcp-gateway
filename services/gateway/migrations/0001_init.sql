-- 0001_init: the first schema of the gateway (docs/architecture.md, decisions 2 to 5).
-- Migrations are forward only and run each in one transaction. A file that has been applied is never edited:
-- a change is a new file. Dashboard sessions (login) get their own table in a later migration, with Step 10.

-- ---------------------------------------------------------------------------------------------------------
-- users: people who can sign in to the dashboard and who own API keys.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE users (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text        NOT NULL,
  role              text        NOT NULL CHECK (role IN ('admin', 'member')),
  -- invited: the invite link was made and not used yet. active: can sign in. disabled: cannot sign in, keys stop working.
  status            text        NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  -- A slow password hash (decision 3). Null until the invite is accepted.
  password_hash     text,
  -- SHA-256 of the one-time invite token. The token itself is shown once and never stored.
  invite_token_hash bytea       CHECK (invite_token_hash IS NULL OR octet_length(invite_token_hash) = 32),
  invite_expires_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        REFERENCES users (id) ON DELETE SET NULL,
  disabled_at       timestamptz,
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_email_shape CHECK (position('@' IN email) > 1 AND length(email) <= 254),
  CONSTRAINT users_invite_pair CHECK ((invite_token_hash IS NULL) = (invite_expires_at IS NULL))
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE UNIQUE INDEX users_invite_token_hash_key ON users (invite_token_hash) WHERE invite_token_hash IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------
-- api_keys: the keys of MCP clients (decision 4). Only the SHA-256 hash is stored.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE api_keys (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- The first characters of the key, so that a person can tell their keys apart. Not enough to use the key.
  key_prefix   text        NOT NULL CHECK (length(key_prefix) BETWEEN 4 AND 16),
  key_hash     bytea       NOT NULL CHECK (octet_length(key_hash) = 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  -- A revoked key is rejected on the next request. The row stays, so the audit log can still name the key.
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX api_keys_key_hash_key ON api_keys (key_hash);
CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);

-- ---------------------------------------------------------------------------------------------------------
-- upstream_servers: the registry of upstream MCP servers.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE upstream_servers (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Part of every exposed tool name: <slug>__<tool> (decision 5). It has no underscore, so the first "__" in an
  -- exposed name can only be the separator. It is never changed after creation, so tool names stay stable.
  slug                  text        NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{0,19}$'),
  name                  text        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  -- The database only checks the basic shape. The application validates the address (no credentials in the URL).
  url                   text        NOT NULL CHECK (url ~ '^https?://[^[:space:]]+$' AND length(url) <= 2048),
  -- "Disabled" in the dashboard is enabled = false. It is not stored as a status.
  enabled               boolean     NOT NULL DEFAULT true,
  call_timeout_ms       integer     NOT NULL DEFAULT 30000 CHECK (call_timeout_ms BETWEEN 1000 AND 120000),

  -- Optional static credential, encrypted with AES-256-GCM before it reaches this table. The three columns
  -- ciphertext, nonce and key id belong together, and the list queries of the application never select them.
  credential_kind       text        CHECK (credential_kind IN ('bearer', 'header')),
  credential_header     text        CHECK (credential_header ~ '^[A-Za-z0-9-]{1,64}$'),
  credential_ciphertext bytea,
  credential_nonce      bytea       CHECK (credential_nonce IS NULL OR octet_length(credential_nonce) = 12),
  credential_key_id     text        CHECK (credential_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  credential_updated_at timestamptz,
  CONSTRAINT upstream_servers_credential_complete CHECK (
    (credential_kind IS NULL AND credential_header IS NULL AND credential_ciphertext IS NULL
       AND credential_nonce IS NULL AND credential_key_id IS NULL AND credential_updated_at IS NULL)
    OR
    (credential_kind IS NOT NULL AND credential_ciphertext IS NOT NULL AND credential_nonce IS NOT NULL
       AND credential_key_id IS NOT NULL AND credential_updated_at IS NOT NULL)
  ),
  -- A header credential names its header. A bearer credential always uses Authorization.
  CONSTRAINT upstream_servers_credential_header_rule CHECK ((credential_kind = 'header') = (credential_header IS NOT NULL)),

  -- The result of the last probe or call. Connected, Unreachable or not known yet.
  status                text        NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'connected', 'unreachable')),
  status_reason         text        CHECK (length(status_reason) <= 500),
  status_checked_at     timestamptz,
  last_success_at       timestamptz,

  -- True for a row that the install created from the Helm values. While true, the install keeps its URL and
  -- credential in step with the values. An edit by an admin sets it to false (Step 8c).
  seed_managed          boolean     NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        REFERENCES users (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX upstream_servers_slug_key ON upstream_servers (slug);

-- ---------------------------------------------------------------------------------------------------------
-- upstream_tools: the cached tool list of each upstream, refreshed by the poller (Step 8d).
-- Names and descriptions come from the upstream and are untrusted: the application validates the name, caps and
-- cleans the description, and keeps a hash of it.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE upstream_tools (
  server_id        uuid        NOT NULL REFERENCES upstream_servers (id) ON DELETE CASCADE,
  -- The name as the upstream calls it. The exposed name is <slug>__<name>.
  name             text        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description      text        NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  input_schema     jsonb       NOT NULL DEFAULT '{"type": "object"}'::jsonb,
  annotations      jsonb,
  -- SHA-256 of the description as received, to notice when an upstream changes it later.
  description_hash bytea       CHECK (description_hash IS NULL OR octet_length(description_hash) = 32),
  -- Null: the tool is exposed. Otherwise the reason it is not (for example an invalid name, or a name that is too long).
  skipped_reason   text        CHECK (length(skipped_reason) <= 200),
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, name)
);

-- ---------------------------------------------------------------------------------------------------------
-- audit_log: every tool call, from an MCP client or from the chat agent (decision 1b).
-- Two phases: the row is inserted before the upstream is called, with the outcome "started", and updated when the
-- call ends. If the insert fails, the call is not made. No tool call runs without a row.
-- Arguments and results are never stored: they can hold customer data.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE audit_log (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- When the call started (the time of the insert).
  ts             timestamptz NOT NULL DEFAULT now(),
  -- The user and the server are copied as text, so the row still names them after they are deleted.
  user_id        uuid        REFERENCES users (id) ON DELETE SET NULL,
  user_email     text        NOT NULL,
  server_id      uuid        REFERENCES upstream_servers (id) ON DELETE SET NULL,
  server_slug    text,
  -- The name the caller used (<slug>__<tool>), cut to 200 characters, and the tool as the upstream calls it.
  requested_name text        NOT NULL CHECK (length(requested_name) <= 200),
  tool           text        CHECK (length(tool) <= 200),
  outcome        text        NOT NULL DEFAULT 'started' CHECK (outcome IN (
                   'started',       -- phase 1: inserted, the call has not ended
                   'ok',            -- the upstream answered and the tool succeeded
                   'error',         -- the upstream answered with a tool error
                   'timeout',       -- the upstream did not answer in time
                   'unreachable',   -- the upstream could not be reached
                   'unknown_tool',  -- no enabled, reachable server has this tool
                   'denied',        -- the user may not call this tool
                   'interrupted'    -- the gateway stopped before the call ended (set by a later sweep of old "started" rows)
                 )),
  -- A short code that says why a call failed, for example the kind of error. Never a message from the upstream.
  error_kind     text        CHECK (length(error_kind) <= 50),
  -- Phase 2 sets these three together.
  finished_at    timestamptz,
  duration_ms    integer     CHECK (duration_ms >= 0),
  via            text        NOT NULL CHECK (via IN ('mcp', 'chat')),
  request_id     uuid        NOT NULL,
  CONSTRAINT audit_log_two_phase CHECK (
    (outcome = 'started' AND finished_at IS NULL AND duration_ms IS NULL)
    OR
    (outcome <> 'started' AND finished_at IS NOT NULL AND duration_ms IS NOT NULL)
  )
);
CREATE INDEX audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX audit_log_user_ts_idx ON audit_log (user_id, ts DESC);
-- Finds calls that never ended, cheaply.
CREATE INDEX audit_log_started_idx ON audit_log (ts) WHERE outcome = 'started';
