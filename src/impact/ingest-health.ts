// Per-device ingest health — the answer to "is this bed's data actually
// LANDING", which no other signal in this service can give.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// The Timescale insert and the IMPACT post are independent (observations.ts
// awaits the first and best-efforts the second), so a device can write to
// Timescale perfectly and to Supabase never. Every way that happens was
// previously a `logger.info`:
//
//   · the bed has no patient assigned  -> {skipped, 'no patient resolved'}
//   · the batch had no mapped vitals   -> {skipped, 'no mapped vitals'}
//   · dry-run mode is still on         -> {dry_run}
//   · a 2xx that wrote nothing         -> {success, physiological_rows_written: 0}
//
// Timescale row counts look perfect throughout, and every screen reads empty.
// That is the exact failure the study brief singles out as worse than an
// outage: "a feed that appears healthy while writing rows nothing can read".
//
// Oscar's ingest-health endpoint cannot see any of these. The first three
// never reach the wire — they are decided in poster.ts before any HTTP call —
// so from the server's side a bed with no patient is indistinguishable from a
// bed that is switched off. That gap is only closable here, in the gateway.
//
// ── WHAT "LOUD" MEANS ──────────────────────────────────────────────────────
// Not one line at startup (it scrolls away in an 18-month run) and not one per
// batch (at 1 Hz x 7 beds that is 840 lines/minute, which is its own kind of
// silence). A device that has been ATTEMPTING for longer than
// IMPACT_UNHEALTHY_AFTER_MS with ZERO successful writes escalates to `error`,
// re-stated at most once per IMPACT_ESCALATE_EVERY_MS, and says which cause
// dominates so the fix is named rather than hunted.
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { PostResult } from './poster.js';

/** Why a device's readings are not reaching Supabase. */
export type StallCause =
  | 'refused_unknown_device'
  | 'no_patient_resolved'
  | 'no_mapped_vitals'
  | 'dry_run_mode'
  | 'post_error'
  | 'wrote_nothing';

export type DeviceHealth = {
  device_id: string;
  first_attempt_at: number;
  last_attempt_at: number;
  last_success_at: number | null;
  attempts: number;
  /** Batches that produced at least one physiological row (or 2xx pre-widen). */
  landed: number;
  by_cause: Record<StallCause, number>;
  consecutive_non_landing: number;
  last_detail: string | null;
  /** Set while the device is escalated, so recovery can be announced once. */
  escalated: boolean;
  last_escalated_at: number;
};

const devices = new Map<string, DeviceHealth>();

function blank(deviceId: string, now: number): DeviceHealth {
  return {
    device_id: deviceId,
    first_attempt_at: now,
    last_attempt_at: now,
    last_success_at: null,
    attempts: 0,
    landed: 0,
    by_cause: {
      refused_unknown_device: 0,
      no_patient_resolved: 0,
      no_mapped_vitals: 0,
      dry_run_mode: 0,
      post_error: 0,
      wrote_nothing: 0,
    },
    consecutive_non_landing: 0,
    last_detail: null,
    escalated: false,
    last_escalated_at: 0,
  };
}

/**
 * Classify a PostResult into "did this reading land, and if not, why".
 *
 * `wrote_nothing` is the subtle one and the reason this is not just a status
 * check. Oscar's widened endpoint returns 201 with
 * `data.physiological_rows_written`; a 2xx carrying 0 rows means the POST was
 * accepted and the engine's copy still does not exist. `response.ok` is true
 * for that, so it would otherwise be counted as a success — a healthy-looking
 * zero, which is the thing this whole module is here to prevent.
 */
