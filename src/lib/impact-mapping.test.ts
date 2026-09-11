import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenBatchToImpactRecord } from './impact-mapping.js';
import type { DeviceObservationBatch } from '../types/canonical.js';
import type { Observation } from '../types/canonical.js';

const PT = '2026-05-30T00:22:17.800Z';

function ob(
  metric_id: string,
  value: number | null,
  quality: Observation['quality'] = 'valid',
  instance_id = 0,
  unit_id = 'NOM_DIM_X',
): Observation {
  return {
    metric_id,
    vendor_metric_id: metric_id,
    instance_id,
    unit_id,
    value,
    quality,
    device_time: null,
  };
}

function batch(
  observations: Observation[],
  overrides: Partial<DeviceObservationBatch> = {},
): DeviceObservationBatch {
  return {
    schema_version: '1.0',
    message_type: 'DeviceObservationBatch',
    unique_device_identifier: 'sim-bcch-bed-01-philips-monitor',
    presentation_time: PT,
    hospital_id: 'bcch',
    unit_id: 'nicu',
    bed_id: 'bcch-nicu-bed-01',
    simulated: true,
    gateway_id: 'jetson-bcch-01',
    vendor: 'philips',
    protocol: 'intellivue_udp',
    observations,
    ...overrides,
  };
}

test('1. full valid Philips batch maps every metric, nothing unmapped', () => {
  const { record, unmapped } = flattenBatchToImpactRecord(
    batch([
      ob('NOM_ECG_CARD_BEAT_RATE', 145, 'valid', 0, 'NOM_DIM_BEAT_PER_MIN'),
      ob('NOM_PULS_OXIM_SAT_O2', 96, 'valid', 0, 'NOM_DIM_PERCENT'),
      ob('NOM_RESP_RATE', 46, 'valid', 0, 'NOM_DIM_RESP_PER_MIN'),
      ob('NOM_TEMP', 36.8, 'valid', 0, 'NOM_DIM_DEGC'),
    ]),
  );
  assert.equal(record.heart_rate, 145);
  assert.equal(record.spo2, 96);
  assert.equal(record.rr, 46);
  assert.equal(record.temperature, 36.8);
  assert.equal(record.device_id, 'sim-bcch-bed-01-philips-monitor');
  assert.equal(record.bed_id, 'bcch-nicu-bed-01');
  assert.equal(record.presentation_time, PT);
  assert.deepEqual(unmapped, []);
});

test('2. Dräger FiO2 batch -> fio2 set, unmapped empty', () => {
  const { record, unmapped } = flattenBatchToImpactRecord(
    batch(
      [ob('NOM_VENT_CONC_AWAY_O2', 28.0, 'valid', 0, 'NOM_DIM_PERCENT')],
      {
        unique_device_identifier: 'sim-bcch-bed-01-drager-ventilator',
        vendor: 'drager',
        protocol: 'drager_sim',
      },
    ),
  );
  assert.equal(record.fio2, 28.0);
  assert.deepEqual(unmapped, []);
});

test('3. lead_off observation -> field null + non-valid quality unmapped', () => {
  const { record, unmapped } = flattenBatchToImpactRecord(
    batch([ob('NOM_ECG_CARD_BEAT_RATE', null, 'lead_off')]),
  );
  assert.equal(record.heart_rate, null);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0]?.metric_id, 'NOM_ECG_CARD_BEAT_RATE');
  assert.ok(unmapped[0]?.reason.startsWith('non-valid quality'));
});

test('4. unknown metric -> unmapped "no MDC→IMPACT mapping", no field set', () => {
  const { record, unmapped } = flattenBatchToImpactRecord(
    batch([ob('NOM_ECG_ELEC_POTL_II', 1.2, 'valid')]),
  );
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0]?.metric_id, 'NOM_ECG_ELEC_POTL_II');
  assert.equal(unmapped[0]?.reason, 'no MDC→IMPACT mapping');
  // No vital field affected.
  assert.equal(record.heart_rate, undefined);
  assert.equal(record.spo2, undefined);
  assert.equal(record.temperature, undefined);
});

test('5. duplicate metric -> instance_id 0 wins, instance_id 1 unmapped', () => {
  const { record, unmapped } = flattenBatchToImpactRecord(
    batch([
      ob('NOM_TEMP', 36.8, 'valid', 0, 'NOM_DIM_DEGC'),
      ob('NOM_TEMP', 37.5, 'valid', 1, 'NOM_DIM_DEGC'),
    ]),
  );
  assert.equal(record.temperature, 36.8);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0]?.metric_id, 'NOM_TEMP');
  assert.equal(unmapped[0]?.reason, 'duplicate field (instance_id 1)');
});

