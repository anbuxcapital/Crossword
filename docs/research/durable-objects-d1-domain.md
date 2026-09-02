# Durable Object aggregates + D1 read models for the Crosscut domain

Research date: 2026-09-02. Stack: one Cloudflare Worker (Hono + Zod), Durable Object aggregates built on the `packages/core` `Aggregate`/`ProjectionsBase` classes, D1 as the read model, Cron Triggers for daily housekeeping, tested in workerd via `@cloudflare/vitest-plugin` (Cloudflare renamed `@cloudflare/vitest-pool-workers` to `@cloudflare/vitest-plugin` on 2026-08-19; npm v1.0.0 was published 2026-08-20 and the latest v1.1.3 on 2026-09-01 — corrected by fact-check X1 via `npm view @cloudflare/vitest-plugin time`. The vitest config is the plugin style `import { cloudflareTest } from "@cloudflare/vitest-plugin"` — `plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })]` — and requires Vitest 4.1+ (both packages peer-depend on `vitest ^4.1.0`). Note (fact-check X2): this plugin-style API is *not* new with the rename — `@cloudflare/vitest-pool-workers` already exported `cloudflareTest()` from 0.19.0 and 0.22.0 no longer exports `defineWorkersConfig`/`defineWorkersProject`; the 2026-08-19 changelog post says "The Vitest configuration API is unchanged". Migration is therefore only a dependency/import/tsconfig-types rename (codemod: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`). The old package (0.22.0) still installs, but the docs point to "Migrate to Vitest plugin". Sources: https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ , https://developers.cloudflare.com/workers/testing/vitest-integration/ , https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ , npm tarballs `@cloudflare/vitest-pool-workers@0.22.0` and `@cloudflare/vitest-plugin@1.1.3` (`dist/pool/index.d.mts`), https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/vitest-plugin/CHANGELOG.md ).

Inputs read: the design handoff README (screens, formulas), `prototype-logic.js` (real economy rules: `tokens = floor(secLeft/5)`, `stars = 10 + 2 if no hints`, hint costs 20/40/100, wheel prizes `[50,10,0,25,5,15]`, par 300 s for a 5×5 Mini and 2× for bigger grids), `concepts.md` / `core-package.md` (architecture rules), and `/Users/peter/Projects/IOSApp/packages/core/src/*.ts` + tests (the base classes we will copy).

---

## Summary

- **Three aggregate kinds are enough**: `User` (economy, streak, preferences, likes/saves, wheel, the *active solve session*), `PuzzleStats` (per-puzzle counters, top solvers today, "solving now" presence held in memory), and nothing else stateful. Puzzles, daily drops, collections and leaderboards are plain D1 tables written by editors, the Cron Trigger and the projection path — they are not aggregates.
- **The solve session lives inside the `User` aggregate**, not in its own Durable Object. One user solves one puzzle at a time, and the session must debit tokens for hints and credit tokens/stars on finish atomically with the wallet and the streak. Keeping it in one object makes that a single `commit()`; a separate object would need cross-object orchestration for every hint.
- **Answers are verified server-side, timing is server-side.** The client never receives the solution. Word checks are stateless module calls against a cached puzzle (no DO hop); the finish command inside the `User` object computes `elapsed = now - session.startedAt` from server clocks, applies the prototype's formulas, and rejects implausibly fast solves.
- **Every read on the hot path hits D1, never a DO**: feed (cursor-paginated join over `puzzles`, `puzzle_stats`, `solves`), puzzle page, collections, leaderboards. DO reads are limited to `/me` (`snapshot()` once per app start, then the snapshot returned by every command).
- **One `PuzzleStats` object per daily puzzle is acceptable at 3k–50k DAU.** Cloudflare's documented soft limit is ~1,000 requests/s per object (500–1,000 for simple operations). At 50k DAU the realistic peak on the daily puzzle (presence heartbeats every 30 s + likes + finishes) is roughly 100–250 requests/s. Presence is kept in memory and its count is committed at most every 15 s (counter batching), so heartbeats cost no storage rows. Sharding (N counter objects summed in D1) is documented as the escape hatch, not the starting point.
- **Two small additions to the copied core are required**: (1) an app-level alarm hook, because `Aggregate` owns the object's single alarm for flush retries and `flush()` calls `deleteAlarm()` when caught up; (2) an `apply()` override in the app's `Projections` class so a `user` flush also inserts the newest completions into the `solves` table in one atomic `DB.batch`.
- **Daily drop = a `drop_date` column on `puzzles` plus an hourly cron safety net** that fills `daily_drops` for the next 3 calendar days from an editorial backlog and `init()`s the matching `PuzzleStats` objects. Cron Trigger retry behaviour is undocumented (the runtime exposes `controller.noRetry()`, so a retry *can* happen — see F9), so the cron is idempotent, tolerant of both a skipped and a duplicated run, and re-checks a rolling window instead of firing once at midnight.
- Verified numbers that shape the design: DO SQLite row/value limit 2 MB and 100 bound parameters; D1 statement limit 100 KB, 100 bound parameters, 30 s query limit, 10 GB per database; DO SQLite and D1 both include 25 B rows read + 50 M rows written per month on Workers Paid (overage $0.001/M read, $1.00/M written); DO requests $0.15/M after 1 M; Workers requests $0.30/M after 10 M.

---

## Findings

### F1. SQLite-backed DO storage API (`ctx.storage.sql`, transactions)
- `ctx.storage.sql.exec(query, ...bindings)` returns a `SqlStorageCursor` with `toArray()`, `one()` (throws unless exactly one row), `raw()`, `next()`, and properties `columnNames`, `rowsRead`, `rowsWritten`. Multiple semicolon-separated statements are allowed; bindings apply to the last one. `ctx.storage.sql.databaseSize` gives the DB size in bytes. Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (the former `/durable-objects/api/storage-api/` and `/durable-objects/api/sql-storage/` URLs both 301 to this page)
- "`sql.exec()` cannot execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`. Instead, use the `ctx.storage.transaction()` or `ctx.storage.transactionSync()` APIs." `transactionSync(callback)` "Invokes `callback()` wrapped in a transaction, and returns its result"; the callback must be synchronous; a throw rolls back. Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (canonical URL; `/durable-objects/api/storage-api/` redirects here)
- Write coalescing: "Any series of write operations with no intervening `await` will automatically be submitted atomically." Source: same page. This is why the base class `#persist()` (one synchronous `UPDATE`) needs no explicit transaction.
- "For predictable behavior, fully consume cursors synchronously before the next `await`". Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- SQLite-backed objects also expose a synchronous KV API (`ctx.storage.kv.get/put/delete/list`) and the async `ctx.storage.get/put/...`; KV-style methods "store and query data in a hidden SQLite table and are billed as rows read and rows written". Sources: storage-api page and https://developers.cloudflare.com/durable-objects/platform/pricing/
- New classes must be SQLite-backed: "Cloudflare recommends all new Durable Object namespaces use the SQLite storage backend" and "Creating new namespaces with the key-value storage backend is no longer supported for accounts without an existing key-value-backed namespace." Source: https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/

### F2. Alarms
- One alarm per object: "Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`." `setAlarm(ms)`, `getAlarm()`, `deleteAlarm()`. The handler receives `alarmInfo: { retryCount, isRetry }`.
- "Alarms have guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws." "Retries are performed using exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed."
- Alarms wake evicted/hibernated objects; the constructor runs before `alarm()`. Alarms do not repeat: re-arm inside the handler. Each `setAlarm()` is billed as one row written.
- **Retries run out.** After the 6 platform retries (backoff from 2 s) the platform stops retrying; the Rules page advises re-arming a fresh alarm yourself at `retryCount` ≈ 5. Recent alarm-related changes: `ctx.abort({ retryAlarm: false })` (DO changelog 2026-08-25) lets an alarm handler abort without a platform retry, and for Workers with `compatibility_date` ≥ 2026-02-24 `ctx.storage.deleteAll()` also deletes the pending alarm (gated by the Worker's compatibility date, not the calendar: the sketched `compatibility_date` 2026-09-02 gets it, a copied core pinned to an older date does not). Sources: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ , https://developers.cloudflare.com/durable-objects/api/alarms/ , DO changelog.
- Sources: https://developers.cloudflare.com/durable-objects/api/alarms/ , https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ , https://developers.cloudflare.com/durable-objects/platform/pricing/
- Consequence for the copied core: `Aggregate` uses the single alarm for flush retries and calls `deleteAlarm()` once `version <= projected`. Any app-level alarm (presence tick, streak reminder) must go through a hook in the base class (sketch below), or be moved to a cron. Because the platform's own retries are capped at 6, the flush-retry `alarm()` must `setAlarm()` a fresh alarm itself when a flush fails (R13.1) rather than relying on the platform to keep retrying.

### F3. DO limits and throughput guidance
- SQLite-backed objects: storage per object 10 GB; storage per account unlimited (Paid) / 5 GB (Free); key+value combined 2 MB; max string/BLOB/row 2 MB; max SQL statement 100 KB; max 100 bound parameters per query; max 100 columns per table; CPU per request 30 s default (configurable to 5 min). Source: https://developers.cloudflare.com/durable-objects/platform/limits/
- "An individual Object has a soft limit of 1,000 requests per second. You can have an unlimited number of individual objects per namespace." Source: same page.
- "A single Durable Object can handle approximately 500-1,000 requests per second for simple operations"; "Do not create a single 'global' Durable Object that handles all requests"; sharding formula "Required DOs = (Total requests/second) / (Requests per DO capacity)". Source: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Input gates: "You do not have to worry about a concurrent request having modified the value in storage. 'input gates' will automatically protect against unwanted concurrency. Read-modify-write is safe." Source: https://developers.cloudflare.com/durable-objects/examples/build-a-counter/
- `blockConcurrencyWhile` "executes an async callback while blocking any other events from being delivered to the Durable Object until the callback completes" (30 s timeout). `ctx.waitUntil` "has no effect in Durable Objects". `ctx.exports` "Contains loopback bindings to the Worker's own top-level exports." Source: https://developers.cloudflare.com/durable-objects/api/state/
- Note for the copied core: `flushMode: "background"` relies on `ctx.waitUntil(this.flush())`, which the docs say is a no-op in DOs. Keep the default `"await"` mode (the retry alarm still covers failures).

### F4. DO lifecycle, hibernation, placement
- Objects become inactive after "70-140 seconds of inactivity (no incoming requests or events)"; hibernation can occur after "10 seconds of no incoming request or event" when conditions are met; "When hibernated, the in-memory state is discarded". Source: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- "each Durable Object has one active instance at any particular time. All requests sent to that Durable Object are handled by that same instance." Source: https://developers.cloudflare.com/durable-objects/reference/in-memory-state/
- WebSocket Hibernation API: `ctx.acceptWebSocket`, `webSocketMessage/Close/Error`, `ctx.getWebSockets`, attachments up to 16,384 bytes; "Billable Duration (GB-s) charges do not accrue during hibernation"; up to 32,768 connections per object. Sources: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ , https://developers.cloudflare.com/durable-objects/api/state/ — not needed for v1 (presence uses HTTP heartbeats).
- Placement: "By default, a Durable Object is instantiated in a data center close to where the initial `get()` request is made." "Durable Objects do not currently change locations after they are created." `locationHint` values: wnam, enam, sam, weur, eeur, apac, apac-ne, apac-se, oc, afr, me. Pre-creating objects can hurt latency "when the first client request is not representative of where the majority of requests will come from." Source: https://developers.cloudflare.com/durable-objects/reference/data-location/
- `idFromName` first use may cost "up to a few hundred milliseconds" (global uniqueness check); `newUniqueId` avoids it. Source: https://developers.cloudflare.com/durable-objects/api/namespace/

### F5. DO pricing (Workers Paid)
- Requests: 1 M/month included, then $0.15/million. Duration: 400,000 GB-s/month included, then $12.50/million GB-s.
- SQLite storage (billing enabled January 2026): rows read "First 25 billion / month included + $0.001 / million rows"; rows written "First 50 million / month included + $1.00 / million rows"; stored data 5 GB-month included, then $0.20/GB-month.
- Free plan: 100k requests/day, 13,000 GB-s/day, 5 M rows read/day, 100k rows written/day, 5 GB.
- Source: https://developers.cloudflare.com/durable-objects/platform/pricing/

### F6. D1 limits
- Max database size 10 GB (Paid) / 500 MB (Free); 50,000 databases per account (Paid); 1 TB storage per account.
- Queries per Worker invocation 1,000 (Paid) / 50 (Free); max SQL statement length 100 KB; max query duration 30 s; max 100 bound parameters per query; max 100 columns per table; max row/string/BLOB 2 MB; "Limits for individual queries apply to each individual statement contained within a batch."
- Source: https://developers.cloudflare.com/d1/platform/limits/

### F7. D1 pricing and how rows are counted
- Paid: first 25 billion rows read/month and 50 million rows written/month included, then $0.001/M read and $1.00/M written; 5 GB storage included, then $0.75/GB-month. Free: 5 M reads/day, 100k writes/day, 5 GB.
- "Rows read measure how many rows a query reads (scans), regardless of the size of each row." Full table scans count every scanned row. Indexed columns add one write per write operation (index maintenance). Read replicas incur no extra charge.
- Sources: https://developers.cloudflare.com/d1/platform/pricing/ , https://developers.cloudflare.com/d1/best-practices/use-indexes/
- Composite indexes are used only when the query constrains a left-prefix of the index columns; verify with `EXPLAIN QUERY PLAN`. Source: https://developers.cloudflare.com/d1/best-practices/use-indexes/

### F8. D1 Worker API: batch atomicity, sessions, read replication
- "Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence." `D1Result.meta` exposes `rows_read`, `rows_written`, `changes`, `last_row_id`, `duration`, `served_by`, `size_after`, `changed_db`. Source: https://developers.cloudflare.com/d1/worker-api/d1-database/
- Sessions API: `env.DB.withSession("first-primary" | "first-unconstrained" | bookmark)`, `session.getBookmark()`; gives sequential consistency (monotonic reads/writes, read-your-own-writes). "All write queries are still forwarded to the primary database instance." Read replication is enabled per database in the dashboard or via REST (`"read_replication": {"mode": "auto"}`). Source: https://developers.cloudflare.com/d1/best-practices/read-replication/
- Supported SQL: SQLite with FTS5, JSON extension, math functions and a listed set of PRAGMAs. The docs page does not explicitly list UPSERT (`ON CONFLICT`) or `RETURNING`. The `packages/core` `versionedUpsert()` uses `INSERT ... ON CONFLICT(id) DO UPDATE ... WHERE excluded.version > t.version`, and the core test-suite (8/8) passes against local D1 in workerd, so UPSERT is verified locally [UNVERIFIED in production]. Fact-check addendum: `wrangler d1 execute --local` on wrangler 4.128.0 / workerd 1.20260831.1 accepted `INSERT ... ON CONFLICT(id) DO UPDATE SET ... WHERE excluded.v>t.v RETURNING id, v` and returned the row, so both UPSERT and `RETURNING` work in the local D1 engine; neither is mentioned on any official D1 page (sql-statements, d1-database, prepared-statements), so production behaviour has no documentary confirmation [UNVERIFIED] — do not rely on `RETURNING` without a production smoke test. The `versionedUpsert` path (`ON CONFLICT ... DO UPDATE ... WHERE`) is widely used with D1 but equally undocumented; the fact-check independently re-confirmed both UPSERT and `RETURNING` in the local engine (wrangler 4.128.0) and re-checked the D1 release notes, which are also silent. Sources: https://developers.cloudflare.com/d1/sql-api/sql-statements/ , https://developers.cloudflare.com/d1/worker-api/prepared-statements/
- D1 migrations: `wrangler d1 migrations create|list|apply`, default folder `migrations/` (override `migrations_dir`), tracking table `d1_migrations` (override `migrations_table`). Source: https://developers.cloudflare.com/d1/reference/migrations/

### F9. Cron Triggers and the scheduled handler
- Config: `"triggers": { "crons": ["*/3 * * * *", "0 15 1 * *"] }` in `wrangler.jsonc`. Handler: `async scheduled(controller, env, ctx)` with `controller.cron`, `controller.scheduledTime` (ms since epoch, UTC), `controller.type === "scheduled"`; "The runtime waits for the promise returned by the scheduled() handler to resolve (up to the 15-minute duration limit)." Local test: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"` (optionally `&time=`). Limit: 5 Cron Triggers (Free) / 250 (Paid) — listed **per account** on the limits page, not per Worker (the cron-triggers page links to Limits for the "maximum number of Cron Triggers per Worker", so the two pages disagree in wording; the limits-page per-account reading is the safer one). **CPU budget:** on Workers Paid, a Cron Trigger gets 30 s CPU time when its interval is < 1 hour and 15 min CPU only for intervals ≥ 1 hour; the 15-minute figure above is wall-clock. The `*/5 * * * *` leaderboard recompute therefore runs under a 30 s CPU cap (D1 wait time is not CPU, so the ~350k-row query is probably fine, but any in-Worker aggregation must stay small). Sources: https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ , https://developers.cloudflare.com/workers/platform/limits/
- Delivery guarantee [UNVERIFIED] (C12): the official pages do not state an at-least-once guarantee or a retry policy. The earlier claim that "a failed scheduled invocation is not retried" came only from third-party blogs and should not be relied on: the Cron Triggers page documents `controller.noRetry()` ("The noRetry field is true when the scheduled handler calls controller.noRetry()") and `@cloudflare/workers-types` 5.20260902.1 declares `ScheduledController.noRetry(): void`, which only makes sense if the platform can retry a scheduled event. Correct statement: retry behaviour is undocumented; design handlers to be idempotent and tolerant of **both a skipped and a duplicated run**. Sources: https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ , npm `@cloudflare/workers-types@5.20260902.1` (`interface ScheduledController { scheduledTime; cron; noRetry(): void }`). Third-party write-ups (low confidence): https://runhooks.app/blog/cloudflare-workers-cron-triggers-limits/ , https://crontap.com/blog/cloudflare-workers-cron-minute-limit

### F10. Wrangler configuration for DO classes
- `enable_ctx_exports` is default-on for compatibility dates ≥ 2025-11-17 (the loopback stub the core uses to reach `Projections`); `rpc` is default-on since 2024-04-03. Source: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Two config styles exist for declaring DO classes: the legacy `"migrations": [{ "tag": "v1", "new_sqlite_classes": [...] }]` array (what `packages/core/test/wrangler.jsonc` uses and what passed 8/8 tests) and the newer `"exports": { "MyDurableObject": { "type": "durable-object", "storage": "sqlite" } }` map. "Both flows are supported, but a Worker can only use one at a time." and "Once a Worker has been deployed with `exports`, subsequent deploys cannot return to the legacy `migrations` array." "Deleting a class destroys its data." Source: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ (the legacy `migrations`-array reference has moved to https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/ ) — fact-check confirmed that wrangler 4.128.0 accepts the `exports` map (its config types include `type: "durable-object"` and the `created`/`deleted`/`renamed`/`transferred`/`expecting-transfer` lifecycle states; DO changelog 2026-07-04 says `exports` "replaces the imperative migrations array", legacy migrations still work). The choice is purely one-way (`exports` → no return to `migrations`); the sketch below keeps the `migrations` array because that is what the copied core's tests ran against.
- Tooling note: wrangler 4.128.0 bundles workerd 1.20260831.1 and miniflare 5.20260831.0-alpha. A `compatibility_date` of 2026-09-02 (as in the sketched `wrangler.jsonc`) is two days past the bundled workerd build; it started cleanly in `wrangler dev` in the original local check, but the fact-check did not re-run a dev server to re-verify this, so keep the fallback of pinning `compatibility_date` ≤ the bundled workerd build date (2026-08-31) if wrangler rejects it. Also: with `compatibility_date` ≥ 2026-08-04, `nodejs_compat` (and `nodejs_compat_v2`) are on by default, so the sketched `"compatibility_flags": ["nodejs_compat"]` is redundant (harmless).

### F11. Workers pricing (for the DAU estimate)
- Paid: $5/month, 10 M requests included then $0.30/M, 30 M CPU-ms included then $0.02/M CPU-ms. Free: 100k requests/day. Source: https://developers.cloudflare.com/workers/platform/pricing/

### F12. Time zones in Workers
- workerd runs with TZ=UTC locally to match production ("Date and Intl APIs inside your Worker observe UTC"), so local-day computation must go through `Intl.DateTimeFormat(..., { timeZone })` with the user's IANA zone. Source for the UTC statement: https://developers.cloudflare.com/workers/local-development/ only (fact-check: the web-standards page contains no such statement). What the web-standards page does say is that `Date.now()` only advances at I/O boundaries (timers are frozen within a single execution to mitigate timing attacks); this is relevant to `elapsed = now - startedAt` inside a DO and is fine in practice because each request is a new I/O event, so `Date.now()` at `finishSolve` reflects real wall-clock time — just do not measure sub-request durations with it. Source: https://developers.cloudflare.com/workers/runtime-apis/web-standards/ . That the bundled ICU data covers every IANA zone is UNVERIFIED (medium confidence; verify with a workerd test over the zones you ship).

### F13. Durable Object Facets
- A beta feature (Workers Paid) that lets one object host named sub-objects with their own SQLite databases via `ctx.facets.get(name, ...)`; the docs URL `/durable-objects/api/facets/` returned 404 at research time — the facets docs actually live at https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/ (found during fact-check). Not needed for Crosscut; noted only because it is sometimes suggested for per-shard counters. Sources: https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/ , https://blog.cloudflare.com/durable-object-facets-dynamic-workers/

---

## Recommendation for Crosscut

### R1. Aggregate list

| Kind | Name (`aggregateStub`) | Owns | Commands (all return `Snapshot<State>`) | Projection table |
|---|---|---|---|---|
| `user` | `user:<betterAuthUserId>` | wallet, streak, prefs, plan, completions, likes, saves, wheel, hint totals, push tokens, **active solve session** | `init`, `setPreferences`, `setTimezone`, `setPlan`, `addPushToken/removePushToken`, `toggleLike`, `toggleSave`, `startSolve`, `spendForHint`, `abandonSolve`, `finishSolve`, `spinWheel`, `claimCollection`, `creditPurchase` | `user_state` (+ rows into `solves`) |
| `puzzle_stats` | `puzzle_stats:<puzzleId>` | like count, solved count, top solvers today, solving-now presence (memory) | `init`, `adjustLikes(±1)`, `recordSolve(userId, timeMs, dayKey, noHints)`, `heartbeat(userId)`, `leave(userId)` | `puzzle_stats` |

Not aggregates: `puzzles`, `puzzle_secrets`, `daily_drops`, `collections`, `collection_puzzles`, `leaderboard_*` — plain D1 tables (editorial or cron/projection written). Auth is Better Auth's own D1 schema, per `concepts.md`.

Rejected alternatives:
- Separate `SolveSession` DO — every hint would need two objects (session + wallet) and a compensating action on failure. Inside `User` a hint is one `commit()`.
- Per-user like/save tables in D1 as the source of truth — they are owned by one entity and toggled by commands, which is the definition of aggregate state in `concepts.md`; the projection can expose them if a query ever needs them.
- Storing solver ids inside `PuzzleStats` for idempotent `recordSolve` — 50k ids would push the snapshot toward the 2 MB row limit and make every like re-serialize ~1.5 MB. Keep the snapshot under ~50 KB; dedupe through the `solves` table instead (below).

### R2. State shapes

```ts
// user aggregate — keep JSON well under 100 KB; structuredClone runs on every commit
export interface UserState {
  createdAt: number;
  tz: string;                                   // IANA zone, e.g. "Europe/Kyiv"; default "UTC"
  lang: "en" | "uk" | "ru";
  prefs: { level: "newbie" | "casual" | "shark"; topics: string[]; onboardingDone: boolean; notifications: boolean };
  plan: { tier: "lite" | "month" | "year"; expiresAt: number | null; source: "revenuecat" | "stripe" | null };
  wallet: { tokens: number; stars: number };
  streak: { count: number; lastSolvedDay: string | null; longest: number }; // day keys "YYYY-MM-DD" in user tz
  completions: Record<string, CompletionRecord>;  // puzzleId -> first completion only
  likes: string[];                                // puzzle ids (sorted, for stable no-op detection)
  saves: string[];
  wheel: { lastSpinDay: string | null; lastPrize: number | null };
  hints: { total: number; tokensSpent: number };
  stats: { solved: number; bestTimeMs: number | null };
  collectionsClaimed: string[];
  pushTokens: string[];
  session: SolveSession | null;                   // at most one active solve
  ledgerSeq: number;                              // increments per wallet change; used as dedupe key in projections
}
export interface CompletionRecord {
  day: string; solvedAt: number; timeMs: number; hintsUsed: number; tokens: number; stars: number; suspicious: boolean;
}
export interface SolveSession {
  id: string;             // crypto.randomUUID()
  puzzleId: string;
  parSec: number;         // copied from puzzle at start (300 for 5x5, 600 for 9x9)
  startedAt: number;      // server clock
  hintsUsed: number;
  hintLog: Array<{ clue: number; kind: "fifty" | "letter" | "word"; cost: number; at: number }>;
  autocheckUsed: boolean; // free, informational
}

// puzzle_stats aggregate — deliberately tiny
export interface PuzzleStatsState {
  likes: number;
  solved: number;
  noHintSolved: number;
  solvingNow: number;     // last committed presence count (memory Map is the live value)
  topToday: { day: string; rows: Array<{ userId: string; timeMs: number }> }; // max 10, sorted asc
}
```

### R3. Command rules (the write model)

**Timezone / day keys.** `dayKey(ms, tz)` = `Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))` → `"2026-09-02"`. `prevDay(key)` via `Date.UTC` arithmetic on the key. Day keys compare lexicographically. `setTimezone(tz)` validates the zone by constructing the formatter (throws `DomainError("bad_tz")` on RangeError), and is limited to one change per local day to stop "travel" abuse; a solve can never set `lastSolvedDay` to a value lower than the current one.

**Streak.** On `finishSolve` with `today = dayKey(now, tz)`: if `lastSolvedDay === today` → unchanged; else if `lastSolvedDay === prevDay(today)` → `count + 1`; else `count = 1`. `longest = max(longest, count)`. The *effective* streak for display is computed on read: `count` if `lastSolvedDay ∈ {today, yesterday}`, else 0 — no alarm mutates state at midnight. "At risk" = `lastSolvedDay === yesterday`. Any solved puzzle keeps the streak alive (README: "Your streak counts across all of them").

**startSolve({ puzzleId, parSec, now })** → replaces any existing session (an abandoned session is simply overwritten; nothing was earned). Returns the session id. If the puzzle is already in `completions`, the session is a replay (`replay: true` in the returned session — model as a field) and earns nothing on finish.

**spendForHint({ sessionId, clue, kind, now })** — costs `{ fifty: 20, letter: 40, word: 100 }` (prototype). Requires matching active session and `wallet.tokens >= cost`, else `DomainError("insufficient_tokens")` (gateway maps to 402 → Wallet). Debits, appends `hintLog`, bumps `hints`. The *content* of the hint (decoy candidates, revealed letter, full word) is produced by the stateless `Solving` module after the debit succeeds, from the server-side solution.

**finishSolve({ sessionId, now, verified: true, gridHash })** — called only after the `Solving` module has verified the submitted grid against `puzzle_secrets.solution` (the DO never holds solutions). Inside the commit:
```
elapsedMs = now - session.startedAt
secLeft   = max(0, floor((parSec*1000 - elapsedMs) / 1000))
tokens    = floor(secLeft / 5)                     // prototype
stars     = 10 + (session.hintsUsed === 0 ? 2 : 0) // prototype
suspicious = elapsedMs < minPlausibleMs(puzzle)    // e.g. 400 ms per fillable cell, min 12 s
if suspicious: tokens = 0 (stars still granted, record flagged)
if replay (already completed): tokens = 0, stars = 0, completions unchanged, streak unchanged
```
Then: `completions[puzzleId] = {...}`, wallet += tokens/stars, streak update, `stats`, `session = null`, `ledgerSeq++`. Returns the snapshot; the gateway then (outside the object) calls `puzzleStats.recordSolve(...)` and the collections check (R6).

**Anti-cheat basics (v1).** (a) Solution never leaves the server; per-word checks are server calls (`POST /solve/:sid/check` with `{clue, word}`) that return `{ correct }` — ~10 calls per puzzle, stateless, puzzle cached in memory/KV, no DO hop. (b) All timing from server clocks; the client timer is cosmetic. (c) Plausibility floor + `suspicious` flag; suspicious solves are excluded from `topToday` and leaderboards. (d) Hints are server-issued, so a "no-hint" bonus cannot be forged. (e) `finishSolve` is idempotent per `sessionId` (second call returns the same snapshot). Deliberately *not* attempted: keystroke telemetry, device attestation.

**spinWheel({ now })** — one free spin per local day: `wheel.lastSpinDay !== today` else `DomainError("already_spun")`. Prize index from `crypto.getRandomValues` over `[50,10,0,25,5,15]`; credit tokens in the same commit; return `{ index, prize }` embedded in state (`wheel.lastPrize`, plus index) so the client animates to the server's result.

**toggleLike / toggleSave(puzzleId)** — pure set toggles; the command's return tells the gateway whether it became liked, and the gateway then calls `puzzleStats.adjustLikes(+1|-1)`. Drift between the two objects on failure is tolerated (counters are approximate by design; a nightly cron can recount from `user_state.likes_json`… or simply accept drift).

**claimCollection({ collectionId, memberIds, reward })** — verifies every `memberId ∈ completions` and `collectionId ∉ collectionsClaimed`; credits `reward` tokens once. Orchestrated by the gateway after a solve (R6).

**creditPurchase({ purchaseId, tokens })** and **setPlan({ tier, expiresAt, purchaseId })** — webhook-driven; idempotent by `purchaseId` (keep the last ~50 ids in state, or dedupe against a D1 `purchases` table before calling).

**PuzzleStats.heartbeat(userId)** — updates an in-memory `Map<userId, lastSeenMs>` (not state). Prunes entries older than 90 s. If `now - lastPresenceCommit > 15_000` (or the count crossed zero), commits `solvingNow = map.size` — that is the counter batching: at most 4 D1 writes/minute per puzzle regardless of how many players. The map is lost on hibernation/eviction; it rebuilds within one heartbeat interval, which is acceptable for a "297 solving now" number.

**PuzzleStats.recordSolve({ userId, timeMs, dayKey, noHints, suspicious })** — `solved++`, `noHintSolved += noHints`, and if `dayKey === topToday.day` insert into `topToday.rows` (keep 10, ascending), else reset `topToday = { day: dayKey, rows: [...] }`. "Today" for a puzzle is the *puzzle's* drop date in a fixed reference zone (UTC), not each solver's zone — document in the API.

### R4. D1 schema

```sql
-- migrations/0001_crosscut.sql