export function classify(result: PostResult): { landed: boolean; cause?: StallCause; detail?: string } {
  switch (result.kind) {
    case 'success': {
      const written = result.physiological_rows_written;
      const sent = result.physiological_fields_sent;
      // A batch with nothing bound for physiological_data (a ventilator sends
      // only FiO2, which is a vital_signs column) SHOULD write zero rows. That
      // is a correct outcome, not a stall — and warning on it at 1 Hz per
      // ventilator would make the alarm meaningless.
      if (sent === 0) return { landed: true };
      // `undefined` means a server that predates the widen — it wrote
      // vital_signs and cannot report the other table. Not a stall.
      if (written !== undefined && written === 0) {
        return {
          landed: false,
          cause: 'wrote_nothing',
          detail: `HTTP ${result.status} but physiological_rows_written=0`
            + (result.records_failed ? `, records_failed=${result.records_failed}` : ''),
        };
      }
      return { landed: true };
    }
    case 'skipped':
      return result.reason === 'no patient resolved'
        ? { landed: false, cause: 'no_patient_resolved', detail: result.reason }
        : { landed: false, cause: 'no_mapped_vitals', detail: result.reason };
    case 'dry_run':
      return { landed: false, cause: 'dry_run_mode', detail: 'IMPACT_INGEST_MODE=dry-run' };
    case 'error':
      return {
        landed: false,
        cause: 'post_error',
        detail: result.reasons?.length
          ? `${result.message} [${result.reasons.join(', ')}]`
          : result.message,
      };
  }
}

/** The cause responsible for most of a device's non-landing batches. */
function dominantCause(h: DeviceHealth): StallCause | null {
  let best: StallCause | null = null;
  let bestN = 0;
  for (const [cause, n] of Object.entries(h.by_cause) as Array<[StallCause, number]>) {
    if (n > bestN) {
      bestN = n;
      best = cause;
    }
  }
  return bestN > 0 ? best : null;
}

/** What an operator should do about each cause, named so it isn't guessed at. */
export const REMEDY: Record<StallCause, string> = {
  refused_unknown_device:
    'this device is not in the schema-2.0 allowlist (src/mqtt/schema2-shim.ts). '
    + 'It was REFUSED, not relabelled. Add it to DEVICE_ALLOWLIST with its real '
    + 'trinity_code if it is genuinely a BCCH device.',
  no_patient_resolved:
    'the bed has no active device+patient assignment — check trinity_devices, '
    + 'bed_device_assignments (unassigned_at IS NULL) and patient_bed_assignments '
    + '(discharged_at IS NULL) for this trinity_code',
  no_mapped_vitals:
    'no observation in these batches mapped to an IMPACT field — check metric_id '
    + 'values against src/lib/impact-mapping.ts, and whether quality is non-valid',
  dry_run_mode: 'set IMPACT_INGEST_MODE=live',
  post_error: 'the IMPACT API rejected or could not be reached — see the reason codes above',
  wrote_nothing:
    'the POST was accepted but wrote no physiological rows — the readings exist '
    + 'in vital_signs and NOT in the table the engine reads',
};

/**
 * Record one batch outcome and, when a device is stalled, say so loudly.
 *
 * Returns the classification so the caller can pick its own log level for the
 * ordinary per-batch line.
 */
export function record(
  deviceId: string,
  result: PostResult,
  now = Date.now(),
  override?: { cause: StallCause; detail: string },
) {
  const h = devices.get(deviceId) ?? blank(deviceId, now);
  devices.set(deviceId, h);

  h.attempts += 1;
  h.last_attempt_at = now;

  const verdict = override
    ? { landed: false, cause: override.cause, detail: override.detail }
    : classify(result);

  if (verdict.landed) {
    h.landed += 1;
    h.last_success_at = now;
    h.consecutive_non_landing = 0;
    if (h.escalated) {
      // Recovery is stated once, at the level the alarm was raised, so anyone
      // who saw the error also sees it clear.
      h.escalated = false;
      logger.error(
        {
          device_id: deviceId,
          stalled_for_ms: now - h.first_attempt_at,
          attempts: h.attempts,
          by_cause: h.by_cause,
        },
        'INGEST RECOVERED: readings from this device are reaching Supabase again',
      );
    }
    return verdict;
  }

  h.consecutive_non_landing += 1;
  if (verdict.cause) h.by_cause[verdict.cause] += 1;
  h.last_detail = verdict.detail ?? null;

  const since = h.last_success_at ?? h.first_attempt_at;
  const stalledFor = now - since;
  const overdue = stalledFor >= config.IMPACT_UNHEALTHY_AFTER_MS;
  const dueToRestate = now - h.last_escalated_at >= config.IMPACT_ESCALATE_EVERY_MS;

  if (overdue && dueToRestate) {
    h.escalated = true;
    h.last_escalated_at = now;
    const cause = dominantCause(h);
    logger.error(
      {
        device_id: deviceId,
        stalled_for_ms: stalledFor,
        never_landed: h.last_success_at === null,
        attempts: h.attempts,
        landed: h.landed,
        consecutive_non_landing: h.consecutive_non_landing,
        dominant_cause: cause,
        by_cause: h.by_cause,
        last_detail: h.last_detail,
        remedy: cause ? REMEDY[cause] : undefined,
      },
      h.last_success_at === null
        ? 'INGEST STALLED: this device has NEVER landed a reading in Supabase — '
          + 'Timescale is being written and the study tables are not'
        : 'INGEST STALLED: this device has stopped landing readings in Supabase',
    );
  }

  return verdict;
}

