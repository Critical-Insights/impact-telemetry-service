// Routes a raw MQTT message to the appropriate handler.
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { parseTopic } from '../mqtt/topic-parser.js';
import {
  parseSchema2Topic,
  resolveIdentity,
  normaliseSchema2Body,
  warnSchema2Seen,
} from '../mqtt/schema2-shim.js';
import { recordRefusal } from '../impact/ingest-health.js';
import {
  DeviceObservationBatchSchema,
  DeviceIdentityMessageSchema,
  DeviceConnectivityMessageSchema,
} from '../types/canonical.js';
import { handleObservations } from './observations.js';
import { handleIdentity } from './identity.js';
import { handleConnectivity } from './connectivity.js';

// Maps a parsed topic kind to its expected payload message_type.
const EXPECTED_MESSAGE_TYPE = {
  observations: 'DeviceObservationBatch',
  identity: 'DeviceIdentity',
  connectivity: 'DeviceConnectivity',
} as const;

export async function routeMessage(topic: string, raw: Buffer): Promise<void> {
  let parsed = parseTopic(topic);

  // ── DEMO SHIM: schema 2.0 (see src/mqtt/schema2-shim.ts) ─────────────────
  // A 2.0 topic has 7 segments, so the 1.0 parser returns null for it. Detect
  // that BEFORE giving up, because dropping these silently at debug level is
  // precisely why the feed has looked dead.
  const s2 = parsed === null ? parseSchema2Topic(topic) : null;
  let schema2Identity: { trinityCode: string; hospitalId: string } | null = null;

  if (s2 !== null) {
    if (!config.SCHEMA2_SHIM_ENABLED) {
      warnSchema2Seen(topic);
      return;
    }
    const identity = resolveIdentity(s2);
    if (!identity.ok) {
      // REFUSE LOUDLY. An unrecognised device is never relabelled into a
      // tenant — it is reported, with the device id that was rejected.
      recordRefusal(s2.deviceId, identity.reason, identity.detail);
      return;
    }
    schema2Identity = { trinityCode: identity.trinityCode, hospitalId: identity.hospitalId };
    parsed = {
      kind: s2.leaf as 'observations' | 'identity' | 'connectivity',
      hospital_id: identity.hospitalId,
      device_id: identity.trinityCode,
    };
  }

  if (parsed === null) {
    // parseTopic already logged at debug.
    return;
  }

  // Parse JSON.
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    logger.error({ topic, err }, 'failed to parse message JSON');
    return;
  }

  // Normalise a 2.0 body into the 1.0 shape before the union validates it.
  if (s2 !== null && schema2Identity !== null && typeof json === 'object' && json !== null) {
    json = normaliseSchema2Body(json as Record<string, unknown>, schema2Identity, s2);
  }

  // Topic kind must agree with payload message_type before we trust the union.
  const messageType =
    typeof json === 'object' && json !== null
      ? (json as { message_type?: unknown }).message_type
      : undefined;
  if (messageType !== EXPECTED_MESSAGE_TYPE[parsed.kind]) {
    logger.warn(
      {
        topic,
        topic_kind: parsed.kind,
        expected: EXPECTED_MESSAGE_TYPE[parsed.kind],
        got: messageType,
      },
      'topic/message_type mismatch; skipping',
    );
    return;
  }

  try {
    switch (parsed.kind) {
      case 'observations': {
        const payload = DeviceObservationBatchSchema.parse(json);
        await handleObservations(parsed, payload);
        break;
      }
      case 'identity': {
        const payload = DeviceIdentityMessageSchema.parse(json);
        await handleIdentity(parsed, payload);
        break;
      }
      case 'connectivity': {
        const payload = DeviceConnectivityMessageSchema.parse(json);
        await handleConnectivity(parsed, payload);
        break;
      }
    }
  } catch (err) {
    // One bad message must never kill the subscriber.
    logger.error(
      { topic, message_type: EXPECTED_MESSAGE_TYPE[parsed.kind], err },
      'handler failed for message',
    );
  }
}
