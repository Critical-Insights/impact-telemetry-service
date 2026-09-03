# Proposal: make TimescaleDB optional — PROPOSED, NOT APPLIED

**Status:** design only. No code changed. Awaiting god/Dhruv's go-ahead.
**Why now:** Tiger Cloud (`ajlxehfq7h…tsdb.cloud.timescale.com:33199`) is unreachable — TCP connect fails. `initDb()` throws in `main()`, `main().catch` calls `process.exit(1)`, and the service never reaches `startMqtt()`. A hosted dependency being down takes the entire feed with it.

---

## Recommended shape: an explicit flag, `TIMESCALE_ENABLED` (default `true`)

```
TIMESCALE_ENABLED=false     # skip Timescale entirely this run
```

When `true` (the default), `TIMESCALE_URL` stays **required** and an unreachable database is still a **fatal startup error**.
When `false`, `TIMESCALE_URL` and `TIMESCALE_CA_PATH` are not read, not parsed, and not connected.

### Why a flag and not "absent URL means off"

god asked which of the three. I recommend the flag, and the reason is the goal's own rule about silent failure.

- **Absent-URL-means-off makes the most dangerous state the easiest to reach by accident.** A typo'd, truncated, or dropped `TIMESCALE_URL` would silently become "provenance store disabled" and the service would come up looking healthy. Losing the time-series copy of an 18-month clinical study should never be reachable by a missing character.
- **A flag makes disabling a deliberate, auditable act.** Someone has to write `TIMESCALE_ENABLED=false`. It shows in a diff and in the startup log.
- **Default `true` preserves today's behaviour.** An existing deployment that upgrades keeps failing loudly if Timescale is down, rather than quietly degrading to half the sinks.
- **It collapses four states into two.** Flag-plus-URL would allow "flag on + no URL" and "flag off + URL set", both contradictory, and someone eventually hits them. With the flag authoritative, `TIMESCALE_URL` is simply ignored when disabled.

### It must be a CLEAN skip, and that takes more than an `if`

`src/db/timescale.ts` has **import-time side effects** — these run when the module is *imported*, before any function is called:

```
src/db/timescale.ts:10   const ca = readFileSync(resolve(config.TIMESCALE_CA_PATH), 'utf8')
src/db/timescale.ts:15   const connectionUrl = new URL(config.TIMESCALE_URL)
src/db/timescale.ts:19   export const pool = new Pool({ … })
```

and three handlers import `pool` at top level (`observations.ts:2`, `identity.ts:2`, `connectivity.ts:3`). So merely guarding `initDb()` is not enough — importing the handler chain still reads the CA off disk, parses the URL and constructs a pool.

Two ways to make the skip real:

1. **Lazy accessor (recommended, smallest diff).** Keep the module, move `ca` / `connectionUrl` / `pool` behind a `getPool()` that throws if called while disabled, and have the handlers call `getPool()` instead of importing `pool`. Then guard the three write sites with `if (config.TIMESCALE_ENABLED)`.
2. **Dynamic import.** `const db = config.TIMESCALE_ENABLED ? await import('./db/timescale.js') : null`. Fewer edits in `timescale.ts`, but pushes a nullable module object through every call site — worse to read.

Either way `zod` must make `TIMESCALE_URL` conditionally required: `.optional()` on the field plus a `superRefine` that fails when `TIMESCALE_ENABLED === true && !TIMESCALE_URL`, so "enabled but unconfigured" is still a startup error naming the variable.

### Explicitly NOT a per-batch try/catch

A caught-and-logged failure per batch would emit one line per write attempt — at 1 Hz × 7 beds × 2 devices that is **840 error lines a minute**, which is its own kind of silence. The whole point of `src/impact/ingest-health.ts` is that noise and silence fail the same way. The skip is decided **once, at startup**.

### What the startup log says — a skip must never look like a misconfig

Disabled, at **`warn`** (not `info` — this is a degraded mode, and it should be visible in a log filtered to warnings):

```
WARN  TIMESCALE DISABLED (TIMESCALE_ENABLED=false) — observations will NOT be
      written to the time-series store. Supabase via the IMPACT API is the ONLY
      sink this run. Set TIMESCALE_ENABLED=true to restore the provenance copy.
```

Enabled and working, at `info`: the existing `timescale connection ok` line with the server version.

Enabled and unreachable: unchanged — **fatal**, naming the host and port.

Enabled but no URL: fatal at config parse, naming `TIMESCALE_URL`.

The four states produce four different, unambiguous lines, so "deliberately skipped" can never be confused with "silently misconfigured".

**And it must stay visible after boot.** A startup line scrolls away in an 18-month run, so `startHeartbeat()` in `ingest-health.ts` should carry `timescale: 'disabled' | 'ok'` in its periodic summary. Degraded mode should be legible from any single log line, not only from the one printed at 3am on day one.

---

## What is lost while disabled — say it plainly

- **The provenance copy.** Timescale holds raw MDC ids, full `DOUBLE PRECISION` values, the `quality` column, the device's own clock, and the `simulated` flag. The Supabase copy has none of those (rounded integers, quality flattened to null, gateway clock only).
- **The only record of readings for unassigned beds.** A bed with no patient never reaches Supabase — the poster skips before the HTTP call. Timescale is currently the *only* place those readings exist. While disabled they are gone for good.
- The comment in `observations.ts` that the IMPACT post happens after "the Timescale insert already succeeded" stops being true and should be reworded in the same change.

None of that blocks tonight's Supabase-only run. All of it argues for Timescale being *relocated* rather than dropped — which the brief already puts outside tonight's scope.