/**
 * Record a message REFUSED before it ever reached the poster.
 *
 * Refusal is deliberate and safe — an unrecognised device must never be
 * relabelled into a tenant — but it is still data not arriving, so it goes
 * through the same escalation as any other non-landing outcome. Otherwise a
 * mis-typed allowlist entry would look exactly like a quiet bed.
 */
const refusalWarnedAt = new Map<string, number>();

export function recordRefusal(deviceId: string, reason: string, detail: string, now = Date.now()) {
  // A refusal is announced the FIRST time it is seen, not only once the 60s
  // stall window elapses — an unrecognised device publishing at 1 Hz should be
  // visible immediately. Re-stated at most once a minute per device so eight
  // devices cannot turn the warning into the noise it is meant to cut through.
  const last = refusalWarnedAt.get(deviceId) ?? 0;
  if (now - last >= config.IMPACT_ESCALATE_EVERY_MS) {
    refusalWarnedAt.set(deviceId, now);
    logger.warn(
      { device_id: deviceId, reason, detail },
      'REFUSED: message not accepted — the device was NOT relabelled into a tenant',
    );
  }
  return record(
    deviceId,
    { kind: 'skipped', reason: `refused: ${reason}` },
    now,
    { cause: 'refused_unknown_device', detail },
  );
}

/**
 * Snapshot for the periodic heartbeat, the health endpoint, and tests.
 *
 * ── WHY THERE ARE FOUR BUCKETS AND NOT ONE ───────────────────────────────
 * The first version asked one question — "has this device landed anything
 * recently?" — and treated every no as a stall. Running it against the real
 * broker showed why that is not good enough: the broker holds 57 RETAINED
 * messages from four superseded naming generations, all of which are replayed
 * to every subscriber on connect. Each one registered as a device, was
 * correctly refused as an unknown id, and then sat in the map forever having
 * never landed. The endpoint read `8/16 devices NOT landing` and 503 for as
 * long as the process lived.
 *
 * That is the same mistake as the spurious `wrote_nothing` warnings: an alarm
 * that is always on is indistinguishable from no alarm at all, and it would
 * have trained whoever watches the board to ignore it before the study even
 * started.
 *
 * The fix is to judge on RECENT ACTIVITY as well as on landing, which splits
 * four genuinely different situations that need different responses:
 *
 *   stalled  — publishing right now, not landing. The loud one: a live bed
 *              whose readings are being lost.
 *   silent   — was working, has stopped publishing entirely. Also loud, and a
 *              different fix (check the bed, the gateway, the network).
 *   refused  — an unrecognised device id arriving right now. A provisioning
 *              problem, not a feed problem; loud, because refusing a REAL
 *              bed's data silently is exactly what must never happen.
 *   inert    — an unrecognised id that arrived once and stopped. Retained
 *              junk from a dead generation. Counted and listed, never alarmed
 *              on, because nothing is being lost.
 */
