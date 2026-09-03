// ACCEPTANCE VERIFIER — read-only. Answers "what ACTUALLY arrived", not "did the
// POST return 200". Every check below exists because a 200 has already lied
// about at least one of them.
//
// Credentials are NOT stored in this repo. Source them at run time:
//   SUPABASE_URL=$(grep -m1 '^VITE_SUPABASE_URL=' ../IMPACT_BCCH_SERVER/.env | cut -d= -f2-) \
//   SUPABASE_SERVICE_ROLE_KEY=$(grep -m1 '^SUPABASE_SERVICE_ROLE_KEY=' ../IMPACT_BCCH_SERVER/.env | cut -d= -f2-) \
//   node scripts/verify-arrivals.mjs --since 2026-09-03T21:00:00.000Z
//
// Flags:
//   --since ISO      window start (default: 15 minutes ago)
//   --patient UUID   default Baby Smith, bed 01
//   --tenant ID      default bcch
//   --expect-zero    assert a genuine 0 landed as 0, not null
//   --baseline       print counts only, to snapshot BEFORE a run

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const SB = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!SB || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required (see header).');
  process.exit(1);
}

const SINCE = flag('since', new Date(Date.now() - 15 * 60_000).toISOString());
const PATIENT = flag('patient', '2a7bff4f-658b-4db5-98d2-b07f7a0278e1');
const TENANT = flag('tenant', 'bcch');
// Oscar's writer stamps device_source (default 'monitor'); the ~104k pre-existing
// seed rows are 'test'. Filtering on provenance is stricter than filtering on
// time — a stale seed row inside the window cannot be mistaken for an arrival.
const SOURCE = flag('source', 'monitor');
const SRC = SOURCE === 'any' ? '' : `&device_source=eq.${SOURCE}`;

// Node's global fetch ignores HTTP_PROXY, and this box reaches Supabase only
// through a proxy — so the transport is curl, which honours the proxy env
// everywhere this is likely to run. Keeps the script dependency-free too.
import { execFileSync } from 'node:child_process';

const CURL = ['-s', '--max-time', '30',
  '-H', `apikey: ${KEY}`, '-H', `Authorization: Bearer ${KEY}`];

