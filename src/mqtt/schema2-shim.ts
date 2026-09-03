// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  DEMO SHIM — schema 2.0 → schema 1.0. NOT PERMANENT ARCHITECTURE.        ║
// ║                                                                          ║
// ║  The BCCH simulator was upgraded to `schema_version: "2.0"` and this      ║
// ║  service was not, which is why ingest has been dead: 2.0 publishes on     ║
// ║  SEVEN-segment topics that parseTopic() (which requires five) drops       ║
// ║  silently at debug level. This module translates 2.0 into the 1.0 shape   ║
// ║  the rest of the pipeline already speaks, so NOTHING downstream changes.  ║
// ║                                                                          ║
// ║  OPEN QUESTION (Arman/Hans): is 2.0 what the real BCCH gateway will       ║
// ║  emit, or a simulator artifact? Until that is answered this stays behind  ║
// ║  SCHEMA2_SHIM_ENABLED (default OFF) and stays in ONE file, so it can be   ║
// ║  deleted or replaced wholesale. Do not spread it into the handlers.       ║
// ╚══════════════════════════════════════════════════════════════════════════╝
import { logger } from '../lib/logger.js';

// ── OBSERVED CONTRACT ──────────────────────────────────────────────────────
// Captured live off the broker 2026-09-03 (20s sample, 8 devices, 1.00 Hz each):
//   topic  hospitals/example-hospital/units/example-nicu/devices/bed-01-monitor/observations
//   body   { schema_version:"2.0", unique_device_identifier:"bed-01-monitor",
//            hospital_id:"example-hospital", unit_id:"example-nicu",
//            bed_id:"bed-01", vendor:"philips", gateway_id:"example-gateway-01",
//            observations:[{ metric_id:"HR", unit_id:"bpm", value:144.74,
//                            quality:"valid", timestamp:"…" }] }
export const SCHEMA2_SOURCE_HOSPITAL = 'example-hospital';

/** A device we are willing to accept, and the identity it resolves to. */
type AllowedDevice = {
  /** The `trinity_code` this device IS, in IMPACT's device registry. */
  trinityCode: string;
  /** The tenant, set as a CONSEQUENCE of the match — never from the topic. */
  hospitalId: string;
};

// ── THE ALLOWLIST, AND WHY IT IS NOT A REWRITE RULE ────────────────────────
// A blanket `example-hospital -> bcch` rewrite would mean this service accepts
// a batch claiming ANY origin and relabels it BCCH. That is the tenancy hazard
// that has already cost this project days, and it is worse here than usual:
// the relabelled row would be indistinguishable from a real BCCH reading.
//
// So the ONLY thing that can produce a BCCH identity is an exact, byte-for-byte
// match on a device id we have written down. `hospitalId` is a property of the
// matched entry, not a transformation of the topic. Anything unrecognised is
// REFUSED and reported — never guessed at, never passed through.
//
// The source hospital is checked too: a device id alone is not enough, because
// `bed-01-monitor` is a generic string that another publisher could claim.
export const DEVICE_ALLOWLIST: Readonly<Record<string, AllowedDevice>> = Object.freeze({
  'bed-01-monitor':    { trinityCode: 'sim-bcch-bed-01-philips-monitor',   hospitalId: 'bcch' },
  'bed-01-ventilator': { trinityCode: 'sim-bcch-bed-01-drager-ventilator', hospitalId: 'bcch' },
  'bed-02-monitor':    { trinityCode: 'sim-bcch-bed-02-philips-monitor',   hospitalId: 'bcch' },
  'bed-02-ventilator': { trinityCode: 'sim-bcch-bed-02-drager-ventilator', hospitalId: 'bcch' },
  'bed-03-monitor':    { trinityCode: 'sim-bcch-bed-03-philips-monitor',   hospitalId: 'bcch' },
  'bed-03-ventilator': { trinityCode: 'sim-bcch-bed-03-drager-ventilator', hospitalId: 'bcch' },
  'bed-04-monitor':    { trinityCode: 'sim-bcch-bed-04-philips-monitor',   hospitalId: 'bcch' },
  'bed-04-ventilator': { trinityCode: 'sim-bcch-bed-04-drager-ventilator', hospitalId: 'bcch' },
  // bed-05 is DECLARED BUT NOT OBSERVED. The simulator publishes beds 01-04
  // only (verified over a 20s sample). These entries are inert until it does.
  'bed-05-monitor':    { trinityCode: 'sim-bcch-bed-05-philips-monitor',   hospitalId: 'bcch' },
  'bed-05-ventilator': { trinityCode: 'sim-bcch-bed-05-drager-ventilator', hospitalId: 'bcch' },
});

