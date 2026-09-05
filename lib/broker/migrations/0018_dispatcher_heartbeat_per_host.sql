-- B9.1 — per-machine heartbeat, not one row for the whole install.
--
-- The single-row form (0008) answers "is *a* dispatcher alive," never "is
-- *this named machine's* dispatcher alive" — a real gap now that more than
-- one machine can dispatch (`runtime_profiles.host_id`, `claimNextRun`).
-- Keyed by host_id instead: one row per machine, upserted on every tick from
-- that machine (`currentHostId()`), read individually or in bulk.
--
-- Dropped and recreated rather than migrated column-by-column: 0008's own
-- header already states the design intent — "not a log table... nobody
-- needs tick history" — so the single existing row is disposable
-- bookkeeping, fully repopulated within seconds of the next tick from any
-- machine. Nothing here is worth a careful in-place migration.
DROP TABLE IF EXISTS dispatcher_heartbeat;

CREATE TABLE dispatcher_heartbeat (
  host_id      TEXT PRIMARY KEY,
  last_tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  worker_id    TEXT
);
