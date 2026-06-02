// Handles batched device observations — one multi-row INSERT into device_numerics.
import { pool } from '../db/timescale.js';
import { logger } from '../lib/logger.js';
import type { ParsedTopic } from '../mqtt/topic-parser.js';
import type { DeviceObservationBatch } from '../types/canonical.js';
import { postObservationToImpact } from '../impact/poster.js';
import { resolvePatientId } from '../impact/patient-resolver.js';

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

  const sql = `INSERT INTO device_numerics (${COLUMNS.join(', ')}) VALUES ${groups.join(', ')}`;
  await pool.query(sql, values);

  logger.debug(
    {
      device_id: parsed.device_id,
      bed_id: payload.bed_id,
      count: payload.observations.length,
    },
    'wrote observations',
  );

  try {
    const patientId = await resolvePatientId(parsed.device_id, parsed.hospital_id);
    const result = await postObservationToImpact(parsed.device_id, payload, patientId);

    if (result.kind === 'error') {
      logger.error({ device_id: parsed.device_id, result }, 'impact-poster: POST failed');
    } else {
      logger.info({ device_id: parsed.device_id, result }, 'impact-poster: result');
    }
  } catch (err) {
    logger.error(
      { device_id: parsed.device_id, err },
      'impact-poster: unexpected error (Timescale insert already succeeded)',
    );
  }
}
