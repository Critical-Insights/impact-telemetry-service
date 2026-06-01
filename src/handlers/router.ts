// Routes a raw MQTT message to the appropriate handler.
import { logger } from '../lib/logger.js';
import { parseTopic } from '../mqtt/topic-parser.js';
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
  const parsed = parseTopic(topic);
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
