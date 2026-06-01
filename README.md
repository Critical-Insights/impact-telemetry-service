# impact-telemetry-service

A long-lived Node.js service for a NICU monitoring proof-of-concept. It:

1. Subscribes to MQTT telemetry published by a hospital device gateway (Jetson) via **EMQX Cloud**.
2. Persists samples to **TimescaleDB (Tiger Cloud)** for history.
3. (Planned) Broadcasts live readings over a **WebSocket** to a Next.js frontend.

## Architecture

```
   Hospital device gateway (Jetson)
                │
                │  MQTT publish
                ▼
        ┌───────────────┐
        │   EMQX Cloud   │   (MQTT broker)
        └───────┬───────┘
                │  MQTT subscribe (hospitals/#)
                ▼
   ┌──────────────────────────────────┐
   │      impact-telemetry-service     │
   │                                   │
   │   mqtt/client → handlers/router   │
   │        ├─ numeric                 │
   │        ├─ identity                │
   │        └─ connectivity            │
   │              │            │       │
   │              ▼            ▼       │
   │     db/timescale     ws/server    │
   └──────────────┬────────────┬──────┘
                  │            │
                  ▼            ▼
         TimescaleDB      WebSocket clients
         (Tiger Cloud)    (Next.js frontend)
```

## Prerequisites

- Node.js 20+
- pnpm
- `psql` on your PATH (for running migrations)

## Setup

```bash
# 1. Configure environment
cp .env.example .env
# ...then fill in MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD, TIMESCALE_URL, WS_SHARED_SECRET

# 2. Install dependencies
pnpm install

# 3. Apply database migrations
pnpm run migrate

# 4. Run in watch mode
pnpm dev
```

## Scripts

| Script           | Description                                    |
| ---------------- | ---------------------------------------------- |
| `pnpm dev`       | Run with `tsx watch` (hot reload)              |
| `pnpm build`     | Compile TypeScript to `dist/`                  |
| `pnpm start`     | Run the compiled output                        |
| `pnpm typecheck` | Type-check without emitting                    |
| `pnpm run migrate` | Apply `migrations/*.sql` against `$TIMESCALE_URL` |
