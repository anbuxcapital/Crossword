# Crosscut backend — consolidated research report

Synthesized 2026-09-02 from the eleven topic documents in this directory (`domain-spec-extraction`, `workers-modular-monolith`, `modular-monolith-principles`, `in-process-event-bus`, `durable-objects-d1-domain`, `hono-best-practices`, `zod4-usage`, `identity-auth-v1`, `wrangler-config`, `testing-and-dx`, `crossword-content-pipeline`). Where the topic docs disagree, this report records one decision and names the source doc. Every version below is a claim the topic docs confirmed against npm or an official page on 2026-09-02; anything the docs could not confirm is tagged **[UNVERIFIED]** and collected in §8.

## Executive summary

- Ship **one Worker** (`workers/gateway`): a Hono `fetch` handler, three SQLite Durable Object aggregate classes (`User`, `PuzzleStats`, plus the `Projections` entrypoint from `packages/core`), a `scheduled()` handler for three crons, and folder-modules with one public `index.ts` each. No Queues, no pub/sub, no second Worker.
- **All per-user economy state (tokens, stars, streak, completions, wheel, likes/saves, prefs, the active solve session) lives in one `User` Durable Object** so that "buy a hint" and "finish a puzzle" are single atomic commits. Per-puzzle counters live in `PuzzleStats`. Everything else (puzzles, drops, collections, leaderboards) is plain D1.
- **Solutions never leave the Worker.** Word checks are stateless calls against a cached puzzle secret; the finishing request verifies the whole grid server-side and computes `tokens = floor(secLeft/5)`, `stars = 10 + (noHints ? 2 : 0)` from server clocks. Rewards are granted once per (user, puzzle).
- **Domain events are a typed in-process dispatcher**: Zod-validated envelope, static handler table wired in the composition root, critical handlers awaited in registration order with per-handler error isolation, background handlers under `ctx.waitUntil`. Money never depends on an event; every handler is idempotent on `event.id`; a `reconcile` route heals lost fan-out. The outbox/alarm redelivery design is documented as the upgrade path, not built in v1.
- Stack pins: wrangler 4.128.0, hono 4.13.5, zod 4.5.4, @hono/zod-validator 0.9.1, TypeScript 7.0.2, vitest 4.1.11, **@cloudflare/vitest-plugin 1.1.3** (the renamed successor of vitest-pool-workers 0.22.0), pnpm 11.24.0, turbo 2.10.12, Node 26.8.1.
- Identity v1: server-minted HS256 device tokens (`hono/jwt`, `kid` rotation), no accounts; Better Auth is the documented v2 path.
- The prototype's data format is adopted verbatim as the authoring format; content is JSON in the repo, validated by a shared Zod+structural validator, imported through one admin endpoint, and dropped per user-local calendar day.

## Stack decisions

