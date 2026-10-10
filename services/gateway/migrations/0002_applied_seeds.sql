-- 0002_applied_seeds: remembers which install-time seeds have been applied (docs/architecture.md, decision 31).
-- Without it, "insert if the row is missing" would create a seeded server again after an admin removed it.
-- A row here means the seed with this slug was applied once. It is never deleted, so a removed server stays removed.
CREATE TABLE applied_seeds (
  slug       text        PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9-]{0,19}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);
