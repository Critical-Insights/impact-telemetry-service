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
