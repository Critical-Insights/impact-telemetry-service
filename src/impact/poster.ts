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
  | {
      kind: 'success';
      status: number;
      inserted?: number;
      skipped?: number;
      // Added by the widened endpoint (Oscar, 48539b2). A 2xx carrying 0 here
      // means the POST was accepted and the ENGINE'S copy still does not
      // exist — `response.ok` is true for that, so it must be surfaced
      // explicitly or it reads as a success. `undefined` means a server that
      // predates the widen, which is a different thing from zero.
      physiological_rows_written?: number;
      records_failed?: number;
      /**
       * How many of the batch's fields were ones that BECOME
       * physiological_data rows (spo2 / heart_rate / rr).
       *
       * Needed to read `physiological_rows_written: 0` correctly. A ventilator
       * batch carries only FiO2, which is a vital_signs COLUMN and never a
       * parameter_type — so zero rows is the CORRECT outcome there, not a
       * stall. Without this the loudness layer would warn on every ventilator
       * batch at 1 Hz, and an alarm that is always on is just noise.
       */
      physiological_fields_sent?: number;
    }
  | {
      kind: 'error';
      status?: number;
      message: string;
      /** Per-record `reason` codes from the 502 body, deduplicated. */
      reasons?: string[];
    };

/**
 * The widened endpoint's response body.
 *
 * It returns 201 ONLY when every record wrote completely; ANY failure is a
 * 502 with `failures[]`. That choice matters to this file specifically: we
 * branch on `response.ok`, which is true across all of 2xx, so a 207 partial
 * would have been logged as a success.
 */
type ImpactBatchResponse = {
  data?: {
    inserted?: number;
    skipped?: number;
    physiological_rows_written?: number;
    records_failed?: number;
  };
  failures?: Array<{
    index?: number;
    stage?: string;
    reason?: string;
    detail?: string;
    code?: string;
  }>;
};

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

  // Count the fields that are destined for physiological_data, so a zero-row
  // response can be told apart from a batch that never had any to write.
  const physiologicalFieldsSent = body.records.reduce((n, r) => {
    return n
      + (r.spo2 !== undefined && r.spo2 !== null ? 1 : 0)
      + (r.heart_rate !== undefined && r.heart_rate !== null ? 1 : 0)
      + (r.rr !== undefined && r.rr !== null ? 1 : 0);
  }, 0);

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
      let data: ImpactBatchResponse['data'];
      try {
        data = ((await response.json()) as ImpactBatchResponse).data;
      } catch {
        // Body wasn't JSON or didn't have the expected shape; not fatal.
      }
      return {
        kind: 'success',
        status: response.status,
        inserted: data?.inserted,
        skipped: data?.skipped,
        physiological_rows_written: data?.physiological_rows_written,
        records_failed: data?.records_failed,
        physiological_fields_sent: physiologicalFieldsSent,
      };
    }

    // A failure body carries per-record `reason` codes. Lifting them out means
    // the log names the cause — `tenant_unresolvable` or `missing_observed_at`
    // rather than a truncated blob — and the caller-fixable ones
    // (missing_observed_at, invalid_observed_at, validation_failed) can be
    // told apart from ours at a glance.
    let errorBody = '';
    let reasons: string[] | undefined;
    try {
      errorBody = await response.text();
      const parsed = JSON.parse(errorBody) as ImpactBatchResponse;
      const seen = (parsed.failures ?? [])
        .map((f) => f.reason ?? f.code)
        .filter((r): r is string => typeof r === 'string');
      if (seen.length > 0) reasons = [...new Set(seen)];
    } catch {
      // Not JSON, or no failures[]; the raw body still goes in the message.
      if (errorBody === '') errorBody = '<unreadable body>';
    }
    return {
      kind: 'error',
      status: response.status,
      message: `IMPACT returned ${response.status}: ${errorBody.slice(0, 500)}`,
      reasons,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const message =
      err instanceof Error ? err.message : 'unknown fetch error';
    return { kind: 'error', message };
  }
}
