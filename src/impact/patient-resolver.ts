import { config } from '../config.js';
import { logger } from '../lib/logger.js';

type CacheEntry = {
  patientId: string | null;
  expiresAt: number; // ms epoch
};

const cache = new Map<string, CacheEntry>();

const TTL_HIT_MS = 60_000; // resolved patient lookup
const TTL_MISS_MS = 30_000; // 404 / no assignment

function cacheKey(trinityCode: string, hospitalId: string): string {
  return `${hospitalId}:${trinityCode}`;
}

function getCached(trinityCode: string, hospitalId: string): CacheEntry | null {
  const entry = cache.get(cacheKey(trinityCode, hospitalId));
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(cacheKey(trinityCode, hospitalId));
    return null;
  }
  return entry;
}

function setCache(
  trinityCode: string,
  hospitalId: string,
  patientId: string | null,
): void {
  const ttl = patientId === null ? TTL_MISS_MS : TTL_HIT_MS;
  cache.set(cacheKey(trinityCode, hospitalId), {
    patientId,
    expiresAt: Date.now() + ttl,
  });
}

/**
 * Resolve a device's trinity_code to its currently assigned IMPACT patient_id.
 *
 * Calls IMPACT's GET /api/v1/devices/:trinity_code/patient endpoint with
 * short-TTL in-memory caching. Returns null on:
 *   - 404 (device unknown, unassigned, or patient discharged)
 *   - HTTP errors (5xx, timeout, network)
 *   - response parse failures
 *
 * Cache: 60s for successful lookups, 30s for null. Both error paths are
 * non-fatal — the caller (poster) treats null as "skip this batch".
 *
 * For testability: exported clearCache() drops all entries.
 */
export async function resolvePatientId(
  trinityCode: string,
  hospitalId: string,
): Promise<string | null> {
  const cached = getCached(trinityCode, hospitalId);
  if (cached !== null) {
    return cached.patientId;
  }

  const url = `${config.IMPACT_API_URL}/api/v1/devices/${encodeURIComponent(trinityCode)}/patient`;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    config.IMPACT_HTTP_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Ingest-Key': config.IMPACT_INGEST_KEY,
        'X-Hospital-ID': hospitalId,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status === 404) {
      setCache(trinityCode, hospitalId, null);
      return null;
    }

    if (!response.ok) {
      logger.warn(
        { trini_code: trinityCode, status: response.status },
        'patient resolver: IMPACT returned non-2xx; not caching',
      );
      return null;
    }

    const json = (await response.json()) as {
      status?: string;
      data?: { patient_id?: string };
    };

    const patientId = json?.data?.patient_id ?? null;
    if (patientId === null || typeof patientId !== 'string') {
      logger.warn(
        { trinity_code: trinityCode, body: json },
        'patient resolver: IMPACT 2xx but no patient_id in body; not caching',
      );
      return null;
    }

    setCache(trinityCode, hospitalId, patientId);
    return patientId;
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : 'unknown fetch error';
    logger.warn(
      { trinity_code: trinityCode, err: message },
      'patient resolver: fetch failed; returning null',
    );
    return null;
  }
}

/**
 * Clear the in-memory cache. Test helper.
 */
export function clearCache(): void {
  cache.clear();
}
