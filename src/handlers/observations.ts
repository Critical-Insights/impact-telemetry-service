// Handles batched device observations — one multi-row INSERT into device_numerics.
import { config } from '../config.js';
import { getPool } from '../db/timescale.js';
import { logger } from '../lib/logger.js';
import type { ParsedTopic } from '../mqtt/topic-parser.js';
import type { DeviceObservationBatch } from '../types/canonical.js';
import { postObservationToImpact } from '../impact/poster.js';
import { resolvePatientId } from '../impact/patient-resolver.js';
import { record as recordIngestHealth } from '../impact/ingest-health.js';

type ObservationsTopic = Extract<ParsedTopic, { kind: 'observations' }>;

// Columns written per observation row, in order.
const COLUMNS = [
  'presentation_time',
  'hospital_id',
  'device_id',
  'metric_id',
  'instance_id',
  'value',
  'unit_id',
  'quality',
  'vendor_metric_id',
  'device_time',
  'gateway_id',
  'vendor',
  'protocol',
  'schema_version',
  'bed_id',
  'hospital_unit',
  'simulated',
];
const COLS = COLUMNS.length;

export async function handleObservations(
  parsed: ObservationsTopic,
  payload: DeviceObservationBatch,
): Promise<void> {
  // The topic is the ACL boundary; trust it over the payload but flag drift.
  if (payload.unique_device_identifier !== parsed.device_id) {
    logger.warn(
      {
        topic_device_id: parsed.device_id,
        payload_udi: payload.unique_device_identifier,
      },
      'device_id mismatch between topic and payload; trusting topic',
    );
  }

  const values: unknown[] = [];
  const groups: string[] = [];

  payload.observations.forEach((obs, i) => {
    const base = i * COLS;
    const placeholders = Array.from(
      { length: COLS },
      (_, j) => `$${base + j + 1}`,
    );
    groups.push(`(${placeholders.join(', ')})`);
    values.push(
      payload.presentation_time,
      parsed.hospital_id,
      parsed.device_id,
      obs.metric_id,
      obs.instance_id,
      obs.value,
      obs.unit_id, // MDC measurement unit code
      obs.quality,
      obs.vendor_metric_id ?? null,
      obs.device_time ?? null,
      payload.gateway_id ?? null,
      payload.vendor ?? null,
      payload.protocol ?? null,
      payload.schema_version,
      payload.bed_id ?? null,
      payload.unit_id ?? null, // hospital unit -> hospital_unit
      payload.simulated,
    );
  });

  // Timescale is the provenance sink and is optional (TIMESCALE_ENABLED). When
  // it is off we skip the write entirely rather than catching a failure per
  // batch — at 1 Hz across 7 beds that would be ~840 error lines a minute,
  // which is its own kind of silence. The decision is made once, at startup.
  if (config.TIMESCALE_ENABLED) {
    const sql = `INSERT INTO device_numerics (${COLUMNS.join(', ')}) VALUES ${groups.join(', ')}`;
    await getPool().query(sql, values);

    logger.debug(
      {
        device_id: parsed.device_id,
        bed_id: payload.bed_id,
        count: payload.observations.length,
      },
      'wrote observations',
    );
  }

  try {
    const patientId = await resolvePatientId(parsed.device_id, parsed.hospital_id);
    const result = await postObservationToImpact(parsed.device_id, payload, patientId);

    // Every outcome goes through the health tracker, which owns escalation.
    // The Timescale insert above has already succeeded at this point, so a
    // device can be perfectly healthy by row count and still be landing
    // nothing the engine can read — `landed` is the only signal that
    // distinguishes those, and it is why this is not just a status check.
    const verdict = recordIngestHealth(parsed.device_id, result);

    if (result.kind === 'error') {
      logger.error({ device_id: parsed.device_id, result }, 'impact-poster: POST failed');
    } else if (!verdict.landed) {
      // Not an error yet — one skipped batch is normal (an unassigned bed, a
      // batch of waveforms). Sustained, it escalates from inside the tracker.
      logger.warn(
        { device_id: parsed.device_id, cause: verdict.cause, detail: verdict.detail },
        'impact-poster: batch did NOT land in Supabase',
      );
    } else {
      logger.info({ device_id: parsed.device_id, result }, 'impact-poster: result');
    }
  } catch (err) {
    logger.error(
      { device_id: parsed.device_id, err },
      'impact-poster: unexpected error (any Timescale write already succeeded)',
    );
  }
}
