// Handles device identity messages — upsert latest-wins into device_identities.
import { pool } from '../db/timescale.js';
import { logger } from '../lib/logger.js';
import type { ParsedTopic } from '../mqtt/topic-parser.js';
import type { DeviceIdentityMessage } from '../types/canonical.js';

type IdentityTopic = Extract<ParsedTopic, { kind: 'identity' }>;

// The WHERE guard stops an older retained message (replayed on reconnect) from
// clobbering newer identity state.
const UPSERT_SQL = `
  INSERT INTO device_identities (
    device_id, hospital_id, manufacturer, model, serial_number,
    firmware_revision, vendor, protocol, gateway_id, presentation_time,
    unique_device_identifier, schema_version
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
  ON CONFLICT (device_id) DO UPDATE SET
    hospital_id = EXCLUDED.hospital_id,
    manufacturer = EXCLUDED.manufacturer,
    model = EXCLUDED.model,
    serial_number = EXCLUDED.serial_number,
    firmware_revision = EXCLUDED.firmware_revision,
    vendor = EXCLUDED.vendor,
    protocol = EXCLUDED.protocol,
    gateway_id = EXCLUDED.gateway_id,
    presentation_time = EXCLUDED.presentation_time,
    unique_device_identifier = EXCLUDED.unique_device_identifier,
    schema_version = EXCLUDED.schema_version,
    received_at = now()
  WHERE EXCLUDED.presentation_time >= device_identities.presentation_time
`;

export async function handleIdentity(
  parsed: IdentityTopic,
  payload: DeviceIdentityMessage,
): Promise<void> {
  if (payload.unique_device_identifier !== parsed.device_id) {
    logger.warn(
      {
        topic_device_id: parsed.device_id,
        payload_udi: payload.unique_device_identifier,
      },
      'device_id mismatch between topic and payload; trusting topic',
    );
  }

  await pool.query(UPSERT_SQL, [
    parsed.device_id,
    parsed.hospital_id,
    payload.manufacturer ?? null,
    payload.model ?? null,
    payload.serial_number ?? null,
    payload.firmware_revision ?? null,
    payload.vendor ?? null,
    payload.protocol ?? null,
    payload.gateway_id ?? null,
    payload.presentation_time,
    payload.unique_device_identifier,
    payload.schema_version,
  ]);

  logger.debug(
    { device_id: parsed.device_id, model: payload.model },
    'wrote identity',
  );
}
