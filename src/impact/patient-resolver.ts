import { logger } from '../lib/logger.js';

/**
 * Resolve a device's trinity_code (Arman's MQTT device ID) to its currently
 * assigned IMPACT patient_id.
 *
 * STUB: this returns null and logs a warning. The real implementation lands
 * in Prompt 8 — it will call IMPACT's GET /api/v1/devices/:trinity_code/patient
 * endpoint with a short TTL cache.
 *
 * Returning null is the signal to the poster that this batch should be
 * skipped without erroring.
 */
export async function resolvePatientId(
  trinityCode: string,
  hospitalId: string,
): Promise<string | null> {
  logger.warn(
    { trinity_code: trinityCode, hospital_id: hospitalId },
    'patient resolver not yet wired — returning null',
  );
  return null;
}
