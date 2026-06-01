// Parses MQTT topics into a typed, structured form.
// hospital_id and device_id live in the TOPIC (the ACL boundary), not the payload.
import { logger } from '../lib/logger.js';

export type ParsedTopic =
  | { kind: 'observations'; hospital_id: string; device_id: string }
  | { kind: 'identity'; hospital_id: string; device_id: string }
  | { kind: 'connectivity'; hospital_id: string; device_id: string };

const LEAVES = new Set(['observations', 'identity', 'connectivity'] as const);

// Matches:
//   hospitals/{hospital_id}/devices/{device_id}/observations
//   hospitals/{hospital_id}/devices/{device_id}/identity
//   hospitals/{hospital_id}/devices/{device_id}/connectivity
// device_id may contain hyphens (e.g. "sim-bcch-bed-01-philips-monitor"); split
// on '/' treats each segment as [^/]+, so hyphens are fine.
export function parseTopic(topic: string): ParsedTopic | null {
  const parts = topic.split('/');

  if (parts.length !== 5 || parts[0] !== 'hospitals' || parts[2] !== 'devices') {
    logger.debug({ topic }, 'unrecognized topic (shape)');
    return null;
  }

  const hospital_id = parts[1];
  const device_id = parts[3];
  const leaf = parts[4];

  if (!hospital_id || !device_id || !leaf || !LEAVES.has(leaf as never)) {
    logger.debug({ topic }, 'unrecognized topic (segment/leaf)');
    return null;
  }

  return {
    kind: leaf as 'observations' | 'identity' | 'connectivity',
    hospital_id,
    device_id,
  };
}
