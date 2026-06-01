import { createRequire } from 'node:module';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { initDb, shutdownDb } from './db/timescale.js';
import { startMqtt, shutdownMqtt } from './mqtt/client.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
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

  await initDb();
  logger.info('connected to timescale');

  await startMqtt();

  // TODO: wire up WebSocket server.
  // Keep the process alive until a termination signal arrives.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal error during startup');
  process.exit(1);
});
