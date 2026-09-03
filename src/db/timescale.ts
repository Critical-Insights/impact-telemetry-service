// TimescaleDB (Tiger Cloud) connection pool and lifecycle.
//
// ── WHY THE POOL IS LAZY ───────────────────────────────────────────────────
// Reading the CA off disk, parsing TIMESCALE_URL and constructing the Pool all
// used to happen at MODULE IMPORT. Three handlers import this file, so merely
// importing the handler chain did that work — which means a `TIMESCALE_ENABLED`
// check around initDb() would not have been a real skip. Everything below is
// therefore deferred to the first getPool() call, and getPool() throws if it is
// reached while Timescale is disabled (that would be a bug in the caller's
// guard, and it should be loud rather than a silent no-op).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!config.TIMESCALE_ENABLED) {
    throw new Error(
      'getPool() called while TIMESCALE_ENABLED=false — the caller is missing '
      + 'its config.TIMESCALE_ENABLED guard.',
    );
  }
  if (pool) return pool;

  // Tiger Cloud presents a private root (CN=ca.timescale.com), so we pin its CA
  // and verify the full chain (including hostname) rather than trusting system CAs.
  const ca = readFileSync(resolve(config.TIMESCALE_CA_PATH), 'utf8');

  // node-postgres merges the connection string OVER the explicit `ssl` option, so a
  // `sslmode` in the URL would clobber our pinned CA (and verify against system CAs
  // instead). Strip it so our `ssl` config is authoritative.
  // TIMESCALE_URL is guaranteed present here: config's superRefine makes it
  // required whenever TIMESCALE_ENABLED is true.
  const connectionUrl = new URL(config.TIMESCALE_URL!);
  connectionUrl.searchParams.delete('sslmode');

  pool = new Pool({
    connectionString: connectionUrl.toString(),
    ssl: { ca, rejectUnauthorized: true },
  });

  // Background/idle client errors must not crash the process.
  pool.on('error', (err) => {
    logger.error({ err }, 'unexpected error on idle timescale client');
  });

  return pool;
}

export async function initDb(): Promise<void> {
  const result = await getPool().query<{ version: string }>('SELECT version() AS version');
  const version = result.rows[0]?.version ?? 'unknown';
  logger.info({ version }, 'timescale connection ok');
}

export async function shutdownDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
