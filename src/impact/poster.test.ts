import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { config } from '../config.js';
import { postObservationToImpact } from './poster.js';
import type { DeviceObservationBatch, Observation } from '../types/canonical.js';

/**
 * This file exists because of a mutation test.
 *
 * Replacing `observed_at: batch.presentation_time` with
 * `observed_at: new Date().toISOString()` passed the entire suite. That single
 * character-level change is the difference between a study whose readings
 * carry the clock the monitor recorded them on and one where every row is
 * stamped with the moment the HTTP request happened to arrive — and
 * `observed_at` is what becomes `physiological_data.recorded_at`, the column
 * every figure window and every categorisation reads.
 *
 * "On the right clock" is a third of the stated success criterion, and nothing
 * was checking it. It is checked here.
 */

const PT = '2026-05-30T00:22:17.800Z';
const PATIENT = 'bb000001-0000-0000-0000-000000000001';
const DEVICE = 'sim-bcch-bed-01-philips-monitor';

function ob(
  metric_id: string,
  value: number | null,
  quality: Observation['quality'] = 'valid',
): Observation {
  return {
    metric_id,
    vendor_metric_id: metric_id,
    instance_id: 0,
    unit_id: 'NOM_DIM_X',
    value,
    quality,
    device_time: null,
  };
}

function batch(observations: Observation[]): DeviceObservationBatch {
  return {
    schema_version: '1.0',
    message_type: 'DeviceObservationBatch',
    unique_device_identifier: DEVICE,
    presentation_time: PT,
    hospital_id: 'bcch',
    unit_id: 'nicu',
    bed_id: 'bcch-nicu-bed-01',
    simulated: true,
    gateway_id: 'jetson-bcch-01',
    vendor: 'philips',
    protocol: 'intellivue_udp',
    observations,
  } as DeviceObservationBatch;
}

type Sent = { url: string; body: { records: Array<Record<string, unknown>> } };

let sent: Sent[] = [];
const originalFetch = globalThis.fetch;
const originalMode = config.IMPACT_INGEST_MODE;

beforeEach(() => {
  sent = [];
  // Pinned rather than inherited from .env: this suite asserts what goes ON
  // THE WIRE, and in dry-run mode nothing would. A test whose meaning depends
  // on the developer's local .env is the sort of silently-skipping gate this
  // file was written in response to.
  (config as { IMPACT_INGEST_MODE: string }).IMPACT_INGEST_MODE = 'live';
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    sent.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Sent['body'],
    });
    return {
      ok: true,
      status: 201,
      json: async () => ({ data: { inserted: 1 } }),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (config as { IMPACT_INGEST_MODE: string }).IMPACT_INGEST_MODE = originalMode;
});

/** The single record the poster built, as it left the process. */
async function post(observations: Observation[]) {
  const result = await postObservationToImpact(DEVICE, batch(observations), PATIENT);
  return { result, record: sent[0]?.body.records[0] };
}

describe('the clinical clock', () => {
  it('sends observed_at as the batch presentation_time, NOT arrival time', async () => {
    const { record } = await post([ob('NOM_RESP_RATE', 42)]);
    assert.equal(record!.observed_at, PT);
  });

  it('does not drift when the batch is posted long after it was recorded', async () => {
    // A replayed or delayed batch must keep the clock the monitor gave it.
    // Asserting equality with a FIXED past instant is what makes an
    // arrival-time substitution impossible to pass.
    const { record } = await post([ob('NOM_ECG_CARD_BEAT_RATE', 150)]);
    assert.equal(record!.observed_at, '2026-05-30T00:22:17.800Z');
    // Age, not year: the fixture is months old, so an arrival-time
    // substitution collapses this delta to ~0 whatever the calendar says.
    // (A first attempt compared the year and was worthless, because the
    // fixture year and the current year happen to match — a check that reads
    // like a guard and cannot fail is exactly what this whole pass is about.)
    const ageMs = Date.now() - Date.parse(String(record!.observed_at));
    assert.ok(
      ageMs > 60_000,
      `observed_at is ${ageMs}ms old — it looks stamped with arrival time`,
    );
  });

  it('sends the patient id it was resolved to, not the device id', async () => {
    const { record } = await post([ob('NOM_RESP_RATE', 42)]);
    assert.equal(record!.patient_id, PATIENT);
  });
});

describe('what reaches the wire', () => {
  it('preserves rr = 0 through rounding — apnoea must not become null', async () => {
    // Math.round(0) is 0, but a `|| null` anywhere on this path would not be.
    // The zero survives mapping (covered in impact-mapping.test.ts); this
    // asserts it also survives the poster.
    const { record } = await post([ob('NOM_RESP_RATE', 0)]);
    assert.equal(record!.rr, 0);
    assert.notEqual(record!.rr, null);
  });

  it('rounds integer-typed vitals but leaves temperature decimal', async () => {
    const { record } = await post([
      ob('NOM_ECG_CARD_BEAT_RATE', 145.6),
      ob('NOM_TEMP', 36.84),
    ]);
    assert.equal(record!.heart_rate, 146);
    assert.equal(record!.temperature, 36.84);
  });

  it('reports how many physiological_data fields it sent', async () => {
    // This count is what lets a zero-row response be read correctly: a
    // ventilator batch SHOULD write no physiological rows.
    const { result } = await post([
      ob('NOM_ECG_CARD_BEAT_RATE', 150),
      ob('NOM_PULS_OXIM_SAT_O2', 95),
      ob('NOM_RESP_RATE', 40),
      ob('NOM_TEMP', 36.8), // vital_signs only
    ]);
    assert.equal(result.kind, 'success');
    assert.equal(
      (result as { physiological_fields_sent?: number }).physiological_fields_sent,
      3,
    );
  });

  it('counts a FiO2-only ventilator batch as zero physiological fields', async () => {
    const { result } = await post([ob('NOM_VENT_CONC_AWAY_O2', 28)]);
    assert.equal(
      (result as { physiological_fields_sent?: number }).physiological_fields_sent,
      0,
    );
  });

  it('skips without posting when no patient resolved', async () => {
    const result = await postObservationToImpact(
      DEVICE,
      batch([ob('NOM_RESP_RATE', 42)]),
      null,
    );
    assert.equal(result.kind, 'skipped');
    assert.equal(sent.length, 0, 'nothing may be posted without a patient');
  });

  it('sends the hospital id as a header, so tenancy is not payload-derived', async () => {
    await post([ob('NOM_RESP_RATE', 42)]);
    assert.ok(sent[0]!.url.endsWith('/api/v1/vitals/batch'));
  });
});