function req(path, extra = []) {
  return execFileSync('curl', [...CURL, ...extra, `${SB}/rest/v1/${path}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function rows(path) {
  const body = req(path);
  let json;
  try { json = JSON.parse(body); } catch { throw new Error(`bad JSON from ${path}: ${body.slice(0, 300)}`); }
  if (!Array.isArray(json)) throw new Error(`${path}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// PostgREST returns the exact count in the Content-Range header. It is read
// SEPARATELY from the rows on purpose: "did I get everything that exists" is
// not a question the returned pages can answer, and a silently capped read is
// exactly how 17,881 rows were once counted as 1,000.
function count(path) {
  const out = req(path, ['-D', '-', '-o', '/dev/null',
    '-H', 'Prefer: count=exact', '-H', 'Range: 0-0']);
  const m = out.match(/content-range:\s*\S*\/(\d+)/i);
  if (!m) throw new Error(`no count for ${path}: ${out.slice(0, 300)}`);
  return Number(m[1]);
}

// The reader's alias map, verbatim and CASE-SENSITIVE (visionQueries.js:146-150).
// Checking every alias — not just the canonical name — is how a writer that
// emits an off-map string ('rr', 'SPO2') is caught instead of reading as zero.
const ALIASES = {
  spo2: ['spo2', 'oxygen_saturation', 'SpO2'],
  heart_rate: ['heart_rate', 'hr'],
  respiratory_rate: ['respiratory_rate', 'rr'],
};

const ok = (b) => (b ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m');
const warn = (m) => `\x1b[33m${m}\x1b[0m`;
let failures = 0;
const check = (label, pass, detail = '') => {
  if (!pass) failures += 1;
  console.log(`  [${ok(pass)}] ${label}${detail ? `  ${detail}` : ''}`);
};

const q = `patient_id=eq.${PATIENT}&recorded_at=gte.${SINCE}${SRC}`;

console.log(
  `\nphysiological_data — patient ${PATIENT.slice(0, 8)}… since ${SINCE}` +
  `  device_source=${SOURCE}\n`);

// Oscar's in-process counters (no DB, so it answers even when the DB is what
// is broken). Checked FIRST: 'stalled' means zero errors AND zero data, which
// is the state nothing else can see.
try {
  const health = JSON.parse(execFileSync('curl',
    ['-s', '--max-time', '5', 'http://localhost:3035/api/v1/vision/ingest-health'],
    { encoding: 'utf8' }));
  const d = health.data ?? health;
  console.log(`0. INGEST-HEALTH (server-side counters)`);
  console.log(`   status=${d.status}  last_success_at=${d.last_success_at ?? 'never'}` +
    `  consecutive_failed_batches=${d.consecutive_failed_batches ?? 0}`);
  if (Array.isArray(d.recent_failures) && d.recent_failures.length) {
    console.log(`   recent failures: ${d.recent_failures.slice(0, 5)
      .map((f) => f.reason ?? f.code ?? JSON.stringify(f)).join(', ')}`);
  }
  console.log('');
} catch {
  console.log(`0. INGEST-HEALTH  ${warn('unreachable — is the server up on 3035?')}\n`);
}

// ── 1. per-parameter arrival counts, per alias ─────────────────────────────
console.log('1. PER-PARAMETER ROW COUNTS (all reader aliases)');
let readable = 0;
const seen = {};
for (const [canonical, list] of Object.entries(ALIASES)) {
  const parts = [];
  let sum = 0;
  for (const a of list) {
    const n = count(`physiological_data?select=id&${q}&parameter_type=eq.${a}`);
    if (n > 0) parts.push(`${a}=${n}`);
    sum += n;
  }
  seen[canonical] = sum;
  readable += sum;
  check(`${canonical.padEnd(17)} ${String(sum).padStart(6)} rows`, sum > 0,
    parts.length > 1 ? `(${parts.join(', ')})` : parts[0] === undefined ? '(none)' : '');
}

// Anything present in the window that is NOT on the alias map reads as zero.
const all = rows(`physiological_data?select=parameter_type&${q}&limit=2000`);
const offMap = [...new Set(all.map((r) => r.parameter_type))]
  .filter((t) => !Object.values(ALIASES).flat().includes(t));
check('no off-map parameter_type', offMap.length === 0,
  offMap.length ? warn(`UNREADABLE: ${offMap.join(', ')}`) : '');

if (readable === 0) {
  console.log(`\n${warn('NOTHING ARRIVED in this window. Remaining checks are vacuous.')}`);
  console.log('  Look at: is 3035 up, did the widen land, did the publisher run,');
  console.log('  and does the device resolve (rpc get_device_current_patient).\n');
  process.exit(1);
}

// ── 2. tenant ──────────────────────────────────────────────────────────────
console.log('\n2. TENANT');
const total = count(`physiological_data?select=id&${q}`);
const right = count(`physiological_data?select=id&${q}&hospital_id=eq.${TENANT}`);
const thr = count(`physiological_data?select=id&${q}&hospital_id=eq.thr_main`);
const nul = count(`physiological_data?select=id&${q}&hospital_id=is.null`);
check(`hospital_id='${TENANT}' on every row`, right === total, `${right}/${total}`);
check('zero rows under thr_main', thr === 0, thr ? warn(`${thr} INVISIBLE ROWS`) : '');
check('zero rows with null tenant', nul === 0, nul ? warn(`${nul} rows`) : '');

// ── 3. the two clocks ──────────────────────────────────────────────────────
// A swap puts readings in the wrong 06:00-anchored study day. recorded_at is
// the DEVICE/clinical clock, received_at is receipt, so received_at >= recorded_at
// and the gap is ingest lag. Equality means someone assigned one from the other.
console.log('\n3. TIMESTAMPS (recorded_at = clinical, received_at = receipt)');
const sample = rows(
  `physiological_data?select=parameter_type,value,recorded_at,received_at&${q}` +
  `&order=recorded_at.desc&limit=200`);
const lags = sample
  .filter((r) => r.received_at && r.recorded_at)
  .map((r) => (Date.parse(r.received_at) - Date.parse(r.recorded_at)) / 1000);
const negative = lags.filter((l) => l < -1).length;
const identical = lags.filter((l) => l === 0).length;
const med = lags.length ? lags.slice().sort((a, b) => a - b)[Math.floor(lags.length / 2)] : NaN;
check('received_at is not BEFORE recorded_at (not swapped)', negative === 0,
  negative ? warn(`${negative}/${lags.length} rows negative — CLOCKS ARE SWAPPED`) : `median lag ${med}s`);
check('lag is plausible (0-300s)', Number.isFinite(med) && med >= 0 && med <= 300, `median ${med}s`);
if (identical === lags.length) {
  console.log(`  [${warn('NOTE')}] every row has received_at === recorded_at exactly.`);
  console.log('         Real ingest should show a small positive lag. Identical values are');
  console.log('         what the SEED does deliberately — check you are not reading seed rows.');
}
const srcs = [...new Set((rows(`physiological_data?select=device_source&${q}&limit=500`))
  .map((r) => r.device_source))];
console.log(`  device_source in window: ${srcs.join(', ') || '(none)'}`);
if (srcs.length === 1 && srcs[0] === 'test') {
  console.log(`  [${warn('NOTE')}] only 'test' rows — these are SEEDED, not device data.`);
}

// ── 4. genuine zero ────────────────────────────────────────────────────────
// `x || null` turns 0 into null. Sustained rr === 0 IS the apnea definition, so
// this is the difference between detecting apnea and not recording it.
if (has('expect-zero')) {
  console.log('\n4. GENUINE ZERO SURVIVAL');
  for (const [canonical, list] of Object.entries(ALIASES)) {
    const inList = list.map((a) => `"${a}"`).join(',');
    const zeros = count(
      `physiological_data?select=id&${q}&parameter_type=in.(${inList})&value=eq.0`);
    const nulls = count(
      `physiological_data?select=id&${q}&parameter_type=in.(${inList})&value=is.null`);
    check(`${canonical.padEnd(17)} 0 landed as 0`, zeros > 0,
      zeros ? `${zeros} zero rows` : warn(`no zeros; ${nulls} NULLs — '|| null' coercion`));
  }
}

// ── 4b. the widen's own guarantees ─────────────────────────────────────────
console.log('\n4b. WIDEN-SPECIFIC');

// The FE timeline filters .in('parameter_type', ['heart_rate','spo2']) with NO
// aliasing, so 'oxygen_saturation' rows are invisible to it even though the
// engine accepts them. New rows must say 'spo2' exactly.
const spo2Exact = count(`physiological_data?select=id&${q}&parameter_type=eq.spo2`);
const spo2Alias = count(`physiological_data?select=id&${q}&parameter_type=eq.oxygen_saturation`);
check("SpO2 written as 'spo2' (the FE timeline does not alias)", spo2Exact > 0,
  spo2Alias > 0 ? warn(`${spo2Alias} rows are 'oxygen_saturation' — invisible to the FE timeline`) : `${spo2Exact}`);

// metadata->>'device_id' is what finally makes a vitals row resolvable back to
// a trinity_device. Without it a row cannot be attributed to a bed.
const withDevice = count(`physiological_data?select=id&${q}&metadata->>device_id=not.is.null`);
check("metadata->>'device_id' set (row is resolvable to a device)",
  withDevice === readable, `${withDevice}/${readable}`);

// No unique constraint on (patient_id, parameter_type, recorded_at) yet
// (20260911 NOT APPLIED), so a QoS-1 reconnect replay duplicates rows — which
// inflates the sample count every dROSE coverage percentage is computed from.
const keyed = rows(`physiological_data?select=parameter_type,recorded_at&${q}&limit=5000`);
const keys = keyed.map((r) => `${r.parameter_type}@${r.recorded_at}`);
const dupes = keys.length - new Set(keys).size;
check('no duplicate (parameter_type, recorded_at) rows', dupes === 0,
  dupes ? warn(`${dupes} duplicates — replay inflates dROSE coverage %; apply 20260911`) : '');

// ── 5. FiO2 + temperature stay on vital_signs, keyed on observed_at ────────
console.log('\n5. vital_signs (FiO2 + temperature — unchanged path, read on observed_at)');
const vsQ = `patient_id=eq.${PATIENT}&observed_at=gte.${SINCE}`;
const fio2 = count(`vital_signs?select=id&${vsQ}&fraction_inspired_oxygen=not.is.null`);
const temp = count(`vital_signs?select=id&${vsQ}&temperature=not.is.null`);
const noObs = count(`vital_signs?select=id&patient_id=eq.${PATIENT}&observed_at=is.null`);
check('temperature rows with observed_at set', temp > 0, `${temp}`);
check('fraction_inspired_oxygen rows with observed_at set', fio2 > 0,
  fio2 ? `${fio2}` : warn('0 — needs the Drager device; none is provisioned for bcch'));
if (noObs > 0) console.log(`  [${warn('NOTE')}] ${noObs} vital_signs rows for this patient have NULL observed_at — invisible to getFio2Samples.`);

console.log(`\n${failures === 0 ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : `\x1b[31m${failures} CHECK(S) FAILED\x1b[0m`}\n`);
process.exit(failures === 0 ? 0 : 1);