// ── METRIC NAMES ───────────────────────────────────────────────────────────
// 2.0 emits short ids; impact-mapping.ts speaks MDC. Normalising to MDC here
// (rather than teaching impact-mapping the short names) keeps ONE metric
// vocabulary downstream and means Timescale still stores MDC ids when it comes
// back. The MDC targets are exactly the keys impact-mapping already maps:
//   NOM_ECG_CARD_BEAT_RATE -> heart_rate  -> physiological_data 'heart_rate'
//   NOM_PULS_OXIM_SAT_O2   -> spo2        -> physiological_data 'spo2'
//   NOM_RESP_RATE          -> rr          -> physiological_data 'respiratory_rate'
//   NOM_TEMP               -> temperature -> vital_signs ONLY
//   NOM_VENT_CONC_AWAY_O2  -> fio2        -> vital_signs ONLY (read on observed_at)
// FiO2 and temperature deliberately do NOT become physiological_data rows:
// `fraction_inspired_oxygen` is a vital_signs COLUMN, not a parameter_type.
export const SHORT_METRIC_TO_MDC: Readonly<Record<string, string>> = Object.freeze({
  HR: 'NOM_ECG_CARD_BEAT_RATE',
  SPO2: 'NOM_PULS_OXIM_SAT_O2',
  RR: 'NOM_RESP_RATE',
  TEMP: 'NOM_TEMP',
  FIO2: 'NOM_VENT_CONC_AWAY_O2',
});

/** 2.0 unit strings -> the MDC measurement unit codes device_numerics expects. */
const UNIT_TO_MDC: Readonly<Record<string, string>> = Object.freeze({
  bpm: 'NOM_DIM_BEAT_PER_MIN',
  percent: 'NOM_DIM_PERCENT',
  resp_per_min: 'NOM_DIM_RESP_PER_MIN',
  celsius: 'NOM_DIM_DEGC',
});

/**
 * 2.0 sends connectivity states lowercase ('connected'); the 1.0 enum is
 * capitalised. Left unhandled this throws a ZodError per message, at ERROR —
 * eight of them on the retained backlog alone.
 */
function normaliseState(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.toLowerCase();
  if (s === 'connected') return 'Connected';
  if (s === 'disconnected') return 'Disconnected';
  if (s === 'error') return 'Error';
  return v;
}

export type Schema2Topic = {
  sourceHospitalId: string;
  unitId: string;
  deviceId: string;
  leaf: string;
};

/**
 * Parse the 7-segment 2.0 topic:
 *   hospitals/{hospital}/units/{unit}/devices/{device}/{leaf}
 * Returns null if it is not that shape (the 5-segment 1.0 parser handles those).
 */
export function parseSchema2Topic(topic: string): Schema2Topic | null {
  const p = topic.split('/');
  if (
    p.length !== 7
    || p[0] !== 'hospitals'
    || p[2] !== 'units'
    || p[4] !== 'devices'
    || !p[1] || !p[3] || !p[5] || !p[6]
  ) {
    return null;
  }
  return { sourceHospitalId: p[1], unitId: p[3], deviceId: p[5], leaf: p[6] };
}

