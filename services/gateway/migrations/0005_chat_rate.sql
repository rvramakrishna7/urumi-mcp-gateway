-- 0005_chat_rate: the per-user rate limit of the chat agent (docs/architecture.md, decision 40).
-- Adds one table and nothing else. No existing row is read, changed or rewritten.
-- Rollback: DROP TABLE chat_rate; (it holds only counters that are at most one minute old).

-- One row per user, a fixed window. The row is created or updated by one INSERT ... ON CONFLICT DO UPDATE, which locks
-- the row, so parallel requests of one user are counted one after the other and the bound is exact.
CREATE TABLE chat_rate (
  user_id      uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL DEFAULT now(),
  -- Requests counted in the window, including the refused ones; it is never raised above the cap plus one.
  count        integer     NOT NULL CHECK (count >= 1)
);
