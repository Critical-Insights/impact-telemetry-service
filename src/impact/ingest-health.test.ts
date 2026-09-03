import { beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { config } from '../config.js';
import { classify, record, reset, snapshot } from './ingest-health.js';
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
