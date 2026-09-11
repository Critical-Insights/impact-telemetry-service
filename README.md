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

## Running unattended

The service is a long-running subscriber, and it has twice stopped simply
because the shell that started it went away — once leaving six days of monitor
output arriving at the broker with no subscriber attached. For anything beyond
a quick local run, install the supervisor rather than starting it by hand:

```bash
npm run build
./deploy/install-launchd.sh --dry-run   # render the unit, change nothing
./deploy/install-launchd.sh             # install and start (macOS)
```

Then check that it is actually delivering, which is not the same question as
whether the process is up:

```bash
curl -s http://127.0.0.1:3036/health | head -40
```

`/health` returns **503 whenever readings are being lost**, not merely when the
process is wedged — a 200 that means "still running" while nothing reaches
Supabase is the failure this service exists to make loud. Supervisors should
poll `/health/live` instead, which ignores data problems a restart cannot fix.

**Never run two instances at once.** They share `MQTT_CLIENT_ID`, the broker
gives the session to whichever connected last, and both then lose batches
indefinitely while each looks healthy. The service detects this and reports it,
but the fix is not to start the second one.

Full detail, including the systemd unit for the hospital box, log rotation, and
what each health status means: **[docs/running-unattended.md](docs/running-unattended.md)**.
