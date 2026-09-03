# Telemetry ingest survey (READ-ONLY)

**Repo surveyed:** `impact-telemetry-service` @ `5b8ce74` (v0.1.0)
**Cross-referenced (read-only):** `IMPACT_BCCH_SERVER` — the reader, and as it turns out the *actual* Supabase writer.
**Author:** Ryan (ingest) · **Date:** 2026-09-03
**Status:** survey only. No code, config or DB was modified. The plan in §9 is **not implemented** and must be reviewed by Oscar first.

---

## TL;DR — the three things that matter

1. **This service never touches Supabase.** It writes TimescaleDB directly, and reaches Supabase only *indirectly* by HTTP POST to `IMPACT_BCCH_SERVER`'s `/api/v1/vitals/batch`. The Supabase INSERT is Oscar's code, not mine. "Dual-write" is really "one direct write + one RPC-over-HTTP".

2. **`physiological_data` has no writer at all.** The engine's primary table — spo2 / heart_rate / respiratory_rate — is fed by *nothing* in either repo. The `/api/v1/vitals/batch` path terminates in RPC `save_patient_vital_signs`, which inserts **only** into `vital_signs`. The empty table is not a tenant bug and not a naming bug; **there is no INSERT statement anywhere that targets it.** This is the single blocking finding and it changes what "connect the Supabase path" means.

3. **The `hospital_id` / `thr_main` question does not bite on the path in use — because that path can't reach the table that has the column.** `vital_signs` has *no tenant column whatsoever* (confirmed in `visionQueries.js:18` and in the SEC-26 migration's exclusion note). The `X-Hospital-ID` header this service sends is consumed by `ingestAuth` to build `req.user` and is **never passed to the RPC or written to any row**. So: no rows are being mis-filed under `thr_main` *today*. But the moment we start writing `physiological_data`, `hospital_id` must be set **explicitly** — the `DEFAULT 'thr_main'` is still live (both fixing migrations are marked ⚠️ NOT APPLIED).

**Secondary finding, clinically serious:** the server-side write **does** coerce genuine zeros to null (`spo2 || null`, `rr || null`). See §3e.

---

## 1. What the service is

| | |
|---|---|
| Language / runtime | TypeScript (ESM, `"type": "module"`), Node ≥ 20, pnpm |
| Entry | `src/index.ts` → `dist/index.js` |
| Start | `pnpm dev` (`tsx watch`) or `pnpm start` (`node --enable-source-maps dist/index.js`) |
| Build state | `dist/` is **fresh** (all `dist/*.js` mtimes newer than their `src/*.ts`), so `pnpm start` runs current code |
| Connects to | EMQX Cloud (MQTT 5, mqtts), TimescaleDB / Tiger Cloud (pg + pinned private CA), IMPACT HTTP API |
| Deployed today | **Nowhere.** No Dockerfile, no systemd unit, no pm2/ecosystem file, no Procfile, no Makefile. |
| Running now | **No.** No `impact-telemetry-service` / `tsx` / `dist/index.js` process on this box (only Cursor extension hosts). |

**Lifecycle.** `main()` → validate env (zod, `src/config.ts`) → `initDb()` (`SELECT version()` smoke test) → `startMqtt()` → `await new Promise(() => {})` to park forever. `SIGINT`/`SIGTERM` drain MQTT then the pg pool. Idle-client pg errors are caught by `pool.on('error')` so a dropped backend does not kill the process.

**Can it run unattended on the simulator box?** Mechanically yes — it is a single long-lived Node process with MQTT auto-reconnect (`reconnectPeriod: 2000`, `clean: false` so the broker session survives). But **not safely unattended as-is**, for four reasons:

- **No supervision.** Nothing restarts it. A fatal startup error calls `process.exit(1)` and that is the end of the study feed. There is no unit file to add `Restart=always` to.
- **No liveness surface.** `src/ws/server.ts` is a stub (`export {}`), and `index.ts` still has `// TODO: wire up WebSocket server`. There is no health endpoint, no heartbeat, no metric. The only evidence it is alive is stdout.
- **Message loss on DB error.** `mqtt.js` acknowledges QoS 1 on receipt, before `routeMessage` runs. `handleObservations` awaits `pool.query` and lets it throw; `routeMessage` catches, logs `'handler failed for message'`, and returns. The message is already acked — **that reading is gone permanently.** For 18 months of study data, a Timescale blip is silent, unrecoverable data loss.
- **Config is currently wrong for live.** `.env` has `IMPACT_INGEST_MODE=live` with `IMPACT_API_URL=http://localhost:3035`, and **nothing is listening on 3035** (probed: connection refused). So every batch currently logs `impact-poster: POST failed` and only Timescale gets the data.

*Also: the publisher is not on this box.* Nothing outside this repo emits `DeviceObservationBatch` anywhere on this machine. The Jetson gateway / Arman's simulator is remote. The only local publisher is the one-shot `scripts/publish-test-batch.mjs`.

---

## 2. One reading, end to end

Topic shape (the ACL boundary; `hospital_id` and `device_id` live **in the topic**, not the payload):

```
hospitals/{hospital_id}/devices/{device_id}/{observations|identity|connectivity}
```