test('6. empty observations -> only envelope fields, unmapped empty', () => {
  const { record, unmapped } = flattenBatchToImpactRecord(batch([]));
  assert.deepEqual(record, {
    device_id: 'sim-bcch-bed-01-philips-monitor',
    bed_id: 'bcch-nicu-bed-01',
    presentation_time: PT,
  });
  assert.deepEqual(unmapped, []);
});

test('7. deviceIdOverride wins over batch.unique_device_identifier', () => {
  const { record } = flattenBatchToImpactRecord(
    batch([ob('NOM_ECG_CARD_BEAT_RATE', 145, 'valid', 0, 'NOM_DIM_BEAT_PER_MIN')]),
    'topic-device-id',
  );
  assert.equal(record.device_id, 'topic-device-id');
  // Mapped vitals are unaffected by the override.
  assert.equal(record.heart_rate, 145);
});

// ── CLINICALLY MEANINGFUL ZEROS ────────────────────────────────────────────
// Added after mutation testing: replacing `record[field] = winner.value` with
// `winner.value || null` passed the entire suite. Nothing checked the one
// property the study depends on most, so a future refactor toward the very
// common `|| null` idiom would have silently deleted the readings that matter
// and left 76 green tests behind.
//
// A zero here is not a missing value. It is the event being studied.

test('rr = 0 (APNOEA) survives as 0 and is never coerced to null', () => {
  const { record } = flattenBatchToImpactRecord(batch([ob('NOM_RESP_RATE', 0)]));
  assert.equal(record.rr, 0);
  assert.notEqual(record.rr, null);
});

test('heart_rate = 0 (ASYSTOLE) survives as 0', () => {
  const { record } = flattenBatchToImpactRecord(
    batch([ob('NOM_ECG_CARD_BEAT_RATE', 0)]),
  );
  assert.equal(record.heart_rate, 0);
});

test('spo2 = 0 survives as 0', () => {
  const { record } = flattenBatchToImpactRecord(
    batch([ob('NOM_PULS_OXIM_SAT_O2', 0)]),
  );
  assert.equal(record.spo2, 0);
});

test('a zero reading is reported, not listed as unmapped', () => {
  // The other way to lose a zero is to treat it as "nothing to map".
  const { record, unmapped } = flattenBatchToImpactRecord(
    batch([ob('NOM_RESP_RATE', 0), ob('NOM_PULS_OXIM_SAT_O2', 98)]),
  );
  assert.equal(record.rr, 0);
  assert.equal(record.spo2, 98);
  assert.deepEqual(unmapped, []);
});

// ── QUALITY GATE ───────────────────────────────────────────────────────────
// Also found by mutation: passing a non-valid reading through as a real number
// was caught by nothing. IMPACT has no quality concept, so a lead-off ECG
// value would be stored as though a monitor had measured it.

test('a non-valid reading becomes null, never the raw value', () => {
  const { record, unmapped } = flattenBatchToImpactRecord(
    batch([ob('NOM_ECG_CARD_BEAT_RATE', 250, 'lead_off')]),
  );
  assert.equal(record.heart_rate, null);
  assert.equal(unmapped.length, 1);
  assert.match(unmapped[0]!.reason, /non-valid quality: lead_off/);
});

test('the quality gate applies even when the bad reading is a zero', () => {
  // Belt and braces: a lead-off 0 must NOT be preserved by the zero rule
  // above. Valid-zero and invalid-zero are different things.
  const { record } = flattenBatchToImpactRecord(
    batch([ob('NOM_RESP_RATE', 0, 'lead_off')]),
  );
  assert.equal(record.rr, null);
});

test('one bad-quality reading does not discard the good ones beside it', () => {
  const { record } = flattenBatchToImpactRecord(
    batch([
      ob('NOM_ECG_CARD_BEAT_RATE', 250, 'lead_off'),
      ob('NOM_RESP_RATE', 0),
      ob('NOM_PULS_OXIM_SAT_O2', 95),
    ]),
  );
  assert.equal(record.heart_rate, null);
  assert.equal(record.rr, 0);
  assert.equal(record.spo2, 95);
});