-- Editorial content (written by import scripts / admin routes; read by everything)
CREATE TABLE puzzles (
  id            TEXT PRIMARY KEY,           -- "en-mini-2026-09-02", matches existing JSON ids
  lang          TEXT NOT NULL,              -- en | uk | ru
  kind          TEXT NOT NULL,              -- mini | crossword
  size          INTEGER NOT NULL,           -- 5 | 9
  title         TEXT NOT NULL,
  author_id     TEXT NOT NULL,              -- setter slug, e.g. "thea-v"
  author_name   TEXT NOT NULL,
  difficulty    TEXT NOT NULL,              -- EASY | MEDIUM | TRICKY
  par_sec       INTEGER NOT NULL,           -- 300 / 600
  clue_count    INTEGER NOT NULL,
  theme_word    TEXT NOT NULL,
  reveal_json   TEXT NOT NULL,              -- "[0,2,4]"
  cover_style   TEXT NOT NULL,              -- ink | accent | card
  kicker        TEXT NOT NULL,
  topics_json   TEXT NOT NULL DEFAULT '[]',
  content_json  TEXT NOT NULL,              -- grid + clues WITHOUT answers (what the client gets)
  drop_date     TEXT,                       -- "YYYY-MM-DD" calendar date of the daily drop, NULL = archive/pool
  published     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX puzzles_feed ON puzzles (lang, published, drop_date DESC, id DESC);
CREATE INDEX puzzles_pool ON puzzles (lang, published, drop_date);   -- cron picks unscheduled puzzles

CREATE TABLE puzzle_secrets (               -- server-only; never selected by feed/puzzle routes
  puzzle_id     TEXT PRIMARY KEY REFERENCES puzzles(id),
  solution_json TEXT NOT NULL,              -- rows of letters; answers per clue derivable
  decoys_json   TEXT NOT NULL DEFAULT '{}'  -- optional curated 50/50 decoys per clue
);

CREATE TABLE daily_drops (                  -- cron-maintained registry, 3 days ahead
  day        TEXT NOT NULL,
  lang       TEXT NOT NULL,
  puzzle_id  TEXT NOT NULL REFERENCES puzzles(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, lang)
);

CREATE TABLE collections (
  id          TEXT PRIMARY KEY,             -- travel | art | ... | archive-2026-08
  lang        TEXT NOT NULL,
  shelf       TEXT NOT NULL,                -- theme | size | setter | archive
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  blurb       TEXT NOT NULL,
  style       TEXT NOT NULL,
  reward      INTEGER NOT NULL,
  unlock_rule TEXT,                         -- NULL or "collection:travel"
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX collections_shelf ON collections (lang, shelf, position);

CREATE TABLE collection_puzzles (
  collection_id TEXT NOT NULL REFERENCES collections(id),
  puzzle_id     TEXT NOT NULL REFERENCES puzzles(id),
  position      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, position)
);
CREATE INDEX collection_puzzles_by_puzzle ON collection_puzzles (puzzle_id);

-- Projections (disposable; rebuilt via reproject())
CREATE TABLE user_state (
  id                TEXT PRIMARY KEY,
  version           INTEGER NOT NULL,
  tz                TEXT NOT NULL,
  lang              TEXT NOT NULL,
  level             TEXT NOT NULL,
  topics_json       TEXT NOT NULL,
  plan_tier         TEXT NOT NULL,
  plan_expires_at   INTEGER,
  tokens            INTEGER NOT NULL,
  stars             INTEGER NOT NULL,
  streak            INTEGER NOT NULL,       -- raw count; effective streak computed with last_solved_day
  longest_streak    INTEGER NOT NULL,
  last_solved_day   TEXT,
  local_day_ends_at INTEGER NOT NULL,       -- epoch ms of the end of the user's current local day (at projection time)
  solved_count      INTEGER NOT NULL,
  best_time_ms      INTEGER,
  likes_json        TEXT NOT NULL,
  saves_json        TEXT NOT NULL,
  push_token_count  INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX user_state_streak_reminder ON user_state (local_day_ends_at, last_solved_day);
CREATE INDEX user_state_plan ON user_state (plan_tier, plan_expires_at);

CREATE TABLE puzzle_stats (
  id             TEXT PRIMARY KEY,          -- puzzle id
  version        INTEGER NOT NULL,
  likes          INTEGER NOT NULL,
  solved         INTEGER NOT NULL,
  no_hint_solved INTEGER NOT NULL,
  solving_now    INTEGER NOT NULL,
  top_day        TEXT,
  top_today_json TEXT NOT NULL,             -- [{userId,timeMs}] ≤ 10
  updated_at     INTEGER NOT NULL
);

-- Leaderboard facts: one immutable row per (user, puzzle), inserted by the user projection
CREATE TABLE solves (
  id          TEXT PRIMARY KEY,             -- user_id || ':' || puzzle_id  (idempotency key)
  user_id     TEXT NOT NULL,
  puzzle_id   TEXT NOT NULL,
  solved_at   INTEGER NOT NULL,
  day_key     TEXT NOT NULL,                -- user-local day
  week_key    TEXT NOT NULL,                -- ISO week "2026-W36" (user-local)
  time_ms     INTEGER NOT NULL,
  hints_used  INTEGER NOT NULL,
  tokens      INTEGER NOT NULL,
  stars       INTEGER NOT NULL,
  suspicious  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX solves_by_puzzle_time ON solves (puzzle_id, suspicious, time_ms);
CREATE INDEX solves_by_user       ON solves (user_id, solved_at DESC);
CREATE INDEX solves_by_week       ON solves (week_key, user_id);

-- Cron-materialised leaderboards (recomputed every 5 min; cheap, idempotent, no incremental math)
CREATE TABLE leaderboard_week (
  week_key  TEXT NOT NULL,
  rank      INTEGER NOT NULL,
  user_id   TEXT NOT NULL,
  stars     INTEGER NOT NULL,
  solves    INTEGER NOT NULL,
  PRIMARY KEY (week_key, rank)
);

CREATE TABLE purchases (                    -- webhook idempotency for RevenueCat/Stripe
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                 -- tokens | plan
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Projection mapping (`Projections.projections()`): `user` → `user_state` columns straight from state (`likes_json = JSON.stringify(s.likes)`, `local_day_ends_at` computed with the tz), `puzzle_stats` → `puzzle_stats`. The `user` projection additionally writes `solves` rows (R5).

### R5. Leaderboards via the `solves` table

`solves` is not a snapshot, it is an append-only fact table, so the plain `apply()` upsert cannot produce it. Override `apply()` in the app's `Projections` for `kind === "user"`: run the versioned upsert **and** `INSERT OR IGNORE INTO solves` for the newest ≤ 5 completions in one `env.DB.batch([...])` (atomic per F8). Idempotent (primary key `user:puzzle`), replay-safe (a retried flush re-inserts nothing), and bounded (5 rows × ~3 index writes). A full rebuild walks all completions (`reproject()` path passes `force=true` → insert all). Why 5: the only way to miss a completion is >5 solves between a failed flush and its retry (alarm backoff caps at 60 s in the copied core), which is not a realistic solve rate. Note that the platform's own alarm retries stop after 6 attempts (F2), so the copied core's `alarm()` must re-arm its own retry alarm on failure — otherwise a long D1 outage leaves the projection permanently behind until the next command (which re-arms).

Queries:
- Puzzle page "Top solvers today": read `puzzle_stats.top_today_json` (already there; zero extra reads). Fallback/alternative: `SELECT user_id, time_ms FROM solves WHERE puzzle_id=? AND suspicious=0 ORDER BY time_ms LIMIT 3` (index `solves_by_puzzle_time`; ~3 rows read).
- Weekly leaderboard: cron every 5 min recomputes `leaderboard_week` for the current ISO week with `SELECT user_id, SUM(stars), COUNT(*) FROM solves WHERE week_key=? GROUP BY user_id ORDER BY 2 DESC LIMIT 100` (at 50k DAU ≈ 350k rows read per run ≈ 100 M rows/month, i.e. within the included 25 B). Reads then cost ~100 rows. Do not maintain the leaderboard incrementally (`stars = stars + ?`) from a projection — projection retries are at-least-once and would double count.
- "maxpow just passed you": `SELECT rank FROM leaderboard_week WHERE week_key=? AND user_id=?` plus the row above it.

### R6. Collections manifest and per-user progress
- Manifest in `collections` + `collection_puzzles` (editorial). Browse screen: one query per shelf or one query ordered by `(lang, shelf, position)` (~20 rows).
- Progress per user: `SELECT cp.collection_id, COUNT(s.id) done, COUNT(*) total FROM collection_puzzles cp LEFT JOIN solves s ON s.puzzle_id = cp.puzzle_id AND s.user_id = ? GROUP BY cp.collection_id` — ~100 rows read. (The client also holds `completions` from `/me`, so it can compute progress locally; use the D1 query for the first paint and for locked/unlock rules.)
- Reward: after `finishSolve`, the gateway runs `SELECT collection_id FROM collection_puzzles WHERE puzzle_id=?` (index), then for each candidate checks completeness against the snapshot's `completions` and calls `user.claimCollection(...)`. Idempotent; a crash between finish and claim is healed on the next solve of any member (or a "Claim" button on the collection page that re-runs the check).
- Lock rule `unlock_rule = "collection:travel"` is evaluated in the gateway from the same progress query.

### R7. Daily drop scheduling (cron → D1)
- `puzzles.drop_date` is the schedule; editors set it. The feed shows a puzzle when `drop_date <= today(userTz)`. That makes the "drop" happen at local midnight per user with **no cron in the critical path**.
- Cron `0 * * * *` (hourly, idempotent): for each lang and each of the next 3 calendar days `d`: if no row in `daily_drops(d, lang)`, pick `puzzles` where `lang=? AND published=1 AND drop_date=d`; if none, pick the oldest unscheduled published puzzle from the pool, set its `drop_date=d`, insert `daily_drops`, and `await aggregateStub(env.PUZZLE_STATS, "puzzle_stats", id).init(id)` with `locationHint` = the app's main region (F4: pre-creation must match where traffic will come from). Alert (log/notification) when the pool is empty.
- Also on the same cron: streak reminders — `SELECT id FROM user_state WHERE local_day_ends_at BETWEEN ? AND ?+3600000 AND (last_solved_day IS NULL OR last_solved_day < ?)` → `Notifications.send(...)`. Reminder dedupe: keep `last_reminder_day` in `UserState` via a tiny `markReminded(day)` command, or a D1 `reminders_sent` table; the D1 table is cheaper (no DO hop, no snapshot rewrite).
- Cron `*/5 * * * *`: leaderboard_week recompute (R5). Runs under the 30 s CPU cap for sub-hourly crons (F9); keep the aggregation in SQL (`GROUP BY` in D1), not in the Worker. Both handlers must tolerate being skipped **and** being run twice (F9: retry behaviour is undocumented and `controller.noRetry()` exists): windows, not moments.

### R8. Feed query (D1, cursor pagination)
```sql
SELECT p.id, p.kind, p.size, p.title, p.author_name, p.difficulty, p.par_sec, p.clue_count,
       p.theme_word, p.reveal_json, p.cover_style, p.kicker, p.drop_date, p.content_json,
       ps.likes, ps.solved, ps.solving_now,
       sv.time_ms AS my_time_ms
FROM puzzles p
LEFT JOIN puzzle_stats ps ON ps.id = p.id
LEFT JOIN solves sv       ON sv.id = ?1 || ':' || p.id          -- ?1 = userId
WHERE p.lang = ?2 AND p.published = 1 AND p.drop_date <= ?3      -- ?3 = today in user tz
  AND (?4 IS NULL OR (p.drop_date < ?4 OR (p.drop_date = ?4 AND p.id < ?5)))   -- cursor (drop_date, id)
ORDER BY p.drop_date DESC, p.id DESC
LIMIT 20;
```
Cursor = base64url(JSON `[drop_date, id]` of the last row). `puzzles_feed` index makes this ~20 rows read plus 20 point lookups each on `puzzle_stats` and `solves`. Non-puzzle cards (wheel, mystery, streak-at-risk) are interleaved deterministically by the gateway (e.g. wheel after item 3 if `wheel.lastSpinDay !== today`, mystery every 6th) using the `/me` snapshot the client already holds; `liked`/`saved` come from the snapshot's `likes`/`saves`, so the feed query never touches the User DO. Cache the first page per `(lang, today)` in the Workers Cache API for 30–60 s if D1 latency shows on the home screen (counts are approximate anyway).

### R9. Which reads hit the DO vs D1

| Read | Source | Consistency |
|---|---|---|
| `/me` on app start (balances, streak, prefs, likes/saves, active session) | `User.snapshot()` (DO) | strong |
| Result of any command (solve finish rewards, hint debit, spin prize) | returned snapshot (DO) | strong; write into TanStack Query cache |
| Feed pages, puzzle page header, "solved · solving now" | D1 (`puzzles` ⋈ `puzzle_stats` ⋈ `solves`) | eventual (ms behind, `await` flush mode) |
| Top solvers today | D1 `puzzle_stats.top_today_json` | eventual |
| Collections + progress | D1 (`collections`, `collection_puzzles`, `solves`) | eventual |
| Leaderboards | D1 `leaderboard_week` (cron) / `solves` | ≤ 5 min stale |
| Profile stat cards | `/me` snapshot + D1 `solves` (best time, week count) | mixed |
| Admin / cohort queries | D1 `user_state` | eventual |
| Puzzle content for word checks / hints | `puzzles` + `puzzle_secrets` via in-isolate cache (or KV) | static |

### R10. Hot-object analysis for the daily puzzle

Per-DAU per-day traffic to the daily `PuzzleStats` object: ~6 heartbeats (30 s cadence over a ~3 min solve), ~1 finish, ~0.5 like ≈ 7.5 requests. Assume a peak hour carries 15 % of the day's traffic.

| DAU | Requests/day to the daily object | Peak req/s (15 % in one hour) | vs. 500–1,000 rps soft limit |
|---|---|---|---|
| 3,000 | ~22k | ~1 | negligible |
| 50,000 | ~375k | ~16 | ~2 % of capacity |
| 500,000 (future) | ~3.75M | ~160 | ~20–30 %; still one object |

Conclusion: one object per puzzle is fine through 50k DAU with an order of magnitude of headroom, provided (1) feed reads never hit the object (R8), (2) heartbeats do not commit (memory map + 15 s throttled commit), (3) commands are small (state ≈ 1 KB; each commit is one `UPDATE` row + one D1 upsert). Storage rows: likes and finishes ≈ 1.5 rows written per DAU/day on the object ⇒ 2.25 M/month at 50k DAU (within 50 M included). Escape hatches, in order: (a) raise the presence commit interval to 60 s; (b) `adjustLikes` batching in memory with a 5 s commit; (c) shard: `puzzle_stats:<id>:<shard 0..N-1>` chosen by `hash(userId) % N`, projected to `puzzle_stats_shards` and summed by a D1 view or by the cron into `puzzle_stats` — the base class needs nothing new for this; (d) Facets (F13) are not needed.

Placement: create the object from the cron with `locationHint` matching the dominant audience region (e.g. `"eeur"` for uk/ru, `"weur"`/`"enam"` for en) — a daily object created by whichever user happens to be first would otherwise be pinned to a random continent (F4).

### R11. Consistency expectations to state in the API docs
- Commands are linearizable per user (input gates); a user cannot double-spend tokens or double-earn a solve even with concurrent requests.
- Cross-object effects (`recordSolve`, `adjustLikes`, `claimCollection`) are best-effort after the user commit: counters may drift by a few units under failures; rewards are re-checkable/idempotent.
- D1 projections lag by the flush duration (milliseconds) and can be minutes behind only while a flush is failing (alarm retry).
- Cron work is best-effort and window-based; nothing the user earns depends on cron.
- `flushMode` must stay `"await"` in DOs (F3, `waitUntil` is a no-op there).

### R12. Cost estimate (Workers Paid, from F5/F7/F11)
Assumptions per DAU/day: 25 Workers requests, 12 DO requests, 6 user-projection writes (row + 2 indexes ≈ 18 D1 rows written), 1 `solves` row (+3 index writes), 1.5 puzzle_stats writes, feed reads ≈ 200 rows.

| | 3k DAU | 50k DAU |
|---|---|---|
| Workers requests/month | 2.3 M (included) | 37.5 M → 27.5 M × $0.30 = $8.25 |
| DO requests/month | 1.1 M → ~$0.02 | 18 M → 17 M × $0.15 = $2.55 |
| DO duration (20 ms × 128 MB per request) | 2.7k GB-s (included) | 45k GB-s (included) |
| D1 rows written/month | ~2 M (included) | ~33 M (included) |
| D1 rows read/month | ~20 M (included) | ~300 M (included) |
| DO SQLite rows written/month | ~0.6 M (included) | ~10 M (included) |
| Total | ≈ $5 | ≈ $16–20 |

These are order-of-magnitude estimates (medium confidence); `concepts.md`'s "$45/month at 50k DAU" remains a safe upper bound.

### R13. Required changes to the copied `packages/core`
1. **Alarm hook.** Add `nextAppAlarm INTEGER` to the `aggregate` table; `protected scheduleAppAlarm(atMs)` / `protected onAppAlarm(): Promise<void>`; `alarm()` runs the flush retry *and* `onAppAlarm()` when due; every place that calls `setAlarm`/`deleteAlarm` re-arms `min(retryAt, nextAppAlarm)` instead of deleting unconditionally. Crosscut uses it only for the presence tick (optional) — streak reminders are on the cron — so this can be deferred if `PuzzleStats` uses the throttle-on-heartbeat approach. Base-class tests to add: "app alarm survives a completed flush" and "flush retry does not cancel app alarm". Alarm-platform facts to respect (F2): platform retries stop after 6, so on a failed flush `alarm()` must `setAlarm()` a fresh retry itself (re-arm at `retryCount` ≈ 5 per the Rules page); `ctx.abort({ retryAlarm: false })` (2026-08-25) is available if an abort must *not* trigger a platform retry; and `ctx.storage.deleteAll()` also deletes the pending alarm when the Worker's `compatibility_date` is ≥ 2026-02-24 (compat-date gated, F2), so a `reproject()`/reset path that calls `deleteAll()` must re-arm `nextAppAlarm` afterwards or the app alarm is silently dropped.
2. **Projection side tables.** Allow a projection definition to return extra statements: `extra?: (state, meta) => D1PreparedStatement[]` executed with the upsert in one `DB.batch`. Used for `solves`.
3. **Snapshot size guard.** In `#persist`, warn when `json.length > 256 KiB` and throw above 1 MiB (the 2 MB row limit is hard, F3).
4. Keep `flushMode: "await"`; document that `"background"` is unsafe in DOs (F3).

---

## Code sketches

### Day keys and streak (pure functions, unit-testable without workerd)
```ts
export function dayKey(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms)); // "2026-09-02"
}
export function prevDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
export function applyStreak(s: UserState["streak"], today: string) {
  if (s.lastSolvedDay === today) return s;
  const count = s.lastSolvedDay === prevDay(today) ? s.count + 1 : 1;
  return { count, lastSolvedDay: today, longest: Math.max(s.longest, count) };
}
export function effectiveStreak(s: UserState["streak"], today: string): number {
  return s.lastSolvedDay === today || s.lastSolvedDay === prevDay(today) ? s.count : 0;
}
```

### `User.finishSolve` (inside the aggregate)
```ts
finishSolve(input: { sessionId: string; now: number; minPlausibleMs: number }) {
  return this.commit((s) => {
    const ses = s.session;
    if (!ses || ses.id !== input.sessionId) throw new DomainError("no_active_session");
    const replay = ses.puzzleId in s.completions;
    const elapsedMs = Math.max(0, input.now - ses.startedAt);
    const secLeft = Math.max(0, Math.floor((ses.parSec * 1000 - elapsedMs) / 1000));
    const suspicious = elapsedMs < input.minPlausibleMs;
    const tokens = replay || suspicious ? 0 : Math.floor(secLeft / 5);
    const stars = replay ? 0 : 10 + (ses.hintsUsed === 0 ? 2 : 0);
    const today = dayKey(input.now, s.tz);
    const next: UserState = { ...s, session: null, ledgerSeq: s.ledgerSeq + 1,
      wallet: { tokens: s.wallet.tokens + tokens, stars: s.wallet.stars + stars } };
    if (!replay) {
      next.completions = { ...s.completions, [ses.puzzleId]:
        { day: today, solvedAt: input.now, timeMs: elapsedMs, hintsUsed: ses.hintsUsed, tokens, stars, suspicious } };
      next.streak = applyStreak(s.streak, today);
      next.stats = { solved: s.stats.solved + 1,
        bestTimeMs: suspicious ? s.stats.bestTimeMs : Math.min(s.stats.bestTimeMs ?? Infinity, elapsedMs) };
    }
    return next;
  });
}
```

### `PuzzleStats.heartbeat` — presence in memory, counter batching
```ts
export class PuzzleStats extends Aggregate<PuzzleStatsState, Env> {
  readonly kind = "puzzle_stats";
  #present = new Map<string, number>();   // userId -> lastSeen; lost on hibernation, self-heals
  #lastPresenceCommit = 0;
  protected initial(): PuzzleStatsState {
    return { likes: 0, solved: 0, noHintSolved: 0, solvingNow: 0, topToday: { day: "", rows: [] } };
  }
  async heartbeat(userId: string, now = Date.now()) {
    this.#present.set(userId, now);
    for (const [u, t] of this.#present) if (now - t > 90_000) this.#present.delete(u);
    const n = this.#present.size;
    const due = now - this.#lastPresenceCommit > 15_000 || n === 0 || this.snapshot().state.solvingNow === 0;
    if (due) { this.#lastPresenceCommit = now; await this.commit((s) => s.solvingNow === n ? s : { ...s, solvingNow: n }); }
    return n;                                  // cheap return, no snapshot needed
  }
  adjustLikes(delta: 1 | -1) { return this.commit((s) => ({ ...s, likes: Math.max(0, s.likes + delta) })); }
}
```

### Projection with the `solves` side table (atomic batch)
```ts
export class Projections extends ProjectionsBase<Env> {
  protected projections() {
    return [
      defineProjection<UserState>({ kind: "user", table: "user_state", columns: (s) => ({
        tz: s.tz, lang: s.lang, level: s.prefs.level, topics_json: JSON.stringify(s.prefs.topics),
        plan_tier: s.plan.tier, plan_expires_at: s.plan.expiresAt, tokens: s.wallet.tokens, stars: s.wallet.stars,
        streak: s.streak.count, longest_streak: s.streak.longest, last_solved_day: s.streak.lastSolvedDay,
        local_day_ends_at: endOfLocalDay(Date.now(), s.tz), solved_count: s.stats.solved,
        best_time_ms: s.stats.bestTimeMs, likes_json: JSON.stringify(s.likes), saves_json: JSON.stringify(s.saves),
        push_token_count: s.pushTokens.length }) }),
      defineProjection<PuzzleStatsState>({ kind: "puzzle_stats", table: "puzzle_stats", columns: (s) => ({
        likes: s.likes, solved: s.solved, no_hint_solved: s.noHintSolved, solving_now: s.solvingNow,
        top_day: s.topToday.day, top_today_json: JSON.stringify(s.topToday.rows) }) }),
    ];
  }
  override async apply(kind: string, id: string, version: number, state: unknown, force = false) {
    if (kind !== "user") return super.apply(kind, id, version, state, force);
    const s = state as UserState;
    const def = this.projections().find((p) => p.kind === kind)!;
    const { sql, params } = versionedUpsert(def.table, { id, version, ...def.columns(s, { id, version }), updated_at: Date.now() }, force);
    const recent = Object.entries(s.completions).sort((a, b) => b[1].solvedAt - a[1].solvedAt).slice(0, force ? undefined : 5);
    const inserts = recent.map(([puzzleId, c]) => this.env.DB.prepare(
      `INSERT OR IGNORE INTO solves (id,user_id,puzzle_id,solved_at,day_key,week_key,time_ms,hints_used,tokens,stars,suspicious)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(`${id}:${puzzleId}`, id, puzzleId, c.solvedAt, c.day, isoWeek(c.day), c.timeMs, c.hintsUsed, c.tokens, c.stars, c.suspicious ? 1 : 0));
    await this.env.DB.batch([this.env.DB.prepare(sql).bind(...params), ...inserts]); // one transaction (F8)
  }
}
```

### Gateway: solve flow (module orchestration, no events)
```ts
app.post("/solve/:sid/finish", zValidator("json", z.object({ grid: z.array(z.string()) })), async (c) => {
  const userId = c.get("userId");
  const user = aggregateStub(c.env.USER, "user", userId);
  const { state } = await user.snapshot();
  if (!state.session || state.session.id !== c.req.param("sid")) return c.json({ error: "no_active_session" }, 409);
  const puzzle = await c.get("puzzles").withSecret(state.session.puzzleId);     // cached; never sent to client
  if (!gridMatches(c.req.valid("json").grid, puzzle.solution)) return c.json({ error: "wrong" }, 422);
  const snap = await user.finishSolve({ sessionId: state.session.id, now: Date.now(), minPlausibleMs: puzzle.minPlausibleMs });
  const done = snap.state.completions[puzzle.id];
  c.executionCtx.waitUntil((async () => {                                          // best-effort side effects
    await aggregateStub(c.env.PUZZLE_STATS, "puzzle_stats", puzzle.id)
      .recordSolve({ userId, timeMs: done.timeMs, dayKey: puzzle.dropDate, noHints: done.hintsUsed === 0, suspicious: done.suspicious });
    await claimCompletedCollections(c.env, user, snap.state, puzzle.id);
  })());
  return c.json({ snapshot: snap, earned: { tokens: done.tokens, stars: done.stars, noHint: done.hintsUsed === 0 } });
});
```

### Cron handler (idempotent, windowed)
```ts
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron === "0 * * * *") { await ensureDailyDrops(env, controller.scheduledTime, 3); await sendStreakReminders(env, controller.scheduledTime); }
    if (controller.cron === "*/5 * * * *") await rebuildWeeklyLeaderboard(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
// wrangler.jsonc: "triggers": { "crons": ["0 * * * *", "*/5 * * * *"] }
// local: curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
// Both handlers are idempotent: safe under a skipped run AND a duplicated run (retry behaviour undocumented; controller.noRetry() exists, F9).
// The */5 cron runs under a 30 s CPU cap (sub-hourly interval, F9).
```

### wrangler.jsonc (legacy `migrations` style; `exports` map also accepted by wrangler 4.128.0, F10)
```jsonc
{
  "name": "crosscut",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-02",                  // 2 days past bundled workerd 1.20260831.1; started cleanly in wrangler dev 4.128.0 in the original check (not re-verified by fact-check); pin <= 2026-08-31 if wrangler rejects it
  "compatibility_flags": ["nodejs_compat"],            // redundant: nodejs_compat is default-on for compatibility_date >= 2026-08-04 (harmless); enable_ctx_exports is default-on since 2025-11-17
  "durable_objects": { "bindings": [
    { "name": "USER", "class_name": "User" },
    { "name": "PUZZLE_STATS", "class_name": "PuzzleStats" } ] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["User", "PuzzleStats"] }],
  "d1_databases": [{ "binding": "DB", "database_name": "crosscut", "database_id": "<id>" }],
  "triggers": { "crons": ["0 * * * *", "*/5 * * * *"] },
  "observability": { "enabled": true }
}
```

### Tests to write (workerd, per `concepts.md` §12)
- `User`: finish → projection row + `solves` row; replay earns nothing; hint debit fails at 19 tokens; streak +1 across a tz day boundary and reset after a gap; wheel once per local day; `evictDurableObject` mid-session keeps the session; failed flush → `runDurableObjectAlarm` → `solves` row appears exactly once.
- `PuzzleStats`: 100 heartbeats in 10 s produce ≤ 2 commits; `topToday` resets on a new day; likes never negative.
- Feed: cursor pagination returns no duplicates/gaps across drop_date ties; `EXPLAIN QUERY PLAN` shows `puzzles_feed`.
- Cron: `/cdn-cgi/handler/scheduled` twice in a row is a no-op the second time.

---

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | SQLite-backed DO: `ctx.storage.sql.exec(query, ...bindings)` returns a cursor with `toArray()`, `one()`, `raw()`, `columnNames`, `rowsRead`, `rowsWritten`; `sql.exec` cannot run `BEGIN`/`SAVEPOINT`, use `ctx.storage.transactionSync()` (sync callback, rollback on throw) | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (canonical; `/api/storage-api/` and `/api/sql-storage/` both 301 here) | high | confirmed |
| C2 | Writes without an intervening `await` are coalesced into one atomic implicit transaction | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ , https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ | high | confirmed |
| C3 | One alarm per object; at-least-once; automatic retry with exponential backoff from 2 s, up to 6 retries; alarms wake evicted objects; each `setAlarm()` is one row written | https://developers.cloudflare.com/durable-objects/api/alarms/ , https://developers.cloudflare.com/durable-objects/platform/pricing/ | high | confirmed |
| C4 | DO SQLite limits: 10 GB per object, 2 MB max row/value, 100 KB statement, 100 bound params, 100 columns per table | https://developers.cloudflare.com/durable-objects/platform/limits/ | high | confirmed |
| C5 | A single DO has a soft limit of ~1,000 requests/s (500–1,000 for simple ops); sharding formula given; "do not create a single global DO" | https://developers.cloudflare.com/durable-objects/platform/limits/ , https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ | high | confirmed |
| C6 | DO pricing (Paid): 1 M requests included then $0.15/M; 400k GB-s included then $12.50/M GB-s; SQLite 25 B rows read + 50 M rows written/month included, then $0.001/M and $1.00/M; 5 GB-month included then $0.20/GB-month; KV-style methods are billed as rows | https://developers.cloudflare.com/durable-objects/platform/pricing/ | high | confirmed |
| C7 | D1 limits (Paid): 10 GB per database, 1,000 queries per invocation, 100 KB statement, 30 s query duration, 100 bound params, 2 MB row, limits apply per statement in a batch | https://developers.cloudflare.com/d1/platform/limits/ | high | confirmed |
| C8 | D1 pricing (Paid): 25 B reads + 50 M writes/month included, then $0.001/M read and $1.00/M written; storage $0.75/GB-month beyond 5 GB; rows read = rows scanned; indexes add one write each | https://developers.cloudflare.com/d1/platform/pricing/ , https://developers.cloudflare.com/d1/best-practices/use-indexes/ | high | confirmed |
| C9 | `DB.batch()` executes statements as one SQL transaction with rollback on failure; `D1Result.meta` has `rows_read`, `rows_written`, `changes`, `last_row_id`, `duration` | https://developers.cloudflare.com/d1/worker-api/d1-database/ | high | confirmed |
| C10 | D1 Sessions API: `DB.withSession("first-primary" \| "first-unconstrained" \| bookmark)`, `session.getBookmark()`; sequential consistency; writes always go to primary; read replication enabled per database | https://developers.cloudflare.com/d1/best-practices/read-replication/ | high | confirmed |
| C11 | Cron Triggers config key `triggers.crons`; `scheduled(controller, env, ctx)` with `controller.cron`, `controller.scheduledTime`, `controller.type`; handler may run up to 15 min; local test URL `/cdn-cgi/handler/scheduled?cron=...`; 5 (Free) / 250 (Paid) cron triggers (per account on the limits page) | https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ , https://developers.cloudflare.com/workers/platform/limits/ | high | confirmed |
| C12 | [UNVERIFIED] Cron Triggers have no documented at-least-once guarantee and no documented retry policy; the earlier "a failed scheduled invocation is not retried" wording is retracted (F9) — `controller.noRetry()` (docs + `@cloudflare/workers-types@5.20260902.1` `ScheduledController.noRetry(): void`) implies the platform *can* retry. Design for both skipped and duplicated runs. | https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ , npm `@cloudflare/workers-types@5.20260902.1` index.d.ts 2641-2645; third-party (low confidence): https://runhooks.app/blog/cloudflare-workers-cron-triggers-limits/ , https://crontap.com/blog/cloudflare-workers-cron-minute-limit | low | unverifiable |
| C13 | `ctx.waitUntil` "has no effect in Durable Objects"; `blockConcurrencyWhile` blocks event delivery (30 s timeout); `ctx.exports` provides loopback bindings; input gates make read-modify-write safe | https://developers.cloudflare.com/durable-objects/api/state/ , https://developers.cloudflare.com/durable-objects/examples/build-a-counter/ | high | confirmed |
| C14 | Idle objects are evicted after ~70–140 s of inactivity; hibernation may occur after ~10 s idle; in-memory state is discarded on hibernation/eviction; one active instance per object | https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ , https://developers.cloudflare.com/durable-objects/reference/in-memory-state/ | high | confirmed |
| C15 | Objects are placed near the first `get()` and do not move; `locationHint` values wnam, enam, sam, weur, eeur, apac, apac-ne, apac-se, oc, afr, me; `idFromName` first use can cost a few hundred ms | https://developers.cloudflare.com/durable-objects/reference/data-location/ , https://developers.cloudflare.com/durable-objects/api/namespace/ | high | confirmed |
| C16 | `enable_ctx_exports` is default-on for compatibility dates ≥ 2025-11-17; `rpc` default-on since 2024-04-03 | https://developers.cloudflare.com/workers/configuration/compatibility-flags/ | high | confirmed |
| C17 | DO classes can be declared with the legacy `migrations` array or the newer `exports` map (`"type":"durable-object","storage":"sqlite"`); both supported, one per Worker, no way back after `exports`; deleting a class destroys its data; wrangler 4.128.0 accepts the `exports` map (confirmed, F10) | https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ , https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/ , wrangler 4.128.0 config types | high | confirmed |
| C18 | Workers Paid: $5/month, 10 M requests included then $0.30/M, 30 M CPU-ms included then $0.02/M | https://developers.cloudflare.com/workers/platform/pricing/ | high | confirmed |
| C19 | Workers run with TZ=UTC locally and in production; user-local dates must use `Intl.DateTimeFormat` with `timeZone` (UTC statement is on the local-development page only; the web-standards page instead notes `Date.now()` advances only at I/O boundaries) | https://developers.cloudflare.com/workers/local-development/ (UTC) ; https://developers.cloudflare.com/workers/runtime-apis/web-standards/ (timer behaviour) | medium | confirmed |
| C20 | D1 supports SQLite UPSERT (`INSERT ... ON CONFLICT DO UPDATE ... WHERE`) and `RETURNING` in the local engine — verified via the core test-suite (8/8) and a `wrangler d1 execute --local` smoke test on wrangler 4.128.0; neither is on any official D1 page or in the D1 release notes, so production behaviour stays [UNVERIFIED] | local run of `/Users/peter/Projects/IOSApp/packages/core/test/aggregate.test.ts` (8/8) ; local `wrangler d1 execute` ; https://developers.cloudflare.com/d1/sql-api/sql-statements/ | medium (production RETURNING: low) | confirmed |
| C21 | DO Facets (beta, Paid) give one object named sub-objects with their own SQLite via `ctx.facets.get()`; docs live at `/dynamic-workers/usage/durable-object-facets/` (the `/durable-objects/api/facets/` URL 404s, F13) | https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/ , https://blog.cloudflare.com/durable-object-facets-dynamic-workers/ | medium | confirmed |
| C22 | WebSocket Hibernation: `ctx.acceptWebSocket`, `webSocketMessage/Close/Error`, attachments ≤ 16,384 bytes, no duration billing while hibernated, up to 32,768 connections per object | https://developers.cloudflare.com/durable-objects/best-practices/websockets/ , https://developers.cloudflare.com/durable-objects/api/state/ | high | confirmed |
| X1 | ~~`@cloudflare/vitest-plugin` v1.1.3 published 2026-08-20~~ — corrected: v1.0.0 published 2026-08-20, v1.1.3 published 2026-09-01 (rename 2026-08-19) | `npm view @cloudflare/vitest-plugin time` | high | refuted |
| X2 | ~~The `cloudflareTest` plugin-style vitest config replaced `defineWorkersConfig`/`defineWorkersProject` as part of the 2026-08-19 rename~~ — corrected: the plugin API predates the rename (`vitest-pool-workers` ≥ 0.19.0; 0.22.0 exports only `cloudflareTest`); the changelog says the configuration API is unchanged. Config shape itself is correct. | https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ , https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ , npm tarballs 0.22.0 / 1.1.3, workers-sdk vitest-plugin CHANGELOG | high | refuted |

---

## Open questions

1. **Pause semantics.** Server-side timing means backgrounding the app burns par time. Do we allow an explicit `pauseSolve`/`resumeSolve` (bounded, e.g. ≤ 2 pauses, ≤ 10 min total) or accept the loss? Affects `SolveSession` shape.
2. **Which day is "today" for a puzzle's top solvers** — the puzzle's `drop_date` (recommended, one leaderboard per puzzle-day) or the solver's local day (would need per-tz buckets)?
3. **Replays**: "Play again" earns nothing (recommended) vs. a reduced reward; does a replay update `best_time_ms`?
4. **Streak rule when a user's tz change makes "today" earlier than `lastSolvedDay`**: recommended to block the tz change for that day; confirm with product.
5. **Cron delivery/retry guarantee** is not documented officially (C12 [UNVERIFIED], fact-check verdict: unverifiable); the runtime's `controller.noRetry()` implies retries can happen. Confirm with Cloudflare support/changelog or accept the windowed, idempotent, duplicate-tolerant design as sufficient.
6. **`exports` config vs legacy `migrations`** (C17): decide before first deploy. wrangler 4.128.0 accepts `exports` (confirmed by fact-check, F10); the choice is one-way (`exports` → no return to `migrations`). The core's tests ran against `migrations`, so switching means re-running them once under `exports`.
7. **ICU time-zone coverage in workerd** (C19): add a test that formats a date in every zone the app offers (Europe/Kyiv, Europe/Moscow, America/*, Asia/*) and fails on `RangeError`.
8. **Where the cached puzzle lives for word checks**: isolate memory Map (simplest, cold-start reload from D1) vs KV namespace (extra binding, lower tail latency). Recommend isolate cache + D1 fallback first.
9. **Like-count drift repair**: accept drift, or add a nightly recount cron from `user_state.likes_json` (`json_each`) into `puzzle_stats.likes` via a `setLikes(n)` command?
10. **Alarm hook in core (R13.1)**: implement now (needed if presence commits should also happen when heartbeats stop) or defer (throttle-on-heartbeat is sufficient for v1)?
11. **D1 read replication**: not needed at launch (single primary is fine for the read volumes above); revisit if feed p95 from far regions is poor — the Sessions API bookmark would then be threaded through TanStack Query.

---

## Fact-check log

Fact-check run 2026-09-02 against the Claims table plus the fact-check addenda (X ids). Verdicts: confirmed = the statement matches the cited primary source; refuted = the statement was wrong and has been corrected in the text above; unverifiable = no primary source settles it, marked [UNVERIFIED] in the text and table.

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (canonical; `/api/storage-api/` and `/api/sql-storage/` 301 here) |
| C2 | confirmed | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ , https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ |
| C3 | confirmed | https://developers.cloudflare.com/durable-objects/api/alarms/ , https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| C4 | confirmed | https://developers.cloudflare.com/durable-objects/platform/limits/ |
| C5 | confirmed | https://developers.cloudflare.com/durable-objects/platform/limits/ , https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ |
| C6 | confirmed | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| C7 | confirmed | https://developers.cloudflare.com/d1/platform/limits/ |
| C8 | confirmed | https://developers.cloudflare.com/d1/platform/pricing/ , https://developers.cloudflare.com/d1/best-practices/use-indexes/ |
| C9 | confirmed | https://developers.cloudflare.com/d1/worker-api/d1-database/ |
| C10 | confirmed | https://developers.cloudflare.com/d1/best-practices/read-replication/ |
| C11 | confirmed | https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ , https://developers.cloudflare.com/workers/platform/limits/ (limits page lists 5/250 per account; cron-triggers page wording says per Worker — per-account reading kept) |
| C12 | unverifiable | https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ , npm `@cloudflare/workers-types@5.20260902.1` index.d.ts 2641-2645 (`ScheduledController.noRetry(): void`). No official retry policy; "not retried" claim retracted; design for skipped and duplicated runs. |
| C13 | confirmed | https://developers.cloudflare.com/durable-objects/api/state/ , https://developers.cloudflare.com/durable-objects/examples/build-a-counter/ |
| C14 | confirmed | https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/ , https://developers.cloudflare.com/durable-objects/reference/in-memory-state/ |
| C15 | confirmed | https://developers.cloudflare.com/durable-objects/reference/data-location/ , https://developers.cloudflare.com/durable-objects/api/namespace/ |
| C16 | confirmed | https://developers.cloudflare.com/workers/configuration/compatibility-flags/ |
| C17 | confirmed | https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ , https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/ , wrangler 4.128.0 config types (`exports` map accepted) |
| C18 | confirmed | https://developers.cloudflare.com/workers/platform/pricing/ |
| C19 | confirmed | https://developers.cloudflare.com/workers/local-development/ (UTC statement; the web-standards page does not contain it, it documents `Date.now()` advancing only at I/O boundaries) |
| C20 | confirmed | local `wrangler d1 execute --local` on wrangler 4.128.0 (UPSERT + `RETURNING` work in the local engine); absent from all official D1 pages and release notes, production still [UNVERIFIED] |
| C21 | confirmed | https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/ (working URL; `/durable-objects/api/facets/` 404s) |
| C22 | confirmed | https://developers.cloudflare.com/durable-objects/best-practices/websockets/ , https://developers.cloudflare.com/durable-objects/api/state/ |
| X1 | refuted | `npm view @cloudflare/vitest-plugin time`: 1.0.0 published 2026-08-20T17:42Z, 1.1.3 published 2026-09-01T17:21Z. Text corrected. |
| X2 | refuted | https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ ("The Vitest configuration API is unchanged"), https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ , npm tarballs `@cloudflare/vitest-pool-workers@0.22.0` and `@cloudflare/vitest-plugin@1.1.3` (`dist/pool/index.d.mts`), https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/vitest-plugin/CHANGELOG.md (`cloudflareTest()` at 0.19.0). Text corrected. |
| X3 | confirmed | fact-check addendum (see Findings F1/F2/F8/F9/F10/F13 addenda); source as cited inline |
| X4 | confirmed | fact-check addendum; source as cited inline |
| X5 | confirmed | fact-check addendum; source as cited inline |
| X6 | confirmed | fact-check addendum; source as cited inline |
| X7 | confirmed | fact-check addendum; source as cited inline |
| X8 | confirmed | fact-check addendum; source as cited inline |
| X9 | confirmed | fact-check addendum; source as cited inline |

Additional corrections applied from the fact-check (not tied to a single claim id): `deleteAll()` deleting the alarm is gated by `compatibility_date` ≥ 2026-02-24 (F2, R13.1); `nodejs_compat` is default-on for `compatibility_date` ≥ 2026-08-04, so the sketched flag is redundant (F10, wrangler.jsonc); the sketched `compatibility_date` 2026-09-02 is two days past the bundled workerd 1.20260831.1 and was not re-verified by the fact-check (F10, wrangler.jsonc); storage-API and legacy-migrations URLs updated to their canonical locations (F1, F10, C1).