```
Jetson gateway ──MQTT publish(qos 0, not retained)──▶ EMQX Cloud
                                                        │
              subscribe 'hospitals/#' qos 1, clean:false │
                                                        ▼
                                              mqtt/client.ts  on('message')
                                                        │
                                       handlers/router.ts  routeMessage()
   T1  parseTopic()          — 5 segments exactly; extracts hospital_id, device_id, leaf
   T2  JSON.parse             — malformed → logged, dropped
   T3  cross-check            — topic leaf must equal payload.message_type, else dropped
   T4  zod parse              — DeviceObservationBatchSchema; ≥1 observation required
   T5  drift warning          — payload.unique_device_identifier ≠ topic device_id → warn,
                                TOPIC WINS (payload UDI is never persisted to device_numerics)
                                                        │
                       ┌────────────────────────────────┴─────────────────────────────┐
                       ▼ PATH A (awaited, authoritative)         PATH B (best-effort) ▼
        handlers/observations.ts                          impact/patient-resolver.ts
   T6  fan out: 1 observation → 1 row                T9   GET /api/v1/devices/{device_id}/patient
   T7  rename: payload.unit_id → hospital_unit             (device_id used verbatim as trinity_code)
       (obs.unit_id keeps its MDC meaning)                 60s cache on hit, 30s on null
   T8  one multi-row INSERT INTO device_numerics      T10  404 / non-2xx / timeout → null
       ── received_at defaults to now()                     → poster returns {skipped}, batch dropped
                                                     impact/lib/impact-mapping.ts
                                                     T11  MDC metric_id → IMPACT field name
                                                          (unmapped → reported in `unmapped`, not sent)
                                                     T12  COLLAPSE: N observations → ONE flat record
                                                     T13  duplicate field → instance_id=0 wins
                                                     T14  quality ≠ 'valid' → value forced to null
                                                     impact/poster.ts
                                                     T15  Math.round() on hr/spo2/rr/fio2/bp*
                                                          (temperature left decimal)
                                                     T16  attach patient_id + observed_at
                                                          observed_at := batch.presentation_time
                                                     T17  dry-run → log only; live → POST
                                                          headers: X-Ingest-Key, X-Hospital-ID
                                                          POST /api/v1/vitals/batch
                                                                    │
                                                    ══ REPO BOUNDARY — IMPACT_BCCH_SERVER ══
                                                     T18  rateLimiter (global, write=600/min)
                                                     T19  ingestAuth — validates key, sets
                                                          req.user.hospitalId FROM THE HEADER
                                                          (used for auth only; never written)
                                                     T20  zod validateBody(batchVitalsSchema)
                                                          NON-STRICT: bed_id and presentation_time
                                                          are SILENTLY STRIPPED
                                                          range checks: temperature 25–45 (!)
                                                     T21  savePatientVitalsBatchDb — LOOPS,
                                                          one RPC call PER RECORD, aborts on first error
                                                     T22  savePatientVitalsDb — `x || null`
                                                          ⚠️ ZERO → NULL (§3e)
                                                     T23  rpc save_patient_vital_signs (11-arg)
                                                     T24  INSERT INTO vital_signs ONLY
                                                          spo2 → oxygen_saturation
                                                          rr   → respiratory_rate
                                                          fio2 → fraction_inspired_oxygen
                                                          observed_at := coalesce(p_observed_at, now())
                                                          ON CONFLICT (device_id, observed_at) DO NOTHING
                       ▼                                              ▼
              TimescaleDB.device_numerics                    Supabase.vital_signs
              (1 row per observation)                        (1 row per batch)
                                                             ✗ physiological_data: NEVER WRITTEN
```

**Transformations that lose or change information** (the ones to argue about):
- **T12 collapse** — a batch of 4 observations becomes 1 Supabase row, 4 Timescale rows. The two stores are not row-comparable.
- **T14 quality→null** — a `lead_off` / `artifact` / `out_of_range` reading is sent as an explicit `null`. Intentional (IMPACT has no quality concept) but it means Supabase cannot distinguish "sensor detached" from "no data", and Timescale can.
- **T15 rounding** — Supabase gets integers, Timescale gets `DOUBLE PRECISION`. SpO2 96.4 → 96 in Supabase.
- **T20 stripping** — `bed_id` and `presentation_time` are accepted and thrown away. Bed is **not** recorded on the Supabase side at all.
- **T22 zero→null** — see §3e.

---

## 3. The Supabase write — exact detail

**Framing correction first.** There is no Supabase client, no `@supabase/supabase-js`, no Postgres connection to Supabase anywhere in this repo (`package.json` deps: dotenv, mqtt, pg, pino, ws, zod). The Supabase INSERT is executed by `IMPACT_BCCH_SERVER` on our behalf. Everything below therefore describes **the write the server performs when we POST**, traced to the SQL.

**Table written:** `public.vital_signs`, and only that. One row per POSTed record.

**Columns and values** (from the 11-arg overload body in `db/migrations/20260602_vitals_observed_at_and_idempotency.sql`):

