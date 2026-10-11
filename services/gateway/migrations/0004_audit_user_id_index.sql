-- 0004_audit_user_id_index: the audit log API (docs/architecture.md, decision 38).
-- Adds one index and nothing else. No row is read, changed or rewritten. Rollback: DROP INDEX audit_log_user_id_idx;

-- The API pages by id (newest first), and a member's query always has "user_id = $caller". The older index
-- audit_log_user_ts_idx (user_id, ts DESC) cannot serve an order by id.
CREATE INDEX audit_log_user_id_idx ON audit_log (user_id, id DESC);