export function snapshot(now = Date.now()) {
  const window = config.IMPACT_UNHEALTHY_AFTER_MS;
  const all = [...devices.values()];

  const describe = (h: DeviceHealth) => ({
    device_id: h.device_id,
    never_landed: h.last_success_at === null,
    stalled_for_ms: now - (h.last_success_at ?? h.first_attempt_at),
    /** Time since ANY batch arrived — tells `silent` apart from `stalled`. */
    silent_for_ms: now - h.last_attempt_at,
    dominant_cause: dominantCause(h),
    attempts: h.attempts,
    landed: h.landed,
  });

  const stalled: ReturnType<typeof describe>[] = [];
  const silent: ReturnType<typeof describe>[] = [];
  const refused: ReturnType<typeof describe>[] = [];
  const inert: ReturnType<typeof describe>[] = [];
  let landing = 0;
  let settling = 0;

  for (const h of all) {
    const active = now - h.last_attempt_at < window;
    const landedRecently =
      h.last_success_at !== null && now - h.last_success_at < window;
    // How long this device has gone without landing anything, measured from
    // its last success or, if it never had one, from when it first appeared.
    const notLandingFor = now - (h.last_success_at ?? h.first_attempt_at);
    // "Every attempt this device ever made was refused" — i.e. the id itself
    // is unknown, as opposed to a known device having a bad run.
    const refusedOnly =
      h.attempts > 0 && h.by_cause.refused_unknown_device === h.attempts;

    if (refusedOnly) {
      (active ? refused : inert).push(describe(h));
    } else if (landedRecently) {
      landing += 1;
    } else if (active) {
      // The window has to elapse before this is a stall. One skipped batch is
      // ordinary — an unassigned bed, a batch of waveforms — and alarming on
      // the first one would make the endpoint useless within a second of boot.
      if (notLandingFor >= window) stalled.push(describe(h));
      else settling += 1;
    } else {
      silent.push(describe(h));
    }
  }

  return {
    // A startup line scrolls away in an 18-month run, so degraded mode has to
    // be legible from any single heartbeat, not only from boot.
    timescale: config.TIMESCALE_ENABLED ? ('ok' as const) : ('disabled' as const),
    devices: all.length,
    landing,
    /**
     * Publishing, nothing landed yet, still inside the window. Deliberately
     * neither healthy nor alarming — this is the state every device passes
     * through on the way to its first success.
     */
    settling,
    stalled,
    silent,
    refused,
    inert,
    /** Everything that warrants waking someone, in one number. */
    alarming: stalled.length + silent.length + refused.length,
    totals: all.reduce(
      (acc, h) => {
        acc.attempts += h.attempts;
        acc.landed += h.landed;
        for (const [c, n] of Object.entries(h.by_cause) as Array<[StallCause, number]>) {
          acc.by_cause[c] += n;
        }
        return acc;
      },
      {
        attempts: 0,
        landed: 0,
        by_cause: {
          refused_unknown_device: 0,
          no_patient_resolved: 0,
          no_mapped_vitals: 0,
          dry_run_mode: 0,
          post_error: 0,
          wrote_nothing: 0,
        } as Record<StallCause, number>,
      },
    ),
  };
}

let heartbeat: NodeJS.Timeout | null = null;

/**
 * Log a whole-feed summary on an interval.
 *
 * Unattended operation needs a line that appears even when nothing changes:
 * "7 devices, 7 landing" is the only evidence that silence is health rather
 * than a crashed subscriber. It logs at `error` while anything is stalled so
 * the state is visible to whatever watches stderr, not just to a reader
 * scrolling back for the original escalation.
 */
export function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    const s = snapshot();
    if (s.devices === 0) {
      logger.warn('ingest-health: no device has published an observation batch yet');
      return;
    }
    if (s.alarming > 0) {
      const parts = [
        s.stalled.length > 0 ? `${s.stalled.length} stalled` : null,
        s.silent.length > 0 ? `${s.silent.length} silent` : null,
        s.refused.length > 0 ? `${s.refused.length} refused` : null,
      ].filter(Boolean).join(', ');
      logger.error(s, `ingest-health: ${s.landing} landing, ${parts}`);
    } else {
      // `inert` is mentioned only when present, and never as a fault: it is
      // retained broker junk, not a bed losing data.
      const tail = s.inert.length > 0 ? ` (${s.inert.length} inert retained id(s) ignored)` : '';
      logger.info(s, `ingest-health: ${s.landing}/${s.landing} device(s) landing${tail}`);
    }
  }, config.IMPACT_HEARTBEAT_MS);
  heartbeat.unref();
}

export function stopHeartbeat(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

/** Test helper. */
export function reset(): void {
  devices.clear();
  refusalWarnedAt.clear();
}