| `vital_signs` column | Value we cause | Our source |
|---|---|---|
| `patient_id` | resolved UUID | `resolvePatientId()` → `/devices/:trinity_code/patient` |
| `heart_rate` | int | `NOM_ECG_CARD_BEAT_RATE`, rounded |
| `oxygen_saturation` | int | `NOM_PULS_OXIM_SAT_O2`, rounded |
| `respiratory_rate` | int | `NOM_RESP_RATE`, rounded |
| `fraction_inspired_oxygen` | int | `NOM_VENT_CONC_AWAY_O2`, rounded |
| `temperature` | numeric | `NOM_TEMP`, **not** rounded |
| `blood_pressure_systolic` / `_diastolic` | null | BP mappings are commented out |
| `device_id` | text | topic `device_id` (= trinity_code) |
| `observed_at` | `coalesce(p_observed_at, now())` | `batch.presentation_time` |
| `recorded_by` | `INGEST_SERVICE_USER_ID` | server env, via `ingestAuth` |
| `recorded_at` | **insert time** (table default) | not ours |
| *(no tenant column exists)* | — | — |

Idempotency: `ON CONFLICT (device_id, observed_at) WHERE device_id IS NOT NULL AND observed_at IS NOT NULL DO NOTHING`, plus a side-effect upsert into `patient_vitals_config`. A skipped row returns `null`, which the batch loop counts as `skipped`.

### (a) ⚠️ Does it set `hospital_id` explicitly, or rely on the default? — **THE ANSWER IS "NEITHER, AND THAT IS THE PROBLEM"**

**Verdict: on the path in use, no `hospital_id` is written because the table has no tenant column.** Not mis-tenanted, not defaulted — absent by schema. Confirmed three ways:

- `visionQueries.js:18` — *"`vital_signs`  NEITHER — no tenant column at all"*.
- `20260902_sec26_drop_thr_main_tenant_defaults.sql:72` — *"`vital_signs`  Not in this list — it has no tenant column at all"*.
- The RPC body's INSERT column list contains no tenant column.

So the specific catastrophe in the brief — *rows land under `thr_main`, table fills, every screen empty* — **is not what is happening on this path.** The `X-Hospital-ID: bcch` header we send is used by `ingestAuth` only to populate `req.user.hospitalId`; `savePatientVitalsDb` destructures the record and never reads `user.hospitalId`. The tenant is simply not part of this write.

**But the risk is real and deferred, not absent.** `physiological_data.hospital_id` **is** `NOT NULL DEFAULT 'thr_main'` and both remediations are ⚠️ **NOT APPLIED**:
- `20260902_sec26_drop_thr_main_tenant_defaults.sql` — drops the default on 25 tables; **deliberately excludes** `physiological_data`.
- `20260905_physiological_data_tenant_derivation.sql` — `BEFORE INSERT` trigger deriving tenant from the patient's most recent bed assignment, treating `'thr_main'` as "not supplied" (because a column DEFAULT is applied *before* row triggers fire, so `is null` alone would never catch it), then dropping the default.

**Therefore: any writer we build for `physiological_data` must set `hospital_id` explicitly and never rely on the trigger existing.** As of today it does not exist.

### (b) Which timestamp goes where?

Four distinct clocks are in play. Naming them precisely, because two of them are called `recorded_at`:

| Clock | Where it comes from | Where it lands |
|---|---|---|
| `obs.device_time` | device's own clock, per observation, **nullable** | `device_numerics.device_time` only. **Never leaves Timescale.** |
| `batch.presentation_time` | gateway (Jetson) presentation clock, per batch | `device_numerics.presentation_time` (hypertable time dim) **and** `vital_signs.observed_at` |
| broker receipt | not captured anywhere | — |
| insert time | `now()` | `device_numerics.received_at` (default) and `vital_signs.recorded_at` (default) |

**The clinical clock we propagate to Supabase is `presentation_time` — the gateway's, not the device's.** `device_time` is discarded at the repo boundary even when present.

Matches the reader: `getFio2Samples` filters on `observed_at` and its own comment says *"NOTE the clock: observed_at, never recorded_at — in vital_signs recorded_at is INSERT time."* We populate `observed_at`, so **the FiO2 clock is correct today.** For `physiological_data`, the reader filters `recorded_at` — where, per `getPhysiologicalSamples`'s docstring, `recorded_at` means device/clinical time and `received_at` is the separate arrival clock. So a future writer maps `presentation_time → recorded_at` and `now() → received_at` — the **opposite** convention to `vital_signs`. Confirmed by the seed, which sets both equal.

### (c) What parameter names does it write?

Two different namespaces, and conflating them is how this gets broken:

**Namespace 1 — `src/lib/impact-mapping.ts`, MDC → IMPACT *record field* names** (JSON body keys, not DB values):

| MDC `metric_id` | field emitted |
|---|---|
| `NOM_ECG_CARD_BEAT_RATE` | `heart_rate` |
| `NOM_PULS_OXIM_SAT_O2` | `spo2` |
| `NOM_RESP_RATE` | **`rr`** |
| `NOM_TEMP` | `temperature` |
| `NOM_VENT_CONC_AWAY_O2` | `fio2` |

**Namespace 2 — `physiological_data.parameter_type`**, matched by the reader's alias map (`visionQueries.js:146-150`), **case-sensitively** via `.in()`:
```
spo2             ← ['spo2', 'oxygen_saturation', 'SpO2']
heart_rate       ← ['heart_rate', 'hr']
respiratory_rate ← ['respiratory_rate', 'rr']
```