| decision | choice | rationale | source doc |
|---|---|---|---|
| Deployment topology | One Worker `workers/gateway` (name `crosscut`) exporting `default { fetch, scheduled }`, DO classes, `Projections` entrypoint | Service bindings/RPC are zero-latency but cost a 32-invocation budget, RPC-safe DTOs and stub disposal; nothing in v1 needs a split. `resolveModules(env, ctx)` is the single seam for a later split. | workers-modular-monolith R1, R6 |
| Config file | `wrangler.jsonc` with `"$schema": "node_modules/wrangler/config-schema.json"` | Cloudflare recommends JSONC; some features are JSON-only | wrangler-config F1 |
| `compatibility_date` | `"2026-09-02"`; **no `compatibility_flags`** | Verified in `wrangler dev` 4.128 (bundled workerd 1.20260831.1 accepts +7 days). `nodejs_compat` is default from 2026-08-04 and `enable_ctx_exports` from 2025-11-17 (wrangler prints a warning if listed). The principles doc's claim that the flag is still required is refuted by the smoke test. | wrangler-config F3, F4 (smoke test) |
| DO class declaration | Declarative `"exports": { "User": { "type": "durable-object", "storage": "sqlite" }, "PuzzleStats": {...} }` + `durable_objects.bindings` | Docs prefer `exports` for new Workers; `migrations` and `exports` are mutually exclusive and the door is one-way. Supported by `wrangler dev`, `wrangler types`, vitest plugin since wrangler 4.107. | wrangler-config F5, R2 |
| Storage split | D1 = content, projections, fact tables, cron-materialised leaderboards; DO = per-user and per-puzzle invariants | Hot reads never hit a DO; commands are serialized per user by input gates | durable-objects-d1-domain R1, R9 |
| Per-user aggregate | **One `User` DO** (`user:<userId>`) owned by module `player`; slice modules call its commands through `player/index.ts` | Hint = debit + hint log in one commit; finish = wallet + stars + streak + completion + session close in one commit. Chosen over "one DO per module" (principles R3) and over a separate `Solve` DO (domain-spec) which needed cross-object compensation. | durable-objects-d1-domain R1 (deviation from modular-monolith-principles R3 recorded) |
| Hono composition | `createFactory<AppEnv>({ defaultAppOptions: { strict: false } }).createApp()` per module, **method-chained** routes, gateway `app.basePath("/v1").route("/feed", feed)…`, `export type AppType = typeof routes` | Hono best practice; chaining is mandatory for `hc`/`testClient` types; sub-apps inherit `Bindings`/`Variables` (verified locally) | hono-best-practices F2, R1–R3 |
| Validation | `@hono/zod-validator` 0.9.1 with one shared `hook` returning `{ error: { code: "invalid_request", target, issues: z.flattenError(e) } }` 400 | Default 400 body hides issues inside a string and leaks into the RPC type union | hono-best-practices F3, zod4-usage F6 |
| OpenAPI | None in v1; `hono-openapi` 1.3.1 route-by-route later if needed (never `.openapi()` in shared schemas; use `.meta({ id, ref })`) | Only client is the Expo app (typed via `hc`); `@hono/zod-openapi` patches `ZodType.prototype` and misses schemas built before import | hono-best-practices F8, zod4-usage F7–F8 |
| Zod | `import * as z from "zod"` (4.5.4, classic API) everywhere; never `zod/mini`, `zod/v4`, `z.compile`, `import "zod/compile"` | Root is Zod 4; `new Function` is disallowed in production Workers and `z.compile` fails silently; ~25 KB gz is irrelevant | zod4-usage R1, R11 |
| Zod conventions | `z.object` for inbound bodies, `z.strictObject` for command/event payloads, `z.discriminatedUnion` for commands/events, `z.iso.datetime()` (seconds required), `z.int().nonnegative()` for economy, ids via regex+`.brand()` | 4.5 soundness changes; `z.templateLiteral` does not enforce numeric checks | zod4-usage F3, F4, F10 |
| TypeScript | 7.0.2 (native); tsconfig `target ES2022, module ESNext, moduleResolution Bundler, strict, noEmit, isolatedModules, types: ["./worker-configuration.d.ts", "@cloudflare/vitest-plugin/types"]` in the Worker; `@cloudflare/workers-types` only in library packages | Mixing workers-types with generated runtime types yields ~1300 duplicate-identifier errors masked by `skipLibCheck`; TS 7 removed `baseUrl`, `node10`, `outFile` | testing-and-dx F11, F12, R6 |
| Types generation | `wrangler types` → committed `worker-configuration.d.ts`; CI runs `wrangler types --check` | Gives `Env`, `Cloudflare.Env`, `Cloudflare.GlobalProps.durableNamespaces` (types `ctx.exports.X`, `exports.default` in tests) | wrangler-config F16, hono-best-practices F7 |
| Test runner | `@cloudflare/vitest-plugin` **1.1.3** + `vitest` 4.1.11 (+ `@vitest/coverage-istanbul` 4.1.11 exact) | Renamed successor of `@cloudflare/vitest-pool-workers` 0.22.0 (same `cloudflareTest()` API); includes the 1.1.2 DO re-creation fix and workerd 1.20260831 (0.22.0's workerd rejects dates > 2026-08-22). Deviates from the brief's 0.22.0 pin on purpose. | testing-and-dx F1, R1 |
| Test config API | `defineConfig({ plugins: [cloudflareTest(async () => ({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } } }))], test: { setupFiles: ["./test/setup.ts"] } })`; `readD1Migrations` from the **package root** (`/config` subpath does not exist) | `defineWorkersConfig`, `poolOptions`, `isolatedStorage`, `singleWorker` are gone; storage isolation is per test file | testing-and-dx F2, hono-best-practices C24 |
| Test entry points | `import { env, exports } from "cloudflare:workers"`; `exports.default.fetch()` end-to-end; `app.request(path, init, env)` route-level; `cloudflare:test` for `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`, `applyD1Migrations`, `createExecutionContext`, `waitOnExecutionContext` | `SELF`/`env` from `cloudflare:test` are deprecated (still exported) | testing-and-dx F4, F5 |
| Identity v1 | Server-issued HS256 JWT device tokens signed/verified with `hono/jwt` using a JWK `{ kty:"oct", k, alg:"HS256", kid }` (sets `kid` header); `Authorization: Bearer`; `POST /v1/devices` bootstrap rate-limited per IP; `tokenVersion` in aggregate | Client UUIDs are forgeable; DB sessions add a lookup per request for no v1 benefit; same header shape as Better Auth `bearer()` later | identity-auth-v1 F3, F14 |
| Rate limiting | `ratelimits` binding (`RL_BOOT` 10/60 s per IP, `RL_USER` 120/60 s, `RL_SPEND` 20/60 s); exact limits enforced in the aggregate | Per-colo, permissive, simulated locally by miniflare (verified); free-plan availability [UNVERIFIED] | identity-auth-v1 F5, wrangler-config F13 |
| Events | Typed in-process dispatcher (§3); no Queues; outbox deferred | Brief mandates direct calls; critical consequences are inside the producing commit so lost fan-out is reconcilable | in-process-event-bus R1–R7, workers-modular-monolith R4 |
| Boundary enforcement | Biome 2.5.11 `noRestrictedImports` (TS-7-proof) + a Vitest architecture test scanning imports and SQL table prefixes; `eslint-plugin-boundaries`/`dependency-cruiser` deferred to TS 7.1 (or a `tools/lint` package aliasing `@typescript/typescript6`) | TS 7.0 ships no compiler API; typescript-eslint peers `<6.1.0` | workers-modular-monolith F8, R7; modular-monolith-principles R6, S7 |
| ORM | None: raw D1 prepared statements + `packages/core` `versionedUpsert`; drizzle-orm 0.45.2/drizzle-kit 0.31.10 only if Better Auth v2 uses the Drizzle adapter | UPSERT works in local D1 (core tests 8/8) and is widely used; keeps the Worker bundle small | durable-objects-d1-domain F8, identity-auth-v1 F10 |
| Monorepo | pnpm 11.24.0 (`pnpm-workspace.yaml`: `allowBuilds: { esbuild: true, workerd: true }`, `catalog:` for zod/hono/typescript, `minimumReleaseAge: 0` while pinning day-old releases), turbo 2.10.12 (`devEngines.packageManager`), Node 26.8.1 | pnpm 11 removed `onlyBuiltDependencies` and the `package.json` `pnpm` field; fix the template's clobbered placeholder | testing-and-dx F13, F14, R7 |
| Time zone policy | "Today" = user-local day from an IANA zone sent by the client, stored on `User`, changeable once per local day; validated by constructing `Intl.DateTimeFormat` (never by comparing to `Intl.supportedValuesOf`, which lists `Europe/Kiev` not `Europe/Kyiv`) | workerd is UTC; crons are UTC; drops are a date comparison, not a midnight cron | crossword-content-pipeline F7, durable-objects-d1-domain R3 |
| Crons | `"0 * * * *"` (ensure drops 3 days ahead + streak reminders), `"*/5 * * * *"` (weekly leaderboard), `"0 6 * * *"` (pool-depth + cron-health alert); all idempotent and duplicate-tolerant | Retry policy undocumented; `controller.noRetry()` exists; 5 crons per account on Free; sub-hourly crons get 30 s CPU | durable-objects-d1-domain F9, R7 |
| Deploy | `env.production` repeats non-inheritable blocks (`vars`, `durable_objects`, `d1_databases`, `ratelimits`); always `wrangler deploy --env production`; secrets via `wrangler secret put … --env production`; `.dev.vars` locally | Environment inheritance rules verified against the schema | wrangler-config F12, R3 |

## Architecture

### Modules and allowed dependencies

`workers/gateway/src/modules/<name>/` = `index.ts` (public commands + queries, one exported object + types), `contract.ts` (Zod schemas of the events it publishes and DTOs it returns, with `examples`), `http.ts` (chained Hono sub-app), `subscriptions.ts` (handlers for other modules' events), `internal/**` (DO classes, SQL, pure domain functions, projections), `test/`. Cross-module imports may target only another module's `index.ts` and `contract.ts`. `shared/` and `events/` import nothing from `modules/`; `app/` imports everything; `modules/*` never import `app/`.

| module | owns (write model) | D1 tables (prefix = owner) | may depend on | subscribes to |
|---|---|---|---|---|
| `shared` | `RequestContext { env, exec, actor, correlationId, now }`, ids, `dayKey(ms, tz)`, `prevDay`, `normalizeWord(lang, s)`, `RpcSafe<T>`, error classes re-exported from `@app/core` | — | — | — |
| `events` | envelope, registry, `dispatch()`, `Subscription` type | — | `shared` | — |
| `content` | puzzle catalog (public payload + secrets), setters, daily drops, collections manifest, admin import, drop cron | `content_puzzles`, `content_puzzle_secrets`, `content_daily_drops`, `content_collections`, `content_collection_puzzles`, `content_meta` | `shared` | — |
| `player` | `User` DO: prefs/tz/plan, wallet, streak, completions, likes/saves, wheel, hint log, active solve session, install/token version, merge fields; projection `player_state` + fact rows `player_solves` | `player_state`, `player_solves` | `shared`, `events` | — |
| `identity` | device-token mint/verify/refresh, auth middleware, bootstrap, `/me`, `DELETE /me` | — | `shared`, `player` | — |
| `solving` | start/progress/word-check/hints/finish orchestration; the only module that reads `content_puzzle_secrets`; pure `questions()/sweep()/timeBonus()/starsFor()` | — | `shared`, `events`, `content`, `player` | — |
| `economy` | wallet view, token packs (mock purchase), plan (mock), wheel spin, hint price constants | `economy_purchases` | `shared`, `events`, `player` | `collections.completed` (grant reward via `player.claimCollection` — see catalog) |
| `social` | `PuzzleStats` DO per puzzle (likes, solved, noHintSolved, solvingNow presence, top-10 today), like/save toggles | `social_puzzle_stats` | `shared`, `events`, `player`, `content` | `solve.finished`, `solve.started/paused/resumed`, `social.likeToggled` |
| `collections` | progress computation, unlock rules, reward claim orchestration | — (reads `content_collection_puzzles` via `content` query, `player_solves` via `player` query) | `shared`, `events`, `content`, `player` | `solve.finished` |
| `leaderboard` | weekly board materialisation, per-puzzle top solvers query | `leaderboard_week` | `shared`, `player`, `content` | — (cron-driven) |
| `feed` | page composition, stories row, ticker, streak-at-risk card, wheel/mystery interleave | — | `content`, `player`, `social`, `collections` (queries only) | — |
| `notifications` (stub) | reminder dedupe; no push delivery in v1 | `notifications_reminders_sent` | `shared`, `events`, `player` | `player.streakExtended` (no-op), cron |
| `app` (composition root) | `index.ts` exports, `app.ts` Hono tree, `wiring.ts` handler table, `modules.ts` `resolveModules`/`createModules` | — | everything | — |

Layering, bottom-up: `shared` → `events` → {`content`, `player`} → `identity` → {`solving`, `economy`, `social`} → {`collections`, `leaderboard`} → {`feed`, `notifications`} → `app`. The graph is a DAG; `feed` is a pure read composer. `player` is deliberately a shared per-user aggregate below the slice modules: only `player/index.ts` touches the `User` stub, and every slice goes through it.

Folder layout (from workers-modular-monolith R5 and modular-monolith-principles R1, merged):

```
workers/gateway/
  wrangler.jsonc  worker-configuration.d.ts (generated, committed)  vitest.config.ts  migrations/NNNN_<module>_<what>.sql  seed/  test/{setup.ts,env.d.ts,arch.test.ts,http/}
  src/app/{index.ts,app.ts,wiring.ts,modules.ts}   src/shared/   src/events/   src/modules/<name>/{index,contract,http,subscriptions}.ts + internal/ + test/
packages/core/      Aggregate, ProjectionsBase, aggregateStub, DomainError (copied from IOSApp; run the vitest-plugin codemod)
packages/shared/    wire schemas (Zod), puzzle validator + normalizeWord, ids, constants (HINT_COST, WHEEL_PRIZES, PACKS, PLANS)
packages/api-client/ hcWithType over the gateway's emitted .d.ts (tsc --emitDeclarationOnly), never over source
```

### Event bus

- **Envelope** (`events/envelope.ts`): `{ id: uuid, type: "<module>.<pastTenseFact>", v: 1, occurredAt: iso, actor: {kind:"user",userId}|{kind:"system",reason}, correlationId, causationId, aggregate: { kind, id, version }, payload }`. Plain JSON only (RPC-safe). `id` is minted where the fact is produced (the gateway after the commit, using the returned snapshot version), so a retried request re-emits the same `(type, aggregate.id, aggregate.version)` key.
- **Registry** (`events/registry.ts`): each module's `contract.ts` exports `defineEvent(type, v, payloadSchema)`; `app/wiring.ts` composes `DomainEvent = z.discriminatedUnion("type", [...])`; `EventOf<T> = Extract<DomainEvent, { type: T }>`. Every event is `safeParse`d before dispatch; invalid → logged, dropped.
- **Subscriptions**: `{ name: "social.onSolveFinished", type, mode: "critical" | "background", handle(event, ctx) }` exported from each `subscriptions.ts`; `wiring.ts` builds an immutable `HandlerTable` at module evaluation. Nothing request-bound (`env`, `ExecutionContext`, stubs) lives in module scope (Cloudflare forbids cross-request I/O objects).
- **Dispatch semantics**: critical handlers run `for…of` in registration order, each awaited in `try/catch`; one failure never blocks the next; outcomes go into a `DispatchReport` that is logged with `correlationId` and partially surfaced to the client (e.g. `report.claimedCollections`). Background handlers are wrapped in `ctx.exec.waitUntil(p.catch(log))` (30 s shared budget after the response; never inside a DO where `waitUntil` is a no-op). Follow-on events from a handler are dispatched with `depth+1`, `causationId = parent.id`; guards: `MAX_DEPTH = 4`, `MAX_EVENTS_PER_REQUEST = 64`, per-request `seen` set on `type:kind:id:version`. A subscriber may issue commands only on its own module (or on `player`), never on a third module — it publishes a follow-on event instead.
- **Failure handling**: the HTTP response is still 2xx when the command committed and a handler failed (command failure is a `DomainError` → 422 and is distinct). Every handler is idempotent (aggregate no-op commits on equal state; `INSERT OR IGNORE` on natural keys; `processed_events` not needed in v1 because no handler moves money). Loss on isolate death mid-fan-out is healed by `POST /v1/me/reconcile` (admin/self) which recomputes `PuzzleStats.recordSolve`, collection claims and `player_solves` from the `User` snapshot — all idempotent. **Upgrade path** (in-process-event-bus R1–R7): DO outbox table written in `transactionSync` with state, per-handler ack, alarm redelivery via `ctx.exports.Events`, `processed_events` dedupe — adopt only if a background handler ever becomes money-relevant or loss becomes measurable. `Promise.allSettled` fan-out and Queues are explicitly not used.
- **Rule of thumb**: anything whose loss the user would notice on the Solved screen (tokens, stars, streak, completion, session close) is inside `User.finishSolve`, not an event.

### Composition with Aggregate / Projections (`packages/core`)

- `User` and `PuzzleStats` extend `Aggregate<State, Env>` (`kind`, `initial()`, commands via `this.commit(s => s')`, `snapshot()`); the base persists one row, bumps `version` only when JSON differs (wrong guesses and duplicate deliveries are free no-op commits), and flushes to D1 through `ctx.exports.Projections` with `setAlarm` backoff. Keep `flushMode: "await"` (`"background"` relies on `waitUntil`, a no-op in DOs).
- Required core changes: (1) `Projections.apply()` override for `kind === "user"` that runs the `versionedUpsert` into `player_state` **and** `INSERT OR IGNORE INTO player_solves` for the ≤5 newest completions in one `DB.batch` (atomic); (2) snapshot-size guard (warn > 256 KiB, throw > 1 MiB; DO row limit 2 MB); (3) because platform alarm retries stop after 6, `alarm()` must `setAlarm` its own retry on a failed flush; (4) no app-level alarms in v1 (streak break is evaluated lazily on read; reminders come from cron), so the single DO alarm stays owned by the flush retry. A multiplexed `nextAppAlarm` hook is the documented addition if presence ticks or subscription expiry ever need it.
- Aggregates are reached with `aggregateStub(env.USER, "user", userId)` (env bindings, so a future `script_name` re-point needs no caller change); the `Projections` entrypoint is reached by loopback `ctx.exports.Projections` (already what core does; typed by `wrangler types`).
- Errors cross RPC as `{ name, message }` only (custom `name` survival observed, not documented): `app.onError` maps `err.name === "DomainError"` → 422, `"NotInitializedError"` → 404, `"MergedError"` → 409, `HTTPException` → its status, `ZodError` → 400, `.retryable` → 503, else 500 with `requestId`. Never `instanceof`, never branch on `.remote`.

### Request lifecycle: finishing a puzzle

`POST /v1/solves/:solveId/finish { grid: string[] }` with `Authorization: Bearer <device token>`:

1. Gateway middleware: `requestId({ headerName: "" })` → `timing` → structured logger → `secureHeaders` → `bodyLimit(64 KB)` → `deviceAuth` (decode `kid`, `verify` HS256 with `iss/aud`, `typ === "device"`, `RL_USER.limit({ key: "u:<sub>" })`, `c.set("auth", { userId, tv })`) → `c.set("modules", createModules(requestContextFrom(c)))`.
2. `solving.http`: `zValidator("param", …)` + `zValidator("json", FinishBody, hook)` → `modules.solving.finish({ solveId, grid })`.
3. `solving.finish`: `player.getSnapshot(userId)` (one DO read) → asserts `session.id === solveId` → `content.withSecret(session.puzzleId)` (isolate cache, D1 fallback; never returned) → `gridMatches(normalize(grid), secret.sol)` else 422 `WRONG_GRID` → `player.finishSolve({ sessionId, now, minPlausibleMs })` — **one commit**: `elapsedMs = now − startedAt`, `secLeft = max(0, floor((par·1000 − elapsed)/1000))`, `tokens = replay||suspicious ? 0 : floor(secLeft/5)`, `stars = replay ? 0 : 10 + (hintsUsed === 0 ? 2 : 0)`, `completions[puzzleId]`, `applyStreak(dayKey(now, tz))`, `stats`, `session = null`, `ledgerSeq++`; projection flush writes `player_state` + `player_solves` (leaderboard fact) atomically.
4. `solving.finish` builds `solve.finished { userId, puzzleId, solveId, lang, dropDate, solveTimeMs, secLeft, par, hintsUsed, firstSolve, suspicious, tokensEarned, starsEarned, dayKey, streak }` and `await dispatch(table, [event], ctx)`:
   - critical, in order: `collections.onSolveFinished` (queries `content.collectionsContaining(puzzleId)`, checks completeness against `snapshot.completions`, calls `player.claimCollection({ collectionId, memberIds, reward })` → idempotent commit → emits `collections.completed`), `social.onSolveFinished` (`PuzzleStats.recordSolve`, excluded if `suspicious`).
   - background: `notifications.onSolveFinished` (cancel today's reminder row), `analytics`.
5. Response `SolveResult` from the snapshot + report: `{ solveTimeSec, secLeft, underPar, tokensEarned, starsEarned, noHintBonus, firstSolve, balances, streak: { count, extendedToday, week }, claimedCollections, nextPuzzleId, celebration }`. Two DO round-trips on the critical path (snapshot + finish) plus one `PuzzleStats` call; no D1 write on the request path except the projection flush.

## Domain model

### Aggregates

```ts
// player/internal/user.do.ts — keep JSON well under 100 KB (structuredClone per commit)
interface UserState {
  createdAt: number; tz: string /* IANA, default "UTC" */; tzChangedDay: string | null;
  lang: "en"|"uk"|"ru"; prefs: { level: "newbie"|"casual"|"shark"; topics: string[]; onboardingDone: boolean; notifications: "enabled"|"declined"|"skipped" };
  plan: { tier: "lite"|"month"|"year"; expiresAt: number|null; source: "mock"|"revenuecat"|"stripe"|null };
  wallet: { tokens: number; stars: number }; ledgerSeq: number;
  streak: { count: number; lastSolvedDay: string|null; longest: number };   // effective streak computed on read
  completions: Record<string, { day: string; solvedAt: number; timeMs: number; hintsUsed: number; tokens: number; stars: number; suspicious: boolean }>;
  likes: string[]; saves: string[];                                          // sorted puzzle ids
  wheel: { lastSpinDay: string|null; lastPrize: number|null; lastIndex: number|null };
  hints: { total: number; tokensSpent: number };
  stats: { solved: number; bestTimeMs: number|null };
  collectionsClaimed: string[]; pushTokens: string[]; installs: string[];
  session: null | { id: string; puzzleId: string; parSec: number; startedAt: number; pausedMs: number; pausedSince: number|null;
                    locked: number[]; hintsUsed: number; hintLog: { q: number; kind: "fifty"|"letter"|"word"; cost: number; at: number }[]; autocheck: boolean; replay: boolean };
  tokenVersion: number; mergedInto: string|null; mergeState: "pending"|"done"|null; absorbedFrom: string[];
}
// Commands: init, registerInstall, setPreferences, setTimezone(≤1/day, never lowers today), setPlan, toggleLike, toggleSave, startSolve,
// reportProgress({locked}), pauseSolve/resumeSolve, spendForHint({q, kind}) → DomainError("INSUFFICIENT_TOKENS"), finishSolve, spinWheel (one per local day,
// crypto.getRandomValues over [50,10,0,25,5,15], credited in the same commit), claimCollection, creditPurchase(purchaseId idempotent), bumpTokenVersion, purge,
// beginMerge/absorb/completeMerge (v2). All take `now` explicitly.

// social/internal/puzzle-stats.do.ts — tiny
interface PuzzleStatsState { likes: number; solved: number; noHintSolved: number; solvingNow: number; topToday: { day: string; rows: { userId: string; timeMs: number }[] } /* ≤10 asc */ }
// heartbeat(userId) keeps an in-memory Map and commits solvingNow at most every 15 s; adjustLikes(±1); recordSolve(...) keyed on the puzzle's drop_date.
```

Streak: on finish with `today = dayKey(now, tz)`: same day → unchanged; `prevDay(today)` → `count+1`; else `1`; `longest = max`. Effective streak on read = `count` if `lastSolvedDay ∈ {today, yesterday}` else 0; at-risk = `lastSolvedDay === yesterday`. Any solve in any language extends it; replays do not.

### D1 schema (one database `crosscut`; `migrations/0001_content.sql`, `0002_player.sql`, `0003_social_leaderboard.sql`)

| table | columns (PK **bold**) | indexes |
|---|---|---|
| `content_puzzles` | **id** ("en-mini-0001"), lang, kind (mini\|crossword), size, shape (word-square\|standard), title, author_id, author_name, difficulty (EASY\|MEDIUM\|TRICKY), par_sec (300\|600), clue_count, theme_word, reveal_json, cover_style (ink\|accent\|card), kicker, topics_json, content_json (public payload, no answers), content_hash, status (draft\|filled\|clued\|reviewed\|published), drop_date (YYYY-MM-DD or NULL = pool), published_at, created_at, updated_at | `(lang, drop_date)`, `(lang, status, drop_date)` pool pick, `(lang, author_id)` |
| `content_puzzle_secrets` | **puzzle_id** FK, solution_json `{ sol, answers: {"1A": …}, decoys }`, updated_at | — (never selected by feed/puzzle routes) |
| `content_daily_drops` | **(day, lang)**, puzzle_id FK, created_at | `(lang, day DESC)` feed; UNIQUE `(puzzle_id)` |
| `content_collections` | **id**, lang, shelf (theme\|size\|setter\|archive), name, emoji, blurb, style, reward, unlock_rule ("collection:travel" or NULL), position | `(lang, shelf, position)` |
| `content_collection_puzzles` | **(collection_id, position)**, puzzle_id FK | `(puzzle_id)` reward check |
| `content_meta` | **key**, value_json, updated_at (last successful `ensureDrops`, etc.) | — |
| `player_state` (projection, rebuildable) | **id**, version, tz, lang, level, topics_json, plan_tier, plan_expires_at, tokens, stars, streak, longest_streak, last_solved_day, local_day_ends_at, solved_count, best_time_ms, likes_json, saves_json, push_token_count, merged_into, updated_at | `(local_day_ends_at, last_solved_day)` reminders; `(plan_tier, plan_expires_at)` |
| `player_solves` (fact rows, `INSERT OR IGNORE`) | **id** = `user_id:puzzle_id`, user_id, puzzle_id, solved_at, day_key, week_key (ISO week), time_ms, hints_used, tokens, stars, suspicious | `(puzzle_id, suspicious, time_ms)`, `(user_id, solved_at DESC)`, `(week_key, user_id)` |
| `social_puzzle_stats` (projection) | **id** = puzzle id, version, likes, solved, no_hint_solved, solving_now, top_day, top_today_json, updated_at | — |
| `leaderboard_week` (cron-materialised) | **(week_key, rank)**, user_id, stars, solves | — |
| `economy_purchases` | **id** (client idempotency key), user_id, kind (tokens\|plan), payload, created_at | `(user_id)` |
| `notifications_reminders_sent` | **(user_id, day_key)**, sent_at | — |

Rules: D1 enforces foreign keys, so upserts are `INSERT … ON CONFLICT DO UPDATE` never `INSERT OR REPLACE`; ≤100 bound parameters per statement (23 per puzzle row → one statement per puzzle); `DB.batch` is one transaction; no cross-module JOINs except inside `feed`'s composed query over `content_*`, `social_puzzle_stats`, `player_solves` which is executed through each owner's query function (feed passes the user id and today).

### Event catalog

| event | payload (beyond envelope) | producer | consumers (mode) |
|---|---|---|---|
| `identity.userBootstrapped` | `{ userId, installId, platform, appVersion }` | identity | analytics (background) |
| `player.onboarded` | `{ userId, level, topics, lang, plan, notifications, tz }` | player (via `setPreferences`) | notifications.scheduleReminderOptIn (background) |
| `player.prefsChanged` | `{ userId, lang?, topics?, tz? }` | player | feed cache bust (background) |
| `solve.started` / `solve.paused` / `solve.resumed` | `{ userId, puzzleId, solveId, at }` | solving | social.presence (`heartbeat`/`leave`, background) |
| `solve.hintUsed` | `{ userId, solveId, puzzleId, kind, cost, balance }` | solving (after `spendForHint` committed) | analytics (background) |
| `solve.finished` | `{ userId, puzzleId, solveId, lang, dropDate, solveTimeMs, secLeft, par, hintsUsed, firstSolve, suspicious, tokensEarned, starsEarned, dayKey, streak }` | solving (after `finishSolve` committed) | collections.checkAndClaim (critical) → social.recordSolve (critical) → notifications.cancelReminder (background), analytics (background) |
| `collections.completed` | `{ userId, collectionId, reward, eventRef }` | collections (after `player.claimCollection` committed the reward) | collections.unlockDependants (critical, emits `collections.unlocked`), notifications (background) |
| `collections.unlocked` | `{ userId, collectionId }` | collections | feed cache bust (background) |
| `economy.wheelSpun` | `{ userId, wheelId, prizeIndex, prize, balance }` | economy (after `spinWheel` credited) | analytics (background) |
| `economy.packPurchased` / `economy.planChanged` | `{ userId, packId\|plan, tokens\|expiresAt, purchaseId, mocked: true }` | economy (after `creditPurchase`/`setPlan`) | analytics (background) |
| `social.likeToggled` / `social.saveToggled` | `{ userId, puzzleId, liked\|saved }` | social (after `toggleLike/Save` on `User`) | social.adjustLikes on `PuzzleStats` (critical — response needs the count) |
| `player.streakExtended` | `{ userId, count, dayKey }` | solving (derived from `finishSolve` result) | notifications (background) |
| `player.merged` (v2) | `{ deviceUserId, accountId }` | identity | leaderboard.rewriteRows (critical) |

Ordering inside `solve.finished` is a behavioural contract covered by a test. Amounts are computed once by the producer and carried in the payload; consumers never recompute economy.

## API surface

All under `/v1`, JSON, errors `{ error: { code, message?, issues?, requestId } }`; 401 carries `WWW-Authenticate: Bearer realm="crosscut"`; 402 `INSUFFICIENT_TOKENS { balance, cost }`; 422 domain errors; 429 rate-limited. Auth column: `none`, `device` (bearer device token), `admin` (`CONTENT_ADMIN_TOKEN` bearer).

**identity**

| method | path | auth | request | response | notes |
|---|---|---|---|---|---|
| POST | `/devices` | none (RL_BOOT per `cf-connecting-ip`) | `{ installId: uuid, platform: ios\|android\|web, appVersion, locale?, tz? }` | 201 `{ userId, token, expiresAt }` | `User.init` + `registerInstall`; `userId = "u_" + 26-char Crockford base32`; token `exp` 365 d |
| POST | `/session/refresh` | device (expired ≤ 30 d accepted) | — | `{ token, expiresAt }` | re-mint with active `kid`; 409 `{ error:"merged", mergedInto, token }` for merged aggregates (v2) |
| GET | `/me` | device | — | `{ id, displayName ("Player-7F3A"), since, lang, level, topics, plan, notifications, tz, balances:{tokens,stars}, streak:{count,todaySolved,atRisk,dayEndsAt}, completedIds, likes, saves, session: ContinueView\|null, wheel:{canSpin,lastPrize} }` | `User.snapshot()`; strongly consistent; the app's single source for optimistic state |
| DELETE | `/me` | device | — | 204 | purge aggregate + projection rows |
| POST | `/me/reconcile` | device or admin | — | `{ repaired: string[] }` | re-drives idempotent fan-out from the snapshot |

**player / onboarding**

| method | path | auth | request | response | notes |
|---|---|---|---|---|---|
| POST | `/me/onboarding` | device | `{ level, topics[], lang, plan, notifications, tz, skippedAt? }` | `/me` shape | idempotent overwrite; emits `player.onboarded` |
| PATCH | `/me/prefs` | device | partial of the above | `/me` shape | `tz` change limited to once per local day |
| GET | `/me/profile` | device | — | `{ displayName, since, balances, streak, solvedTotal, bestTimeSec, weekCount, achievements:{done,total}, completed:[{puzzleId,title,themeInitial}], langs }` | snapshot + `player_solves` query |
| GET | `/me/continue` | device | — | `{ solveId, puzzleId, title, locked, total, pct }\|null` | from `session` in snapshot (locked count reported by `reportProgress`) |

**feed / content (read)**

| method | path | auth | request | response | notes |
|---|---|---|---|---|---|
| GET | `/feed` | device | `?cursor&lang&limit(≤50, default 20)` | `{ items: FeedItem[], nextCursor, stories: Story[7], ticker: string[], streakAtRisk: {streak,dayEndsAt,puzzleId}\|null, balances }` | D1 query `content_daily_drops ⋈ content_puzzles ⋈ social_puzzle_stats ⋈ player_solves(userId)` where `day <= today(tz)`, order `day DESC, id DESC`, cursor `base64url([day,id])`; gateway interleaves `streak_save` (position 1, only if today unsolved), `wheel` (position 3 if `canSpin`), `mystery` every 6th; `liked/saved` from the snapshot; 10-page cap; first page cacheable 30–60 s per `(lang, today)` |
| GET | `/daily` | device | `?lang` | `{ dayKey, puzzleId }` | today's drop for the user's local day |
| GET | `/puzzles/:id` | device | — | `{ id, lang, kind, size, parSec, diff, title, author:{id,name,initial}, cover:{theme,themeWordLength,revealed:[{i,ch}],clue,clueMeta}, kicker, questionCount, dropDate, stats:{likeCount,solvedCount,solvingNow}, me:{done,bestTimeSec,inProgressSolveId,liked,saved} }` | never includes answers; `Review` mode after completion returns the grid letters via `/solves/:id` |
| GET | `/puzzles/:id/leaderboard` | device | `?period=today&limit=3` | `{ rows:[{rank,userId,displayName,solveTimeSec}], me:{rank,solveTimeSec}\|null }` | `social_puzzle_stats.top_today_json` (day = puzzle `drop_date`), fallback `player_solves` index |
| GET | `/puzzles/:id/next` | device | — | `{ nextPuzzleId }` | v1 order: today's drop → newest archive not completed |
| GET | `/collections` | device | `?lang` | `{ shelves:[{ key, title, countLabel, items:[{ id, name, emoji, theme, blurb, total, done, pct, locked, lockLabel, reward, claimed }] }] }` | manifest + `player_solves` progress in one grouped query |
| GET | `/collections/:id` | device | — | `{ …item, members:[{ n, puzzleId, title, meta, diff, done }] }` | |
| POST | `/collections/:id/claim` | device | — | `{ claimed, reward, balances }` | re-runs the completeness check; idempotent |

**solving**

| method | path | auth | request | response | notes |
|---|---|---|---|---|---|
| POST | `/puzzles/:id/solves` | device | `{ restart?: boolean }` | `SolveView = { solveId, puzzleId, size, parSec, grid, questions:[{index,dir,num,clue,length,cells}], locked, fixedLetters:[{r,c,ch}], secLeft, running, usedHints, autocheck, balances, status, replay }` | `User.startSolve` (replaces an abandoned session; `replay = puzzleId ∈ completions`); emits `solve.started` |
| GET | `/solves/:solveId` | device | — | `SolveView` | resume; `fixedLetters` = letters of locked words recomputed from the secret |
| POST | `/solves/:solveId/words` | device (RL_USER) | `{ questionIndex, word, locked: number[] }` | `{ correct, locked, newlyLocked, fixedLetters, nextQuestionIndex, complete }` | **stateless**: `normalizeWord(lang, word) === answer`, then `sweep()` over the client's locked set; no DO hop |
| POST | `/solves/:solveId/progress` | device | `{ locked: number[] }` | 204 | `reportProgress` commit; called on pause/exit only (feeds `/me/continue`) |
| POST | `/solves/:solveId/hints/fifty` | device (RL_SPEND) | `{ questionIndex }` | `{ options:[a,b], balances }` or 402 | `spendForHint(20)` commit, then decoy from `secret.decoys` or the language bank (same length, ≠ any grid answer) |
| POST | `/solves/:solveId/hints/fifty/pick` | device | `{ questionIndex, word, locked }` | words response | no charge |
| POST | `/solves/:solveId/hints/letter` | device (RL_SPEND) | `{ questionIndex, filled: string[] }` | `{ cell:[r,c], letter, …words }` or `{ noop:true }` (no charge if word already correct) or 402 | `spendForHint(40)`; first wrong-or-empty cell |
| POST | `/solves/:solveId/hints/word` | device (RL_SPEND) | `{ questionIndex, locked }` | words response | `spendForHint(100)` |
| POST | `/solves/:solveId/autocheck` | device | `{ on }` | `{ autocheck }` | free; does not set `usedHints` |
| POST | `/solves/:solveId/check` | device | `{ cells:[{r,c,ch}] }` | `{ wrongCells:[[r,c]] }` | stateless; only while autocheck is on |
| POST | `/solves/:solveId/pause` / `/resume` | device | — | `{ secLeft, running }` | server accumulates `pausedMs`; product cap on pauses is an open question |
| POST | `/solves/:solveId/finish` | device | `{ grid: string[] }` | `SolveResult` (see §3 lifecycle) | 422 `WRONG_GRID`, 409 `NO_ACTIVE_SESSION`; idempotent per `sessionId` |

**economy / wallet / wheel**

| method | path | auth | request | response | notes |
|---|---|---|---|---|---|
| GET | `/wallet` | device | — | `{ balances, packs:[{id,tokens,priceCents,currency,badge}], hintCosts:{fifty:20,letter:40,word:100}, ledger:[{at,delta,kind,reason,ref}] }` | packs 120/$0.99, 550/$3.99 "Popular", 1400/$8.99 "Best value" |
| POST | `/wallet/purchases` | device (RL_SPEND) | `{ packId, idempotencyKey }` | `{ balances, ledgerEntry }` | v1 mock: `economy_purchases` insert + `creditPurchase` |
| POST | `/billing/plan` | device | `{ plan: lite\|month\|year, idempotencyKey }` | `{ plan, adsRemoved, expiresAt }` | mock; `setPlan` |
| GET | `/wheel` | device | — | `{ wheels:[{ wheelId:"<dayKey>:base", canSpin, prize }] }` | one free spin per local day (decision; prototype allowed six per session) |
| POST | `/wheel/:wheelId/spin` | device (RL_SPEND) | `{ idempotencyKey }` | `{ prizeIndex, prize, prizes:[50,10,0,25,5,15], balances }` | 422 `ALREADY_SPUN`; client animates 3.4 s to the server's index |

**social**

| method | path | auth | request | response | notes |
|---|---|---|---|---|---|
| POST | `/puzzles/:id/like` | device | `{ liked }` | `{ liked, likeCount }` | `User.toggleLike` then `PuzzleStats.adjustLikes` (drift tolerated) |
| POST | `/puzzles/:id/save` | device | `{ saved }` | `{ saved }` | |
| GET | `/me/saved` | device | — | `{ puzzleIds }` | |
| POST | `/puzzles/:id/presence` | device | `{ state: solving\|left }` | `{ solvingNow }` | 30 s heartbeat while on Play; memory-only in `PuzzleStats` |

**content admin**

| method | path | auth | request | response | notes |
|---|---|---|---|---|---|
| POST | `/admin/content/import` | admin (`bodyLimit` 512 KB) | `{ puzzles: PuzzleFile[] (≤50), force? }` | 200/207 `{ imported, unchanged, rejected:[{id,issues}] }` | validator re-run; one `DB.batch` per puzzle (`content_puzzles` + `content_puzzle_secrets`), `content_hash` no-op, published grid change needs `force` |
| GET | `/admin/content/status` | admin | — | `{ poolDepth:{en,uk,ru}, nextDrops[14], byStatus, lastEnsureDropsAt }` | also read by the 06:00 alert cron |
| POST | `/admin/collections/import` | admin | manifest | report | |

Screen coverage: Welcome/Quiz/PlanReady/Notifs/Paywall → `/me/onboarding`, `/billing/plan`; Feed → `/me`, `/feed`, like/save, wheel; Browse → `/collections`, `/me/continue`; Collection detail → `/collections/:id`, claim; Profile → `/me/profile`, `PATCH /me/prefs`; Puzzle page → `/puzzles/:id`, leaderboard, `POST /puzzles/:id/solves`; Play → `/solves/:id`, words, hints, check, pause/resume, presence; Solved → `/finish` response, `/puzzles/:id/next`; Wallet → `/wallet`, purchases; Wheel modal → `/wheel/:id/spin`.

## Content pipeline

- **Authoring format** = the prototype format in a versioned envelope (`content/puzzles/<lang>/<id>.json`): `schemaVersion: 1`, `id` `<lang>-<mini|cross>-<nnnn>` (aliases mini1→`en-mini-0001`, cross1→`en-cross-0001`, mini2→`en-mini-0002`, mini3→`en-mini-0003`), `lang`, `kind`, `size` (5|9), `shape` (`word-square` relaxes the duplicate rule), `fullyChecked?` (default `kind === "mini"`), `title`, `author {id,name}`, `difficulty`, `par` (300|600), `themeWord`, `reveal[]`, `cover` (ink|accent|card), `kicker` (date suffix rendered by client from `drop_date`), `topics[]`, `grid[]` (`.`/`#`), `sol[]`, `across`/`down` as `[num, clue, answer, row, col]`, optional `decoys`, `status`, `publishedAt`.
- **Validator** (`packages/shared/src/puzzle/`): Zod `strictObject` + `superRefine` structural pass — grid/sol shape and block agreement; letters normalised with `normalizeWord(lang)` (NFC → strip `[\s'’ʼ\-.]` → `toLocaleUpperCase(lang)` → fold table `ru: Ё→Е`, `uk: none` → per-language alphabet whitelist EN 26 / RU 33 / UK 33; **never** NFD+strip-marks, which merges `й→и`, `ї→і`); derived numbering (standard rule, runs ≥ 2) must equal authored `(num,row,col,dir)`; every slot has exactly one clue; answer equals the solution read along the slot; min word length 3; every open cell covered, fully-checked policy for minis; no duplicate answers except word-square (across set = down set); clue must not contain its answer or its stem; clue ≤ 90 chars (warn); `themeWord` is an answer and `reveal` indexes are in range; par default check; mixed Latin/Cyrillic homoglyph rejection. Output is canonical and split by `splitPuzzle()` into `pub` (grid, clues without answers, `clueCount`) and `secret` (`sol`, `answers` by slot key, `decoys`). The same `normalizeWord` runs at word-check time.
- **Seeding**: `pnpm content:seed` → `seed/0001_content.sql` (one `INSERT … ON CONFLICT(id) DO UPDATE` per row, literal SQL, so the 100-parameter cap does not apply) → `wrangler d1 execute crosscut --local --file seed/0001_content.sql`. The four prototype puzzles seed `en-*`; collections seed with distinct member ids (drop the prototype's repeated ids and the `colProgress` hack). Production content goes through `POST /admin/content/import` only (`pnpm content:import --remote`).
- **Daily drop**: editors set `drop_date` or leave the puzzle in the pool; `content_daily_drops` is the resolved calendar. Feed visibility is `day <= today(userTz)`; hourly cron `ensureDrops(now, 3)` fills each `(day, lang)` for the next 3 UTC days (scheduled first, else oldest published pool puzzle), `INSERT OR IGNORE`, one `DB.batch` per language, and `init()`s the `PuzzleStats` object with a `locationHint` for the audience region. 06:00 cron alerts when a pool has < 14 puzzles or `content_meta.lastEnsureDropsAt` is stale (cron failures are silent). Leaderboard "today" for a puzzle is its `drop_date`.
- **Generation (v1 pipeline, scripts not Worker)**: in-house word banks `content/wordbank/<lang>.txt` (`WORD;score;topics`; EN seeded from the MIT Collaborative Word List ≥ 50, UK/RU LLM-drafted + native review; NC-licensed lists only for review-time checks) → `scripts/gen-crossword.mjs` CSP filler (pattern → slots → MRV + forward checking + scored candidates, seeded RNG, theme word pinned) → Claude Batches clue drafting via `client.messages.parse` + `zodOutputFormat` (handle `stop_reason: "refusal"`, run the answer-in-clue check) → human review in a PR → import. No npm generator fills a fixed block pattern; `@xwordly/xword-parser` (Node only; pulls `buffer`) converts editor-authored PUZ/iPUZ/JPZ/XD.

## Testing & DX

Pins (workers/gateway `devDependencies`): `@cloudflare/vitest-plugin ^1.1.3`, `vitest 4.1.11`, `@vitest/coverage-istanbul 4.1.11`, `wrangler 4.128.0`, `typescript 7.0.2`, `@biomejs/biome 2.5.11`; `packages/core` and `packages/shared` keep `@cloudflare/workers-types 5.20260902.1`. Run `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` on the copied core (rewrites dependency, imports, tsconfig `types`); `ProvidedEnv` no longer exists — test bindings are added by `declare namespace Cloudflare { interface Env { TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] } }`.

```jsonc
// workers/gateway/wrangler.jsonc (top level = local dev; env.production repeats vars/durable_objects/d1_databases/ratelimits with real ids)
{ "$schema": "node_modules/wrangler/config-schema.json", "name": "crosscut", "main": "src/app/index.ts", "compatibility_date": "2026-09-02",
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "triggers": { "crons": ["0 * * * *", "*/5 * * * *", "0 6 * * *"] },
  "exports": { "User": { "type": "durable-object", "storage": "sqlite" }, "PuzzleStats": { "type": "durable-object", "storage": "sqlite" } },
  "durable_objects": { "bindings": [ { "name": "USER", "class_name": "User" }, { "name": "PUZZLE_STATS", "class_name": "PuzzleStats" } ] },
  "d1_databases": [ { "binding": "DB", "database_name": "crosscut", "database_id": "local-dev" } ],
  "ratelimits": [ { "name": "RL_BOOT", "namespace_id": "1001", "simple": { "limit": 10, "period": 60 } },
                  { "name": "RL_USER", "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } },
                  { "name": "RL_SPEND", "namespace_id": "1003", "simple": { "limit": 20, "period": 60 } } ],
  "vars": { "APP_ENV": "dev" }, "dev": { "port": 8787 },
  "env": { "production": { "vars": { "APP_ENV": "production" }, "durable_objects": { "bindings": [ /* same */ ] },
           "d1_databases": [ { "binding": "DB", "database_name": "crosscut", "database_id": "<uuid from wrangler d1 create>" } ], "ratelimits": [ /* same */ ] } } }
// secrets: DEVICE_TOKEN_KEYS (JSON key ring), CONTENT_ADMIN_TOKEN — `.dev.vars` locally, `wrangler secret put X --env production`
```

Scripts (`workers/gateway/package.json`): `dev: wrangler dev --ip 0.0.0.0 --port 8787` · `dev:cron: wrangler dev --test-scheduled` (then `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"`) · `types: wrangler types` · `typecheck: wrangler types --check && tsc --noEmit` · `test: vitest run` · `test:coverage: vitest run --coverage` · `test:debug: vitest --inspect --no-file-parallelism` · `lint: biome lint src` · `db:new: wrangler d1 migrations create crosscut` · `db:migrate: wrangler d1 migrations apply crosscut` (local by default) · `db:migrate:prod: … --remote --env production` · `db:seed: wrangler d1 execute crosscut --local --file ./seed/0001_content.sql` · `deploy: wrangler deploy --env production`. Root: `pnpm install` → `turbo types typecheck lint test`; `turbo.json` tasks `types` (outputs `worker-configuration.d.ts`), `typecheck` (`dependsOn: ["types", "^typecheck"]`), `test` (`dependsOn: ["types"]`, inputs include `migrations/**`), `dev` (`cache:false, persistent:true`). CI: `pnpm install --frozen-lockfile` → `turbo typecheck lint test` → `wrangler deploy --dry-run --env production`. `.gitignore`: `.wrangler/`, `.dev.vars*`. Local state resets with `rm -rf .wrangler/state`; `wrangler dev --remote` is useless here (no DO/ratelimit/secret support); Local Explorer at `/cdn-cgi/explorer`.

Test tiers, all inside workerd (~1–2 s startup per file, per-file storage isolation, unique ids per test, always `await` storage calls, `using` for `RpcTarget` results, `await expect(async () => { await stub.x() }).rejects.toThrow()` for command failures, keep the template's `onUnhandledError` filter — expect workerd "code had hung" noise on every throwing RPC path):

1. **Pure domain** (no bindings): `questions/sweep`, `timeBonus/starsFor`, `dayKey/prevDay/applyStreak/effectiveStreak`, `normalizeWord` (Cyrillic table), puzzle validator over the four prototype puzzles, bus `dispatch()` with a fake table (ordering, isolation, report, loop guard, invalid event).
2. **Aggregates**: `User` — finish → `player_state` + `player_solves` rows; replay earns nothing; hint debit fails at 19 tokens; streak +1 across a tz day boundary and reset after a gap; wheel once per local day; `evictDurableObject` mid-session keeps the session; failed flush (D1 `test_flags` switch) → `runDurableObjectAlarm` → row appears exactly once. `PuzzleStats` — 100 heartbeats in 10 s ≤ 2 commits; `topToday` resets on a new day; likes never negative. One guard test asserting `runDurableObjectAlarm(stub)` is `false` on a fresh object in a new file.
3. **Modules/events**: call `solving.finish` with real `env`; assert snapshot, `PuzzleStats`, collection claim; deliver `solve.finished` twice → one claim; contract tests parse each module's `contract.examples` against the registry and freeze each module's public API keys; `test/arch.test.ts` scans imports (only `index.ts`/`contract.ts` across modules, never `app/`) and SQL table prefixes.
4. **HTTP end-to-end**: `exports.default.fetch` — bootstrap → token → `/me`; unknown `kid` → 401; refresh accepts ≤30-day-expired tokens; `RL_BOOT` returns 429 after 10 calls; feed first page is today's drop with no cursor duplicates; `/finish` returns the `SolveResult`; cron URL twice is a no-op the second time. Cheap Zod-layer checks via `app.request(path, init, env)`.

Time: every command and event takes `now` explicitly (`vi.useFakeTimers()`/`vi.setSystemTime()` work inside workerd and even inside DO instances, but they do not drive alarms or KV TTLs).

## Risks and open questions

**[UNVERIFIED] items carried over from the topic docs**

| # | item | source | mitigation |
|---|---|---|---|
| U1 | D1 UPSERT (`ON CONFLICT … DO UPDATE … WHERE`) and `RETURNING` are verified only in the local engine; no official D1 page lists them | durable-objects-d1-domain C20 | Production smoke test of `versionedUpsert` on first deploy; avoid `RETURNING` |
| U2 | Cron Trigger delivery/retry guarantee is undocumented (`controller.noRetry()` implies retries can happen; third parties say failures are lost) | durable-objects-d1-domain C12, content-pipeline C12 | Windowed, idempotent, duplicate-tolerant handlers; 06:00 health check |
| U3 | Rate Limiting binding availability on the Free plan and its pricing at scale | wrangler-config C10, identity-auth-v1 C6 | Verify on first deploy; fall back to guarding only bootstrap/spend routes |
| U4 | `exports` DO declaration end-to-end inside `@cloudflare/vitest-plugin` (supported per wrangler CHANGELOG 4.107, not executed) | wrangler-config Q3 | Milestone 0 runs core's tests under `exports` before anything depends on it |
| U5 | Whether DO stub calls count toward the 32-invocations-per-request cap | workers-modular-monolith Q7 | Irrelevant until a split; budget conservatively |
| U6 | `waitUntil` budget of an RPC-invoked entrypoint; AsyncLocalStorage across `waitUntil` continuations | in-process-event-bus F1, C15 | Not relied upon (no outbox entrypoint in v1; correlation id passed explicitly) |
| U7 | `wrangler tail` on the Free plan; `assets.not_found_handling` default | wrangler-config C23, F18 | Use Workers Logs dashboard; set `not_found_handling` explicitly when assets arrive |
| U8 | iOS Keychain `AFTER_FIRST_UNLOCK` items surviving iCloud restore | identity-auth-v1 C25 | Device test; Android reinstall is a new player regardless (say so in FAQ) |
| U9 | zod 4.5.4 on a physical Hermes device (Expo SDK 54/55) | zod4-usage C36 | Run `packages/shared` in a dev build early |
| U10 | wrangler's esbuild honouring workspace-package `exports` maps; `tools/lint` with TS 6 next to TS 7 not executed; Vitest `projects` + `cloudflareTest` inheritance not executed | modular-monolith-principles C23, Q2, Q4 | Not needed in v1 (folder modules, Biome, single vitest config) |
| U11 | Production tolerance of a redundant `nodejs_compat` flag | wrangler-config C26 | Omit the flag |
| U12 | `hono-openapi` `resolver()` option names | hono-best-practices Q8 | OpenAPI not in v1 |

**Product/design decisions still needed** (defaults chosen here in brackets): replay rewards [none; best time not updated for replays]; what extends the streak [any first-solve in any language]; wheel cadence [one per local day]; pause semantics [explicit pause/resume, no cap]; 50/50 decoy source [curated `decoys` or language bank]; Cyrillic keyboard layout and `Ё→Е` folding for ru [fold]; word-square minis repeating clue text [allowed]; 9×9 symmetry/fully-checked policy [off for `crossword`]; daily schedule (mini weekdays, 9×9 weekends?) [one drop per day per language]; social counters real vs fuzzed [real from day one]; achievements (12/30) and collection badges [undefined, out of v1]; reset-my-data UX; refresh grace window [30 days]; Free-plan headroom (100k Worker + 100k DO requests/day) → the DAU at which Paid is switched on.

**Technical risks**: TS 7.0 has no compiler API — ESLint-based boundary tooling waits for TS 7.1 (no date; `next` = `7.1.0-dev.20260902.1`); pnpm 11 `minimumReleaseAge` may skip day-old releases (`@cloudflare/vitest-plugin` 1.1.3, `typescript` 7.0.2) on a fresh install; `@cloudflare/vitest-plugin` hard-pins its own `zod` copy in the dev graph (scope any "one zod" check to `--prod`); per-puzzle `PuzzleStats` is a single hot object (fine to ~50k DAU with feed reads on D1 and presence in memory; shard by `hash(userId) % N` if needed); like-count drift between `User` and `PuzzleStats` is accepted (nightly recount optional); hint content that leaks the decoy pool must come from a bank that excludes every answer in the grid.

## Recommended implementation order

| milestone | scope | testable outcome |
|---|---|---|
| **M0 Scaffold** | pnpm workspace (`allowBuilds`, catalog), turbo, `packages/core` copied + codemod to `@cloudflare/vitest-plugin`, `workers/gateway` with `wrangler.jsonc` (`exports`, crons, ratelimits), `wrangler types`, Biome config, `test/arch.test.ts`, empty Hono app with middleware stack, `onError`, `/healthz` | `turbo typecheck lint test` green; core's 8 tests pass under `exports` + plugin 1.1.3 (closes U4); `wrangler deploy --dry-run --env production` |
| **M1 Shared domain + content** | `packages/shared`: constants, ids, `normalizeWord`, `questions/sweep`, puzzle validator + `splitPuzzle`; `content` module: migration 0001, seed script with the four prototype puzzles + collections, `withSecret` cache, `ensureDrops` cron, admin import/status | Validator passes/fails fixtures; `db:seed` then `GET /v1/puzzles/en-mini-0001` returns no answers; cron URL twice is idempotent |
| **M2 Identity + player** | `User` aggregate (all commands, projection + `player_solves` in one batch, size guard), `identity` (tokens, middleware, `/devices`, `/session/refresh`, `/me`, `DELETE /me`), `/me/onboarding`, `/me/prefs`, `/me/profile` | Bootstrap → `/me` round trip; unknown `kid` 401; 429 on boot flood; streak/day-key aggregate tests; failed-flush alarm recovery |
| **M3 Solving + economy** | `solving` module (start, words, progress, hints, check, pause/resume, finish), `economy` (wallet, packs, plan, wheel), `events` bus + `wiring.ts`, `solve.finished` critical chain | Full solve of `en-mini-0001` via HTTP earns `floor(secLeft/5)` tokens and 12 stars once; replay earns 0; hint at 19 tokens → 402; wheel twice → 422; dispatch report ordering test |
| **M4 Social, collections, feed** | `PuzzleStats` aggregate + presence, like/save, `collections` progress/claim + `collections.completed`, `feed` composition (stories, ticker, streak-at-risk, wheel/mystery interleave), `/puzzles/:id`, `/next` | Feed pagination has no gaps/duplicates (`EXPLAIN QUERY PLAN` uses the drop index); completing all members of `travel` grants 120 tokens exactly once and unlocks `food`; 100 heartbeats ≤ 2 commits |
| **M5 Leaderboard, notifications stub, reconcile** | `*/5` cron → `leaderboard_week`; `/puzzles/:id/leaderboard`; reminders cron + `notifications_reminders_sent`; `POST /me/reconcile`; observability polish | Board excludes `suspicious`; cron re-run idempotent; killing fan-out mid-request and reconciling restores `PuzzleStats` and claims |
| **M6 Client contract + deploy** | `tsc --emitDeclarationOnly` for `AppType`, `packages/api-client` (`hcWithType`), first `wrangler deploy --env production` (D1 create, secrets, content import), Free-plan checks (U1, U3) | Expo app compiles against the `.d.ts`; production smoke: bootstrap, feed, solve; UPSERT verified in production |
| **Later** | Better Auth + linking/merge, RevenueCat/Stripe webhooks, outbox/alarm redelivery, OpenAPI via `hono-openapi`, module extraction via `WorkerEntrypoint` + `services`, App Attest | — |
