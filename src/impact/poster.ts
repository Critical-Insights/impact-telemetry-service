import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import {
  flattenBatchToImpactRecord,
  type ImpactVitalRecord,
} from '../lib/impact-mapping.js';
import type { DeviceObservationBatch } from '../types/canonical.js';

export type PostResult =
  | { kind: 'skipped'; reason: string }
  | {
      kind: 'dry_run';
      would_post: {
        url: string;
        headers: Record<string, string>;
        body: ImpactBatchBody;
      };
    }
  | { kind: 'success'; status: number; inserted?: number; skipped?: number }
  | { kind: 'error'; status?: number; message: string };

type ImpactBatchBody = {
  records: Array<
    ImpactVitalRecord & { patient_id: string; observed_at: string }
  >;
};

/**
 * Build the IMPACT batch request body for a single observation batch.
 *
 * Returns null if no mapped vital fields survived the flatten step (in which
 * case we have nothing to send).
 */
function buildBody(
  deviceId: string,
  batch: DeviceObservationBatch,
  patientId: string,
): ImpactBatchBody | null {
  const { record, unmapped } = flattenBatchToImpactRecord(batch, deviceId);

  if (unmapped.length > 0) {
    logger.warn(
      { device_id: deviceId, unmapped_count: unmapped.length, unmapped },
      'impact-mapping: some observations were unmapped',
    );
  }

  // A record with only the envelope fields and no mapped vitals means there's
  // nothing IMPACT can actually store. Skip rather than send an empty record.
  const hasMappedVital =
    record.heart_rate !== undefined ||
    record.spo2 !== undefined ||
    record.rr !== undefined ||
    record.temperature !== undefined ||
    record.fio2 !== undefined ||
    record.bp_systolic !== undefined ||
    record.bp_diastolic !== undefined ||
    record.bp_mean !== undefined;

  if (!hasMappedVital) {
    return null;
  }

  // IMPACT's vital_signs columns are integer-typed for everything except
  // temperature. Round before send to satisfy the RPC's integer params.
  const roundIfNumber = (v: number | null | undefined): number | null | undefined =>
    typeof v === 'number' ? Math.round(v) : v;

  return {
    records: [
      {
        ...record,
        heart_rate: roundIfNumber(record.heart_rate),
        spo2: roundIfNumber(record.spo2),
        rr: roundIfNumber(record.rr),
        bp_systolic: roundIfNumber(record.bp_systolic),
        bp_diastolic: roundIfNumber(record.bp_diastolic),
        bp_mean: roundIfNumber(record.bp_mean),
        fio2: roundIfNumber(record.fio2),
        // temperature stays as-is (numeric column accepts decimals)
        patient_id: patientId,
        observed_at: batch.presentation_time,
      },
    ],
  };
}

/**
 * Post an observation batch to IMPACT's /api/v1/vitals/batch endpoint.
 *
 * Behavior depends on config.IMPACT_INGEST_MODE:
 *   - 'dry-run' (default): build the full request, log it, return without
 *     sending.
 *   - 'live': actually POST.
 *
 * Failure modes that DON'T propagate (logged + returned as PostResult):
 *   - patientId is null (skipped — no patient to attribute to)
 *   - No mapped vitals in the batch (skipped — nothing to send)
 *   - HTTP errors (4xx, 5xx, timeout, network) in live mode
 *
 * The caller (handleObservations) is responsible for ensuring that the
 * Timescale insert has already succeeded; IMPACT post is a secondary sink.
 * Even total IMPACT failure must not lose the Timescale-backed observation.
 */
export async function postObservationToImpact(
  deviceId: string,
  batch: DeviceObservationBatch,
  patientId: string | null,
): Promise<PostResult> {
  if (patientId === null) {
    return { kind: 'skipped', reason: 'no patient resolved' };
  }

  const body = buildBody(deviceId, batch, patientId);
  if (body === null) {
    return { kind: 'skipped', reason: 'no mapped vitals' };
  }

  const url = `${config.IMPACT_API_URL}/api/v1/vitals/batch`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Ingest-Key': config.IMPACT_INGEST_KEY,
    'X-Hospital-ID': config.IMPACT_HOSPITAL_ID,
  };

  if (config.IMPACT_INGEST_MODE === 'dry-run') {
    logger.info(
      {
        url,
        headers: { ...headers, 'X-Ingest-Key': '<redacted>' },
        body,
      },
      'impact-poster: DRY-RUN — would POST',
    );
    return { kind: 'dry_run', would_post: { url, headers, body } };
  }

  // Live mode below.
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    config.IMPACT_HTTP_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      // IMPACT returns { status, data: { inserted, skipped, total }, message }
      let inserted: number | undefined;
      let skipped: number | undefined;
      try {
        const json = (await response.json()) as {
          data?: { inserted?: number; skipped?: number };
        };
        inserted = json.data?.inserted;
        skipped = json.data?.skipped;
      } catch {
        // Body wasn't JSON or didn't have the expected shape; not fatal.
      }
      return { kind: 'success', status: response.status, inserted, skipped };
    }

    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      errorBody = '<unreadable body>';
    }
    return {
      kind: 'error',
      status: response.status,
      message: `IMPACT returned ${response.status}: ${errorBody.slice(0, 500)}`,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const message =
      err instanceof Error ? err.message : 'unknown fetch error';
    return { kind: 'error', message };
  }
}
