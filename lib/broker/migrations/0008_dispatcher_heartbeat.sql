-- R3.3 — dispatcher supervision.
--
-- One row, forever. The dispatcher is a single manually started loop, and
-- when it stops nothing reports it: runs stay `queued` and the UI waits on
-- an answer that will never come. A heartbeat is the smallest thing that
-- makes "idle" distinguishable from "dead".
--
-- Deliberately not a log table. Nobody needs tick history, and writing a row
-- every three seconds forever to answer one question would be a storage leak
-- dressed up as observability.
CREATE TABLE IF NOT EXISTS dispatcher_heartbeat (
  id           SMALLINT PRIMARY KEY DEFAULT 1,
  last_tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  worker_id    TEXT,
  CONSTRAINT dispatcher_heartbeat_single_row CHECK (id = 1)
);
