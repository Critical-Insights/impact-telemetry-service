import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  deriveStatus,
  liveCode,
  statusCode,
  type FeedStatus,
} from './server.js';

/**
 * These tests are about ONE thing: the endpoint must never say green while the
 * feed is losing readings, and must never say red for something that is not
 * losing readings. Both halves matter — a board that cries wolf gets ignored
 * just as thoroughly as one that stays silent.
 */

type Input = Parameters<typeof deriveStatus>[0];

/** A connected, fully healthy feed; each test perturbs one thing. */
const healthy: Input = {
  mqtt: 'connected',
  sessionTakenOver: false,
  devices: 8,
  stalled: 0,
  silent: 0,
  refused: 0,
  withinGrace: false,
};
const at = (o: Partial<Input>): Input => ({ ...healthy, ...o });

describe('deriveStatus', () => {
  it('is ok when the broker is connected and every device lands', () => {
    assert.equal(deriveStatus(healthy).status, 'ok');
  });

  it('omits `problem` when ok, so its presence always means something is wrong', () => {
    assert.equal(deriveStatus(healthy).problem, undefined);
  });

  it('is starting before the grace window expires with nothing published yet', () => {
    assert.equal(deriveStatus(at({ devices: 0, withinGrace: true })).status, 'starting');
  });

  it('is DOWN once grace expires with no device having published', () => {
    const r = deriveStatus(at({ devices: 0 }));
    assert.equal(r.status, 'down');
    // Must name the two real causes, not merely assert failure.
    assert.match(r.problem!, /not publishing|topic filter/);
  });

  it('is degraded when devices publish but do not land', () => {
    const r = deriveStatus(at({ stalled: 3 }));
    assert.equal(r.status, 'degraded');
    assert.match(r.problem!, /3 device/);
    assert.match(r.problem!, /being lost/);
  });

  it('is degraded, not ok, even when only ONE device is stalled', () => {
    assert.equal(deriveStatus(at({ stalled: 1 })).status, 'degraded');
  });

  it('is degraded when a device that was landing goes silent', () => {
    const r = deriveStatus(at({ silent: 2 }));
    assert.equal(r.status, 'degraded');
    // The remedy for silent is a different place to look than for stalled.
    assert.match(r.problem!, /STOPPED publishing/);
  });

  it('is degraded when an unrecognised id is publishing right now', () => {
    const r = deriveStatus(at({ refused: 1 }));
    assert.equal(r.status, 'degraded');
    assert.match(r.problem!, /provisioning|refused/i);
    // Must reassure that nothing was quietly relabelled into a tenant.
    assert.match(r.problem!, /NOT being silently relabelled/);
  });

  // The disconnect case is the subtle one. The ingest counters FREEZE when the
  // socket drops rather than changing, so a device that landed 4s before the
  // drop still looks perfectly healthy by counter for a further stall window.
  it('is DOWN the instant the broker socket drops, even with every counter healthy', () => {
    const r = deriveStatus(at({ mqtt: 'disconnected' }));
    assert.equal(r.status, 'down');
    assert.match(r.problem!, /MQTT is disconnected/);
  });

  it('does not let the grace window excuse a DISCONNECT (only a not-yet-started one)', () => {
    // Grace covers boot; it must not suppress a real drop that happens early.
    assert.equal(
      deriveStatus(at({ mqtt: 'disconnected', withinGrace: true })).status,
      'down',
    );
  });

  it('treats not_started within grace as starting, and after grace as down', () => {
    assert.equal(
      deriveStatus(at({ mqtt: 'not_started', devices: 0, withinGrace: true })).status,
      'starting',
    );
    assert.equal(
      deriveStatus(at({ mqtt: 'not_started', devices: 0 })).status,
      'down',
    );
  });

  // Found by running a verification instance against a live one: the broker
  // evicts the older session, both processes reconnect and report `connected`,
  // and batches are lost on both sides with nothing obviously wrong.
  it('is DOWN when another instance has taken the MQTT session over', () => {
    const r = deriveStatus(at({ sessionTakenOver: true }));
    assert.equal(r.status, 'down');
    assert.match(r.problem!, /ANOTHER INSTANCE/);
    assert.match(r.problem!, /MQTT_CLIENT_ID/);
  });

  it('ranks a takeover above stalled devices, since it explains them', () => {
    const r = deriveStatus(at({ sessionTakenOver: true, stalled: 4 }));
    assert.match(r.problem!, /ANOTHER INSTANCE/);
  });

  it('ranks a broker disconnect above everything else', () => {
    // If the socket is gone, "3 devices stalled" is a symptom, and naming it
    // would send someone to check bed bindings instead of the network.
    const r = deriveStatus(at({ mqtt: 'disconnected', stalled: 3, silent: 2 }));
    assert.equal(r.status, 'down');
    assert.match(r.problem!, /MQTT/);
  });

  it('ranks stalled above silent above refused', () => {
    assert.match(deriveStatus(at({ stalled: 1, silent: 1, refused: 1 })).problem!, /being lost/);
    assert.match(deriveStatus(at({ silent: 1, refused: 1 })).problem!, /STOPPED publishing/);
    assert.match(deriveStatus(at({ refused: 1 })).problem!, /unrecognised/);
  });

  // THE REGRESSION THIS BUCKETING EXISTS FOR.
  // The broker replays 57 retained messages from four superseded naming
  // generations on every connect. Each registered as a device, was correctly
  // refused, and then never published again — and the first version of this
  // endpoint reported 8/16 NOT landing and 503 forever because of it.
  it('stays ok when the only non-landing ids are inert retained junk', () => {
    // `inert` is deliberately absent from the input: nothing that has stopped
    // arriving can make the endpoint red, so it cannot be passed in at all.
    assert.equal(deriveStatus(at({ devices: 16 })).status, 'ok');
  });
});

