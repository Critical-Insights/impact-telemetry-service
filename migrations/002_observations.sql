-- 002_observations.sql
-- Batched device-observation contract: add bed/hospital-unit/simulated context
-- to the three telemetry tables. Idempotent (ADD COLUMN IF NOT EXISTS).
--
-- Naming note: the batch envelope's `unit_id` is the *hospital* unit ("nicu"/"picu"),
-- which collides with the per-observation `unit_id` (MDC measurement unit code,
-- e.g. NOM_DIM_PERCENT). We keep device_numerics.unit_id meaning the MDC unit and
-- store the hospital unit in a new `hospital_unit` column to avoid the collision.

-- device_numerics
ALTER TABLE device_numerics ADD COLUMN IF NOT EXISTS bed_id TEXT;
ALTER TABLE device_numerics ADD COLUMN IF NOT EXISTS hospital_unit TEXT;
ALTER TABLE device_numerics ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS device_numerics_bed_id_idx
  ON device_numerics (bed_id, presentation_time DESC);

-- device_identities
ALTER TABLE device_identities ADD COLUMN IF NOT EXISTS bed_id TEXT;
ALTER TABLE device_identities ADD COLUMN IF NOT EXISTS hospital_unit TEXT;
ALTER TABLE device_identities ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT FALSE;

-- device_connectivity_events
ALTER TABLE device_connectivity_events ADD COLUMN IF NOT EXISTS bed_id TEXT;
ALTER TABLE device_connectivity_events ADD COLUMN IF NOT EXISTS hospital_unit TEXT;
ALTER TABLE device_connectivity_events ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT FALSE;