**Resolution of the lead in the brief.** The header on `impact-mapping.ts` saying *"NOT yet wired into the running subscriber"* is **stale** — it was wired in commit `f7f1055`, and `poster.ts` imports `flattenBatchToImpactRecord` today. The comment should be corrected (flagged, not touched).

The `rr`-vs-`respiratory_rate` worry, however, **does not apply**, because `rr` here is a JSON body key consumed by `savePatientVitalsDb`'s destructuring and mapped by the RPC into the column `respiratory_rate`. It never becomes a `parameter_type`. **`rr` is correct on this path and would be wrong on the `physiological_data` path.** A future writer must emit canonical `spo2` / `heart_rate` / `respiratory_rate` — relying on the `rr` alias would work but leaves the study one case-change away from a silent zero.

Nothing in the mapping is outside the reader's map. There is no silent-zero naming defect today.

### (d) Does FiO2 go to `vital_signs` keyed on `observed_at`?

**Yes — this path is correct by design.** `NOM_VENT_CONC_AWAY_O2` → `fio2` → `p_fio2` → `vital_signs.fraction_inspired_oxygen`, on the same row as `observed_at = presentation_time`. `getFio2Samples` reads exactly `(fraction_inspired_oxygen, observed_at)` from `vital_signs` filtered on `observed_at`. **Aligned.**

Note `fraction_inspired_oxygen` is *not* in `PHYSIOLOGICAL_PARAMETER_TYPES`, so FiO2 must **stay** on the `vital_signs` path even after `physiological_data` is wired. Same for temperature.

Four caveats:
1. **FiO2 comes from a different device.** In the seeded topology the Dräger ventilator (`sim-bcch-bed-NN-drager-ventilator`) is a separate `trinity_code` from the Philips monitor. It resolves separately, so **FiO2 can be absent while SpO2 flows** — and the on-oxygen-vs-room-air band would silently fall back to room air. All 10 sim devices (5 Philips + 5 Dräger) exist in `db/seeds/20260602_bcch_nicu_simulator_seed.sql`, so resolution should succeed for beds 01–05 — but the deployment is **7 beds** and the seed covers 5.
2. **Rounding.** FiO2 21.5% → 22. `fio2` is an `integer` param, so this is required, but it is a real precision loss on the variable that picks the SpO2 target band.
3. **`fio2 || null`** — FiO2 0 becomes null. Physically odd but see §3e.
4. **Idempotency collision on all-null rows.** `hasMappedVital` tests `!== undefined`, so a batch whose only mapped observation was `lead_off` still POSTs a record of nulls. That row claims `(device_id, observed_at)`, and a genuine reading arriving later at the same instant is then **silently `DO NOTHING`**-ed. First writer wins, even when it wrote nulls.

### (e) ⚠️ Does it ever coerce a genuine ZERO to null? — **YES. TWICE.**

**Coercion 1 — server side, `IMPACT_BCCH_SERVER/src/db/vitalsQueries.js:23-36`:**
```js
p_heart_rate: heart_rate || null,
p_spo2:       spo2       || null,
p_rr:         rr         || null,
p_fio2:       fio2       || null,
p_temperature: temperature || null,
```
`||` is falsy-coalescing. **`0 || null === null`.** So:
- **SpO2 0 → null.**
- **RR 0 → null. Sustained RR 0 is the apnea definition. Apnea is currently unrepresentable in `vital_signs`.**
- HR 0 (asystole) → null.

This is not hypothetical: `spo2: z.number().min(0).max(100)` and `rr: z.number().min(0).max(150)` both *accept* 0, so a genuine zero passes validation and is then destroyed one layer down. It is precisely the defect the reader was hardened against — `getPhysiologicalSamples`'s own comment reads *"`value` is returned as-is. It is NOT passed through `|| null`: a genuine spo2 of 0 is a real reading and apnea is literally rr === 0."* **The reader knows. The writer does not.** The fix is `??` for `??`-safe values, and it is Oscar's file.

**Coercion 2 — our side, `src/lib/impact-mapping.ts` (T14):** any observation with `quality !== 'valid'` has its value replaced by `null`. Correct in intent, but it means a device that reports RR 0 flagged `out_of_range` (a plausible encoding of apnea) is nulled here too, *before* the server gets a chance to null it again. Worth a decision: should apnea-shaped zeros be trusted through a non-`valid` quality?

**Related third-order hazard:** `temperature: z.number().min(25).max(45)`. A probe-off temperature of 0 or 20 does **not** null — it **400s the entire batch**, taking the SpO2, HR and RR in that batch down with it. `savePatientVitalsBatchDb` also aborts on the first RPC error and returns `partial`, so a mid-batch failure leaves a partially-applied batch with no rollback.

---

## 4. The Timescale write

`migrations/001_init_timescale.sql` + `002_observations.sql`, applied via `scripts/migrate-timescale.sh` (raw `psql` loop, no ledger table, idempotent by `IF NOT EXISTS`).

**`device_numerics`** — hypertable on `presentation_time`, 1-week chunks. **One row per observation** (not per batch), 17 explicit columns:

`presentation_time, hospital_id, device_id, metric_id, instance_id, value, unit_id, quality, vendor_metric_id, device_time, gateway_id, vendor, protocol, schema_version, bed_id, hospital_unit, simulated` + `received_at DEFAULT now()`.

Contrasts with the Supabase copy that matter for provenance:

