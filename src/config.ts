import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // MQTT (EMQX Cloud)
  MQTT_URL: z.string().min(1, 'MQTT_URL is required'),
  MQTT_USERNAME: z.string().min(1, 'MQTT_USERNAME is required'),
  MQTT_PASSWORD: z.string().min(1, 'MQTT_PASSWORD is required'),
  MQTT_CLIENT_ID: z.string().default('impact-telemetry-01'),
  MQTT_TOPIC_FILTER: z.string().default('hospitals/#'),

  // TimescaleDB (Tiger Cloud)
  // Disabling the provenance store must be a DELIBERATE act, never the side
  // effect of a dropped or typo'd URL — so the flag is authoritative and
  // defaults to on. When it is false, TIMESCALE_URL is not read, not parsed
  // and not connected; when it is true, a missing URL is a fatal config error
  // (see superRefine below) and an unreachable server is a fatal startup error.
  TIMESCALE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  TIMESCALE_URL: z.string().min(1).optional(),
  // Path to Tiger Cloud's CA cert (PEM) for TLS verification.
  TIMESCALE_CA_PATH: z.string().default('certs/timescale-ca.pem'),

  // Logging
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  // Numeric batching
  NUMERIC_BATCH_INTERVAL_MS: z.coerce.number().int().positive().default(100),
  NUMERIC_BATCH_MAX_SIZE: z.coerce.number().int().positive().default(500),

  // WebSocket broadcast
  WS_PORT: z.coerce.number().int().positive().default(8080),
  WS_SHARED_SECRET: z.string().min(1, 'WS_SHARED_SECRET is required'),

  // IMPACT API (clinical backend)
  IMPACT_API_URL: z.string().url('IMPACT_API_URL must be a valid URL'),
  IMPACT_HOSPITAL_ID: z.string().min(1, 'IMPACT_HOSPITAL_ID is required'),
  IMPACT_INGEST_KEY: z.string().min(1, 'IMPACT_INGEST_KEY is required'),
  IMPACT_INGEST_MODE: z.enum(['dry-run', 'live']).default('dry-run'),
  IMPACT_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),

  // Ingest health / loudness.
  // A device that keeps ATTEMPTING for this long without landing a single
  // reading in Supabase is escalated from info to error. 60s at 1 Hz is 60
  // missed readings — long enough not to fire on a transient, short enough
  // that nobody loses a night of study data to a silent skip.
  IMPACT_UNHEALTHY_AFTER_MS: z.coerce.number().int().positive().default(60_000),
  // How often a still-stalled device restates its error. One line per batch
  // would be 840/min across 7 beds, which is its own kind of silence.
  IMPACT_ESCALATE_EVERY_MS: z.coerce.number().int().positive().default(60_000),
  // Whole-feed summary interval. Unattended operation needs a line that
  // appears even when nothing changes, so silence can be told from a crash.
  IMPACT_HEARTBEAT_MS: z.coerce.number().int().positive().default(60_000),

  // ── DEMO SHIM (schema 2.0) — see src/mqtt/schema2-shim.ts ────────────────
  // Whether to accept the simulator's schema-2.0 messages (7-segment topics,
  // short metric ids, non-BCCH identifiers) by normalising them to the 1.0
  // contract. Off by default: it is a shim, not architecture. A 2.0 topic
  // arriving while this is off is WARNED about, never silently dropped.
  SCHEMA2_SHIM_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

// `TIMESCALE_URL` is required only when Timescale is enabled. Expressing that
// here rather than at the call site means "enabled but unconfigured" fails at
// startup, naming the variable, instead of surfacing later as a connect error.
const envSchemaChecked = envSchema.superRefine((cfg, ctx) => {
  if (cfg.TIMESCALE_ENABLED && !cfg.TIMESCALE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TIMESCALE_URL'],
      message:
        'TIMESCALE_URL is required when TIMESCALE_ENABLED=true. '
        + 'Set TIMESCALE_ENABLED=false to run without the time-series store.',
    });
  }
});

const parsed = envSchemaChecked.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export type Config = z.infer<typeof envSchemaChecked>;

export const config: Config = parsed.data;
