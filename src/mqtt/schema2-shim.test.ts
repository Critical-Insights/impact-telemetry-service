import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  parseSchema2Topic,
  resolveIdentity,
  normaliseSchema2Body,
  DEVICE_ALLOWLIST,
  SHORT_METRIC_TO_MDC,
} from './schema2-shim.js';
import { mdcToImpact } from '../lib/impact-mapping.js';

const LIVE_TOPIC =
  'hospitals/example-hospital/units/example-nicu/devices/bed-01-monitor/observations';

describe('parseSchema2Topic', () => {
  it('parses the observed 7-segment topic', () => {
    assert.deepEqual(parseSchema2Topic(LIVE_TOPIC), {
      sourceHospitalId: 'example-hospital',
      unitId: 'example-nicu',
      deviceId: 'bed-01-monitor',
      leaf: 'observations',
    });
  });

  it('returns null for the 5-segment 1.0 topic, leaving it to the 1.0 parser', () => {
    assert.equal(
      parseSchema2Topic('hospitals/bcch/devices/sim-bcch-bed-01-philips-monitor/observations'),
      null,
    );
  });

  it('returns null for near-miss shapes', () => {
    assert.equal(parseSchema2Topic('hospitals/h/units/u/devices/d'), null);
    assert.equal(parseSchema2Topic('hospitals/h/rooms/u/devices/d/observations'), null);
    assert.equal(parseSchema2Topic('hospitals/h/units//devices/d/observations'), null);
  });
});

describe('resolveIdentity — allowlist, never a rewrite', () => {
  it('resolves an allowlisted device to its trinity_code and tenant', () => {
    const r = resolveIdentity(parseSchema2Topic(LIVE_TOPIC)!);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.trinityCode, 'sim-bcch-bed-01-philips-monitor');
    assert.equal(r.ok && r.hospitalId, 'bcch');
  });

  // THE invariant. A blanket example-hospital -> bcch rewrite would accept data
  // of any origin and relabel it BCCH; only a written-down device may do that.
  it('REFUSES an unknown device instead of relabelling it', () => {
    const r = resolveIdentity({
      sourceHospitalId: 'example-hospital',
      unitId: 'example-nicu',
      deviceId: 'bed-99-monitor',
      leaf: 'observations',
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'unknown_device');
  });

  // A device id is a generic string; it is not proof of origin.
  it('REFUSES an allowlisted device arriving under an unexpected origin', () => {
    const r = resolveIdentity({
      sourceHospitalId: 'somewhere-else',
      unitId: 'example-nicu',
      deviceId: 'bed-01-monitor',
      leaf: 'observations',
    });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, 'unexpected_source_hospital');
  });

  it('never yields a tenant other than bcch', () => {
    for (const entry of Object.values(DEVICE_ALLOWLIST)) {
      assert.equal(entry.hospitalId, 'bcch');
    }
  });
});

describe('normaliseSchema2Body', () => {
  const body = {
    message_type: 'DeviceObservationBatch',
    schema_version: '2.0',
    unique_device_identifier: 'bed-01-monitor',
    hospital_id: 'example-hospital',
    unit_id: 'example-nicu',
    bed_id: 'bed-01',
    simulated: true,
    vendor: 'philips',
    presentation_time: '2026-09-03T22:54:26Z',
    observations: [
      { metric_id: 'HR', quality: 'valid', timestamp: '2026-09-03T22:54:26.496277Z', unit_id: 'bpm', value: 144.74 },
      { metric_id: 'SPO2', quality: 'valid', timestamp: '2026-09-03T22:54:26.496277Z', unit_id: 'percent', value: 0 },
    ],
  };
  const topic = parseSchema2Topic(LIVE_TOPIC)!;
  const identity = { trinityCode: 'sim-bcch-bed-01-philips-monitor', hospitalId: 'bcch' };
  const out = normaliseSchema2Body(body, identity, topic) as any;

  it('replaces the identity with the allowlisted one', () => {
    assert.equal(out.unique_device_identifier, 'sim-bcch-bed-01-philips-monitor');
    assert.equal(out.hospital_id, 'bcch');
  });

  it('translates short metric ids to the MDC ids impact-mapping speaks', () => {
    assert.equal(out.observations[0].metric_id, 'NOM_ECG_CARD_BEAT_RATE');
    assert.equal(out.observations[1].metric_id, 'NOM_PULS_OXIM_SAT_O2');
  });

  it('maps units to MDC unit codes', () => {
    assert.equal(out.observations[0].unit_id, 'NOM_DIM_BEAT_PER_MIN');
    assert.equal(out.observations[1].unit_id, 'NOM_DIM_PERCENT');
  });

  it("carries 2.0's `timestamp` across to `device_time`", () => {
    assert.equal(out.observations[0].device_time, '2026-09-03T22:54:26.496277Z');
  });

  // A genuine zero must survive the shim, not just the writer. Apnea is rr === 0.
  it('preserves a genuine zero', () => {
    assert.equal(out.observations[1].value, 0);
  });

  it('passes an unknown metric through so it surfaces as unmapped, not vanished', () => {
    const o = normaliseSchema2Body(
      { observations: [{ metric_id: 'ETCO2', unit_id: 'mmhg', value: 5 }] },
      identity, topic,
    ) as any;
    assert.equal(o.observations[0].metric_id, 'ETCO2');
  });
});

// The chain that actually matters: short id -> MDC -> the IMPACT body field
// that Oscar's writer turns into a parameter_type the reader matches.
describe('short metric -> canonical reader name, end to end', () => {
  it('HR/SPO2/RR reach the physiological_data canonical names', () => {
    assert.equal(mdcToImpact(SHORT_METRIC_TO_MDC.HR!), 'heart_rate');
    assert.equal(mdcToImpact(SHORT_METRIC_TO_MDC.SPO2!), 'spo2');
    // body field `rr` is what the widen maps to parameter_type respiratory_rate
    assert.equal(mdcToImpact(SHORT_METRIC_TO_MDC.RR!), 'rr');
  });

  it('TEMP and FIO2 map to vital_signs-only fields, NOT physiological_data', () => {
    assert.equal(mdcToImpact(SHORT_METRIC_TO_MDC.TEMP!), 'temperature');
    assert.equal(mdcToImpact(SHORT_METRIC_TO_MDC.FIO2!), 'fio2');
  });
});
