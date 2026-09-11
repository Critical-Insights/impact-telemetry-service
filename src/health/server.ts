// A pollable statement of whether the feed is actually delivering.
//
// WHY THIS EXISTS
// ingest-health.ts has known whether each device is landing in Supabase since
// the loudness work, but the only way to read it was to be watching stderr at
// the moment a line scrolled past. That is not a thing an 18-month unattended
// run can rely on, and it leaves the liveness board inferring ingest health
// from the DATABASE — which cannot distinguish a stopped subscriber from a
// quiet night, because both look like "no new rows".
//
// This module turns those counters into an HTTP endpoint, so the board can see
// the GATEWAY directly.
//
// THE STATUS-CODE DECISION, WHICH IS THE WHOLE POINT
// `/health` returns 503 whenever the feed is not landing, not just when the
// process is wedged. That is deliberate and it is the opposite of the usual
// convention, where /health means "am I running". A 200 that means "the
// process is up" while nothing reaches the database is precisely the feed that
// "appears healthy while writing rows nothing can read", and it is worse than
// a feed that is plainly down. So the DEFAULT endpoint is the loud one.
//
// Supervisors need the lenient reading — restarting the process will not fix
// an unassigned bed, and a restart loop driven by a stalled device would be
// self-inflicted downtime. They get `/health/live`, which is narrow, terse,
// and named for its purpose rather than being the default.
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { isMqttConnected, isMqttStarted, wasSessionTakenOver } from '../mqtt/client.js';
import { REMEDY, snapshot, type StallCause } from '../impact/ingest-health.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

let server: Server | null = null;
let startedAt = 0;

/**
 * `ok`       — broker connected and every known device is landing.
 * `starting` — still inside the grace window with nothing to judge yet.
 * `degraded` — connected, but at least one device is not landing.
 * `down`     — broker connection is gone, or the grace window expired with no
 *              device having ever published.
 */
export type FeedStatus = 'ok' | 'starting' | 'degraded' | 'down';

export type HealthBody = {
  status: FeedStatus;
  /** Present only when status is not `ok` — what to actually go and do. */
  problem?: string;
  service: string;
  version: string;
  uptime_s: number;
  /**
   * Grace window from process start. Before it expires, "no device has
   * published yet" is boot rather than breakage; after it, the same state is
   * breakage and says so.
   */
  grace_s: number;
  mqtt: 'connected' | 'disconnected' | 'not_started';
  /** Echoed so a reader of the endpoint alone can tell degraded from intended. */
  mode: {
    ingest: string;
    timescale: 'ok' | 'disabled';
    schema2_shim: boolean;
    hospital_id: string;
  };
  feed: ReturnType<typeof snapshot> & {
    /** Per-cause remedy text for whatever is currently stalled. */
    remedies?: Partial<Record<StallCause, string>>;
  };
};

function withinGrace(now: number): boolean {
  return now - startedAt < config.IMPACT_UNHEALTHY_AFTER_MS;
}

/**
 * The status decision, isolated from any I/O.
 *
 * Pulled out as a pure function because this mapping IS the contract: a board
 * that shows green while nothing lands is the exact failure the endpoint
 * exists to prevent, so the rule has to be assertable without binding a port
 * or owning a live broker socket.
 */
export function deriveStatus(input: {
  mqtt: HealthBody['mqtt'];
  sessionTakenOver: boolean;
  devices: number;
  stalled: number;
  silent: number;
  refused: number;
  withinGrace: boolean;
}): { status: FeedStatus; problem?: string } {
  const graceS = Math.round(config.IMPACT_UNHEALTHY_AFTER_MS / 1000);

  // Ranked hardest-cause-first. Whatever comes back is the thing to go and
  // fix; naming a symptom above its cause sends someone to the wrong place.
  if (input.mqtt !== 'connected') {
    // A dropped socket is reported immediately rather than waiting for the
    // stall window: the counters freeze on disconnect, so "last landed 4s ago"
    // stays true and green for a full minute after the feed has gone.
    if (input.withinGrace && input.mqtt === 'not_started') {
      return { status: 'starting' };
    }
    return {
      status: 'down',
      problem:
        `MQTT is ${input.mqtt}. No observations can arrive at all. Check `
        + 'MQTT_URL, the broker credentials, and network egress to the broker.',
    };
  }

  // Ranked above every data signal, because while it is true the counters are
  // describing batches this process is no longer the one receiving.
  if (input.sessionTakenOver) {
    return {
      status: 'down',
      problem:
        'ANOTHER INSTANCE took over this MQTT session — two processes are '
        + `running with MQTT_CLIENT_ID=${config.MQTT_CLIENT_ID}. The broker `
        + 'hands the subscription to whichever connected last, so the two will '
        + 'steal it back and forth and BOTH will lose batches. Stop one of '
        + 'them (a `pnpm dev` and the launchd job both running is the usual '
        + 'cause), or give one a distinct MQTT_CLIENT_ID.',
    };
  }

  if (input.devices === 0) {
    if (input.withinGrace) return { status: 'starting' };
    return {
      status: 'down',
      problem:
        'Broker connected but NO device has published an observation batch in '
        + `${graceS}s. Either the simulator/gateway is not publishing, or the `
        + `topic filter (${config.MQTT_TOPIC_FILTER}) does not match what it `
        + 'publishes.',
    };
  }

  if (input.stalled > 0) {
    return {
      status: 'degraded',
      problem:
        `${input.stalled} device(s) are publishing but NOT landing in `
        + 'Supabase — those readings are being lost. See '
        + 'feed.stalled[].dominant_cause and feed.remedies.',
    };
  }

  if (input.silent > 0) {
    return {
      status: 'degraded',
      problem:
        `${input.silent} device(s) were landing and have now STOPPED `
        + `publishing for over ${graceS}s. Check the bed, the gateway, and the `
        + 'network path from it. See feed.silent[].',
    };
  }

  if (input.refused > 0) {
    return {
      status: 'degraded',
      problem:
        `${input.refused} unrecognised device id(s) are publishing RIGHT NOW `
        + 'and are being refused, so their readings are going nowhere. If one '
        + 'is a real bed it needs provisioning (allowlist + device row); it is '
        + 'NOT being silently relabelled. See feed.refused[].',
    };
  }

  return { status: 'ok' };
}