export type IdentityResolution =
  | { ok: true; trinityCode: string; hospitalId: string }
  | { ok: false; reason: 'unknown_device' | 'unexpected_source_hospital'; detail: string };

/**
 * Resolve an observed 2.0 device to a BCCH identity — ONLY via the allowlist.
 *
 * Refuses (never guesses) when the device id is not one we have written down,
 * or when a known device id arrives claiming an origin we did not expect.
 */
export function resolveIdentity(t: Schema2Topic): IdentityResolution {
  const entry = DEVICE_ALLOWLIST[t.deviceId];
  if (!entry) {
    return {
      ok: false,
      reason: 'unknown_device',
      detail:
        `device_id '${t.deviceId}' is not in the schema-2.0 allowlist, so it has `
        + 'no known trinity_code and no tenant. Refusing rather than relabelling.',
    };
  }
  if (t.sourceHospitalId !== SCHEMA2_SOURCE_HOSPITAL) {
    return {
      ok: false,
      reason: 'unexpected_source_hospital',
      detail:
        `device_id '${t.deviceId}' is allowlisted but arrived under hospital `
        + `'${t.sourceHospitalId}', not '${SCHEMA2_SOURCE_HOSPITAL}'. A device id `
        + 'alone is not proof of origin. Refusing.',
    };
  }
  return { ok: true, trinityCode: entry.trinityCode, hospitalId: entry.hospitalId };
}

/**
 * Rewrite a 2.0 observation batch body into the 1.0 shape.
 *
 * Only the fields that differ are touched: `metric_id` short -> MDC, `unit_id`
 * -> MDC unit code, and the per-observation `timestamp` -> `device_time` (2.0
 * renamed it; without this the device's own clock is dropped by zod). An
 * observation whose metric is not in SHORT_METRIC_TO_MDC is PASSED THROUGH
 * unchanged so it surfaces downstream as `unmapped` rather than vanishing here.
 */
export function normaliseSchema2Body(
  body: Record<string, unknown>,
  identity: { trinityCode: string; hospitalId: string },
  topic: Schema2Topic,
): Record<string, unknown> {
  const observations = Array.isArray(body.observations) ? body.observations : [];
  return {
    ...body,
    ...(body.state !== undefined ? { state: normaliseState(body.state) } : {}),
    // The identity the rest of the pipeline will trust, from the allowlist.
    unique_device_identifier: identity.trinityCode,
    hospital_id: identity.hospitalId,
    unit_id: topic.unitId,
    observations: observations.map((raw) => {
      const o = raw as Record<string, unknown>;
      const short = typeof o.metric_id === 'string' ? o.metric_id : '';
      const unit = typeof o.unit_id === 'string' ? o.unit_id : '';
      return {
        ...o,
        metric_id: SHORT_METRIC_TO_MDC[short] ?? o.metric_id,
        unit_id: UNIT_TO_MDC[unit] ?? o.unit_id,
        // 2.0 calls it `timestamp`; the 1.0 schema (and Timescale) call it
        // `device_time`. Keep whichever is present.
        device_time: o.device_time ?? o.timestamp ?? null,
        // instance_id is absent in 2.0; the 1.0 schema defaults it to 0.
        instance_id: o.instance_id ?? 0,
        vendor_metric_id: o.vendor_metric_id ?? short,
      };
    }),
  };
}

// A 2.0 topic seen while the shim is OFF must not be a silent drop — that is
// the exact failure this whole exercise exists to end. Warn, rate-limited so
// 8 devices at 1 Hz cannot turn the warning into noise.
let lastDisabledWarn = 0;
export function warnSchema2Seen(topic: string): void {
  const now = Date.now();
  if (now - lastDisabledWarn < 60_000) return;
  lastDisabledWarn = now;
  logger.warn(
    { topic },
    'schema-2.0 topic seen but SCHEMA2_SHIM_ENABLED=false — these messages are '
    + 'being DROPPED. Set SCHEMA2_SHIM_ENABLED=true to accept them.',
  );
}
