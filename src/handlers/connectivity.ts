// Handles device connectivity events — append-on-change into
// device_connectivity_events, idempotent against retained-message replay.
import { config } from '../config.js';
import { getPool } from '../db/timescale.js';
import { logger } from '../lib/logger.js';
import type { ParsedTopic } from '../mqtt/topic-parser.js';
import type { DeviceConnectivityMessage } from '../types/canonical.js';

type ConnectivityTopic = Extract<ParsedTopic, { kind: 'connectivity' }>;

const LATEST_SQL = `
  SELECT state, type, info, presentation_time
  FROM device_connectivity_events
  WHERE device_id = $1
  ORDER BY presentation_time DESC
  LIMIT 1
`;

const INSERT_SQL = `
  INSERT INTO device_connectivity_events (
    presentation_time, hospital_id, device_id, state, type, info,
    gateway_id, vendor, protocol, schema_version
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`;

interface LatestRow {
  state: string;
  type: string | null;
  info: string | null;
  presentation_time: Date;
}

export async function handleConnectivity(
  parsed: ConnectivityTopic,
  payload: DeviceConnectivityMessage,
): Promise<void> {
  // Timescale-only handler: nothing downstream consumes it, so with the
  // provenance store disabled there is no work to do.
  if (!config.TIMESCALE_ENABLED) return;

  if (payload.unique_device_identifier !== parsed.device_id) {
    logger.warn(
      {
        topic_device_id: parsed.device_id,
        payload_udi: payload.unique_device_identifier,
      },
      'device_id mismatch between topic and payload; trusting topic',
    );
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<LatestRow>(LATEST_SQL, [
      parsed.device_id,
    ]);
    const latest = rows[0];

    const newTime = new Date(payload.presentation_time);
    const sameState =
      latest !== undefined &&
      latest.state === payload.state &&
      (latest.type ?? null) === (payload.type ?? null) &&
      (latest.info ?? null) === (payload.info ?? null);

    // device_connectivity_events is a change-only log. Skip when the state is
    // unchanged (covers retained-message replay — same payload, equal/older time),
    // and skip a differing message that is older than what we already have
    // (a stale out-of-order replay). Only a genuine forward transition inserts.
    const isForwardTransition =
      latest === undefined ||
      (!sameState && newTime.getTime() > latest.presentation_time.getTime());

    if (!isForwardTransition) {
      await client.query('COMMIT');
      logger.debug(
        { device_id: parsed.device_id, state: payload.state, sameState },
        'skipped connectivity event (no forward state change)',
      );
      return;
    }

    await client.query(INSERT_SQL, [
      payload.presentation_time,
      parsed.hospital_id,
      parsed.device_id,
      payload.state,
      payload.type ?? null,
      payload.info ?? null,
      payload.gateway_id ?? null,
      payload.vendor ?? null,
      payload.protocol ?? null,
      payload.schema_version,
    ]);

    await client.query('COMMIT');

    logger.debug(
      { device_id: parsed.device_id, state: payload.state },
      'wrote connectivity',
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