| | Timescale | Supabase (`vital_signs`) |
|---|---|---|
| Granularity | 1 row per observation | 1 row per batch (collapsed) |
| Parameter naming | **raw MDC** (`NOM_PULS_OXIM_SAT_O2`) — untranslated | canonical columns |
| Value type | `DOUBLE PRECISION` | `integer` (rounded) |
| Quality | preserved as a column | destroyed → null |
| Tenant | `hospital_id` **explicit, from the topic**, `NOT NULL`, no default | no column |
| Patient | **not recorded** — device/bed only | `patient_id` is the key |
| Bed | `bed_id`, `hospital_unit` | stripped |
| Device clock | `device_time` preserved | discarded |
| Arrival clock | `received_at` | `recorded_at` (same meaning, different name) |
| Simulated flag | `simulated BOOLEAN NOT NULL` | absent |
| Idempotency | **none** — no PK, no unique index. Reconnect replay duplicates. | `(device_id, observed_at)` unique |

**Timescale is unambiguously the better provenance store** — raw MDC ids, full precision, quality, device clock, explicit tenant, simulated flag. It has exactly one thing Supabase has and it does not: **no `patient_id`**. Attribution to an infant exists *only* in the Supabase copy. Moving the engine to the time series (post-presentation, per the scope decision) therefore requires solving device→patient attribution over historical time, not just repointing a query.

Other observations:
- **Indexes:** `(device_id, metric_id, presentation_time DESC)`, `(hospital_id, presentation_time DESC)`, `(bed_id, presentation_time DESC)`.
- **Compression and retention are commented out** — deliberate for the POC. At the §6 volume this needs revisiting well inside 18 months.
- **`device_identities` / `device_connectivity_events` never receive `bed_id`, `hospital_unit` or `simulated`,** even though migration 002 added those columns to all three tables. Only `handleObservations` writes them. The identity/connectivity handlers' INSERT column lists omit them, so they sit permanently null / `false`. Cosmetic today; a trap for anyone joining on them.
- `handleConnectivity` is a change-only log with a genuine forward-transition guard (skips equal state and out-of-order older messages) inside a transaction. `handleIdentity` upserts with a `WHERE EXCLUDED.presentation_time >= …` guard against retained-message replay. Both are careful. `handleObservations` has **no such guard** — see idempotency above.

---

## 5. Can the two diverge? — **Yes, in both directions, and nothing reconciles them.**

The control flow is explicitly asymmetric (`src/handlers/observations.ts`): the Timescale INSERT is `await`ed bare, then the IMPACT block is wrapped in `try/catch` whose comment reads *"impact-poster: unexpected error (Timescale insert already succeeded)"*.

**Timescale succeeds, Supabase does not** — the common case:
1. `resolvePatientId` returns null (404 unassigned bed, 5xx, timeout, network) → `{kind:'skipped', reason:'no patient resolved'}`
2. no mapped vitals in the batch → `{kind:'skipped'}`
3. `IMPACT_INGEST_MODE=dry-run` → nothing is ever sent
4. POST 4xx/5xx/timeout/ECONNREFUSED → `{kind:'error'}`
5. rate limit 429 (see §6)
6. `ON CONFLICT DO NOTHING` → counted `skipped`, indistinguishable from success at the wire level
7. mid-batch RPC error → `partial`, some records applied

**Right now, cause 4 is firing for every single batch**: `.env` says `IMPACT_INGEST_MODE=live`, `IMPACT_API_URL=http://localhost:3035`, and nothing is listening on 3035.

**Supabase succeeds, Timescale does not** — narrower but worse: if `pool.query` throws, `handleObservations` throws *before* the IMPACT block, so nothing is posted. Timescale is therefore never behind. **But the MQTT message was already acked**, so a Timescale failure is *permanent loss of that reading from both stores*. There is no retry, no DLQ, no buffer. (The `NUMERIC_BATCH_INTERVAL_MS` / `NUMERIC_BATCH_MAX_SIZE` config keys exist and are **read by nothing** — the batching they describe was never built, so there is no buffer to replay from either.)

**Reconciliation: none.** No sequence numbers, no checksums, no backfill job, no comparison of counts, nothing keyed to let a row in one store find its counterpart in the other. And the two are not row-comparable anyway (1-per-observation vs 1-per-batch, MDC vs canonical, double vs int).

**Loudness assessment — this is the specific way the feed lies.** Every Supabase-side failure above is caught, converted to a `PostResult`, and **`logger.info`**-ed as `'impact-poster: result'`. Cases 1, 2, 3 and 6 never even reach `logger.error`. So a bed whose patient cannot be resolved streams into Timescale forever while writing nothing to Supabase, emitting only cheerful `info` lines. Timescale row counts look perfect. The dashboard is empty. **That is exactly the "healthy feed writing rows nothing can read" failure the goal names**, and it is the current default behaviour, not an edge case.

The study's outcome variable is computed from the Supabase copy — the weaker, lossier, unreconciled, best-effort one.

---

## 6. Cadence and volume

**This repo does not set the rate.** It is a subscriber; it writes whatever arrives. Cadence is the Jetson gateway's / simulator's, and that publisher is not on this box. Nothing in `config.ts` or `.env` throttles, samples or decimates.

`scripts/publish-test-batch.mjs` publishes **one** batch per device once and exits — a smoke test, not a load generator.

