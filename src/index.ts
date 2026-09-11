import { createRequire } from 'node:module';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { initDb, shutdownDb } from './db/timescale.js';
import { startMqtt, shutdownMqtt } from './mqtt/client.js';
import { startHeartbeat, stopHeartbeat } from './impact/ingest-health.js';
import { startHealthServer, stopHealthServer } from './health/server.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  stopHeartbeat();
  try {
    await stopHealthServer();
  } catch (err) {
    logger.error({ err }, 'error stopping health endpoint');
  }
  try {
    await shutdownMqtt();
  } catch (err) {
    logger.error({ err }, 'error stopping mqtt');
  }
  try {
    await shutdownDb();
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
  }
  process.exit(0);
}

async function main(): Promise<void> {
  logger.info(
    { version: pkg.version, topicFilter: config.MQTT_TOPIC_FILTER },
    'impact-telemetry-service starting',
  );

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Four states, four unambiguous lines — a deliberate skip must never be
  // mistakable for a silent misconfiguration. (Enabled-but-no-URL is already
  // fatal at config parse; enabled-but-unreachable stays fatal here.)
  if (config.TIMESCALE_ENABLED) {
    await initDb();
    logger.info('connected to timescale');
  } else {
    logger.warn(
      'TIMESCALE DISABLED (TIMESCALE_ENABLED=false) — observations will NOT be '
      + 'written to the time-series store. Supabase via the IMPACT API is the '
      + 'ONLY sink this run. Set TIMESCALE_ENABLED=true to restore the '
      + 'provenance copy.',
    );
  }

  // Started BEFORE the broker connect, deliberately. If connecting hangs or
  // fails, the endpoint is already answering and reports `mqtt: not_started`
  // — a subscriber stuck at boot is otherwise indistinguishable from one that
  // was never launched, which is the state that went unnoticed for weeks.
  startHealthServer();

  await startMqtt();

  // Whole-feed summary on an interval. In an 18-month unattended run this is
  // the line that tells silence apart from a dead subscriber.
  startHeartbeat();

  // TODO: wire up WebSocket server.
  // Keep the process alive until a termination signal arrives.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error during startup');
  process.exit(1);
});
