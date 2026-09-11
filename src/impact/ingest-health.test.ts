import { beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { config } from '../config.js';
import { classify, record, recordRefusal, reset, snapshot } from './ingest-health.js';
import type { PostResult } from './poster.js';

const DEV = 'sim-bcch-bed-01-philips-monitor';
const OTHER = 'sim-bcch-bed-03-philips-monitor';

const landed: PostResult = {
  kind: 'success',
  status: 201,
  inserted: 1,
  physiological_rows_written: 3,
  physiological_fields_sent: 3,
};

beforeEach(() => reset());

describe('classify', () => {
  it('treats a 2xx that wrote physiological rows as landed', () => {
    assert.equal(classify(landed).landed, true);
  });

  // THE point of this module. A 201 with zero rows written is `response.ok`,
  // so anything branching on the status alone counts it as a success while the
  // engine's table stays empty.
  it('treats a 2xx that wrote ZERO physiological rows as NOT landed', () => {
    const v = classify({
      kind: 'success',
      status: 201,
      inserted: 1,
      physiological_rows_written: 0,
      records_failed: 1,
      physiological_fields_sent: 3,
    });
    assert.equal(v.landed, false);
    assert.equal(v.cause, 'wrote_nothing');
    assert.match(v.detail!, /physiological_rows_written=0/);
    assert.match(v.detail!, /records_failed=1/);
  });

  // A server predating the widen cannot report the field at all. Absent is not
  // zero, and calling it a stall would alarm on a correctly working old build.
  it('treats an ABSENT physiological_rows_written as landed, not as zero', () => {
    assert.equal(
      classify({ kind: 'success', status: 201, inserted: 1, physiological_fields_sent: 3 }).landed,
      true,
    );
  });

  // A ventilator batch carries only FiO2, which is a vital_signs COLUMN and
  // never a parameter_type, so zero physiological rows is CORRECT. Warning on
  // it once a second per ventilator would make the alarm worthless.
  it('treats a FiO2-only batch writing zero physiological rows as LANDED', () => {
    const v = classify({
      kind: 'success',
      status: 201,
      inserted: 1,
      physiological_rows_written: 0,
      physiological_fields_sent: 0,
    });
    assert.equal(v.landed, true);
  });

  it('separates an unassigned bed from a batch with nothing mappable', () => {
    assert.equal(
      classify({ kind: 'skipped', reason: 'no patient resolved' }).cause,
      'no_patient_resolved',
    );
    assert.equal(
      classify({ kind: 'skipped', reason: 'no mapped vitals' }).cause,
      'no_mapped_vitals',
    );
  });

  it('surfaces the 502 reason codes in the detail', () => {
    const v = classify({
      kind: 'error',
      status: 502,
      message: 'IMPACT returned 502: ...',
      reasons: ['tenant_unresolvable', 'insert_failed'],
    });
    assert.equal(v.cause, 'post_error');
    assert.match(v.detail!, /tenant_unresolvable, insert_failed/);
  });
});

describe('stall detection', () => {
  const t0 = 1_800_000_000_000;
  const skip: PostResult = { kind: 'skipped', reason: 'no patient resolved' };

  it('does not escalate a short run of skips', () => {
    for (let i = 0; i < 10; i += 1) record(OTHER, skip, t0 + i * 1000);
    assert.equal(snapshot(t0 + 10_000).stalled.length, 0);
  });

  it('reports a device that has never landed once the window is exceeded', () => {
    record(OTHER, skip, t0);
    const after = t0 + config.IMPACT_UNHEALTHY_AFTER_MS + 1000;
    record(OTHER, skip, after);
    const s = snapshot(after);
    assert.equal(s.stalled.length, 1);
    assert.equal(s.stalled[0]!.device_id, OTHER);
    assert.equal(s.stalled[0]!.never_landed, true);
    assert.equal(s.stalled[0]!.dominant_cause, 'no_patient_resolved');
  });

  // A device that streamed fine and then stopped landing is a DIFFERENT
  // failure from one that never worked, and the study cares about both.
  it('reports a device that landed and then stopped', () => {
    record(DEV, landed, t0);
    const after = t0 + config.IMPACT_UNHEALTHY_AFTER_MS + 5000;
    record(DEV, { kind: 'error', status: 502, message: 'boom' }, after);
    const s = snapshot(after);
    assert.equal(s.stalled.length, 1);
    assert.equal(s.stalled[0]!.never_landed, false);
    assert.equal(s.stalled[0]!.dominant_cause, 'post_error');
  });

  it('clears the stall as soon as a reading lands', () => {
    record(DEV, skip, t0);
    const after = t0 + config.IMPACT_UNHEALTHY_AFTER_MS + 1000;
    record(DEV, skip, after);
    assert.equal(snapshot(after).stalled.length, 1);
    record(DEV, landed, after + 500);
    assert.equal(snapshot(after + 500).stalled.length, 0);
  });

  it('tracks devices independently, so one bad bed does not mask a good one', () => {
    const after = t0 + config.IMPACT_UNHEALTHY_AFTER_MS + 1000;
    record(DEV, landed, t0);
    record(OTHER, skip, t0);
    record(DEV, landed, after);
    record(OTHER, skip, after);
    const s = snapshot(after);
    assert.equal(s.devices, 2);
    assert.equal(s.landing, 1);
    assert.deepEqual(s.stalled.map((d) => d.device_id), [OTHER]);
  });

  it('counts causes so the dominant one can be named', () => {
    record(DEV, skip, t0);
    record(DEV, skip, t0 + 1000);
    record(DEV, { kind: 'dry_run', would_post: {} as never }, t0 + 2000);
    const s = snapshot(t0 + 2000);
    assert.equal(s.totals.attempts, 3);
    assert.equal(s.totals.landed, 0);
    assert.equal(s.totals.by_cause.no_patient_resolved, 2);
    assert.equal(s.totals.by_cause.dry_run_mode, 1);
  });
});

/**
 * The four-bucket classification.
 *
 * Added after running the endpoint against the real broker, which holds 57
 * retained messages from four superseded device-naming generations. Every one
 * registered as a device, was correctly refused as an unknown id, and then
 * never published again — so the first version reported "8/16 devices NOT
 * landing" and 503 for the life of the process. An alarm that is always on is
 * the same as no alarm.
 */
describe('activity bucketing', () => {
  const t0 = 1_800_000_000_000;
  const W = config.IMPACT_UNHEALTHY_AFTER_MS;
  const refusal: PostResult = { kind: 'skipped', reason: 'refused: unknown_device' };

  it('puts an actively-publishing, non-landing device in `stalled`', () => {
    const err: PostResult = { kind: 'error', status: 502, message: 'boom' };
    record(DEV, err, t0);
    // Still publishing at the far end of the window, still nothing landed.
    record(DEV, err, t0 + W + 1000);
    const s = snapshot(t0 + W + 1000);
    assert.equal(s.stalled.length, 1);
    assert.equal(s.silent.length, 0);
    assert.equal(s.alarming, 1);
  });

  it('holds a brand-new non-landing device in `settling`, not `stalled`', () => {
    // One failed batch is ordinary. Alarming on it would make the endpoint
    // useless within a second of boot, which is how the grace window earns
    // its keep — the same reason the original stall test exists.
    record(DEV, { kind: 'error', status: 502, message: 'boom' }, t0);
    const s = snapshot(t0);
    assert.equal(s.settling, 1);
    assert.equal(s.stalled.length, 0);
    assert.equal(s.alarming, 0);
  });

  it('moves a device that STOPS publishing from stalled to `silent`', () => {
    record(DEV, landed, t0);
    // Nothing further arrives; well past the window it is silent, not stalled.
    const s = snapshot(t0 + W + 1000);
    assert.equal(s.stalled.length, 0);
    assert.equal(s.silent.length, 1);
    assert.equal(s.silent[0]!.device_id, DEV);
    // Both clocks are reported: it landed once, and has been quiet since.
    assert.equal(s.silent[0]!.never_landed, false);
    assert.ok(s.silent[0]!.silent_for_ms >= W);
    // A bed going quiet IS worth waking someone for.
    assert.equal(s.alarming, 1);
  });

  it('puts a CURRENTLY-publishing unknown id in `refused`, and alarms', () => {
    recordRefusal('bed-99-monitor', 'unknown_device', 'not in allowlist', t0);
    const s = snapshot(t0);
    assert.equal(s.refused.length, 1);
    assert.equal(s.inert.length, 0);
    // A real bed that is being refused must be loud — its data is going
    // nowhere, and the fix is provisioning, not a restart.
    assert.equal(s.alarming, 1);
  });

  // THE REGRESSION. A retained message arrives once at connect and never
  // again; it must not hold the board red for the life of the process.
  it('demotes a refused id that has stopped arriving to `inert`, NOT alarming', () => {
    recordRefusal('dev-retained-e2e-check-01', 'unknown_device', 'retained junk', t0);
    const s = snapshot(t0 + W + 1000);
    assert.equal(s.refused.length, 0);
    assert.equal(s.inert.length, 1);
    assert.equal(s.inert[0]!.device_id, 'dev-retained-e2e-check-01');
    assert.equal(s.alarming, 0, 'retained junk must not raise an alarm');
  });

  it('still counts inert ids in `devices` and in cause totals — ignored, not hidden', () => {
    recordRefusal('old-generation-device', 'unknown_device', 'retained', t0);
    const s = snapshot(t0 + W + 1000);
    assert.equal(s.devices, 1);
    assert.equal(s.totals.by_cause.refused_unknown_device, 1);
  });

  it('reports a healthy feed alongside inert junk as fully ok', () => {
    // The real shape of this broker: 8 live devices landing, 8 retained ids.
    for (let i = 1; i <= 8; i += 1) record(`bed-0${i}`, landed, t0 + W);
    for (let i = 1; i <= 8; i += 1) {
      recordRefusal(`junk-${i}`, 'unknown_device', 'retained', t0);
    }
    const s = snapshot(t0 + W);
    assert.equal(s.devices, 16);
    assert.equal(s.landing, 8);
    assert.equal(s.inert.length, 8);
    assert.equal(s.alarming, 0, 'this is the state that used to read 8/16 and 503');
  });

  it('a device refused ONCE but otherwise landing is not treated as an unknown id', () => {
    // refusedOnly requires EVERY attempt to have been a refusal, so a known
    // device with one odd batch stays in the normal stalled/landing logic.
    recordRefusal(DEV, 'unknown_device', 'one-off', t0);
    record(DEV, landed, t0 + 100);
    const s = snapshot(t0 + 100);
    assert.equal(s.refused.length, 0);
    assert.equal(s.inert.length, 0);
    assert.equal(s.landing, 1);
  });
});