/**
 * Assemble the full health picture.
 *
 * Exported (and taking `now`) so the semantics can be tested without binding a
 * port — the status/code mapping is the part that must not drift, since a board
 * showing green off a 503 body is the failure this file exists to prevent.
 */
export function buildHealth(now = Date.now()): HealthBody {
  const feed = snapshot(now);

  const mqtt: HealthBody['mqtt'] = !isMqttStarted()
    ? 'not_started'
    : isMqttConnected()
      ? 'connected'
      : 'disconnected';

  const { status, problem } = deriveStatus({
    mqtt,
    sessionTakenOver: wasSessionTakenOver(),
    devices: feed.devices,
    stalled: feed.stalled.length,
    silent: feed.silent.length,
    refused: feed.refused.length,
    withinGrace: withinGrace(now),
  });

  // Attach remedy text for exactly the causes currently in play, so whoever is
  // reading at 3am is told what to do rather than handed an enum.
  let remedies: Partial<Record<StallCause, string>> | undefined;
  const causes = new Set(
    [...feed.stalled, ...feed.silent, ...feed.refused]
      .map((s) => s.dominant_cause)
      .filter((c): c is StallCause => c !== null),
  );
  if (causes.size > 0) {
    remedies = {};
    for (const c of causes) remedies[c] = REMEDY[c];
  }

  return {
    status,
    ...(problem ? { problem } : {}),
    service: 'impact-telemetry-service',
    version: pkg.version,
    uptime_s: Math.round((now - startedAt) / 1000),
    grace_s: Math.round(config.IMPACT_UNHEALTHY_AFTER_MS / 1000),
    mqtt,
    mode: {
      ingest: config.IMPACT_INGEST_MODE,
      timescale: feed.timescale,
      schema2_shim: config.SCHEMA2_SHIM_ENABLED,
      hospital_id: config.IMPACT_HOSPITAL_ID,
    },
    feed: { ...feed, ...(remedies ? { remedies } : {}) },
  };
}

/**
 * HTTP status for the loud endpoint.
 *
 * `starting` is 200 on purpose: during boot "nothing has landed yet" is true
 * and not a fault, and a 503 there would have a supervisor kill the process
 * before it ever connected. Everything else that is not `ok` is 503, because
 * the endpoint's job is to be believed when it says green.
 */
export function statusCode(status: FeedStatus): number {
  return status === 'ok' || status === 'starting' ? 200 : 503;
}

/**
 * HTTP status for the supervisor endpoint.
 *
 * Narrow by design: it answers "is this process wedged", not "is the data
 * good". A stalled device must NOT restart the process — the restart cannot
 * fix an unassigned bed or a refused device id, and a crash loop would turn a
 * single bad bed into total downtime.
 */
export function liveCode(status: FeedStatus): number {
  return status === 'down' ? 503 : 200;
}

export function startHealthServer(): void {
  if (server) return;
  if (!config.HEALTH_ENABLED) {
    logger.warn(
      'HEALTH ENDPOINT DISABLED (HEALTH_ENABLED=false) — nothing can poll '
      + 'whether this feed is landing. The liveness board will have to infer '
      + 'ingest health from the database, which cannot tell a stopped '
      + 'subscriber from a quiet night.',
    );
    return;
  }

  startedAt = Date.now();

  const s = createServer((req, res) => {
    // Path only; a query string must not turn a known route into a 404.
    const path = (req.url ?? '/').split('?')[0];
    const send = (code: number, body: unknown) => {
      const json = JSON.stringify(body, null, 2);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(json),
      });
      res.end(json);
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, { error: 'method_not_allowed', allow: 'GET' });
      return;
    }

    if (path === '/health' || path === '/') {
      const body = buildHealth();
      send(statusCode(body.status), body);
      return;
    }

    if (path === '/health/live') {
      const body = buildHealth();
      send(liveCode(body.status), {
        status: body.status,
        mqtt: body.mqtt,
        uptime_s: body.uptime_s,
      });
      return;
    }

    send(404, {
      error: 'not_found',
      routes: ['/health', '/health/live'],
    });
  });

  s.on('error', (err) => {
    // A port clash must not be survivable-but-silent: if the endpoint is not
    // listening, everything downstream believes it is unmonitored-but-fine.
    logger.error(
      { err, port: config.HEALTH_PORT, bind: config.HEALTH_BIND },
      'health endpoint FAILED to listen — this feed is now unmonitored',
    );
  });

  s.listen(config.HEALTH_PORT, config.HEALTH_BIND, () => {
    logger.info(
      {
        url: `http://${config.HEALTH_BIND}:${config.HEALTH_PORT}/health`,
        supervisor_url: `http://${config.HEALTH_BIND}:${config.HEALTH_PORT}/health/live`,
      },
      'health endpoint listening',
    );
  });
  s.unref();
  server = s;
}

export async function stopHealthServer(): Promise<void> {
  const s = server;
  if (!s) return;
  server = null;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

/** Test helper: pretend the process started `ms` ago. */
export function setStartedAtForTest(ms: number): void {
  startedAt = ms;
}
