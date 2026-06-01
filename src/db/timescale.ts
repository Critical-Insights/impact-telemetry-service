// TimescaleDB (Tiger Cloud) connection pool and lifecycle.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Tiger Cloud presents a private root (CN=ca.timescale.com), so we pin its CA
// and verify the full chain (including hostname) rather than trusting system CAs.
const ca = readFileSync(resolve(config.TIMESCALE_CA_PATH), 'utf8');

// node-postgres merges the connection string OVER the explicit `ssl` option, so a
// `sslmode` in the URL would clobber our pinned CA (and verify against system CAs
// instead). Strip it so our `ssl` config is authoritative.
const connectionUrl = new URL(config.TIMESCALE_URL);
connectionUrl.searchParams.delete('sslmode');

// Singleton connection pool.
export const pool = new Pool({
  connectionString: connectionUrl.toString(),
  ssl: { ca, rejectUnauthorized: true },
});

// Background/idle client errors must not crash the process.
pool.on('error', (err) => {
  logger.error({ err }, 'unexpected error on idle timescale client');
});

export async function initDb(): Promise<void> {
  const result = await pool.query<{ version: string }>('SELECT version() AS version');
  const version = result.rows[0]?.version ?? 'unknown';
  logger.info({ version }, 'timescale connection ok');
}

export async function shutdownDb(): Promise<void> {
  await pool.end();
}
