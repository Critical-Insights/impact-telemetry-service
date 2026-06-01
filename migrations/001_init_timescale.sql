-- 001_init_timescale.sql
-- Initial schema for impact-telemetry-service (NICU monitoring POC).
-- Idempotent: safe to run multiple times.
--
-- hospital_id and device_id are parsed from the MQTT topic by the subscriber and
-- injected as columns (they are NOT present in the message payloads).

-- TimescaleDB is already enabled in Tiger Cloud Free; stated here for intent.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- 1. device_numerics — time-series of numeric metric samples (hypertable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_numerics (
  presentation_time   TIMESTAMPTZ      NOT NULL,
  hospital_id         TEXT             NOT NULL,
  device_id           TEXT             NOT NULL,
  metric_id           TEXT             NOT NULL,
  instance_id         INTEGER          NOT NULL DEFAULT 0,
  value               DOUBLE PRECISION,            -- nullable; quality may be lead_off / invalid
  unit_id             TEXT             NOT NULL,
  quality             TEXT             NOT NULL,
  vendor_metric_id    TEXT,
  device_time         TIMESTAMPTZ,
  gateway_id          TEXT,
  vendor              TEXT,
  protocol            TEXT,
  schema_version      TEXT             NOT NULL,
  received_at         TIMESTAMPTZ      NOT NULL DEFAULT now()
);

SELECT create_hypertable(
  'device_numerics',
  'presentation_time',
  chunk_time_interval => INTERVAL '1 week',
  if_not_exists => TRUE
);

-- Primary query path: HR/SpO2/etc for one device+metric over a time range.
CREATE INDEX IF NOT EXISTS device_numerics_device_metric_time_idx
  ON device_numerics (device_id, metric_id, presentation_time DESC);

-- Hospital-wide queries.
CREATE INDEX IF NOT EXISTS device_numerics_hospital_time_idx
  ON device_numerics (hospital_id, presentation_time DESC);

-- ---------------------------------------------------------------------------
-- 2. device_identities — one row per device, latest identity wins (regular table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_identities (
  device_id           TEXT PRIMARY KEY,
  hospital_id         TEXT NOT NULL,
  manufacturer        TEXT,
  model               TEXT,
  serial_number       TEXT,
  firmware_revision   TEXT,
  unique_device_identifier TEXT,
  gateway_id          TEXT,
  vendor              TEXT,
  protocol            TEXT,
  schema_version      TEXT,
  presentation_time   TIMESTAMPTZ,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Upserts happen via: INSERT ... ON CONFLICT (device_id) DO UPDATE.

-- ---------------------------------------------------------------------------
-- 3. device_connectivity_events — history of connectivity state changes (hypertable)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_connectivity_events (
  presentation_time   TIMESTAMPTZ NOT NULL,
  hospital_id         TEXT        NOT NULL,
  device_id           TEXT        NOT NULL,
  state               TEXT        NOT NULL,   -- Connected | Disconnected | Error
  type                TEXT,                    -- Network | Serial
  info                TEXT,
  gateway_id          TEXT,
  vendor              TEXT,
  protocol            TEXT,
  schema_version      TEXT,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

SELECT create_hypertable(
  'device_connectivity_events',
  'presentation_time',
  chunk_time_interval => INTERVAL '1 month',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS device_connectivity_events_device_time_idx
  ON device_connectivity_events (device_id, presentation_time DESC);

-- ---------------------------------------------------------------------------
-- 4. device_current_connectivity — latest connectivity state per device
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW device_current_connectivity AS
SELECT DISTINCT ON (device_id)
  device_id, hospital_id, state, type, info, presentation_time
FROM device_connectivity_events
ORDER BY device_id, presentation_time DESC;

-- ===========================================================================
-- DEFERRED — enable after POC.
-- ===========================================================================
-- TimescaleDB native compression and retention are intentionally left OFF for
-- the POC so we can freely inspect/mutate recent data. When ready to enable,
-- uncomment the blocks below (and tune the intervals).
--
-- Compression dramatically shrinks older chunks; retention drops chunks past a
-- cutoff. add_compression_policy / add_retention_policy are idempotent-ish but
-- should still be guarded if you script them — here they're just documentation.
--
-- -- device_numerics: compress chunks older than 7 days, drop older than 90 days.
-- ALTER TABLE device_numerics SET (
--   timescaledb.compress,
--   timescaledb.compress_segmentby = 'device_id, metric_id',
--   timescaledb.compress_orderby   = 'presentation_time DESC'
-- );
-- SELECT add_compression_policy('device_numerics', INTERVAL '7 days');
-- SELECT add_retention_policy('device_numerics', INTERVAL '90 days');
--
-- -- device_connectivity_events: compress older than 30 days, drop older than 1 year.
-- ALTER TABLE device_connectivity_events SET (
--   timescaledb.compress,
--   timescaledb.compress_segmentby = 'device_id',
--   timescaledb.compress_orderby   = 'presentation_time DESC'
-- );
-- SELECT add_compression_policy('device_connectivity_events', INTERVAL '30 days');
-- SELECT add_retention_policy('device_connectivity_events', INTERVAL '365 days');
