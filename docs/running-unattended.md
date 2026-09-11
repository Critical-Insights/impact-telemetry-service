# Running unattended

This service has died twice the same way: started from an interactive shell,
it went away when the shell did, and nobody noticed for days while the monitors
kept publishing to no one.

- 2026-09-04 22:49:55Z — stopped with the session that started it. Six days of
  monitor output arrived at the broker with no subscriber attached.
- Before that, the same shape of failure is what left `physiological_data`
  empty from 16 July.

Nothing in an 18-month study can depend on a person remembering to restart a
process. This document is the two pieces that fix it: a **supervisor**, so the
process comes back by itself, and a **health endpoint**, so "it came back" is
something you can check rather than assume.

---

## 1. The health endpoint

Two routes, deliberately different, because two different things ask.

### `GET /health` — for humans and the liveness board

Returns **503 whenever the feed is not delivering**, not merely when the
process is wedged. This is the opposite of the usual convention and it is the
point: a 200 that means "the process is running" while nothing reaches Supabase
is precisely the feed that *appears healthy while writing rows nothing can
read*, which is worse than a feed that is plainly down.

| `status`   | HTTP | Meaning | What to do |
|------------|------|---------|-----------|
| `ok`       | 200  | Broker connected, every live device landing. | Nothing. |
| `starting` | 200  | Inside the grace window, nothing to judge yet. | Wait `grace_s`. |
| `degraded` | 503  | Connected, but readings are being lost. | Read `problem`. |
| `down`     | 503  | Broker gone, session stolen, or nothing publishing at all. | Read `problem`. |

Every non-`ok` response carries a `problem` string that names the thing to go
and fix, and `feed.remedies` maps each active cause to its remedy. You should
not need to read the source to action a red board.

### `GET /health/live` — for the supervisor

Narrow: 200 unless `status` is `down`. A stalled device must **not** trigger a
restart — restarting cannot fix an unassigned bed or an unprovisioned device
id, and a restart loop would turn one bad bed into total downtime.

### Reading `feed`

Devices are bucketed by *recent activity* as well as by landing, because those
are different failures with different fixes:

| Bucket | Meaning | Alarms? |
|--------|---------|---------|
| `landing` | Landed a reading within the window. | — |
| `settling` | Publishing, nothing landed yet, still inside the window. | No |
| `stalled` | Publishing **now**, not landing. Readings are being lost. | **Yes** |
| `silent` | Was landing, has stopped publishing entirely. | **Yes** |
| `refused` | Unrecognised device id publishing **now**. Provisioning gap. | **Yes** |
| `inert` | Unrecognised id that arrived once and stopped. Retained junk. | No |

`inert` exists because of a real defect found by running this against the live
broker. EMQX holds **57 retained messages** spanning four superseded
device-naming generations, replayed to every subscriber on connect. Each
registered as a device, was correctly refused, then never published again — so
the endpoint read `8/16 devices NOT landing` and 503 **for the life of the
process**. An alarm that is always on is the same as no alarm. Those ids are
still counted and listed; they simply cannot make the board red, because
nothing is being lost.

---

## 2. Install the supervisor (macOS)

```bash
npm run build
./deploy/install-launchd.sh --dry-run   # render the plist, change nothing
./deploy/install-launchd.sh             # install and start
```

To stop it:

```bash
./deploy/uninstall-launchd.sh
```

`KeepAlive` is `true`, so **`kill` will not stop this service** — launchd
restarts it within `ThrottleInterval` (10s). That is intentional: a stray
signal must not be able to end the study's data collection quietly. Stopping it
is a deliberate act, and `uninstall-launchd.sh` is how you perform it.

| | |
|---|---|
| Status | `launchctl print gui/$UID/com.criticalinsights.impact-telemetry` |
| Health | `curl -s http://127.0.0.1:3036/health` |
| Logs | `tail -f ~/Library/Logs/impact-telemetry/impact-telemetry.log` |
| Restart | `launchctl kickstart -k gui/$UID/com.criticalinsights.impact-telemetry` |

### Secrets are not in the plist

`src/config.ts` does `import 'dotenv/config'`, which reads `.env` relative to
the working directory — so `WorkingDirectory` in the plist is the entire
mechanism by which `MQTT_PASSWORD` and `IMPACT_INGEST_KEY` reach the process.
Putting them in `EnvironmentVariables` would copy live credentials into a
world-readable plist and require re-editing on every rotation. Keep `.env` at
`0600`; the installer checks and warns.

### Known limits of the LaunchAgent

- **It is an agent, not a daemon.** It starts at user *login*, so it does not
  cover an unattended reboot. For the hospital box, use `deploy/systemd/` (or a
  `LaunchDaemon`), which starts at boot with no session.
- **The node path is baked in.** launchd jobs get a minimal `PATH`, so the
  plist stores an absolute path to `node`. Under nvm that path contains the
  version number, so upgrading node moves the binary and the job then fails to
  spawn. Re-run the installer after a node change; it warns when it detects nvm.

### Log rotation

pino writes JSONL to stdout, which launchd appends to a file that grows without
bound. At 1 Hz across 8 devices that is not small. Add
`/etc/newsyslog.d/impact-telemetry.conf`:

```
# logfilename                                                  [owner:group]  mode count size when  flags
/Users/<user>/Library/Logs/impact-telemetry/impact-telemetry.log <user>:staff  644  7     10240 *    GJ
```

---

## 3. The failure mode that costs data silently

**Never run two instances at once.** The service connects with `clean: false`
to keep its QoS-1 queue across reconnects, which requires a *stable*
`MQTT_CLIENT_ID` — so two instances inevitably fight over the same id. The
broker hands the session to whichever connected last and evicts the other with
MQTT 5 reason **142, "session taken over"**. Both then reconnect, evict each
other again, and **both lose batches**, indefinitely.

It is invisible by nature: each process logs a reconnect and otherwise looks
fine. This was found exactly that way — a verification instance started while a
`pnpm dev` was already live.

So the service now detects reason 142 explicitly, logs it at `error` naming the
client id and the fix, and reports `status: down` with a `problem` that says
another instance is running. If you see that, stop one of them — a `pnpm dev`
and the launchd job both running is the usual cause.

The corollary for development: `npm run dev` uses `tsx watch`, which restarts
the process on **every source edit**. Editing this repo while a dev instance is
serving the live feed restarts that feed repeatedly, each restart a short gap.
Stop the dev instance before editing, or accept the gaps.

---

## 4. Configuration

| Variable | Default | Notes |
|---|---|---|
| `HEALTH_ENABLED` | `true` | `false` logs a warning — nothing can then poll whether the feed is landing. |
| `HEALTH_PORT` | `3036` | |
| `HEALTH_BIND` | `127.0.0.1` | Loopback on purpose: the body carries device and bed identifiers, and this process runs inside a hospital network. Widen only for an off-box scraper. |
| `IMPACT_UNHEALTHY_AFTER_MS` | `60000` | Doubles as the boot grace window and the activity window for the buckets above. |

---

## 5. What is still not covered

- **Reboot without login**, per the LaunchAgent note above. The hospital
  deployment needs the systemd unit or a `LaunchDaemon`.
- **Nothing scrapes `/health` yet.** The endpoint exists; wiring it to the
  liveness board so the board shows the *gateway* and not just the database is
  a separate change in the IMPACT server.
- **No alerting.** A 503 nobody polls is still a silent failure.