**Volume at the 1 Hz target, 7 beds:**

| | per second | per day |
|---|---|---|
| Timescale rows (1/observation, 4 params) | 28 | **~2.4 M** ✓ matches the brief |
| Supabase `vital_signs` rows (1/batch) | 14 (7 Philips + 7 Dräger) | ~1.2 M |
| **HTTP POSTs to IMPACT** | **14** | **~1.2 M** |
| HTTP GETs (patient resolver, 60 s cache) | ~0.23 | ~20 k |

**⚠️ The rate limit will reject the target feed.** `IMPACT_BCCH_SERVER/src/config/index.js:82-95` sets `windowMs: 60_000`, `maxRequests.write: 600`. At 1 Hz × 7 beds × 2 devices = **840 POST/min > 600**. The service would take a sustained ~29 % 429 rate. The config's own TODO sizes it for *"~288/min sustained from 5-bed sim"* — i.e. it was never sized for 1 Hz at 7 beds. The same comment notes the `req.isIngestService` bypass is **dead code**, because `app.use(rateLimiter)` (line 157) is mounted *before* `ingestAuth` (line 172).

A 429 is a `{kind:'error'}` → logged → **batch dropped, never retried.**

**Structural inefficiency:** one MQTT batch = one HTTP POST = one record, even though `batchVitalsSchema` accepts up to **1000** records and `savePatientVitalsBatchDb` loops them. We are using a batch endpoint one record at a time. Buffering ~5 s per device would cut POSTs ~5× and put us comfortably under the limit — at the cost of up to 5 s of ingest latency and a buffer that must survive shutdown.

**Retention:** Timescale compression/retention policies are commented out. ~2.4 M rows/day × ~550 days ≈ **1.3 billion rows** uncompressed on Tiger Cloud Free. Needs a decision inside the study window, not at the end of it.

---

## 7. Bed and patient resolution

**A published reading does not know its patient.** It carries only `hospital_id` + `device_id` (topic) and `bed_id` + `unit_id` (payload). Attribution is a **separate synchronous HTTP call per batch**, cached.

```
topic device_id ──used verbatim as trinity_code──▶ GET /api/v1/devices/{trinity_code}/patient
                                                   → rpc get_device_current_patient(p_trinity_code)
                                                       trinity_devices
                                                         ⋈ bed_device_assignments  (unassigned_at IS NULL)
                                                         ⋈ patient_bed_assignments (discharged_at  IS NULL)
                                                       → patient_id
```

**The key matches.** `db/seeds/20260903_vision_demo_liveness_seed.sql` registers `trinity_code = 'sim-bcch-bed-01-philips-monitor'` — byte-identical to the topic `device_id` the simulator publishes. Not a coincidence to rely on silently, but correct today. `payload.bed_id` (`'bcch-nicu-bed-01'`) is **never** used for resolution — it goes to Timescale and is stripped by the server's zod schema.

**Unassigned bed → no tenant, silently.** RPC returns an empty TABLE → `getDeviceCurrentPatientDb` returns `{data:null}` → controller `errors.notFound` → **404** → resolver caches `null` for 30 s → poster returns `{kind:'skipped', reason:'no patient resolved'}` → **`logger.info`**. Timescale keeps ingesting. So with only beds 01 and 02 assigned, **beds 03–07 write to Timescale indefinitely and to Supabase never, at log level `info`.** Nothing counts it, nothing escalates it, nothing surfaces it on the liveness board.

**Two resolution rules that disagree — flag for Oscar:**
- `get_device_current_patient` requires `pba.discharged_at IS NULL` → **active assignments only**.
- The proposed `physiological_data_set_tenant` trigger deliberately takes *"the MOST RECENT bed assignment, DISCHARGED OR NOT"*, arguing an open-assignments-only rule *"would reject vitals for every discharged one"* across ~1,440 patient-days.

