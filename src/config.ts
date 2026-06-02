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
  TIMESCALE_URL: z.string().min(1, 'TIMESCALE_URL is required'),
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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export type Config = z.infer<typeof envSchema>;

export const config: Config = parsed.data;
