// ACCEPTANCE DRIVER — exercises the widened /api/v1/vitals/batch contract
// directly over HTTP, with the EXACT body shape src/impact/poster.ts builds.
//
// ── WHY THIS EXISTS ALONGSIDE THE MQTT PUBLISHER ───────────────────────────
// Driving the real simulator needs the Jetson PUBLISHER credential, because
// `impact-subscriber` is subscribe-only by ACL. This script needs no MQTT at
// all: it is the same request the poster would send, so it proves everything
// on the server side of the boundary — parameter names, tenant, both clocks,
// zero survival, metadata.device_id, and the 201-vs-502 contract — while the
// publisher credential is still outstanding.
//
// What it does NOT prove: the MQTT -> router -> poster hop. That is this
// repo's own code and is covered by `pnpm test` plus the 1 Hz publisher once
// credentials exist. Keep the distinction when reporting: this is the server
// contract, not the full feed.
//
//   set -a; . ./.env; set +a; node scripts/acceptance-http.mjs --scenario all
//
// Flags:
//   --scenario normal|zero|unassigned|no-observed-at|all   (default all)
//   --seconds N   how many 1 Hz records for the normal/zero scenarios (default 5)
//   --bed NN      bed for the normal/zero scenarios (default 01)
//   --dry         print the requests, send nothing

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const API = (process.env.IMPACT_API_URL || 'http://localhost:3035').replace(/\/$/, '');
const KEY = process.env.IMPACT_INGEST_KEY || '';
const HOSPITAL = process.env.IMPACT_HOSPITAL_ID || 'bcch';
const SCENARIO = flag('scenario', 'all');
const SECONDS = Number(flag('seconds', 5));
const BED = String(flag('bed', '01'));
const DRY = has('dry');

if (!KEY && !DRY) {
  console.error('IMPACT_INGEST_KEY required (source .env). Use --dry to preview.');
  process.exit(1);
}

const H = {
  'Content-Type': 'application/json',
  'X-Ingest-Key': KEY,
  'X-Hospital-ID': HOSPITAL,
};
const dev = (bed) => `sim-${HOSPITAL}-bed-${bed}-philips-monitor`;

// Node's global fetch ignores HTTP_PROXY, but NO_PROXY covers localhost, so
// curl is used here for consistency with verify-arrivals.mjs and to keep one
// transport story across both scripts.
import { execFileSync } from 'node:child_process';

function http(method, path, body) {
  const args = ['-s', '-w', '\n%{http_code}', '--max-time', '15', '-X', method];
  for (const [k, v] of Object.entries(H)) args.push('-H', `${k}: ${v}`);
  if (body !== undefined) args.push('-d', JSON.stringify(body));
  args.push(`${API}${path}`);
  let out;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8' });
  } catch (e) {
    return { status: 0, body: null, raw: String(e.message) };
  }
  const i = out.lastIndexOf('\n');
  const raw = out.slice(0, i);
  const status = Number(out.slice(i + 1).trim());
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
  return { status, body: parsed, raw };
}

/** The poster resolves the patient exactly this way before it posts. */
function resolvePatient(trinityCode) {
  const override = flag('patient', null);
  if (override) return { patientId: override, status: 200 };
  const r = http('GET', `/api/v1/devices/${encodeURIComponent(trinityCode)}/patient`);
  if (r.status === 404) return { patientId: null, status: 404 };
  // --dry is for reviewing the payload with the server down, so a placeholder
  // stands in rather than aborting. Never used on a real send.
  if (DRY && r.status === 0) {
    return { patientId: '<unresolved-dry-run>', status: 0 };
  }
  return { patientId: r.body?.data?.patient_id ?? null, status: r.status, body: r.body };
}

// Mirrors buildBody() in src/impact/poster.ts: integer-rounded vitals,
// temperature left decimal, patient_id + observed_at attached, and
// observed_at = batch.presentation_time.
function record(bed, patientId, at, { zero = false, omitObservedAt = false } = {}) {
  const r = {
    device_id: dev(bed),
    bed_id: `${HOSPITAL}-nicu-bed-${bed}`,
    presentation_time: at,
    heart_rate: zero ? 0 : 145,
    spo2: zero ? 0 : 96,
    rr: zero ? 0 : 46,
    temperature: 36.8,
    patient_id: patientId,
    observed_at: at,
  };
  if (omitObservedAt) delete r.observed_at;
  return r;
}

let failures = 0;
const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
function expect(label, cond, detail = '') {
  if (!cond) failures += 1;
  console.log(`   [${cond ? PASS : FAIL}] ${label}${detail ? `  ${detail}` : ''}`);
}