Harmless for live streaming (a discharged infant isn't streaming) but it is two answers to "which infant is this", and `visionQueries.js:20-27` records that exactly this class of disagreement caused the 2026-08-31 404. It must not be left implicit.

**Other resolution notes:**
- The resolver is **not tenant-scoped** — `getDeviceCurrentPatientDb(trinityCode)` takes no site/hospital argument and deliberately skips `validateUserSession`. A `trinity_code` collision across hospitals would cross tenants. `trinity_code` uniqueness is doing all the security work here.
- Both devices at a bed resolve **independently**. Philips can resolve while Dräger 404s → HR/SpO2/RR flow, FiO2 does not → SpO2 band silently reads as room air.
- Two devices, one patient, one instant → two `vital_signs` rows. Harmless: `getFio2Samples` filters `.not('fraction_inspired_oxygen','is',null)`.
- **7 beds vs 5 seeded.** The simulator seed provisions 5 beds / 10 devices. Beds 06 and 07 have no `trinity_devices` row I can find, so they would 404 forever.
- Cache TTLs (60 s hit / 30 s miss) mean a bed assignment change takes up to 60 s to take effect, and up to 60 s of readings can be attributed to the **previous** patient after a bed turnover. For a 7-bed NICU that is a real misattribution window and should be an explicit decision, not a default.

---

## 8. Decisions needed

Ordered by what blocks the study starting.

**D1 — Who writes `physiological_data`? (BLOCKING; nothing else matters until this is settled.)**
No code in either repo inserts into it. Options: **(a)** a new server endpoint (e.g. `POST /api/v1/physiological/batch`) that this service calls; **(b)** this service writes Supabase directly with `@supabase/supabase-js`; **(c)** the engine moves to Timescale now instead of after the presentation.
*My recommendation: (a).* It keeps one writer and one tenant rule in the repo that owns the reads, needs no service-role key on the gateway box, reuses the working `ingestAuth`, and keeps `resolvePatientTenant` as the single answer to "which hospital". (b) puts a Supabase service-role key on a clinical gateway and forks the tenant rule; (c) contradicts the stated scope decision and has no `patient_id` to attribute by (§4).

**D2 — `|| null` zero-coercion.** `vitalsQueries.js:23-36` destroys SpO2 0, RR 0, HR 0. Oscar's file, Oscar's call, but apnea is the study's clinical signal and is currently unrepresentable in `vital_signs`. `??` where a zero is legitimate.

**D3 — Rate limit.** 840 POST/min needed, 600 allowed. Raise `maxRequests.write`, or mount the limiter after `ingestAuth` so the `isIngestService` bypass stops being dead code, or buffer on our side (D4). Needs a number agreed before go-live, not discovered as 429s.

**D4 — Buffering and latency budget.** Is up to N seconds of ingest latency acceptable in exchange for N× fewer POSTs and a retry buffer? The `NUMERIC_BATCH_*` config keys already exist unused. What is the acceptable N?

**D5 — Which clock is authoritative?** We propagate the *gateway's* `presentation_time` and discard the *device's* `device_time`. For an 18-month study, is gateway time the study clock? If yes, the Jetson's NTP discipline becomes study infrastructure. If not, `device_time` needs to reach Supabase.

**D6 — Zero-vs-quality.** Should a value-0 observation with `quality !== 'valid'` be nulled (current behaviour), or trusted as apnea/asystole? Needs the device's actual encoding of apnea from whoever owns the Philips integration.

**D7 — Beds 06 and 07.** Only 5 beds are seeded with `trinity_devices`. Who provisions the other two, and does the topology exist before the study starts?

**D8 — Resolver rule divergence (§7).** `discharged_at IS NULL` vs "most recent, discharged or not". Pick one and use it in both places.

**D9 — Cache TTL vs bed turnover.** 60 s of possible misattribution after a bed change. Acceptable, or does turnover need to invalidate?

**D10 — Idempotency on the Timescale side.** `device_numerics` has no unique constraint; `clean:false` + QoS 1 replay duplicates rows on every reconnect. If Timescale becomes the provenance store, duplicates corrupt it. Needs a natural key — `(device_id, metric_id, instance_id, presentation_time)`.

**D11 — Message loss on DB error.** QoS 1 is acked before the handler runs, so a Timescale error loses the reading from both stores permanently. Acceptable for a POC; not for 18 months of clinical data. Needs manual ack or a local WAL.

**D12 — Retention/compression** before 1.3 B rows accumulate.

**D13 — Deployment and supervision.** No unit file, no restart policy, no health endpoint. "Unattended for 18 months" needs all three plus the WebSocket/liveness surface that is still a stub.

---

## 9. Proposed plan — connecting the Supabase path

> ⚠️ **NOT IMPLEMENTED. FLAGGED FOR OSCAR'S REVIEW.** He owns every table below and the reader that consumes them. Nothing here is actionable until D1 and D2 are answered. Phases 1 and 2 are pointless independently — they only produce readable rows together.

**Assumption this plan is built on:** D1 resolves to **(a)**, a server-side endpoint. If Oscar prefers (b), phases 1 and 2 merge into this repo and D1's key-management question becomes blocking.

**Phase 0 — Restore the path that already works (this repo only, no schema change).**
The FiO2/`vital_signs` path is *correctly designed today* (§3d) and fails only on configuration: `IMPACT_API_URL` points at a dead port. Bring up the IMPACT server, confirm `IMPACT_INGEST_MODE=live` reaches it, and verify FiO2 + temperature land in `vital_signs` with `observed_at` set and that `getFio2Samples` returns them. **This is the fastest possible proof that any Supabase row is readable**, and it de-risks everything after it. No new code.

**Phase 1 — Server side (Oscar): a real `physiological_data` writer.**
`POST /api/v1/physiological/batch`, mounted behind `ingestAuth` exactly as `/vitals` is. Per sample it inserts one row of
`(id, patient_id, hospital_id, device_source, parameter_type, value, unit, recorded_at, received_at, metadata)`
— the column list the seed already uses — with these non-negotiables:
- **`hospital_id` set EXPLICITLY**, from `resolvePatientTenant` (the reader's own rule), never omitted, never `'thr_main'`. The trigger in `20260905` is NOT APPLIED; the endpoint must be correct without it, and must stay correct after it is applied.
- `parameter_type` from the canonical set only: `spo2` | `heart_rate` | `respiratory_rate`. Reject anything else with a 4xx rather than storing an unreadable row.
- `recorded_at` = the supplied clinical time; `received_at` = `now()`. (Opposite convention to `vital_signs` — §3b.)
- **`value` passed through with `??`, never `||`.** A zero is data.
- Multi-row insert, and a unique key on `(patient_id, parameter_type, recorded_at, device_source)` so replay is idempotent — matching what `vital_signs` already has.
- Response reports `inserted` / `skipped` / `rejected` **per parameter**, so the writer can tell "stored" from "silently dropped".

**Phase 2 — This repo: a second mapping namespace.**
A new MDC → `parameter_type` map, kept **separate** from `mdcToImpactField` (they are different namespaces, §3c, and merging them is how `rr` leaks into `parameter_type`):
`NOM_PULS_OXIM_SAT_O2 → spo2`, `NOM_ECG_CARD_BEAT_RATE → heart_rate`, `NOM_RESP_RATE → respiratory_rate` (canonical — **not** `rr`, even though the alias map would forgive it), with `unit` from the MDC unit code. FiO2 and temperature **stay** on the `vital_signs` path — `fraction_inspired_oxygen` is not a `parameter_type` and the reader unions it separately. Then fan out (1 observation → 1 sample, no §3c collapse), keep full `DOUBLE PRECISION` precision (no Phase-1 rounding — `physiological_data.value` is not integer-typed), and preserve `quality` in `metadata` rather than only expressing it as null.

**Phase 3 — Fix the zero coercion (D2).** `|| null` → `??` in `vitalsQueries.js`, with a test asserting SpO2 0 and RR 0 survive to the row. Oscar's file.

**Phase 4 — Make it survive 1 Hz (D3, D4).** Raise the write limit or remount the limiter after `ingestAuth`; buffer per-device on our side and send multi-record batches; retry 429/5xx with backoff from the buffer instead of dropping.

**Phase 5 — Make failure LOUD (the goal's actual success criterion).** Today every Supabase-side failure is `logger.info`. Minimum viable: per-device counters of `posted` / `skipped_no_patient` / `error`; **escalate to `error`** when a device has written to Timescale for > 60 s with zero successful Supabase writes; expose the counters on the health/WS surface so the liveness board can show "streaming but unreadable" as a distinct state from "down". A feed that appears healthy while writing rows nothing can read must not be reachable from a clean log.

**Phase 6 — DB migrations (Dhruv, not agents).** `20260902` and `20260905`, in that order, only after Phase 1 sets `hospital_id` explicitly and after confirming every streaming bed has a current assignment (`20260905`'s stated operational precondition: after it, **bed assignment becomes a hard prerequisite for vitals ingest** — an unassigned bed starts *raising* instead of silently mis-filing, which is the intent but is a behaviour change to schedule deliberately).

**Verification gate before the study starts** — publish a known batch, then assert end-to-end: the exact row appears in `device_numerics`; the corresponding `physiological_data` rows carry `hospital_id = 'bcch'` (not `thr_main`, not null); `getPhysiologicalSamples` returns them for the tenant-scoped reader; a deliberate SpO2 0 survives as 0; FiO2 appears via `getFio2Samples` on `observed_at`; and an unassigned bed produces a **loud** failure. Counts must match at both ends — "the service runs" is not the test.

---

### Appendix — key references

| Fact | Location |
|---|---|
| No Supabase client in ingest | `package.json` deps |
| Timescale INSERT | `src/handlers/observations.ts` (`COLUMNS`) |
| MDC → IMPACT field map (+ stale "not wired" header) | `src/lib/impact-mapping.ts` |
| `observed_at := presentation_time`; rounding | `src/impact/poster.ts` (`buildBody`) |
| Patient resolution + cache TTLs | `src/impact/patient-resolver.ts` |
| `IMPACT_INGEST_MODE=live` → dead port 3035 | `.env` |
| **`x \|\| null` zero coercion** | `IMPACT_BCCH_SERVER/src/db/vitalsQueries.js:23-36` |
| RPC writes `vital_signs` ONLY | `IMPACT_BCCH_SERVER/db/migrations/20260602_vitals_observed_at_and_idempotency.sql` |
| Reader alias map (case-sensitive `.in()`) | `IMPACT_BCCH_SERVER/src/db/visionQueries.js:146-150` |
| `vital_signs` has NO tenant column | `…/src/db/visionQueries.js:18`; `…/db/migrations/20260902_…sql:72` |
| FiO2 read on `observed_at` | `…/src/db/visionQueries.js:484` (`getFio2Samples`) |
| Reader refuses `\|\| null`; apnea is `rr === 0` | `…/src/db/visionQueries.js:380-390` |
| `physiological_data` has no writer (verified) | `…/db/migrations/20260905_physiological_data_tenant_derivation.sql:9-32` |
| `thr_main` default still live; both fixes NOT APPLIED | `…/db/migrations/20260902_…sql`, `…/20260905_…sql` |
| `physiological_data` column list | `…/db/seeds/20260903_vision_demo_liveness_seed.sql` |
| Rate limit `write: 600/min`, bypass is dead code | `…/src/config/index.js:82-95` |
| zod strips `bed_id`/`presentation_time`; temp 25–45 | `…/src/middleware/validation.js:216-230` |
| Ingest routes behind `ingestAuth` | `…/src/index.js:172,179` |
| Resolver rule `discharged_at IS NULL` | `…/db/migrations/20260602_device_current_patient_rpc.sql` |
| trinity_code == topic device_id; 10 sim devices | `…/db/seeds/20260903_…sql`, `…/20260602_bcch_nicu_simulator_seed.sql` |