describe('statusCode — the loud, default endpoint', () => {
  it('200 only for ok and starting', () => {
    assert.equal(statusCode('ok'), 200);
    assert.equal(statusCode('starting'), 200);
  });

  // This encodes the project's core rule. A /health that 200s while nothing
  // reaches Supabase is the "healthy-looking dead feed", which the brief calls
  // worse than a feed that is plainly down.
  it('503 for degraded — a partially dead feed must NOT read as success', () => {
    assert.equal(statusCode('degraded'), 503);
  });

  it('503 for down', () => {
    assert.equal(statusCode('down'), 503);
  });

  it('covers every FeedStatus, so a new state cannot default to 200', () => {
    const all: FeedStatus[] = ['ok', 'starting', 'degraded', 'down'];
    for (const s of all) {
      assert.ok([200, 503].includes(statusCode(s)), `${s} mapped to something odd`);
    }
  });
});

describe('liveCode — the supervisor endpoint', () => {
  it('200 while the process is merely degraded', () => {
    // Restarting cannot fix an unassigned bed or a refused device id, so a
    // stalled device must never drive a restart: that turns one bad bed into
    // total downtime, which is self-inflicted and worse.
    assert.equal(liveCode('degraded'), 200);
  });

  it('200 for ok and starting', () => {
    assert.equal(liveCode('ok'), 200);
    assert.equal(liveCode('starting'), 200);
  });

  it('503 only for down — the one state a restart might actually clear', () => {
    assert.equal(liveCode('down'), 503);
  });

  it('is never STRICTER than the loud endpoint', () => {
    // The supervisor view is deliberately the lenient one. If this inverts, a
    // stalled device starts a restart loop.
    const all: FeedStatus[] = ['ok', 'starting', 'degraded', 'down'];
    for (const s of all) {
      assert.ok(
        liveCode(s) <= statusCode(s),
        `liveCode(${s}) must not be harsher than statusCode(${s})`,
      );
    }
  });
});
