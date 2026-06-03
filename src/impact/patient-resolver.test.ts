import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { clearCache, resolvePatientId } from './patient-resolver.js';

type FetchArgs = Parameters<typeof fetch>;
type MockResponse = {
  status: number;
  ok?: boolean;
  json?: () => Promise<unknown>;
};

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
const originalFetch = globalThis.fetch;

function mockFetch(response: MockResponse | Error): void {
  globalThis.fetch = (async (...args: FetchArgs) => {
    const [url, init] = args;
    fetchCalls.push({ url: String(url), init: init as RequestInit });
    if (response instanceof Error) {
      throw response;
    }
    return {
      status: response.status,
      ok: response.ok ?? (response.status >= 200 && response.status < 300),
      json: response.json ?? (async () => ({})),
      text: async () => '',
    } as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  fetchCalls = [];
  clearCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('resolvePatientId', () => {
  it('returns patient_id on 200 success', async () => {
    mockFetch({
      status: 200,
      json: async () => ({
        status: 'success',
        data: { patient_id: 'bb000001-0000-0000-0000-000000000001' },
      }),
    });

    const result = await resolvePatientId('TRIN-001', 'bcch');
    assert.equal(result, 'bb000001-0000-0000-0000-000000000001');
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0]!.url.endsWith('/api/v1/devices/TRIN-001/patient'));
  });

  it('returns null on 404', async () => {
    mockFetch({ status: 404 });
    const result = await resolvePatientId('TRIN-unknown', 'bcch');
    assert.equal(result, null);
  });

  it('caches successful lookups for repeat calls within TTL', async () => {
    mockFetch({
      status: 200,
      json: async () => ({
        status: 'success',
        data: { patient_id: 'bb000001-0000-0000-0000-000000000001' },
      }),
    });

    const first = await resolvePatientId('TRIN-002', 'bcch');
    const second = await resolvePatientId('TRIN-002', 'bcch');
    const third = await resolvePatientId('TRIN-002', 'bcch');

    assert.equal(first, 'bb000001-0000-0000-0000-000000000001');
    assert.equal(second, first);
    assert.equal(third, first);
    // Only ONE network call should have been made.
    assert.equal(fetchCalls.length, 1);
  });

  it('caches 404 (null) for repeat calls within TTL', async () => {
    mockFetch({ status: 404 });

    const first = await resolvePatientId('TRIN-unassigned', 'bcch');
    const second = await resolvePatientId('TRIN-unassigned', 'bcch');

    assert.equal(first, null);
    assert.equal(second, null);
    assert.equal(fetchCalls.length, 1);
  });

  it('returns null on 5xx error and does NOT cache', async () => {
    mockFetch({ status: 500 });
    const first = await resolvePatientId('TRIN-003', 'bcch');
    assert.equal(first, null);
    assert.equal(fetchCalls.length, 1);

    // Next call should hit the network again (no cache for errors).
    mockFetch({
      status: 200,
      json: async () => ({
        status: 'success',
        data: { patient_id: 'bb000003-0000-0000-0000-000000000003' },
      }),
    });
    const second = await resolvePatientId('TRIN-003', 'bcch');
    assert.equal(second, 'bb000003-0000-0000-0000-000000000003');
    assert.equal(fetchCalls.length, 2);
  });

  it('returns null when network throws (timeout/abort/connection refused)', async () => {
    mockFetch(new Error('connection refused'));
    const result = await resolvePatientId('TRIN-004', 'bcch');
    assert.equal(result, null);
    assert.equal(fetchCalls.length, 1);
  });

  it('returns null on 2xx with malformed body', async () => {
    mockFetch({
      status: 200,
      json: async () => ({ status: 'success', data: {} }), // no patient_id
    });
    const result = await resolvePatientId('TRIN-005', 'bcch');
    assert.equal(result, null);
  });

  it('sends X-Ingest-Key and X-Hospital-ID headers', async () => {
    mockFetch({
      status: 200,
      json: async () => ({
        status: 'success',
        data: { patient_id: 'bb000001-0000-0000-0000-000000000001' },
      }),
    });
    await resolvePatientId('TRIN-006', 'bcch');
    const headers = fetchCalls[0]!.init?.headers as
      | Record<string, string>
      | undefined;
    assert.ok(headers, 'fetch should receive headers');
    assert.ok(headers!['X-Ingest-Key'], 'X-Ingest-Key should be set');
    assert.equal(headers!['X-Hospital-ID'], 'bcch');
  });

  it('URL-encodes the trinity_code path segment', async () => {
    mockFetch({ status: 404 });
    await resolvePatientId('weird/trinity:code', 'bcch');
    assert.ok(fetchCalls[0]!.url.includes('weird%2Ftrinity%3Acode'));
  });

  it('keeps cache entries per (trinityCode, hospitalId) pair', async () => {
    mockFetch({
      status: 200,
      json: async () => ({
        status: 'success',
        data: { patient_id: 'bb000099-0000-0000-0000-000000000099' },
      }),
    });
    await resolvePatientId('TRIN-007', 'bcch');
    await resolvePatientId('TRIN-007', 'bcch'); // cached
    await resolvePatientId('TRIN-007', 'other-hospital'); // different key

    assert.equal(fetchCalls.length, 2);
  });
});