function summarise(r) {
  const d = r.body?.data ?? {};
  const f = r.body?.failures ?? [];
  return `HTTP ${r.status}`
    + ` inserted=${d.inserted ?? '-'} skipped=${d.skipped ?? '-'}`
    + ` physiological_rows_written=${d.physiological_rows_written ?? '-'}`
    + ` records_failed=${d.records_failed ?? '-'}`
    + (f.length ? `\n        failures: ${f.map((x) => `${x.reason ?? x.code}${x.detail ? ` (${x.detail})` : ''}`).join('; ')}` : '');
}

function post(records) {
  if (DRY) {
    console.log(`   DRY — would POST ${records.length} record(s):`);
    console.log(JSON.stringify({ records: [records[0]] }, null, 2).split('\n').map((l) => `     ${l}`).join('\n'));
    return null;
  }
  return http('POST', '/api/v1/vitals/batch', { records });
}

function stamps(n) {
  // Distinct, ascending seconds. A constant observed_at would be deduped by
  // vital_signs' ON CONFLICT (device_id, observed_at) and look like a lost write.
  const base = Date.now() - n * 1000;
  return Array.from({ length: n }, (_, i) => new Date(base + i * 1000).toISOString());
}

// ── scenarios ──────────────────────────────────────────────────────────────

function scenarioNormal(zero = false) {
  const title = zero ? 'ZERO (SpO2 0 / HR 0 / RR 0 — apnea is rr === 0)' : 'NORMAL 1 Hz';
  console.log(`\n== ${title} — bed ${BED} ==`);
  const { patientId, status } = resolvePatient(dev(BED));
  expect('device resolves to a patient', patientId !== null, `resolver HTTP ${status}`);
  if (patientId === null) {
    console.log('   cannot post without a patient; skipping the rest of this scenario');
    return null;
  }
  const ts = stamps(SECONDS);
  const r = post(ts.map((t) => record(BED, patientId, t, { zero })));
  if (!r) return null;
  console.log(`   ${summarise(r)}`);
  // 201 ONLY if every record wrote completely; ANY failure is 502.
  expect('HTTP 201 (the contract: 201 only on a complete write)', r.status === 201);
  expect('physiological rows written = 3 per record',
    r.body?.data?.physiological_rows_written === SECONDS * 3,
    `expected ${SECONDS * 3}`);
  expect('records_failed = 0', (r.body?.data?.records_failed ?? 0) === 0);
  return { firstTs: ts[0], patientId };
}

function scenarioUnassigned() {
  console.log('\n== UNASSIGNED BED (the deliberate failure) ==');
  const bed = '03';
  const { patientId, status } = resolvePatient(dev(bed));
  // This is the case that never reaches the server: the poster stops here, so
  // the server has nothing to report and the gateway must be the loud one.
  expect('resolver returns 404 for an unbound device', status === 404, `HTTP ${status}`);
  expect('no patient resolved', patientId === null);
  console.log('   -> poster returns {kind:"skipped", reason:"no patient resolved"}');
  console.log('   -> src/impact/ingest-health.ts escalates to ERROR after '
    + `${process.env.IMPACT_UNHEALTHY_AFTER_MS ?? 60000}ms of this`);
  console.log('   (server-side ingest-health CANNOT see this — no HTTP call is made)');
}

function scenarioNoObservedAt() {
  console.log('\n== MISSING observed_at (refusal, not a now() fallback) ==');
  const { patientId } = resolvePatient(dev(BED));
  if (patientId === null) { console.log('   no patient; skipped'); return; }
  const r = post([record(BED, patientId, new Date().toISOString(), { omitObservedAt: true })]);
  if (!r) return;
  console.log(`   ${summarise(r)}`);
  expect('refused with 502, not silently stamped with now()', r.status === 502);
  const reasons = (r.body?.failures ?? []).map((f) => f.reason);
  expect("reason is 'missing_observed_at'", reasons.includes('missing_observed_at'),
    reasons.join(', '));
}

console.log(`acceptance driver -> ${API}  hospital=${HOSPITAL}${DRY ? '  [DRY]' : ''}`);

let normal = null;
if (SCENARIO === 'all' || SCENARIO === 'normal') normal = scenarioNormal(false);
if (SCENARIO === 'all' || SCENARIO === 'zero') scenarioNormal(true);
if (SCENARIO === 'all' || SCENARIO === 'unassigned') scenarioUnassigned();
if (SCENARIO === 'all' || SCENARIO === 'no-observed-at') scenarioNoObservedAt();

if (!DRY) {
  console.log(`\n${failures === 0 ? '\x1b[32mHTTP CONTRACT OK\x1b[0m' : `\x1b[31m${failures} EXPECTATION(S) FAILED\x1b[0m`}`);
  if (normal?.firstTs) {
    console.log(`\nNow verify what ARRIVED (not what was accepted):\n` +
      `  node scripts/verify-arrivals.mjs --since ${normal.firstTs} --expect-zero`);
  }
}
process.exit(failures === 0 ? 0 : 1);
