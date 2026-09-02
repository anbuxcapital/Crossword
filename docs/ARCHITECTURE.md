# Crosscut backend — Architecture (v1 design)

Date: 2026-09-02 · Status: v1 design, assembled from per-section drafts and a consistency pass
Inputs: docs/research/README.md (fact-checked research), docs/research/gap-*.md, docs/design/glossary.md (canonical names), the design handoff README, packages/core.
Scope: backend only (one Cloudflare Worker, modular monolith, in-process domain events, Hono + Zod + Durable Objects + D1). The Expo app is out of scope.
Work breakdown lives in docs/IMPLEMENTATION-PLAN.md (§10).

## 0. Decisions

Crosscut v1 is a single Cloudflare Worker (`workers/gateway`), deployed with one operational mode from the start. Every row below represents a choice made either in the consolidated research (README.md, gap-*.md) or in this orchestrator pass; where a choice remains undecided, it is marked and resolved with reference to the priority sources and the fixed decisions already committed. Stack decisions are drawn from README.md §"Stack decisions" (lines 15–43); architectural decisions from gap docs §"Recommendation for Crosscut"; operational decisions from the constraints of v1 scope.

| decision | choice | why | alternatives rejected |
|---|---|---|---|
| Deployment topology | One Worker `workers/gateway` (name `crosscut`, main `src/app/index.ts`) exporting `{ fetch, scheduled }`, three DO classes (`User`, `PuzzleStats`, `Projections`), one D1 database | Service bindings / RPC zero-latency in-account; nothing in v1 needs a split; `resolveModules(env, ctx)` seam allows future extraction | Multiple Workers (split by domain layer); separate identity/payment Workers |
| Config file | `wrangler.jsonc` with `"$schema": "node_modules/wrangler/config-schema.json"` + JSONC comments for ops | Cloudflare recommends JSONC; community best practice; schema validation in IDEs | TOML (Wrangler no longer supports it) |
| Compatibility date and flags | `"2026-09-02"`, **no `compatibility_flags`** | Verified in wrangler 4.128.0 dev; `nodejs_compat` default from 2026-08-04; `enable_ctx_exports` from 2025-11-17; both unnecessary and they cause warnings | Listing flags that are already defaults |
| DO class declaration | Declarative `"exports": { "User": { "type": "durable-object", "storage": "sqlite" }, "PuzzleStats": {…} }` + `durable_objects.bindings` in `wrangler.jsonc` | Wrangler docs prefer `exports` for new Workers since 4.107; `migrations` and `exports` are mutually exclusive; one-way door; supported by vitest-plugin 1.1.3 | Legacy `migration()` pattern (incompatible with exports) |
| Storage split | D1: content, projections, fact tables (player_solves), cron-materialised leaderboards; DO: per-user aggregate (User), per-puzzle aggregate (PuzzleStats), ledger table (in User) | Hot reads never hit a DO; commands serialized by input gates per user (no race on lock/debit/finish); ledger in-object via `transactionSync` keeps the wallet atomic | All storage in D1 (no strongly-consistent wallet); all in DO (query latency, 10 GB per object limit) |
| Per-user aggregate | One `User` DO per player (id `u_<26-char base32>`), module `player`, owns wallet, streak, session, prefs, completions, likes/saves, hint log, push tokens; all write-model commands go through it | Hint debit + log + session update atomic in one commit; finish = wallet + stars + streak + completion + session close in one commit; no cross-object compensation | "One DO per module" (README R3 deviation, but cycle would break DAG); separate Solve DO (needs compensation logic) |
| Hono composition | Per-module `createFactory<AppEnv>({ defaultAppOptions: { strict: false } }).createApp()`, method-chained routes, gateway `app.basePath("/v1").route("/feed", feed)…`, export `type AppType = typeof routes` | Chaining mandatory for `hc` / `testClient` types; sub-apps inherit `Bindings`/`Variables`; reduces boilerplate; best practice per Hono 4.13.5 docs | Unchained routes (types lost); flat root app (no module isolation) |
| Validation | `@hono/zod-validator` 0.9.1 + shared `hook` returning `{ error: { code: "invalid_request", target, issues: z.treeifyError(e) } }` 400 | Standard Hono 4.13.5 middleware; hook type-narrows responses; `treeifyError` handles nested bodies | Default 400 (hides issues); `flattenError` (single-level only) |
| OpenAPI | None in v1; `hono-openapi` 1.3.1 route-by-route later if needed (never `.openapi()` in shared schemas) | Client is Expo app (typed via `hc` from `worker-configuration.d.ts`); `@hono/zod-openapi` patches `ZodType.prototype` and misses schemas built before import | Building OpenAPI in v1 (scope creep; Expo doesn't need it) |
| Zod | `import * as z from "zod"` (4.5.4 classic API); never `zod/mini`, `zod/v4`, `z.compile` | Root is 4.5.4; `z.compile` + `new Function` disallowed in Workers; ~25 KB gzipped is irrelevant vs. runtime safety | Alternate import paths (Workers compatibility unknown) |
| Zod conventions | `z.object` inbound (strip), `z.strictObject` for DTOs/events, `z.discriminatedUnion`, `z.iso.datetime()` (seconds required), ids via regex + `.brand()`, `z.coerce.*` for query/param | Zod 4.5 soundness rules; stricter validation upstream; one schema pattern everywhere; 4.5 `iso.datetime()` requires seconds; Crockford base32 regex + brand cannot be forged | `z.enum` for ids (no validation); `templateLiteral` (numeric checks not encoded) |
| TypeScript | 7.0.2 native (no setup required); tsconfig `target ES2022, module ESNext, moduleResolution Bundler, strict, noEmit, isolatedModules, types: ["./worker-configuration.d.ts", "@cloudflare/vitest-plugin/types"]` in worker | TS 7 removes `baseUrl`, `node10`, `outFile`; native support for `ESNext`; `@cloudflare/workers-types` only in library packages (`packages/core`, `packages/shared`) | Mixing workers-types with generated types (1300+ duplicate-identifier errors) |
| Types generation | `wrangler types` → `worker-configuration.d.ts` (committed); CI runs `wrangler types --check` | Gives `Env`, `Cloudflare.Env`, bindings, DO class names, D1 shape (all present in test suite); one source of truth for deploy | Manual type stubs (drift risk); no type checking in CI |
| Test runner | `@cloudflare/vitest-plugin` 1.1.3 + `vitest` 4.1.11 (renamed successor of `vitest-pool-workers` 0.22.0) | Same `cloudflareTest()` API; includes 1.1.2 DO re-creation fix; workerd 1.20260831 (0.22.0's workerd rejects dates > 2026-08-22); Zod 4.5 bundled in plugin deps | `vitest-pool-workers` 0.22.0 (obsolete; date rejection) |
| Test config API | `defineConfig({ plugins: [cloudflareTest(async () => ({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { TEST_MIGRATIONS } } }))], test: { setupFiles: ["./test/setup.ts"] } })` + `readD1Migrations` from **package root** | `defineWorkersConfig` gone; `poolOptions` gone; storage isolation per test file; `readD1Migrations` is a CLI helper (no subpath) | Old pool config (incompatible); expecting a `/config` subpath |
| Test entry points | `import { env, exports } from "cloudflare:workers"`; `exports.default.fetch()` end-to-end; `app.request(path, init, env)` route-level; `cloudflare:test` for DO + migration helpers | Unified import path; consistent with vitest-plugin 1.1.3; `SELF`/`env` from `cloudflare:test` deprecated | Deprecated imports (still exported, but phased out) |
| Identity v1 | HS256 device tokens (header `kid` rotation), `hono/jwt`, `POST /devices` bootstrap (RL_BOOT 10/60 s per IP), `Authorization: Bearer <token>`, `exp` 365 days, `tokenVersion` in aggregate for revocation | No accounts needed; same header shape as Better Auth v2 later; kid rotation matches the brief; token age ≤ 30 d refreshable | Database sessions (extra read per request); device UUIDs (forgeable); UUIDs in JWT (no rotation strategy) |
| Rate limiting | `ratelimits` binding: `RL_BOOT` 10/60 s per IP, `RL_USER` 120/60 s per user, `RL_SPEND` 20/60 s per user, **`RL_CHECK` 30/60 s per `solveId`** (new, for autocheck tickets) | Enforced in aggregate / route; per-colo, permissive, simulated by miniflare locally; free-plan availability [UNVERIFIED]; `RL_CHECK` bounds oracle harvest | Soft limits (not enforced); no per-colo scoping |
| Events | Typed in-process dispatcher (Zod discriminated union registry, static handler table in `app/wiring.ts`, critical handlers awaited in registration order per handler error isolation, background via `ctx.waitUntil`, 30 s budget after response) | Brief mandates direct calls; critical consequences inside the producing commit so lost fan-out is reconcilable with `POST /me/reconcile`; `MAX_DEPTH = 4`, `MAX_EVENTS_PER_REQUEST = 64`, per-request seen dedup | Queues (extra hops, harder to test); pub/sub (not on Free); outbox (deferred to v1.1) |
| Money never depends on an event | Token/star ledger rows and `wallet` updated inside `commitTx`, same transaction as idempotency store; all event subscribers are analytics-only or use `dispatch` report, never ledger mutations | Idempotency guaranteed by snapshot + deduplication; DO transaction atomicity; retried commands are detected by the object | Trusting events for economy (no reconcile path on failure) |
| Boundary enforcement | Biome 2.5.11 `noRestrictedImports` config + Vitest `arch.test.ts` scanning imports (only `index.ts`/`contract.ts` across modules, SQL table prefixes) | TS 7.0 has no compiler API; Biome is IDE-aware; Vitest runs in CI; catches violations early | ESLint + `dependency-cruiser` (wait for TS 7.1) |
| ORM | None: raw D1 prepared statements + `packages/core` `versionedUpsert`; UPSERT verified locally in core tests; `DB.batch` atomic | Keeps Worker bundle small; UPSERT standard SQLite; no vendor lock to drizzle-orm lifecycle | Drizzle-orm (extra dependency, one more schema to maintain) |
| Monorepo | pnpm 11.24.0 (`allowBuilds: { esbuild: true, workerd: true }`, `catalog`), turbo 2.10.12, Node 26.8.1 | pnpm 11 removed `onlyBuiltDependencies`; catalog for shared versions; turbo caches task outputs; Node 26 LTS | yarn (ecosystem fragmentation); npm (slower; no workspaces) |
| Time zone policy | "Today" = user's local day from IANA zone (sent by client, stored on User, changeable once per local day), validated by `Intl.DateTimeFormat` (never `supportedValuesOf`); crons and drops are UTC | Clients use device timezone; workerd is UTC; one user-local day boundary per player (no midnight cron needed for drops) | Midnight UTC (ignores user location); hourly boundaries (data sparsity) |
| Crons | Three crons: `"0 * * * *"` (drops 3 days ahead + streak reminders), `"*/5 * * * *"` (weekly leaderboard), `"0 6 * * *"` (pool depth + cron health alert); all idempotent, duplicate-tolerant | Idempotent handlers replay on transient failure; no manual recovery; Free plan allows ≥ 3; 30 s CPU per run (sub-hourly limit) | More frequent (CPU budget); fewer (manual drop filling) |
| Deploy | `wrangler deploy --env production` after `wrangler secret put` (DEVICE_TOKEN_KEYS, CONTENT_ADMIN_TOKEN); `.dev.vars` locally (never checked in) | Environment vars/secrets are immutable after deploy; CONTENT_ADMIN_TOKEN is a fixed string (no Stripe/RevenueCat webhook secrets in v1) | Inline secrets (audit/security risk) |
| Anti-cheat scope (v1 = server-authoritative) | Server-owned locked set, S1–S4 audit flags (plausibility floor, typing speed floor, too-clean flag, check-heavy flag), `boardEligible = firstSolve && !suspicious && pauseCount === 0 && (veteran ≥ 3 eligible on ≥ 2 days OR attested)`, three suspicious finishes in 30 days → `boardShadow` | Device attestation (iOS App Attest, Android Play Integrity) is v2; v1 flags exclude from boards but keep rewards; shadow-exclusion on repeat; lazy attestation flow designed but gated by ATTEST_REQUIRED flag | No anti-cheat (leaderboard meaningless); full attestation from launch (Play Integrity quota / App Attest key lifetime unknown); strict exclusion (penalizes edge cases) |
| Attestation (v2, designed but not enabled v1) | iOS: attest once per install at `POST /devices`, verify chain via `@peculiar/x509`; Android: Play Integrity standard requests under lazy flow (`boardStatus = "attestation_required"` when a finish would enter top 10); challenge single-use, `attest_keys` table stores keys/counter | App Attest keys are per physical device (Sybil-hard); Play Integrity quota 10,000/day by default (< 30 board-entering finishes per puzzle); lazy flow keeps requests trivial | Eager attestation at every board finish (quota risk); no attestation (leaderboard vulnerable) |
| Content pipeline | Authoring format in repo as JSON (versioned envelope, `<lang>-<kind>-<nnnn>` ids), shared Zod + structural validator, drop per `(day, lang)` via `ensureDrops` cron (fills 3 days ahead, picks pool or newest published), daily seed or admin `POST /admin/content/import`, generation via CSP + Claude Batches (v1 pipeline, not Worker) | Content is the "source of truth" living in the repo; drops are deterministic per UTC day; admin import for production; no BYOC (generated content has human review built in) | All content stored in D1 (no git history, no code review); generated without review (quality risk); weekly/hourly drops (sparsity) |
| Feed composition | Base posts (today's drop + prior days), stories row (today + 6 previous days), ticker (analytics), streak-at-risk card (if at-risk), interleaved `mystery` (every 6th puzzle, picks by level/topics), one `wheel` card (canSpin); cursor pagination `[lang, day, n]` (10-page cap); kickers computed client-side from `day` + `kind` | One source per user per language; `mysteryPick` defers topic/level filtering to card time; pagination by day then ordinal; mystery/wheel break monotony without requiring separate endpoints | Personalized ordering per user (complex query; eventual consistency lag); stored kickers (product-side i18n burden) |
| Notifications (v1 = stub, no push transport) | `UserState.prefs.notifications: "enabled"\|"declined"\|"skipped"` (set at onboarding, PATCH via prefs), `pushTokens: string[]` (raw Expo tokens, stored but unused in v1); the `notifications` module owns only `notifications_reminders_sent` (dedupe) and reacts to `player.onboarded` / `solve.finished` / `collections.completed` by writing or clearing a reminder row — no HTTP delivery, no per-kind toggles, no `dropHourLocal`, no `POST /v1/me/push-tokens` route | Push delivery (Expo/APNs/FCM) is a v2 integration (`gap-push-notifications-delivery.md`); v1 only proves the dedupe/scheduling logic so the module boundary and event wiring do not change when delivery is added | Build full push delivery in v1 (scope, undocumented Workers→APNs HTTP/2 support); drop the module entirely (loses the reminder dedupe table other v1 features can query) |
| Purchase receipts (v1 = mock only, v1.1+ = RevenueCat) | Mock purchases via `POST /wallet/purchases { packId, idempotencyKey }` (v1 always succeeds, ledger entry appended); `economy_purchases` row written by projection (never pre-check in D1); idempotency table prevents double-credit | Mocks tokens instantly for playtesting; real receipts layer in with a provider webhook later (same routes, same ledger); idempotency checked server-side (duplicate requests are detected) | Real IAP in v1 (integration complexity, testing on device required) |
| Plan (v1 = mock only) | `POST /billing/plan { plan: "lite" | "month" | "year", idempotencyKey }` sets `UserState.plan` + emits `economy.planChanged`; v1 always succeeds, no payment required | Placeholder for product/pricing later; ads removal controlled by `plan.tier` (not v1 feature yet); mock lets the team test UI | Real payment in v1 (Stripe/RevenueCat integration deferred) |

Notes on resolutions:
- **RL_CHECK**: new rate limit binding for autocheck ticket checks (gap-solve-protocol-integrity R3). Kept as 30/60 s per `solveId` from the gap doc, oracle harvest takes ≥ 6.3 min at 190 calls (5×5 plausible) or ≥ 11 min at 325 calls (worst-case uniform).
- **Per-user aggregate**: DAG preserved by making `collections` the owner of reward claim (not `economy`), per gap-api-contract-freeze F2. `economy` has no `subscriptions.ts`.
- **Session shape**: stateful in User DO per gap-solve-protocol-integrity §2, not stateless per words route per README. Typed locks, wrong-guess budgets, autocheck tickets, hint idempotency all server-side.
- **Ledger storage**: in-object DO table per gap-wallet-ledger R1, not a ring in `UserState` (per-commit clone cost) or D1 only (eventual consistency on wallet read after purchase).
- **DO classes declaration**: `exports` over `migration()` per wrangler 4.107+ preference (tested in vitest-plugin 1.1.3).
- **Notification prefs shape**: kept as the simple enum `"enabled"|"declined"|"skipped"` plus `pushTokens: string[]` (README's original v1 shape). The richer `{ status, streak, drop, rival, dropHourLocal }` object from gap-push-notifications-delivery.md R1 is the v2 shape, adopted only when push delivery is built.
- **Cron identity**: three distinct crons (not one catch-all) per gap docs and README risk U2 (retry guarantees undocumented; windowed idempotency acceptable).
- **Anti-cheat**: board exclusion (tokens/stars kept) per gap-solve-protocol-integrity R4 fairness model; shadow flag for repeat offenders; attestation designed but v1 is local flags only.

## 1. Module map

### Table: modules, their write models, storage, and dependencies

| module | owns (write model / responsibilities) | Durable Objects | D1 tables | may depend on | subscribes to |
|---|---|---|---|---|---|
| `shared` | request context, id generation, day keys, word normalisation, error classes | — | — | — | — |
| `events` | envelope definition, event registry, dispatch function, subscription types | — | — | `shared` | — |
| `content` | puzzle catalog (public payload + secrets), daily drops, collections manifest, admin import, drop cron | — | `content_puzzles`, `content_puzzle_secrets`, `content_daily_drops`, `content_collections`, `content_collection_puzzles`, `content_meta` | `shared` | — |
| `player` | User DO: wallet, streak, completions, session, install/token version, merge state; projection: `player_state`; fact rows: `player_solves` | `User` | `player_state`, `player_solves` | `shared`, `events` | — |
| `identity` | device-token mint/verify/refresh, auth middleware, bootstrap, account management (`/me`, `DELETE /me`) | — | — | `shared`, `player` | — |
| `solving` | solve session orchestration (start, word-check, hints, finish); queries puzzle secrets | — | — | `shared`, `events`, `content`, `player` | — |
| `economy` | wallet view, token packs, plans, wheel spin, hint prices (cost constants) | — | `economy_purchases` | `shared`, `events`, `player` | `collections.completed` |
| `social` | PuzzleStats DO (likes, solved, no-hint solved, solvingNow, top 10 today); like/save toggles; leaderboard queries | `PuzzleStats` | `social_puzzle_stats` | `shared`, `events`, `player`, `content` | `solve.started`, `solve.paused`, `solve.resumed`, `solve.finished`, `social.likeToggled` |
| `collections` | progress tracking, unlock rule evaluation, reward claim orchestration | — | — (reads `content_collection_puzzles` via `content`, `player_solves` via `player`) | `shared`, `events`, `content`, `player` | `solve.finished` |
| `leaderboard` | weekly board materialisation (cron-driven), per-puzzle top solvers query | — | `leaderboard_week` | `shared`, `player`, `content` | — (cron-driven) |
| `feed` | page composition (daily drops, stories, ticker, streak-at-risk, wheel/mystery interleave) | — | — (reads `content_*`, `player_solves`, `social_puzzle_stats` via query functions) | `shared`, `content`, `player`, `social`, `collections` | — |
| `notifications` | reminder deduplication, streak-break notices (cron-driven; no push delivery in v1) | — | `notifications_reminders_sent` | `shared`, `events`, `player` | `player.onboarded`, `solve.finished` (background), `collections.completed` (background) |
| `app` | composition root: Hono tree, wiring, module factory, event handler table | — | — | everything | — |

### Dependency DAG and layering

The module dependency graph is a directed acyclic graph (DAG) structured in layers, bottom-up:

1. `shared` (no dependencies)
2. `events` (depends only on `shared`)
3. {`content`, `player`} (depend only on `shared` and/or `events`)
4. `identity` (depends on `shared`, `player`)
5. {`solving`, `economy`, `social`} (depend on lower layers; `social` and `economy` span more dependencies)
6. {`collections`, `leaderboard`} (depend on `shared`, `events`, lower modules)
7. {`feed`, `notifications`} (depend on lower modules, compose read models)
8. `app` (composition root, depends on everything, forms the Hono tree and wiring)

**Why `player` sits below the slice modules (identity, solving, economy, social, collections):**
`player` owns the single `User` Durable Object that holds all per-user state (wallet, streak, completions, session, likes, saves, preferences, wheel, etc.). Slice modules (economy, solving, collections, social) are *responsibilities* that delegate through `player/index.ts` to command methods on the `User` aggregate. This keeps one aggregate per user, ensuring atomic commits for coupled operations (e.g., "finish a puzzle" = tokens + stars + streak + completion + session close in one transaction).

**Why `feed` sits at the top:**
Feed is a pure read-side page composer. It queries (never mutates) multiple modules' read models via their query APIs (`content.withSecret`, `player.getSnapshot`, `social.getStats`, `collections.getCollections`) and interleaves results with gateway-computed rows (streak-at-risk card, wheel state, mystery cells). It has no subscribers and no domain events.

### Import rules

Cross-module imports are governed by strict compiler-enforced boundaries:

1. **Sanctioned cross-module imports:** A module may import from another module only via that module's two public files: `modules/<name>/index.ts` (exported commands and queries) and `modules/<name>/contract.ts` (Zod schemas for events and DTOs). All other files in a module (`internal/**`, `http.ts`, `subscriptions.ts`) are private.

2. **Forbidden directions:** The dependency graph must remain a DAG; therefore, a module must never import from `app/` (composition root) or from any module higher in the layer chart above it.

3. **Kernel isolation:** `shared/` and `events/` import nothing from `modules/`; they form the kernel and may only depend on each other.

4. **Composition root privilege:** Only `app/index.ts`, `app/app.ts`, `app/wiring.ts` and `app/modules.ts` may import from any module or directly invoke Durable Objects. No module imports from `app/`.

5. **Subscriber command rule (event handlers):** When a subscriber module's handler receives an event and needs to command other modules, it may only command its own module (no-op idempotency via aggregate state) or the `player` module (shared per-user aggregate); it may not command a third module. To influence a third module, the handler publishes a follow-on integration event that the third module subscribes to. This keeps the dispatcher acyclic and limits the depth of cascading events.

### Ports rule: how modules are injected and extracted

**In-process (monolith):** `src/app/modules.ts` exports `createModules(ctx: RequestContext)` which returns a `Modules` record binding all module APIs to the current request context. Each module's `index.ts` exports env-free functions (commands and queries) that take a `RequestContext` as their first argument; `createModules` partially applies that context, so callers write `modules.economy.credit({...})` with no context argument visible. Route handlers and subscribers receive this `Modules` object on Hono's context (`c.get("modules")`).

**Extraction (later, via Workers RPC):** When a module is split to its own Worker, the same `createModules` file resolves the module's binding one way: if `env.BINDING` exists (post-split, a service binding), use it; otherwise, use `ctx.exports.ClassName` (loopback, in-process). The binding is typed as `Service<import("...").ClassName>` (Workers RPC), which has the same method signatures as the in-process object. Callers never change; the call site is identical before and after extraction.

**Concrete example:** Today, `modules/economy/index.ts` exports `export const economy = { credit, debit, spinWheel, ... }` and is imported as `import { economy } from "../modules/economy"`. After extraction to `workers/economy`, `app/modules.ts` checks `env.ECONOMY` and returns either the service binding or the loopback stub. The caller's code remains `modules.economy.credit({...})`, and the RPC-safe DTOs in `economy/contract.ts` (plain JSON, no class instances) are already structured for transmission.

## 2. Aggregates

Two Durable Object aggregates hold mutable domain state: `User` (per-player economy and session state) and `PuzzleStats` (per-puzzle counters and leaderboards). All other entities (puzzles, drops, collections, leaderboards) are plain D1 tables written by editors, the cron Trigger, or projection flushes.

---

### User

**Module:** `player` · **File:** `workers/gateway/src/modules/player/internal/user.do.ts`  
**Kind:** `"user"` · **ID scheme:** `u_<26-char Crockford base32>` (from `shared.userId()`)  
**Env binding:** `USER` · **Wrangler export:** `"User"`

**Full TypeScript state interface:**

```ts
export interface UserState {
  createdAt: number;
  tz: string; // IANA zone, e.g. "Europe/Kyiv"; default "UTC"
  tzChangedDay: string | null; // last day a tz change was made (YYYY-MM-DD)
  lang: "en" | "uk" | "ru";
  prefs: {
    level: "newbie" | "casual" | "shark";
    topics: string[]; // lowercase slugs from TOPICS constant
    onboardingDone: boolean;
    notifications: "enabled" | "declined" | "skipped";
  };
  plan: {
    tier: "lite" | "month" | "year";
    expiresAt: number | null; // epoch ms, null for "lite" or expired
    source: "mock" | "revenuecat" | "stripe" | null;
  };
  wallet: { tokens: number; stars: number };
  ledgerSeq: number; // seq of the newest ledger entry; dedupe key for projections
  streak: {
    count: number; // current streak; 0 if not extended today
    lastSolvedDay: string | null; // YYYY-MM-DD in user tz; null if never solved
    longest: number; // max count ever reached
  };
  completions: Record<string, CompletionRecord>; // puzzleId → { day, solvedAt, timeMs, hintsUsed, tokens, stars, suspicious, boardEligible }
  likes: string[]; // sorted puzzle ids
  saves: string[]; // sorted puzzle ids
  wheel: {
    lastSpinDay: string | null; // YYYY-MM-DD in user tz
    lastPrize: number | null; // prize amount from the last spin
    lastIndex: number | null; // prize index [0..5] for client animation
  };
  hints: { total: number; tokensSpent: number }; // cumulative
  stats: { solved: number; bestTimeMs: number | null };
  collectionsClaimed: string[]; // collection ids that have been claimed once
  pushTokens: string[];
  installs: { id: string; platform: "ios" | "android" | "web"; attested: boolean; keyId?: string }[]; // app installs (v2: attestation)
  session: SolveSession | null; // one active solve session per user; null = no active session
  tokenVersion: number; // incremented to revoke all held device tokens (merge, security)
  mergedInto: string | null; // userId this account was merged into (v2 feature, null in v1)
  absorbedFrom: string[]; // userIds merged into this account (v2 feature, empty in v1)
}

export interface CompletionRecord {
  day: string; // YYYY-MM-DD (user-local day when solved)
  solvedAt: number; // epoch ms
  timeMs: number; // elapsed from startedAt to finish, minus pausedMs
  hintsUsed: number; // count of hint commands that cost tokens
  tokens: number; // earned (0 if replay or suspicious)
  stars: number; // earned (0 if replay, ≥10 always if first solve)
  suspicious: boolean; // S1/S2 flags set; excluded from leaderboards
  boardEligible: boolean; // S3/S4/replay/pause checks passed
  telemetry: {
    typed: number; // typed lock count
    swept: number; // locks from cascade
    wrong: number; // total wrong guesses
    checks: number; // autocheck tickets used
    hints: number; // hints count (same as hintsUsed)
    pauses: number; // pause/resume cycles
    minGapMs: number; // smallest time between consecutive locks
    firstLockMs: number; // time from startedAt to first typed lock
  };
}

export interface SolveSession {
  id: string; // "<puzzleId>~<22-char base32 random>"
  puzzleId: string;
  size: 5 | 9; // copied at start
  parSec: number; // 300 | 600, copied at start
  fillableCells: number; // for plausibility floor and check caps
  questionCount: number;
  replay: boolean; // puzzleId ∈ completions at start
  status: "running" | "paused" | "finished";
  startedAt: number; // server clock (now)
  pausedMs: number; // cumulative pause duration
  pausedSince: number | null; // timestamp when paused (null if running)
  pauseCount: number; // number of pause/resume cycles (excludes from board if > 0)
  locked: number[]; // server-owned; sorted question indexes
  locks: {
    q: number;
    at: number; // server clock when locked
    typed: boolean; // true = typed, false = hint/sweep
    swept: number[]; // other questions locked by cascade
  }[];
  guesses: {
    total: number; // wrong guesses
    wrongTotal: number; // per-solve wrong count
    wrongByQ: Record<string, number>; // per-question wrong count
    lastAt: number | null; // server clock of last wrong guess
  };
  hintsUsed: number; // count of paid hints (fifty, letter, word)
  hintLog: { q: number; kind: "fifty" | "letter" | "word"; cost: number; at: number }[];
  pendingFifty: { q: number; options: [string, string]; at: number } | null; // server-issued options; consumed by pick
  autocheck: boolean; // user enabled autocheck
  autocheckUsed: boolean; // turned on at least once (recorded for telemetry)
  checkTickets: number; // tickets issued (≤6; 7th call → CHECK_BUDGET)
  lastTicketAt: number | null; // server clock of last ticket renewal
  finishedAt: number | null; // server clock when finished
  lastResult: SolveResult | null; // cached; returned on every retry until session replaced
}
```

**Projection columns** (`player_state` table receives: id, version, updated_at plus):
- `tz` ← `state.tz`
- `lang` ← `state.lang`
- `level` ← `state.prefs.level`
- `topics_json` ← JSON.stringify(state.prefs.topics)
- `plan_tier` ← `state.plan.tier`
- `plan_expires_at` ← `state.plan.expiresAt`
- `tokens` ← `state.wallet.tokens`
- `stars` ← `state.wallet.stars`
- `streak` ← `state.streak.count`
- `longest_streak` ← `state.streak.longest`
- `last_solved_day` ← `state.streak.lastSolvedDay`
- `local_day_ends_at` ← computed from tz
- `solved_count` ← `state.stats.solved`
- `best_time_ms` ← `state.stats.bestTimeMs`
- `likes_json` ← JSON.stringify(state.likes)
- `saves_json` ← JSON.stringify(state.saves)
- `push_token_count` ← state.pushTokens.length

**Plus `player_solves` rows** (via Projections.extra for kind="user"; see §Required changes):
- Insert OR IGNORE newest ≤5 completions as fact rows: `(id, user_id, puzzle_id, solved_at, day_key, week_key, time_ms, hints_used, tokens, stars, suspicious, board_eligible, typed_words, wrong_guesses, check_tickets, pause_count, min_gap_ms, first_lock_ms)`

---

#### Streak algorithm

**Day keys and boundaries:**
- `dayKey(ms, tz): string` = `Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))` → `"YYYY-MM-DD"`
- `prevDay(day: string): string` computes the previous day via `Date.UTC` arithmetic

**Updating the streak** (in `finishSolve` commit):
- `today = dayKey(now, tz)`
- If `lastSolvedDay === today` → no change (already solved today)
- Else if `lastSolvedDay === prevDay(today)` → `count++` (extended the streak)
- Else → `count = 1` (restarted or first solve)
- `longest = max(longest, count)` always

**Effective streak on read** (for display):
- `count` if `lastSolvedDay ∈ {today, yesterday}`, else `0`
- "At risk" = `lastSolvedDay === yesterday` (must solve today to keep the streak)

**Constraints:**
- `setTimezone` is limited to once per local day; it never lowers `lastSolvedDay` (no rewinding)
- Replays do not extend the streak

---

#### Commands (all take `now: number` explicitly; all return `Snapshot<UserState>`)

##### `init(id: string): Promise<Snapshot<UserState>>`

**Preconditions:** aggregate not yet initialized

**Effect:** Creates the aggregate with default state (zero wallet, new tz from client, lang from onboarding, no prefs, empty completions, session null). Flushes to D1 `player_state` row via the projection.

**Returns:** snapshot

**Idempotency:** Idempotent by `id` (calling again returns current snapshot)

**DomainErrors:** (none)

---

##### `registerInstall(installId: string; platform: "ios" | "android" | "web"; appVersion: string; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** aggregate initialized

**Effect:** Appends to `installs[]` (deduplicated by `installId`; overwrites existing `{ id, platform, attested: false }`). Emits `identity.userBootstrapped` event.

**Returns:** snapshot

**Idempotency:** Idempotent by `installId` (set `attested: false` on update, never true)

**DomainErrors:** (none)

---

##### `setPreferences(level: string; topics: string[]; lang: string; notifications: string; tz: string; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** `tz` must be valid IANA zone (tested via `Intl.DateTimeFormat` construction); aggregate initialized

**Effect:** Updates `prefs`, `lang`, `tz` (subject to rate limit below), marks `onboardingDone = true`. Emits `player.onboarded` event (first time) or `player.prefsChanged` event.

**Returns:** snapshot

**Idempotency:** Idempotent by state equality (same values → no version bump)

**DomainErrors:**
- `BAD_TZ`: `tz` fails validation

---

##### `setTimezone(tz: string; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** `tz` valid; `dayKey(now, tz) ≠ tzChangedDay` (at most once per local day)

**Effect:** Updates `tz`, sets `tzChangedDay = dayKey(now, tz)`. Never lowers `lastSolvedDay` (streak cannot rewind).

**Returns:** snapshot

**Idempotency:** Rate-limited (409 if called twice in the same local day)

**DomainErrors:**
- `BAD_TZ`: `tz` fails validation
- `TZ_CHANGE_LIMIT`: Called twice in the same local day

---

##### `setPlan(tier: "lite" | "month" | "year"; expiresAt: number | null; purchaseId: string; source: "mock" | "revenuecat" | "stripe"; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** aggregate initialized

**Effect:** Updates `plan`. Idempotent by `purchaseId` (see below).

**Returns:** snapshot

**Idempotency:** Idempotent by `purchaseId` (stored in DO `idempotency` table or D1 `economy_purchases`; same key + same payload → replay stored result; same key + different payload → 409 `IDEMPOTENCY_MISMATCH`)

**DomainErrors:** (none; 409 is a precondition failure, handled by gateway)

---

##### `toggleLike(puzzleId: string; liked: boolean; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** aggregate initialized

**Effect:** If `liked` true, add to `likes[]` (sorted); if false, remove. Emits `social.likeToggled` event.

**Returns:** snapshot with updated `likes[]`

**Idempotency:** Idempotent by state equality (toggling the same value twice is a no-op)

**DomainErrors:** (none)

---

##### `toggleSave(puzzleId: string; saved: boolean; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** aggregate initialized

**Effect:** If `saved` true, add to `saves[]` (sorted); if false, remove. Emits `social.saveToggled` event.

**Returns:** snapshot with updated `saves[]`

**Idempotency:** Idempotent by state equality

**DomainErrors:** (none)

---

##### `startSolve(puzzleId: string; now: number; parSec: number; fillableCells: number; questionCount: number): Promise<Snapshot<UserState>>`

**Preconditions:** puzzle exists (validated by calling module); aggregate initialized

**Effect:** Replaces any existing `session` with a new one. `replay = puzzleId ∈ completions`. Sets `status = "running"`.

**Returns:** snapshot with new session

**Idempotency:** Idempotent (calling again with the same `puzzleId` returns the same session)

**DomainErrors:** (none)

---

##### `submitWord(solveId: string; questionIndex: number; correct: boolean; now: number; topology: { questionCount: number; cells: number[][][] }): Promise<Snapshot<UserState>>`

**Preconditions:** session exists and `session.id === solveId`; `session.status === "running"` (not `paused` or `finished`); if `correct` false: `guesses.wrongByQ[q] < 20 && guesses.wrongTotal < 100`

**Effect (wrong guess):** Increments `guesses.total`, `guesses.wrongByQ[q]`, `guesses.lastAt`. State changes → version bump, **no D1 flush** (via `projectionFingerprint` hook in core).

**Effect (correct word):**
1. Add `questionIndex` to `locked[]`, execute `sweep()` (cascade-lock questions whose cells are all fixed)
2. Push entry to `locks[]` with timing telemetry
3. Increment `guesses.total`
4. If `locked.length === questionCount` → **inline finish** (see below)

**Returns:** snapshot; for a finishing word, includes `result: SolveResult` in `session.lastResult`

**Idempotency:** Idempotent by `solveId` + `questionIndex` (second call to lock the same question is a no-op)

**DomainErrors:**
- `NO_ACTIVE_SESSION`: no session or session id mismatch
- `PAUSED`: command not allowed while `status === "paused"`
- `GUESS_BUDGET`: wrong guess after budgets exhausted
- `ALREADY_LOCKED`: `questionIndex ∈ locked`

---

##### **Inline finish** (inside `submitWord` when all questions locked)

Same logic as `finishSolve` below:

```
elapsedMs = now - session.startedAt - session.pausedMs
secLeft = max(0, floor((parSec*1000 - elapsedMs)/1000))
suspicious = (elapsedMs < minPlausible) || (S2 typing floor)
tokens = (replay || suspicious) ? 0 : floor(secLeft/5)
stars = replay ? 0 : (10 + (hintsUsed === 0 ? 2 : 0))
completions[puzzleId] = { day, solvedAt, timeMs, hintsUsed, tokens, stars, suspicious, boardEligible, telemetry }
applyStreak(dayKey(now, tz))
stats.solved++, stats.bestTimeMs = min(stats.bestTimeMs, timeMs)
ledgerSeq += 3 (solve tokens + solve stars + no-hint bonus, capped; entries appended to DO ledger table)
session.status = "finished"
session.lastResult = SolveResult { ... }
```

Emits `solve.finished` event (collections and leaderboard subscribers awaited critically; notifications background).

Returns snapshot with `session.lastResult`.

---

##### `spendForHint(solveId: string; questionIndex: number; kind: "fifty" | "letter" | "word"; idempotencyKey?: string; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** session exists, `session.id === solveId`, `status === "running"`, `questionIndex ∉ locked`, `tokens >= cost` (where cost is `HINT_COST[kind]` = 20/40/100)

**Effect:** Debits tokens, increments `hintsUsed`, pushes to `hintLog`, appends ledger entry. Stores `pendingFifty` for `fifty` hints (consumed by subsequent `pick` call). Emits `solve.hintUsed` event.

**Returns:** snapshot

**Idempotency:** Idempotent by `(solveId, questionIndex, kind)` if `idempotencyKey` provided; otherwise unique per call

**DomainErrors:**
- `INSUFFICIENT_TOKENS`: balance < cost → 402 (gateway maps)
- `NO_ACTIVE_SESSION`: session mismatch
- `PAUSED`: paused session
- `QUESTION_LOCKED`: already locked
- `IDEMPOTENCY_MISMATCH`: same key, different parameters → 409

---

##### `pauseSolve(solveId: string; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** session exists, `status === "running"`

**Effect:** Sets `status = "paused"`, `pausedSince = now`, increments `pauseCount`. Subsequent `submitWord` etc. return 409 `PAUSED`.

**Returns:** snapshot with `status = "paused"`

**Idempotency:** Idempotent (second pause is a no-op)

**DomainErrors:**
- `NO_ACTIVE_SESSION`: no session

---

##### `resumeSolve(solveId: string; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** session exists, `status === "paused"`

**Effect:** Sets `status = "running"`, adds `now - pausedSince` to `pausedMs`, clears `pausedSince`.

**Returns:** snapshot with `status = "running"`

**Idempotency:** Idempotent (second resume is a no-op)

**DomainErrors:**
- `NO_ACTIVE_SESSION`: no session

---

##### `finishSolve(solveId: string; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** session exists, `session.id === solveId`

**Effect:** If `status === "finished"` → return cached `lastResult` (idempotent). Otherwise 409 `NOT_COMPLETE` (finish is inline in `submitWord` when all locked).

**Returns:** cached `lastResult` or error

**Idempotency:** Idempotent by `solveId` (retried finish returns same result until session replaced)

**DomainErrors:**
- `NO_ACTIVE_SESSION`: no session
- `NOT_COMPLETE`: session running but not all questions locked

---

##### `spinWheel(idempotencyKey: string; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** `dayKey(now, tz) ≠ wheel.lastSpinDay` (once per local day); aggregate initialized

**Effect:** Selects random prize from `[50, 10, 0, 25, 5, 15]`, credits tokens (if non-zero), sets `wheel.lastSpinDay`, `lastPrize`, `lastIndex`. Appends ledger entry. Emits `economy.wheelSpun` event.

**Returns:** snapshot with prize details

**Idempotency:** Idempotent by `idempotencyKey` (stored result includes same `prizeIndex`); same `wheelId` (day-based) after a spin → 422 `ALREADY_SPUN`

**DomainErrors:**
- `ALREADY_SPUN`: second spin on the same local day
- `IDEMPOTENCY_MISMATCH`: same key, different parameters

---

##### `claimCollection(collectionId: string; memberIds: string[]; reward: number; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** all `memberIds ∈ completions`, `collectionId ∉ collectionsClaimed`, aggregate initialized

**Effect:** Verifies completeness (gateway pre-checks via D1 query), adds to `collectionsClaimed`, credits `reward` tokens, appends ledger entry. Emits `collections.completed` event.

**Returns:** snapshot

**Idempotency:** Idempotent by `collectionId` (second claim is a no-op; event not re-emitted)

**DomainErrors:**
- `COLLECTION_INCOMPLETE`: not all members solved

---

##### `creditPurchase(purchaseId: string; packId: string; tokens: number; source: { provider: string; ... }; now: number): Promise<Snapshot<UserState>>`

**Preconditions:** aggregate initialized

**Effect:** Credits tokens, appends ledger entry with `reason: "purchase"`, `ref: purchaseId`. Idempotent by `purchaseId`.

**Returns:** snapshot

**Idempotency:** Idempotent by `purchaseId` (stored in `idempotency` table; replay returns stored `{ replayed: true, entry, balances }`). Attachment to projection writes to `economy_purchases` D1 table.

**DomainErrors:** (none; 409 `IDEMPOTENCY_MISMATCH` handled by gateway)

---

##### `bumpTokenVersion(): Promise<Snapshot<UserState>>`

**Preconditions:** aggregate initialized

**Effect:** Increments `tokenVersion` to revoke all held device tokens.

**Returns:** snapshot

**Idempotency:** Unique per call

**DomainErrors:** (none)

---

##### `reconcile(now: number): Promise<Snapshot<UserState>>`

**Preconditions:** aggregate initialized; called by POST `/v1/me/reconcile` (admin or self)

**Effect:** Re-drives idempotent fan-out from the current snapshot: calls `PuzzleStats.recordSolve` for each completion, re-flushes ledger to D1, verifies ledger invariants.

**Returns:** snapshot with repaired flag

**Idempotency:** Idempotent (no-op if everything is in sync)

**DomainErrors:** (none)

---

##### `purge(): Promise<void>`

**Preconditions:** aggregate initialized

**Effect:** Deletes the aggregate from the DO's SQLite and schedules deletion of all projection rows in D1.

**Returns:** void

**Idempotency:** Idempotent (second call finds nothing)

**DomainErrors:** (none)

---

### PuzzleStats

**Module:** `social` · **File:** `workers/gateway/src/modules/social/internal/puzzle-stats.do.ts`  
**Kind:** `"puzzle_stats"` · **ID scheme:** puzzle id (e.g. `en-mini-0001`)  
**Env binding:** `PUZZLE_STATS` · **Wrangler export:** `"PuzzleStats"`

**Full TypeScript state interface:**

```ts
export interface PuzzleStatsState {
  likes: number;
  solved: number; // all completions
  noHintSolved: number; // first solves with hints=0
  solvingNow: number; // presence count (committed at most every 15 s)
  topToday: {
    day: string; // puzzle's drop_date or UTC today
    rows: Array<{ userId: string; timeMs: number }>; // ≤10, sorted ascending by time
  };
}
```

**Projection columns** (`puzzle_stats` table receives: id, version, updated_at plus):
- `likes` ← `state.likes`
- `solved` ← `state.solved`
- `no_hint_solved` ← `state.noHintSolved`
- `solving_now` ← `state.solvingNow`
- `top_day` ← `state.topToday.day`
- `top_today_json` ← JSON.stringify(state.topToday.rows)

---

#### Commands (all take `now: number` explicitly; all return `Snapshot<PuzzleStatsState>`)

##### `init(puzzleId: string; now: number): Promise<Snapshot<PuzzleStatsState>>`

**Preconditions:** aggregate not yet initialized

**Effect:** Creates aggregate with `likes = 0`, `solved = 0`, `noHintSolved = 0`, `solvingNow = 0`, empty `topToday`.

**Returns:** snapshot

**Idempotency:** Idempotent by `puzzleId`

**DomainErrors:** (none)

---

##### `adjustLikes(delta: 1 | -1; now: number): Promise<Snapshot<PuzzleStatsState>>`

**Preconditions:** aggregate initialized

**Effect:** Adds `delta` to `likes` (never negative).

**Returns:** snapshot

**Idempotency:** Idempotent by state equality (toggling like then unlike is a no-op)

**DomainErrors:** (none; negative balance clamped to 0)

---

##### `recordSolve(userId: string; timeMs: number; boardDay: string; noHints: boolean; boardEligible: boolean; now: number): Promise<Snapshot<PuzzleStatsState>>`

**Preconditions:** aggregate initialized; called only if `boardEligible === true` (suspicious solves excluded by caller)

**Effect:** Increments `solved`, `noHintSolved += noHints`. If `boardDay === topToday.day` insert into `topToday.rows` (keep ≤10 asc by time), else reset `topToday = { day: boardDay, rows: [...] }`.

**Returns:** snapshot

**Idempotency:** Idempotent by `(userId, puzzleId)` (keyed by `player_solves` PK; projection already prevents duplicates)

**DomainErrors:** (none)

---

##### `heartbeat(userId: string; now: number): Promise<Snapshot<PuzzleStatsState>>`

**Preconditions:** aggregate initialized

**Effect:** Updates in-memory `Map<userId, lastSeenMs>` (not persisted). If `now - lastPresenceCommit > 15_000` or count crossed zero, commits `solvingNow = map.size`.

**Returns:** snapshot (unchanged state if commit not triggered)

**Idempotency:** Idempotent (repeated heartbeats from same user are deduplicated in memory)

**DomainErrors:** (none)

---

##### `leave(userId: string; now: number): Promise<Snapshot<PuzzleStatsState>>`

**Preconditions:** aggregate initialized

**Effect:** Removes `userId` from in-memory presence map. If count crosses zero, commits `solvingNow = 0`.

**Returns:** snapshot

**Idempotency:** Idempotent (removing non-existent user is a no-op)

**DomainErrors:** (none)

---

### Required changes to packages/core

The following changes are mandatory for Crosscut v1:

1. **`projectionFingerprint(state)`** hook (fixes D1 write bloat): `commit()` compares a fingerprint of state (rather than full JSON) to decide whether to flush. `User.projectionFingerprint` returns state without the `session` field. Without this, ≈12 per-DAU per-day `submitWord` commits that only touch `session` would trigger 3 D1 writes each (54 M rows/month at 50k DAU ⇒ +$37/month), but the hook ensures only `finishSolve` (which changes `completions`, `wallet`, `streak`) flushes to D1. Core change: in `#persist`, compute `JSON.stringify(projectionFingerprint(prev))` and `…(next)`; when equal, mark `projected = version` and skip `flush()`.

2. **`Projections.apply(…, attachments)`** hook for side tables: Allow projection definitions to return extra D1 statements (`extra?: (state, meta, attachments) => D1PreparedStatement[]`) to be batched with the main upsert. Used by `player` to insert `player_solves` rows atomically with `player_state`. Core change: `apply()` signature gains `attachments: unknown` parameter; pass to `extra()` if present; batch all statements in one `DB.batch([upsert, ...extra])`.

3. **`flushAttachments()` and `onFlushed()` hooks** (for ledger watermark): Allow aggregates to read side-effect data synchronously before `await`, send it with the projection, and finalize on success. Core change: add `protected flushAttachments(): unknown { return undefined }` (default) and `protected onFlushed(_attachments: unknown): void {}` (default); in `flush()` read attachments before `await`, pass to `apply()`, call `onFlushed()` on success.

4. **Snapshot-size guard in `#persist`**: Warn if snapshot > 256 KiB, throw if > 1 MiB (prevents large-state runaway). Core change: in `#persist` after `JSON.stringify(state)`, check size and log/throw.

**Existing self-rearm behavior:** The alarm handler already re-arms its own retry on failed flush (`flush()` → `#scheduleRetry()` → `setAlarm`); this is preserved as-is. Platform retries stop after 6, so the handler re-arms keep retrying indefinitely within Crosscut's own circuit logic.

**Tests to add to core (`packages/core/test/aggregate.test.ts`):**
- "commit with `projectionFingerprint`: session-only changes do not flush"
- "fingerprint change triggers flush to D1"
- "attachments reach `apply()` and `onFlushed()` only on success"
- "snapshot > 256 KiB warns; > 1 MiB throws"

**No user-facing API changes.** The `Aggregate` constructor, `init()`, `snapshot()`, `commit()`, `flush()` signatures are unchanged. Subclasses override optional hooks (`schemaMigrations`, `projectionFingerprint`, `flushAttachments`, `onFlushed`).

---

## 3. Event bus

### Envelope

Every domain event is a plain JSON object validated by Zod and delivered by the in-process dispatcher:

```typescript
interface Envelope<T extends string, P> {
  id: string;              // uuid v4, minted by the producing aggregate to ensure
                           // deterministic re-delivery: (type, aggregate.id, aggregate.version) → same id
  type: T;                 // "<module>.<pastTenseFact>", e.g. "solve.finished"
  v: 1;                    // payload schema version for evolution
  occurredAt: string;      // ISO 8601 timestamp (z.iso.datetime() seconds required)
  actor: {kind:"user", userId:string} | {kind:"system", reason:string};
  correlationId: string;   // per inbound HTTP request; alarm redelivery reuses it
  causationId: string;     // event or command id that triggered this (tracing, cycle detection)
  aggregate: {
    kind: string;          // "user", "puzzle_stats"
    id: string;            // user id, puzzle id, etc.
    version: number;       // aggregate version at commit; subscribers use for de-dup when id table pruned
  };
  payload: P;              // domain-specific fields; plain JSON only (structured-clone-safe over RPC)
}
```

### Registry and defineEvent()

Each module's `contract.ts` exports `defineEvent(type, v, payloadSchema)` returning a Zod object schema. The composition root (`app/wiring.ts`) composes all of them into a single discriminated union, validated on every dispatch:

```typescript
// modules/<m>/contract.ts
export const SolveFinished = defineEvent("solve.finished", 1, z.strictObject({
  userId: z.string(),
  puzzleId: z.string(),
  solveId: z.string(),
  lang: z.string(),
  dropDate: z.string(),
  solveTimeMs: z.int().min(0),
  secLeft: z.int().min(0),
  par: z.int(),
  hintsUsed: z.int().min(0),
  firstSolve: z.boolean(),
  suspicious: z.boolean(),
  tokensEarned: z.int().min(0),
  starsEarned: z.int().min(0),
  dayKey: z.string(),
  streak: z.int().min(0),
  streakExtended: z.boolean(),
}));

// app/wiring.ts
export const DomainEvent = z.discriminatedUnion("type", [
  SolveFinished, CollectionsCompleted, SocialLikeToggled, /* ... all 18 events */
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type EventOf<T extends DomainEvent["type"]> = Extract<DomainEvent, {type: T}>;
```

### Subscriptions and handlers

A subscriber is a handler that reacts to an event published by another module. Handlers are registered once at module evaluation in the composition root:

```typescript
interface Subscription<T extends DomainEvent["type"] = any> {
  name: string;              // "collections.onSolveFinished" — stable, used for per-handler ack
  type: T;                   // the event type this handler consumes
  mode: "critical" | "background";  // delivery semantics
  handle(event: EventOf<T>, ctx: DispatchContext): Promise<void | any>;
}

interface DispatchContext {
  env: Env;                  // wrangler bindings
  exec: ExecutionContext | null;   // null when running from a DO alarm; needed for ctx.exec.waitUntil
  actor: {kind:"user", userId:string} | {kind:"system", reason:string};
  correlationId: string;
  now: () => Date;           // injected clock
  depth: number;             // event causation depth (loop guard)
  seen: Set<string>;         // `type:aggregate.kind:aggregate.id:aggregate.version` per request
  publish(events: DomainEvent[]): Promise<void>;  // emit follow-on events
}

type HandlerTable = ReadonlyMap<DomainEvent["type"], readonly Subscription[]>;
```

### Dispatch algorithm

The gateway calls `dispatch(table, events[], ctx)` immediately after a command commits. Ordering and error semantics are:

1. **Validate** each event: `DomainEvent.safeParse()` rejects parse failures (logged, acked to avoid loops).
2. **Critical handlers**: iterate in registration order (wiring order is an API); await each handler; wrap in try/catch; one failure never blocks the next; record outcomes.
3. **Background handlers**: wrap each in `ctx.exec.waitUntil(p.catch(log))` if `ctx.exec` exists (no-op in DO alarms; recovers via alarm-path dispatch instead).
4. **Follow-on events** (if a handler calls `ctx.publish(events)`): dispatch with `depth + 1`, `causationId = parent.id`. Guards: `MAX_DEPTH = 4`, `MAX_EVENTS_PER_REQUEST = 64`, per-request `seen` set prevents re-entrancy of exact same fact.
5. **Ack**: after critical handlers, the gateway calls `stub.ackEvents([{eventId, handlers: [successful names]}])` to delete outbox rows for handlers that succeeded. Rows with `remaining` handlers stay armed for retry.

Response status is still 200 if the command committed and handlers failed; command failure (`DomainError`) is distinct and maps to 422.

### DispatchReport

```typescript
interface DispatchReport {
  eventId: string;
  outcomes: Array<{handler: string; ok: boolean; ms: number; error?: {name, message}}>;
  reason?: "invalid" | "loop-guard";  // if validation or depth/count guard triggered
}
```

The HTTP response surface: only successful critical handler names (so clients know "yes, collection was claimed") and failed handler names are logged. Background handler results are not returned.

### Idempotency per handler kind

Every handler must be idempotent on `event.id`:

- **Aggregate commands** (in v1): Idempotency is provided by the snapshot + re-delivered events model; a replay of the same event (from outbox retry) is detected by re-running the command (e.g., `collections.checkAndClaim` idempotent by collectionId). No `processed_events` table in v1 (upgrade path to v1.1 outbox adds it).
- **D1 projection writes** (leaderboard rows, social counters): use event id as a natural key in the write (`INSERT OR IGNORE INTO leaderboard_week(event_id, …)`) or a version guard.
- **No money depends on events**. Tokens, stars, and streak changes are inside `User.finishSolve()` or `collections.claimCollection()`, not triggered by events; the event carries already-computed amounts and subscribers only update read models or trigger follow-on events.

### Failure semantics (v1 reconciliation model)

The outbox is a recovery queue, not an event log. It lives in the producing aggregate's SQLite, written atomically with state in one `transactionSync`:

| Failure point | Effect | Recovery | Data loss |
|---|---|---|---|
| Before command commits | nothing | client retries | no |
| After commit, before dispatch | outbox rows exist | aggregate alarm re-delivers through `Events` entrypoint | no |
| During critical dispatch | handlers idempotent on event id | redelivery to all; done ones dedupe | no |
| Handler failure | recorded in report; not acked | alarm retries that handler only (per-handler ack) | no |
| Alarm exhausts 6 retries | handler permanently failed | client `POST /v1/me/reconcile` manually re-drives from User snapshot | no (reconcile is idempotent) |

**Upgrade path (v1 → v2)**: when a background handler becomes money-relevant (e.g., push notifications affect retention metrics used to unlock rewards) or measured loss exceeds tolerance, adopt a DO outbox table with ack-per-handler and alarm-based redelivery. Trigger: a handler in `subscriptions.ts` that calls a rate-limited third party (Expo push, email, RevenueCat) and must survive independently of the request; use Cloudflare Queues or Workflows instead of expanding the event bus.

### Full event catalog (from glossary section 4)

| Type | Payload fields | Producer | Critical subscribers | Background subscribers |
|---|---|---|---|---|
| `identity.userBootstrapped` | userId, installId, platform, appVersion | identity | — | analytics |
| `player.onboarded` | userId, level, topics, lang, plan, notifications, tz | player | — | notifications.scheduleReminderOptIn |
| `player.prefsChanged` | userId, lang?, topics?, tz? | player | — | feed cache bust |
| `solve.started` | userId, puzzleId, solveId, at | solving | — | social.heartbeat (background) |
| `solve.paused` | userId, puzzleId, solveId, at | solving | — | social.leave (background) |
| `solve.resumed` | userId, puzzleId, solveId, at | solving | — | social.heartbeat (background) |
| `solve.hintUsed` | userId, solveId, puzzleId, kind, cost, balance | solving | — | analytics |
| `solve.finished` | userId, puzzleId, solveId, lang, dropDate, solveTimeMs, secLeft, par, hintsUsed, firstSolve, suspicious, tokensEarned, starsEarned, dayKey, streak, streakExtended | solving | collections.checkAndClaim → social.recordSolve | notifications.cancelReminder, analytics |
| `collections.completed` | userId, collectionId, reward, eventRef | collections | collections.unlockDependants | notifications (background) |
| `collections.unlocked` | userId, collectionId | collections | — | feed cache bust |
| `economy.wheelSpun` | userId, wheelId, prizeIndex, prize, balance | economy | — | analytics |
| `economy.packPurchased` | userId, packId, tokens, purchaseId, mocked | economy | — | analytics |
| `economy.planChanged` | userId, plan, expiresAt, purchaseId, mocked | economy | — | analytics |
| `social.likeToggled` | userId, puzzleId, liked | social | social.adjustLikes (PuzzleStats) (critical) | — |
| `social.saveToggled` | userId, puzzleId, saved | social | — | — |

### Module extraction (moving a module to its own Worker)

Because payloads are already `structured-clone`-safe and handlers are thin adapters of commands, extracting a module is mechanical:

1. Create `modules/<name>/entrypoint.ts` as a `WorkerEntrypoint` that re-exports the module's public API, one method per line.
2. Update `wrangler.jsonc`: add the module's Durable Object namespace bindings with `script_name`, add a service binding (`services: [{binding, service, entrypoint}]`), require `compatibility_flags: ["enable_ctx_exports"]`.
3. In `app/modules.ts`, swap the in-process call from `bind(moduleName, ctx)` to `ctx.env.BINDING`.
4. Event subscriptions: for modules still in the gateway, dispatch in-process; for extracted modules, forward events over the service binding or upgrade one subscription to a Queue consumer (if rates or third-party latency demand it).

Caller code is unchanged; the adapter layer (`RpcSafe` type and port pattern) ensures no leakage of RPC details.

### Tests the events module must ship

The `events/` folder has no business logic, only mechanics. Tests cover:

1. **Ordering invariant**: dispatch handler table from `wiring.ts`, emit a sequence of events with inter-dependencies, assert critical handlers run in registration order and follow-on events are queued in depth-first order.
2. **Error isolation**: one critical handler throws; assert the next handler still runs, report documents both, ack omits the failed one.
3. **Loop guard**: emit an event that triggers a follow-on at depth 4; depth 5 is rejected (reason: "loop-guard"); per-request count cap of 64 is tested likewise.
4. **Validation failure**: parse a malformed event; assert it is logged, acked (not retried), report records reason: "invalid".
5. **Background handlers and `ctx.exec.waitUntil`**: use `createExecutionContext` and `waitOnExecutionContext` to assert background promises settle correctly.
6. **Idempotency**: deliver the same envelope twice; assert deduplication works if a subscriber aggregate exists (this is an integration test run through the Hono app, not a unit test of `dispatch()` alone).

---

**Summary: 18 events, 7 producing modules, typed in-process dispatcher, critical-then-background delivery model, per-handler ack, outbox-based recovery, reconcile-driven v1 healing. Extracted modules re-use identical payloads over RPC.**

## 4. Request flows

### (1) Device bootstrap `POST /v1/devices`

1. **Gateway middleware**: `requestId` → `timing` → structured logger → `secureHeaders` → `bodyLimit(64 KB)` → `RL_BOOT.limit({ key: cf-connecting-ip })` (10/60s per IP; unauthenticated)
2. **identity.http**: `zValidator("json", DeviceBody)` → `identity.bootstrap(installId, platform, appVersion, tz, locale)`
3. **identity.bootstrap**: → `player.init(userId, installId, platform, appVersion)` → `User.init()` (DO command)
4. **User DO commit** (one `UPDATE aggregate SET version, state`): `{ createdAt: now, tz, lang: "en", prefs: {…}, wallet: {tokens: 100, stars: 0}, streak: {}, completions: {}, session: null, tokenVersion: 0, installs: [{id, platform, attested: false}] }`
5. **identity.middleware** → `identity.mint(userId)` → JWT sign with `kid`
6. **Event dispatch**: `identity.userBootstrapped { userId, installId, platform, appVersion }` (background, analytics)
7. **Response**: 201 `{ userId, token, expiresAt }`
8. **Projection flush** (async via `ctx.exports.Projections`): `player_state` upsert + initial row

**Cost**: 1 DO round-trip (init) · 1 D1 write after response (async) · events: `identity.userBootstrapped` (background) · **Errors**: 429 `rate_limited`, 400 `invalid_request` (bad tz), 500 `internal`

---

### (2) User snapshot `GET /v1/me`

1. **Gateway middleware**: `requestId` → `timing` → logger → `secureHeaders` → `bodyLimit` → `deviceAuth` (RL_USER.limit per user)
2. **identity.http**: `identity.getMe(userId)` from auth context
3. **identity.getMe**: → `player.getSnapshot(userId)` → `aggregateStub(env.USER, "user", userId).snapshot()`
4. **User DO read** (strongly consistent, one call): return `{ id, tz, lang, level, topics, plan, notifications, balances: {tokens, stars}, streak: {count, atRisk, dayEndsAt}, completedIds, likes, saves, session, wheel: {canSpin, lastPrize} }`
5. **No D1 read on path** (`/me/continue` reads `session.locked.length` from snapshot)
6. **Response**: 200 `MeView`

**Cost**: 1 DO round-trip · 0 D1 · 0 events · **Errors**: 401 `unauthenticated`, 401 `token_expired`, 404 `not_found` (merged account)

---

### (3) Feed page, first and cursor `GET /v1/feed?cursor&lang&limit`

1. **Gateway middleware**: `requestId` → `timing` → logger → `secureHeaders` → `bodyLimit` → `deviceAuth` (RL_USER)
2. **feed.http**: `zValidator("query", FeedQuery)` → `feed.getPage(userId, lang, cursor, limit)`
3. **feed.getPage**: decode cursor `base64url([day, id])` → (optional) isolate cache LRU lookup on key `(lang, today)`
4. **D1 query** (keyset pagination): `SELECT * FROM content_daily_drops d INDEXED BY daily_drops_feed WHERE d.lang = ? AND d.day < ? ORDER BY d.day DESC, d.id DESC LIMIT ?+1` (one `SEARCH … USING INDEX`, ≤ 23 rows read per page)
5. **D1 point lookups**: per puzzle in page, join `content_puzzles` + `social_puzzle_stats` + left join `player_solves(userId, puzzleId)` for `done/bestTime/inProgressSolveId` (all covering indexes; ≤ 50 joins)
6. **Gateway interleave** (pure function of puzzle ordinal `n` from cursor): insert `streak_save` after `n=0` (only if `today ∉ completedIds`), `wheel` after `n=1` (page 1 only), `mystery` after every 6th puzzle (deterministic SHA-256 pick from 90-day pool, filtered by level/topics)
7. **Response**: 200 `{ items, nextCursor, stories: [7 recent day_keys], ticker: [lines], streakAtRisk, balances }` with `Cache-Control: private, no-store`
8. **(Optional async)** `ctx.waitUntil(cache.put(skeleton_key, skeleton_response))`with `s-maxage=30` (isolate LRU is primary until D1 latency shows)

**Cost**: 0 DO · 1 D1 query (23 rows read + ≤ 50 point reads) · 0 events · **Errors**: 400 `invalid_cursor`, 400 `bad_json` (malformed cursor), 401 `unauthenticated`

---

### (4) Start solve `POST /v1/puzzles/:id/solves`

1. **Gateway middleware**: `requestId` → `timing` → logger → `secureHeaders` → `bodyLimit` → `deviceAuth` (RL_USER)
2. **solving.http**: `zValidator("param", { id: PuzzleId })` → `zValidator("json", StartBody)` → `solving.start(puzzleId, userId, restart)`
3. **solving.start**: check `restart || session.puzzleId ≠ id || session.status === "finished"` → `content.withSecret(puzzleId)` (isolate cache) → `player.startSolve(puzzleId, userId, now)` → `User.startSolve(puzzleId, now, fillableCells)` (DO command)
4. **User DO commit**: `{ session: { id: `<puzzleId>~<random>`, puzzleId, status: "running", startedAt: now, locked: [], guesses: {total: 0, wrongTotal: 0}, hintsUsed: 0, autocheck: false, pausedMs: 0, … }, replay: completions[puzzleId] ? true : false }`
5. **Event dispatch**: `solve.started { userId, puzzleId, solveId, at: now }` (background: social.heartbeat)
6. **Response**: 201 `SolveView`

**Cost**: 1 DO round-trip · 0 D1 on path · events: `solve.started` (background) · **Errors**: 404 `puzzle_not_found`, 422 `solve_finished` (if session exists and trying to replace)

---

### (5) Submit word, non-finishing `POST /v1/solves/:solveId/words`

1. **Gateway middleware**: `requestId` → `timing` → logger → `secureHeaders` → `bodyLimit` → `deviceAuth` (RL_USER)
2. **solving.http**: `zValidator("param", { solveId })` → `zValidator("json", WordBody { questionIndex, word })` (strict; no `locked` accepted, 400 if present)
3. **solving.submitWord**: extract `puzzleId` from `solveId` → `content.withSecret(puzzleId)` (no letters returned) → compute `topology` → `normalizeWord(lang, word)` → verdict = `word === answer[q]` (stateless)
4. **solving.submitWord**: → `player.submitWord(userId, solveId, questionIndex, correct, now, topology)` → `User.submitWord(…)` (DO command)
5. **User DO commit** (if wrong guess): `{ guesses.wrongTotal++, guesses.wrongByQ[q]++; if guesses.wrongByQ[q] ≥ 20 return 422 GUESS_BUDGET; if guesses.wrongTotal ≥ 100 return 422 GUESS_BUDGET }`
6. **User DO commit** (if correct): `{ locked += q, sweep(topology) → recursively lock dependent questions, locks.push({q, at: now, typed: true, swept: [...]}), guesses.total++ }` (sweep is server-owned, not client-claimed)
7. **If all questions locked**: inline finish (flow 6, same commit)
8. **No D1 write** (session-only commit; projected ≠ version, no flush unless finishing)
9. **Response**: `WordResult { correct, locked, newlyLocked, fixedLetters: [] or [for newly locked only], nextQuestionIndex, complete }`

**Cost**: 1 DO round-trip (submitWord) · 0 D1 · 0 events (no-op or guess) · **Errors**: 409 `no_active_session`, 409 `paused`, 422 `solve_finished`, 422 `guess_budget`, 422 `question_locked` (already locked)

---

### (6) Submit finishing word + rewards, streak, completion, projection flush `POST /v1/solves/:solveId/words` (all locked)

1. **(Steps 1–4 as flow 5, then inline finish inside `User.submitWord`)**
2. **User DO inline finish commit** (same transaction as lock): `{ elapsedMs = now − startedAt − pausedMs, secLeft = max(0, floor((parSec × 1000 − elapsedMs) / 1000)), suspicious = S1 || S2 (server-side plausibility + typing floor checks), tokens = replay || suspicious ? 0 : floor(secLeft / 5), stars = replay ? 0 : 10 + (hintsUsed === 0 ? 2 : 0), completions[puzzleId] = {day: dayKey(now, tz), solvedAt, timeMs: elapsedMs, hintsUsed, tokens, stars, suspicious, boardEligible, telemetry: {typed, swept, wrong, checks, hints, pauses, …}}, applyStreak(dayKey(now, tz)), stats: {solved++}, session.status = "finished", finishedAt = now, lastResult = SolveResult (cached), ledgerSeq++ }`
3. **Projections flush** (atomic, one `DB.batch`): 
   - `INSERT … ON CONFLICT UPDATE INTO player_state (version, tz, lang, …, tokens, stars, streak, …)` 
   - `INSERT OR IGNORE INTO player_solves (user_id, puzzle_id, solved_at, day_key, week_key, time_ms, hints_used, tokens, stars, suspicious, board_eligible, typed_words, …)` (fact row, 5 newest completions per flush)
4. **Event dispatch** (critical handlers awaited in order, background via `waitUntil`):
   - **collections.checkAndClaim** (critical): query `content.collectionsContaining(puzzleId)` → for each: `collections.checkAndClaim(userId, collectionId)` → query `player_solves` for collection members → if all done call `player.claimCollection(userId, collectionId, memberIds, reward)` → `User.claimCollection(…)` (DO command, idempotent on collectionId) → `emit collections.completed { userId, collectionId, reward, eventRef }`
   - **collections.unlockDependants** (critical): for each completed collection, query unlock rule dependants → `emit collections.unlocked` for each
   - **social.recordSolve** (critical, only if `boardEligible`): → `PuzzleStats.recordSolve(userId, timeMs, boardDay)` (DO, no fetch on failed board gate) → increment `solved`, update `topToday` JSON if in top 10
   - **notifications.cancelReminder** (background): → delete `(userId, dayKey)` from `notifications_reminders_sent`
   - **analytics** (background)
5. **Response**: `SolveResult { solveTimeSec, secLeft, underPar, tokensEarned, starsEarned, noHintBonus, firstSolve, balances, streak: {count, extendedToday, dayEndsAt}, claimedCollections, nextPuzzleId, celebration, boardStatus }`

**Cost**: 1 DO (User) + 1 DO read (PuzzleStats, if `wouldEnterTop` check needed) · 1 D1 batch (2–3 statements) · events: `solve.finished` → `collections.completed` → `collections.unlocked` · **Errors**: 422 `wrong_grid` (only if finish called via separate endpoint), 402 `insufficient_tokens` (during hint spends on the path), 409 `no_active_session`, 404 `solve_gone` (session replaced)

---

### (7) Hint 50/50 `POST /v1/solves/:solveId/hints/fifty`

1. **Gateway middleware**: `requestId` → `timing` → logger → `secureHeaders` → `bodyLimit` → `deviceAuth` (RL_SPEND: 20/60s per user)
2. **solving.http**: `zValidator("json", QuestionBody { questionIndex })` → `solving.spendForHint(solveId, questionIndex, "fifty")`
3. **content.withSecret(puzzleId)** (from solveId): get decoys or fallback to language bank
4. **player.spendForHint(userId, solveId, "fifty", 20 tokens, now)** → **User.spendForHint** (DO command): check `tokens ≥ 20` else return 402 `INSUFFICIENT_TOKENS { balance, cost: 20, kind: "fifty" }` → debit tokens → `hintsUsed++, hintLog.push({q, kind: "fifty", cost: 20, at: now})` (idempotent by (solveId, q, kind); retried request returns same options without re-debiting)
5. **Route computes options** (not stored in body): pick random order of `[answer, decoy]` or two decoys of matching length
6. **Route stores `pendingFifty`** in DO via `User.setPendingFifty(solveId, questionIndex, options)` (optional; route may compute options first, then one command)
7. **No D1 write** (session-only; projected = true)
8. **Response**: 200 `FiftyResult { options: [a, b], balances }`

**Cost**: 1 DO round-trip (spendForHint) + optional 1 DO (setPendingFifty) · 0 D1 · 0 events · **Errors**: 402 `insufficient_tokens`, 409 `paused`, 422 `solve_finished`, 422 `question_locked` (already solved)

---

### (8) Reveal letter `POST /v1/solves/:solveId/hints/letter` and reveal word `POST /v1/solves/:solveId/hints/word`

1. **solving.http** (letter): extract client `letters: string[]` (optional, bounded to word length) → if letters match answer exactly → `User.submitWord(correct: true, source: "hint")` without spendForHint → response `{ noop: true, word: {correct: true, …}, tokens unchanged }`
2. **Otherwise** → `User.spendForHint("letter", 40 tokens)` → route reads first wrong-or-empty cell from secret → `User.submitWord(correct: true, source: "hint")` (inline lock) → response `LetterResult { cell: [r, c], letter, word: WordResult, balances }`
3. **solving.http** (word): → `User.spendForHint("word", 100 tokens)` → `User.submitWord(correct: true, source: "hint", all cells)` (inline lock) → response `WordResult`

**Cost**: 1 DO (spendForHint + submitWord inline, or just submitWord if noop) · 0 D1 · 0 events · **Errors**: 402 `insufficient_tokens`, 422 `question_locked`

---

### (9) Autocheck ticket + per-cell check `POST /v1/solves/:solveId/autocheck { on: boolean }` and `POST /v1/solves/:solveId/check`

1. **autocheck ON** → `deviceAuth` (RL_USER) → `solving.http` → `User.setAutocheck(solveId, true, now)` (DO command)
2. **User DO commit**: check `checkTickets < 6` else 422 `CHECK_BUDGET` → `checkTickets++, lastTicketAt = now, autocheckUsed = true` → compute HMAC-SHA256 ticket `payload = "chk:" + solveId + ":" + issuedAt + ":" + n`, signed with `CHECK_TICKET_KEY` (Worker secret, rotated via `kid`) → response `AutocheckResult { autocheck: true, ticket, expiresAt: issuedAt + 600_000, ticketsLeft: 6 − checkTickets }`
3. **check** (per-cell) → `deviceAuth` (RL_CHECK: 30/60s per solveId) → `zValidator("json", CheckBody { questionIndex, letters, ticket })` → `solving.check(solveId, questionIndex, letters, ticket, now)`
4. **solving.check** (stateless): verify ticket signature, check `now − issuedAt < 10 min` else 403 `BAD_TICKET` → extract `solveId` from ticket, match path param else 403 → `RL_CHECK.limit({ key: "chk:" + solveId })` (30/60) → route reads `content.withSecret(puzzleId)` → compare client letters to answer cells only for the given question (no cross-question leak) → response `CheckResult { wrongCells: [r, c][] }`
5. **No state change on check, no D1**; ticket TTL = 10 min; if expired client calls `autocheck { on: true }` again to renew

**Cost**: 1 DO (setAutocheck) + 0 on check · 0 D1 · 0 events · **Errors**: 422 `check_budget` (after 6th ticket), 403 `bad_ticket`, 429 `rate_limited` (RL_CHECK), 403 `autocheck_off` (if `autocheck: false`)

---

### (10) Pause and resume `POST /v1/solves/:solveId/pause` and `/resume`

1. **deviceAuth** (RL_USER) → `solving.http` → `User.pauseSolve(solveId, now)` (DO command)
2. **User DO commit**: check status `running` else 409 `paused` → `pausedSince = now, pauseCount++` → return `{ secLeft: frozen value, running: false, pauseCount }`
3. **Resume**: `User.resumeSolve(solveId, now)` (DO command) → `pausedMs += now − pausedSince, pausedSince = null` → return `{ secLeft: recalculated, running: true, pauseCount }`
4. (pauseCount recorded; boardEligible requires pauseCount === 0)

**Cost**: 1 DO per command · 0 D1 · 0 events · **Errors**: 409 `paused` (on any command while paused), 409 `no_active_session`

---

### (11) Wheel spin `POST /v1/wheel/:wheelId/spin`

1. **Gateway middleware**: `deviceAuth` (RL_SPEND: 20/60s)
2. **economy.http** → `zValidator("param", { wheelId })` → `economy.spinWheel(wheelId, userId, now)`
3. **User.spinWheel** (DO command): parse `wheelId = dayKey(now, tz) + ":base"` → check `lastSpinDay !== dayKey(now, tz)` else 409 `already_spun` → `crypto.getRandomValues(new Uint8Array(4))` → index modulo WHEEL_PRIZES length → debit (or credit if negative prize) → `wheel.lastSpinDay = dayKey, lastPrize = prize, lastIndex = index`
4. **No D1**; once per local day (picked server-side, not client-sent)
5. **Event dispatch**: `economy.wheelSpun { userId, wheelId, prizeIndex, prize, balance }` (background: analytics)
6. **Response**: `SpinResult { prizeIndex, prize: <tokens>, prizes: [50, 10, 0, 25, 5, 15], balances }`

**Cost**: 1 DO · 0 D1 · events: `economy.wheelSpun` (background) · **Errors**: 409 `already_spun`, 402 `insufficient_tokens` (edge case)

---

### (12) Like toggle `POST /v1/puzzles/:id/like`

1. **deviceAuth** (RL_USER) → `social.http` → `zValidator("json", { liked: boolean })` → `social.toggleLike(puzzleId, userId, liked, now)`
2. **player.toggleLike** → **User.toggleLike** (DO command): toggle in `likes: string[]` (sorted) → `ledgerSeq++` (version bump to trigger eventual flush)
3. **Event dispatch** (critical): `social.likeToggled { userId, puzzleId, liked }` → **social.adjustLikes** → **PuzzleStats.adjustLikes** (±1 to `likes`, DO commit, one-liner)
4. **No D1 on path** (PuzzleStats is memory-backed, flushed per 15s throttle)
5. **Response**: `LikeResult { liked, likeCount }`

**Cost**: 1 DO (User) + 1 DO (PuzzleStats, critical) · 0 D1 on path · events: `social.likeToggled` · **Errors**: 401 `unauthenticated`, 404 `puzzle_not_found` (optional validation)

---

### (13) Mock purchase `POST /v1/wallet/purchases { packId, idempotencyKey }`

1. **deviceAuth** (RL_SPEND) → `economy.http` → `zValidator("json", PurchaseBody)` → `economy.purchasePack(packId, idempotencyKey, userId, now)`
2. **D1 query** (check idempotency): `SELECT * FROM economy_purchases WHERE id = ? AND user_id = ?` → if exists verify `payload` matches else 409 `purchase_conflict`
3. **Player.creditPurchase** → **User.creditPurchase** (DO command): debit from mock balance (or credit if reverse), increment `ledgerSeq`
4. **D1 write** (async or awaited): `INSERT … ON CONFLICT(id) DO UPDATE INTO economy_purchases (id, user_id, kind: "tokens", payload: {packId, tokens}, created_at)` (client idempotency key)
5. **Event dispatch**: `economy.packPurchased { userId, packId, tokens, purchaseId, mocked: true }` (background: analytics)
6. **Response**: `PurchaseResult { balances, ledgerEntry: {at, delta, kind, reason} }`

**Cost**: 1 DO (creditPurchase) · 1 D1 read + 1 D1 write (INSERT idempotent) · events: `economy.packPurchased` (background) · **Errors**: 409 `purchase_conflict`, 402 `insufficient_tokens` (reverse impossible)

---

### (14) Daily drop cron `0 * * * *` and weekly leaderboard cron `*/5 * * * *`

**Daily drop + reminder cron** (hourly):
1. **content.ensureDrops(now, 3)**: loop over 3 next UTC days; for each `(day, lang)` not in `content_daily_drops`: query pool ordered by `status=published, drop_date DESC`, pick oldest, `INSERT OR IGNORE`, emit `PuzzleStats.init(puzzleId, locationHint)`
2. **D1 batch**: ≤ 1 row per (lang, 3 days) ≈ 3 rows total
3. **Reminder cron**: query `player_state` where `streak.atRisk AND (local_day_ends_at - now < 2 hours)` → for each: `notifications.scheduleReminder(userId, dayKey)` → `INSERT OR IGNORE INTO notifications_reminders_sent (user_id, day_key)` → no-op if already sent today (not pushed in v1, scheduled for later)
4. **Health alert cron** `0 6 * * *`: query pool depth per lang; if < 14 puzzles log alert

**Weekly leaderboard cron** (every 5 min):
1. **leaderboard.materialiseWeek(week, now)**: query `player_solves` where `week_key = week AND suspicious = 0 AND board_eligible = 1`, group by user, sum stars, rank, upsert `leaderboard_week`
2. **D1 write**: ≤ 100 rows (top solvers)

**Cost**: daily: 3 D1 rows (drops) + 50–200 D1 reads (reminders) · weekly: 100–1000 D1 reads (leaderboard query), 100 D1 writes · 0 events (state externally driven) · **Errors**: cron failures silent per Cloudflare policy; `controller.noRetry()` optional for idempotency

---

### (15) Reconcile idempotent fan-out `POST /v1/me/reconcile`

1. **deviceAuth** (admin or self, RL_SPEND) → `app.http` → `player.reconcile(userId)`
2. **Player.reconcile**: read `User.snapshot()` (DO read, strongly consistent)
3. **Re-run critical handlers** (from `completions` records not yet claimed or fan-out lost):
   - **collections.checkAndClaim** per recent completion (idempotent on collectionId)
   - **social.recordSolve** if `boardEligible` (idempotent on puzzleId + day boundary)
   - **Recompute** `PuzzleStats.topToday` (deterministic, eventual consistency)
4. **No D1 write on request path** (dispatch handlers do the writes if needed)
5. **Response**: `{ repaired: [puzzleId, collectionId, ...] }` (admin visibility)

**Cost**: 1 DO read (snapshot) + optional 1 DO per collection claim + 1 DO per social record (critical) · D1 reads via handlers, writes via insert/update idempotent keys · events: re-dispatched from snapshot · **Errors**: 404 `not_found` (merged), 401 `unauthenticated`

---

## 5. D1 schema

The Crosscut Worker uses **one SQLite D1 database** (`crosscut`) divided into five migrations (0001–0005), each owned by a module. All tables follow the D1 limit of 100 bound parameters per query and leverage covering indexes for hot reads. Times are epoch milliseconds (INTEGER); day keys are TEXT (YYYY-MM-DD, UTC calendar date or user-local date per context).

---

### 0001_content.sql

Puzzle catalog, solutions, daily drops, collections manifest — all written by editors or the hourly cron; never touched by user commands.

```sql
CREATE TABLE content_puzzles (
  id            TEXT PRIMARY KEY,
  lang          TEXT NOT NULL,                    -- en | uk | ru
  kind          TEXT NOT NULL,                    -- mini | crossword; set by cron from kindForDay(drop_date)
  size          INTEGER NOT NULL,                 -- 5 | 9
  title         TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  difficulty    TEXT NOT NULL,                    -- EASY | MEDIUM | TRICKY
  par_sec       INTEGER NOT NULL,                 -- 300 (mini) | 600 (crossword)
  clue_count    INTEGER NOT NULL,
  theme_word    TEXT NOT NULL,
  reveal_json   TEXT NOT NULL,                    -- "[0,2,4]" positions to reveal in cover
  cover_style   TEXT NOT NULL,                    -- ink | accent | card
  kicker        TEXT NOT NULL,                    -- suffix rendered by client from drop_date + kind
  topics_json   TEXT NOT NULL DEFAULT '[]',
  content_json  TEXT NOT NULL,                    -- grid + clues WITHOUT answers (public payload)
  content_hash  TEXT NOT NULL,                    -- for import dedup and change detection
  status        TEXT NOT NULL DEFAULT 'draft',    -- draft | filled | clued | reviewed | published
  drop_date     TEXT,                             -- YYYY-MM-DD (UTC calendar) when this becomes today's daily; NULL = pool
  published_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX puzzles_pkey ON content_puzzles (id);
CREATE INDEX puzzles_feed ON content_puzzles (lang, drop_date DESC, id DESC);      -- feed page (day < today)
CREATE INDEX puzzles_pool ON content_puzzles (lang, status, kind, drop_date);      -- cron: pick unscheduled by kind
CREATE INDEX puzzles_author ON content_puzzles (lang, author_id);

CREATE TABLE content_puzzle_secrets (
  puzzle_id     TEXT PRIMARY KEY REFERENCES content_puzzles (id) ON DELETE CASCADE,
  solution_json TEXT NOT NULL,                    -- rows of letters; answers keyed by (num,dir)
  updated_at    INTEGER NOT NULL
);

CREATE TABLE content_daily_drops (
  day           TEXT NOT NULL,                    -- YYYY-MM-DD UTC calendar date
  lang          TEXT NOT NULL,                    -- en | uk | ru
  puzzle_id     TEXT NOT NULL REFERENCES content_puzzles (id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (day, lang),
  UNIQUE (puzzle_id)                              -- one drop per puzzle ever
);
CREATE INDEX daily_drops_feed ON content_daily_drops (lang, day DESC);             -- feed pages

CREATE TABLE content_collections (
  id            TEXT PRIMARY KEY,
  lang          TEXT NOT NULL,
  shelf         TEXT NOT NULL,                    -- theme | size | setter | archive
  name          TEXT NOT NULL,
  emoji         TEXT NOT NULL,
  blurb         TEXT NOT NULL,
  style         TEXT NOT NULL,
  reward        INTEGER NOT NULL,                 -- tokens granted on completion
  unlock_rule   TEXT,                             -- "collection:X" (another collection) or NULL
  position      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX collections_shelf ON content_collections (lang, shelf, position);

CREATE TABLE content_collection_puzzles (
  collection_id TEXT NOT NULL REFERENCES content_collections (id) ON DELETE CASCADE,
  puzzle_id     TEXT NOT NULL REFERENCES content_puzzles (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  PRIMARY KEY (collection_id, position)
);
CREATE INDEX collection_puzzles_by_puzzle ON content_collection_puzzles (puzzle_id);

CREATE TABLE content_meta (
  key           TEXT PRIMARY KEY,                 -- e.g. "lastEnsureDropsAt", "economy_audit:2026-09-02"
  value_json    TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

---

### 0002_player.sql

User aggregates project here; per-user economy, progress, and solve history.

```sql
CREATE TABLE player_state (
  id                    TEXT PRIMARY KEY,         -- user id "u_<26-char base32>"
  version               INTEGER NOT NULL,         -- bumped on every User.commit(); projection only advances on version > projected
  tz                    TEXT NOT NULL,            -- IANA zone (e.g. "Europe/Kyiv"), default "UTC"
  lang                  TEXT NOT NULL,            -- en | uk | ru
  level                 TEXT NOT NULL,            -- newbie | casual | shark
  topics_json           TEXT NOT NULL,            -- ["travel", "music"]
  plan_tier             TEXT NOT NULL,            -- lite | month | year
  plan_expires_at       INTEGER,                  -- epoch ms when subscription ends; NULL = free
  tokens                INTEGER NOT NULL,         -- current balance
  stars                 INTEGER NOT NULL,         -- current balance
  streak                INTEGER NOT NULL,         -- current streak (0 = not at risk, >= 1)
  longest_streak        INTEGER NOT NULL,         -- all-time high
  last_solved_day       TEXT,                     -- YYYY-MM-DD user-local day of most recent solve
  local_day_ends_at     INTEGER NOT NULL,         -- epoch ms when user's current local day ends
  solved_count          INTEGER NOT NULL,         -- total completions (per-puzzle max once)
  best_time_ms          INTEGER,                  -- fastest completion in any puzzle (ms)
  likes_json            TEXT NOT NULL,            -- sorted puzzle ids ["en-mini-0001", ...]
  saves_json            TEXT NOT NULL,            -- sorted puzzle ids
  push_token_count      INTEGER NOT NULL DEFAULT 0,
  merged_into           TEXT,                     -- user id this account was merged into (v2)
  updated_at            INTEGER NOT NULL
);
CREATE INDEX player_state_streak_reminder ON player_state (local_day_ends_at, last_solved_day);
CREATE INDEX player_state_plan ON player_state (plan_tier, plan_expires_at);

CREATE TABLE player_solves (
  id            TEXT PRIMARY KEY,                 -- "user_id:puzzle_id" (natural key, idempotent)
  user_id       TEXT NOT NULL,
  puzzle_id     TEXT NOT NULL REFERENCES content_puzzles (id) ON DELETE CASCADE,
  solved_at     INTEGER NOT NULL,                 -- epoch ms when solved
  day_key       TEXT NOT NULL,                    -- YYYY-MM-DD user-local day (recorded at solve time)
  week_key      TEXT NOT NULL,                    -- ISO week "2026-W36" user-local (for weekly leaderboard)
  time_ms       INTEGER NOT NULL,                 -- solve duration (elapsed time in ms)
  hints_used    INTEGER NOT NULL,                 -- count of hints claimed
  tokens        INTEGER NOT NULL,                 -- earned tokens (0 if replay or suspicious)
  stars         INTEGER NOT NULL,                 -- earned stars (10 + 2 bonus if no hints)
  suspicious    INTEGER NOT NULL DEFAULT 0        -- 1 if plausibility checks flagged (excluded from leaderboards)
);
CREATE INDEX solves_by_puzzle_time ON player_solves (puzzle_id, suspicious, time_ms);  -- leaderboard: top solvers today
CREATE INDEX solves_by_user ON player_solves (user_id, solved_at DESC);              -- profile stats
CREATE INDEX solves_by_week ON player_solves (week_key, user_id);                    -- weekly leaderboard aggregation
CREATE INDEX solves_user_day ON player_solves (user_id, day_key);                    -- stories (covering)
CREATE INDEX solves_user_puzzle ON player_solves (user_id, puzzle_id);              -- done check, replay detect, mystery/next
```

---

### 0003_social.sql

Puzzle counters (projections) and leaderboards (cron-materialized).

```sql
CREATE TABLE social_puzzle_stats (
  id                TEXT PRIMARY KEY,             -- puzzle id (matches content_puzzles.id)
  version           INTEGER NOT NULL,
  likes             INTEGER NOT NULL DEFAULT 0,
  solved            INTEGER NOT NULL DEFAULT 0,   -- total solves (including suspicious and replays)
  no_hint_solved    INTEGER NOT NULL DEFAULT 0,   -- solves with hints_used = 0
  solving_now       INTEGER NOT NULL DEFAULT 0,   -- presence count (heartbeats, ~15s throttle)
  top_day           TEXT,                         -- YYYY-MM-DD of topToday rows
  top_today_json    TEXT NOT NULL DEFAULT '[]',   -- [{userId, timeMs}, ...] sorted asc, max 10 (excludes suspicious)
  updated_at        INTEGER NOT NULL
);

CREATE TABLE leaderboard_week (
  week_key          TEXT NOT NULL,                -- ISO week "2026-W36" (user-local)
  rank              INTEGER NOT NULL,             -- 1-indexed
  user_id           TEXT NOT NULL,
  stars             INTEGER NOT NULL,             -- SUM(stars) from player_solves WHERE week_key=? AND NOT suspicious
  solves            INTEGER NOT NULL,             -- COUNT(*) from player_solves WHERE week_key=? AND NOT suspicious
  PRIMARY KEY (week_key, rank)
);
CREATE INDEX leaderboard_week_user ON leaderboard_week (week_key, user_id);        -- lookup current rank
```

---

### 0004_economy.sql

Purchase ledger for receipts and idempotency; mirror of the User DO's ledger table.

```sql
CREATE TABLE economy_ledger (
  user_id           TEXT NOT NULL,
  seq               INTEGER NOT NULL,             -- ledger entry sequence (bumps per balance change)
  at                INTEGER NOT NULL,             -- epoch ms when entry was recorded
  kind              TEXT NOT NULL,                -- tokens | stars
  delta             INTEGER NOT NULL,             -- signed change (never 0)
  balance           INTEGER NOT NULL,             -- balance AFTER this entry
  reason            TEXT NOT NULL,                -- solve | no_hint_bonus | hint | wheel | collection | purchase | refund | adjust | merge
  ref               TEXT NOT NULL,                -- business key: solveId, sessionId:q:kind, wheelId, collectionId, purchaseId, etc.
  op_key            TEXT,                         -- idempotency key if this came from a keyed command
  meta              TEXT,                         -- {"packId": "p120", "provider": "mock"} for details
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX economy_ledger_reason_at ON economy_ledger (reason, at);               -- sinks/sources per day

CREATE TABLE economy_purchases (
  id                TEXT PRIMARY KEY,             -- "<provider>:<external_id>"; v1: "mock:<idempotencyKey>"
  user_id           TEXT NOT NULL,
  provider          TEXT NOT NULL,                -- mock | revenuecat | apple | stripe
  provider_event_id TEXT,                         -- RevenueCat event.id, Apple notificationUUID for webhook dedup
  product_id        TEXT NOT NULL,                -- store SKU (e.g. "tokens_550")
  pack_id           TEXT NOT NULL,
  tokens            INTEGER NOT NULL,
  price             REAL,
  currency          TEXT,
  store             TEXT,                         -- APP_STORE | PLAY_STORE | STRIPE | MOCK
  environment       TEXT,                         -- PRODUCTION | SANDBOX | MOCK
  status            TEXT NOT NULL DEFAULT 'credited',  -- credited | refunded
  ledger_seq        INTEGER NOT NULL,             -- points to the economy_ledger row
  refund_ledger_seq INTEGER,                      -- points to the refund entry (if refunded)
  raw_json          TEXT,                         -- webhook payload for audit
  purchased_at      INTEGER NOT NULL,             -- epoch ms of the purchase event
  created_at        INTEGER NOT NULL
);
CREATE INDEX economy_purchases_user ON economy_purchases (user_id, purchased_at DESC);
CREATE INDEX economy_purchases_event ON economy_purchases (provider, provider_event_id);  -- webhook dedup
```

---

### 0005_notifications.sql

Reminder deduplication to prevent duplicate streak-break notices on the same user-day.

```sql
CREATE TABLE notifications_reminders_sent (
  user_id           TEXT NOT NULL,
  day_key           TEXT NOT NULL,                -- YYYY-MM-DD user-local day
  sent_at           INTEGER NOT NULL,             -- epoch ms when sent (or would have been sent in v1)
  PRIMARY KEY (user_id, day_key)
);
```

---

### Query → index reference

This table documents the hot read paths and their index coverage. All reads verify via `EXPLAIN QUERY PLAN` to confirm `SEARCH ... USING INDEX`.

| Read operation | SQL shape | Source table | Index used | Row budget |
|---|---|---|---|---|
| Feed page (skeleton) | `SELECT d.*, p.*, ps.* FROM content_daily_drops d JOIN content_puzzles p WHERE d.lang=? AND d.day<=? ORDER BY day DESC LIMIT limit+1` | content_daily_drops + content_puzzles + social_puzzle_stats | daily_drops_feed (lang, day DESC) + content_puzzles PK + social_puzzle_stats PK | 20–50 rows |
| Feed overlay (done/liked/saved) | `SELECT time_ms FROM player_solves WHERE user_id=? AND puzzle_id IN (?, ?, ...)` | player_solves | solves_user_puzzle (user_id, puzzle_id) | ≤ 20 point lookups |
| Feed stories | `SELECT DISTINCT day_key FROM player_solves WHERE user_id=? AND day_key BETWEEN ? AND ?` | player_solves | solves_user_day (user_id, day_key) covering | ≤ 7 rows |
| Top solvers today (puzzle page) | `SELECT top_today_json FROM social_puzzle_stats WHERE id=?` | social_puzzle_stats | PK (id) | 1 row |
| Weekly leaderboard | `SELECT user_id, SUM(stars), COUNT(*) FROM player_solves WHERE week_key=? AND suspicious=0 GROUP BY user_id ORDER BY 2 DESC LIMIT 100` | player_solves | solves_by_week (week_key, user_id) | ~350k rows at 50k DAU (D1 rows_read cost) |
| Collection detail (progress) | `SELECT cp.*, COUNT(s.id) AS done FROM content_collection_puzzles cp LEFT JOIN player_solves s ON (s.user_id=? AND s.puzzle_id=cp.puzzle_id) WHERE cp.collection_id=? GROUP BY cp.puzzle_id` | content_collection_puzzles + player_solves | collection_puzzles_by_puzzle (puzzle_id) + solves_user_puzzle | ~20 rows |
| Mystery pick | `SELECT * FROM content_daily_drops d JOIN content_puzzles p WHERE d.lang=? AND d.day<? AND d.day>=? AND NOT EXISTS (SELECT 1 FROM player_solves s WHERE s.user_id=? AND s.puzzle_id=d.puzzle_id) ORDER BY d.day DESC` | content_daily_drops + content_puzzles + player_solves | daily_drops_feed (lang, day DESC) + solves_user_puzzle (covering) | ≤ 90 candidates |
| Puzzle /next | `SELECT d.puzzle_id FROM content_daily_drops d WHERE d.lang=? AND d.day<=? AND d.puzzle_id<>? AND NOT EXISTS (...) LIMIT 1` | content_daily_drops + player_solves | daily_drops_feed (lang, day DESC) + solves_user_puzzle (covering) | ~5 rows |
| Pool for cron | `SELECT * FROM content_puzzles WHERE lang=? AND status='published' AND kind=? AND drop_date IS NULL ORDER BY created_at LIMIT 1` | content_puzzles | puzzles_pool (lang, status, kind, drop_date) | 1–3 rows |
| Profile stats (best time) | `SELECT MIN(time_ms), COUNT(*), MAX(week_key) FROM player_solves WHERE user_id=?` | player_solves | solves_by_user (user_id, solved_at DESC) or full scan (small per-user set) | ~100 rows |

---

### Conventions

**Projection rows** (`player_state`, `social_puzzle_stats`):
- **versionedUpsert semantics**: Stored via `INSERT INTO ... ON CONFLICT(id) DO UPDATE ... WHERE excluded.version > table.version` (from `packages/core` `versionedUpsert`). A stale flush (version ≤ projected) leaves the row unchanged. Re-runs are safe; out-of-order flushes are ignored.
- **id, version, updated_at**: Every projection row has `id TEXT PRIMARY KEY`, `version INTEGER`, `updated_at INTEGER`. The base class adds `updated_at = Date.now()` on every upsert.
- **Booleans as 0/1**: SQLite has no boolean type; columns like `suspicious` use `INTEGER DEFAULT 0` (value 1 is true).

**Fact tables** (`player_solves`, `economy_ledger`):
- **INSERT OR IGNORE idempotency**: Rows are written with `INSERT OR IGNORE` on a natural key (`id` or `user_id:puzzle_id`). Retried flushes and `reproject(force=true)` are safe; duplicate keys do nothing.
- **No UPDATE after insert**: Fact rows are immutable. Corrections go as new entries (e.g., `refund` ledger entry).
- **Append-only for leaderboards**: A `player_solves` row is the source of truth for earnings and leaderboard eligibility. `leaderboard_week` is cron-materialized from it; never updated row-by-row.

**Cross-module boundaries**:
- **No JOINs across module prefixes** except within composed queries (e.g., `feed` joins `content_*` and `social_*` in D1, but the module calls each owner's query function). `player` module owns `player_*` tables; `content` owns `content_*`; etc.
- **Time semantics**: All times are epoch milliseconds (INTEGER). `day_key` and `week_key` are TEXT ISO 8601 strings, never computed in D1 (the Worker's `dayKey(ms, tz)` and `weekKey(day)` are canonical). User-local `day_key` is recorded at solve time and never recomputed; cron uses UTC `day_keys` for scheduled tasks.
- **Streaks and progress**: Streak is computed lazily on read from `last_solved_day`. Collection progress is `COUNT(solves)` per user; no denormalization in state.

** Feed indexes** (gap-feed-composition-semantics R3–R8):
- `daily_drops_feed (lang, day DESC)` for keyset cursor pagination (`day < ?`).
- `solves_user_puzzle (user_id, puzzle_id)` as a covering index for `done` checks and `NOT EXISTS` in mystery/next queries.
- `solves_user_day (user_id, day_key)` as a covering index for stories (seven-day distinct days).

** Economy ledger** (gap-wallet-ledger-and-idempotency R1–R4):
- `economy_ledger` mirrors the `User` DO's in-object `ledger` table via watermark attachment (`projected_seq`).
- Rows are inserted by the projection's `extra` statements in the same `DB.batch` as `player_state` upserts.
- `reason` is a closed enum (solve, hint, wheel, collection, purchase, refund, adjust, merge).
- `balance` is the cumulative balance *after* the entry (no need for Σ delta to verify the chain).

---

Total tables: **13** (6 content, 2 player, 1 social, 1 leaderboard, 2 economy, 1 notifications).
Total indexes: **17** (covering nearly every hot read).

## 6. API surface

### Common conventions

**Base path & transport:** all endpoints are under `/v1`; JSON-only request and response bodies; no OpenAPI schema.

**Authentication & rate limits:**
- `Authorization: Bearer <token>` on all endpoints except `POST /devices`, `GET /config`, `GET /healthz` (none), and `POST /admin/*` (CONTENT_ADMIN_TOKEN bearer instead).
- Rate limit headers `Retry-After` on every 429 and 503; rate limit scopes:
  - `RL_BOOT` 10/60s per IP (device bootstrap)
  - `RL_USER` 120/60s per user (general authenticated use)
  - `RL_SPEND` 20/60s per user (hints, purchases, wheel spins)
  - `RL_CHECK` 30/60s per solveId (per-cell autocheck calls, keyed by solveId)

**Error envelope:** all non-2xx responses use `{ error: { code, message?, details?, issues?, requestId } }` where:
- `code` is a lower-snake-case error code from the Error code catalog.
- `message` is developer-facing English (never shown to users).
- `details` carries code-specific structured data (e.g. `{ balance, cost }`, `{ retryAfterSec }`).
- `issues` contains `z.treeifyError(err)` on `invalid_request` for nested bodies.
- `requestId` is a correlation id for debugging.
- `WWW-Authenticate: Bearer realm="crosscut"` on every 401.

**Pagination:** feed uses cursor-based pagination. Cursor format: opaque `base64url(JSON)` encoding `{ v: 1, lang, day, n }` (language, drop date, page ordinal). Pass cursor via `?cursor=` query param. Decode failures or mismatched language → 400 `invalid_cursor`. Page size `?limit=1–50` (default 20); 10-page cap to limit D1 reads.

**Idempotency:** 
- `POST /solves/:solveId/finish` idempotent per solveId (returns cached `SolveResult`).
- Hints idempotent per `(solveId, questionIndex, kind)`.
- Purchases and plan changes idempotent per client `idempotencyKey` (deduped via D1 `economy_purchases.id` PK).
- Onboarding and prefs are overwrites (no dedup needed).
- Like/save carry the target state (`{ liked: true }`, not "toggle").

**Timezone handling:** user can supply `X-Timezone: <IANA zone>` header (validated by constructing `Intl.DateTimeFormat`). Fallback: stored user pref → per-language default. Determines user-local `dayKey` for feeds, streaks, wheel.

**Consistency markers** (in DTO docs):
- **S** = aggregate snapshot (linearizable per user; one User DO read).
- **P** = D1 projection (millisecond lag; minutes if a flush fails).
- **C** = cron-materialised (≤5 min; weekly boards updated every 5 minutes).

---

### Identity module

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| GET | `/config` | none | — | — | 200 ConfigView (cache 1h) | — |
| POST | `/devices` | none | RL_BOOT | DeviceBody | 201 DeviceSession | 429 rate_limited |
| POST | `/session/refresh` | device (expired ≤30d ok) | RL_USER | — | 200 DeviceSession | 401 token_expired, token_key_unknown, token_revoked; 409 merged |
| GET | `/me` | device | RL_USER | — | 200 MeView (S) | 401 unauthenticated |
| DELETE | `/me` | device | RL_SPEND | — | 204 | 401 unauthenticated |
| POST | `/me/reconcile` | device or admin | RL_SPEND | — | 200 ReconcileReport | — |

**Request bodies:**
- `DeviceBody = { installId: uuid, platform: "ios"|"android"|"web", appVersion: string, locale?: string, tz?: string }`

**Response headers:** `WWW-Authenticate: Bearer realm="crosscut"` on 401.

---

### Player module (onboarding, preferences, profile)

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| POST | `/me/onboarding` | device | RL_USER | OnboardingBody | 200 MeView | 422 bad_tz |
| PATCH | `/me/prefs` | device | RL_USER | PrefsPatch | 200 MeView | 409 tz_change_limit; 422 bad_tz |
| GET | `/me/profile` | device | RL_USER | — | 200 ProfileView (P) | — |
| GET | `/me/saved` | device | RL_USER | — | 200 SavedView (S) | — |

**Request bodies:**
- `OnboardingBody = { level: "newbie"|"casual"|"shark", topics: string[≤8], lang: "en"|"uk"|"ru", plan: "lite"|"month"|"year", notifications: "enabled"|"declined"|"skipped", tz: string, skippedAt?: "welcome"|"level"|"topics"|"language"|"planReady"|"notifs"|"paywall" }`
- `PrefsPatch = { level?, topics?[≤8], lang?, tz?, notifications? }` (at least one field required)

---

### Feed module

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| GET | `/feed` | device | RL_USER | FeedQuery | 200 FeedPage (P+S) | 400 invalid_cursor |
| GET | `/daily` | device | RL_USER | — | 200 DailyView | 404 no_drop |

**Query params:**
- `FeedQuery = { cursor?: string, lang?: string, limit?: 1..50 }`
  - Defaults: no cursor (first page), user's stored `lang`, limit 20.
  - Mismatch: cursor lang ≠ query lang → 400 `invalid_cursor`.

**Response:** `FeedPage` with `items: FeedItem[]`, `nextCursor?: string`, `stories: DayState[7]`, `ticker: TickerItem[]`, `streakAtRisk?: StreakAtRiskCard`, `balances: Balances`.

**Cards:** non-puzzle cards inserted at ordinals: `streak_save` after puzzle 0 (page 1 only, if streak > 0 and today unsolved), `wheel` after puzzle 1 (page 1 only), `mystery` after every puzzle with `(n+1) % 6 === 0` (if available). Card ids are stable within a user-day.

---

### Content module (puzzles, collections, browse)

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| GET | `/puzzles/:id` | device | RL_USER | — | 200 PuzzleView | 404 puzzle_not_found |
| GET | `/puzzles/:id/leaderboard` | device | RL_USER | LeaderboardQuery | 200 PuzzleLeaderboard (P) | 404 puzzle_not_found |
| GET | `/puzzles/:id/next` | device | RL_USER | — | 200 NextView | 404 puzzle_not_found |
| GET | `/collections` | device | RL_USER | — | 200 CollectionsView (P) | — |
| GET | `/collections/:id` | device | RL_USER | — | 200 CollectionDetail (P) | 404 collection_not_found |

**Leaderboard query:**
- `LeaderboardQuery = { period?: "today", limit?: 1..10 }`
  - Defaults: "today", limit 3.
  - "today" = the puzzle's `drop_date` (UTC calendar day).

**Response:** `PuzzleView` includes `cover, stats, me: { done, bestTimeSec, inProgressSolveId?, liked, saved }` (me fields from User snapshot).

---

### Solving module

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| POST | `/puzzles/:id/solves` | device | RL_USER | StartSolveBody | 201 SolveView | 404 puzzle_not_found |
| GET | `/solves/:solveId` | device | RL_USER | — | 200 SolveView | 404 solve_not_found, solve_gone; 409 no_active_session |
| GET | `/puzzles/:id/solution` | device | RL_USER | — | 200 SolutionView | 403 not_completed; 404 puzzle_not_found |
| POST | `/solves/:solveId/words` | device | RL_USER | WordsBody | 200 WordsResult | 409 no_active_session, paused; 422 bad_question, bad_word |
| POST | `/solves/:solveId/hints/fifty` | device | RL_SPEND | HintBody | 200 FiftyResult | 402 insufficient_tokens; 409 no_active_session, paused, already_claimed; 422 question_locked |
| POST | `/solves/:solveId/hints/fifty/pick` | device | RL_USER | FiftyPickBody | 200 WordsResult | 422 bad_question |
| POST | `/solves/:solveId/hints/letter` | device | RL_SPEND | LetterHintBody | 200 LetterResult | 402 insufficient_tokens; 409 no_active_session, paused |
| POST | `/solves/:solveId/hints/word` | device | RL_SPEND | WordHintBody | 200 WordHintResult | 402 insufficient_tokens; 409 no_active_session, paused; 422 question_locked |
| POST | `/solves/:solveId/autocheck` | device | RL_USER | AutocheckBody | 200 AutocheckResult | 409 no_active_session, paused; 422 check_budget |
| POST | `/solves/:solveId/check` | device | RL_CHECK | CheckBody | 200 CheckResult | 403 autocheck_off, bad_ticket; 409 no_active_session, paused |
| POST | `/solves/:solveId/pause` | device | RL_USER | — | 200 TimerView | 409 no_active_session, already_paused |
| POST | `/solves/:solveId/resume` | device | RL_USER | — | 200 TimerView | 409 no_active_session, not_paused |
| POST | `/solves/:solveId/finish` | device | RL_USER | FinishBody | 200 SolveResult | 409 no_active_session, NOT_FINISHED |

**Request bodies:**
- `StartSolveBody = { restart?: boolean }`
  - `restart: true` replaces an in-progress session for the same puzzle.
- `WordsBody = { questionIndex: int≥0, word: string 1–15 }`
  - Submitted word; locked set is server-owned.
- `HintBody = { questionIndex: int≥0 }`
- `FiftyPickBody = { questionIndex: int≥0, word: string }`
- `LetterHintBody = { questionIndex: int≥0, filled: string[] }`
  - `filled` contains the client's entries for the question's cells (`.` for empty).
- `WordHintBody = { questionIndex: int≥0 }`
- `AutocheckBody = { on: boolean }`
  - Toggles autocheck on/off; returns ticket if turned on.
- `CheckBody = { ticket: string, cells: [{ r: int≥0, c: int≥0, ch: string }] }`
  - Per-cell check with autocheck ticket; cells are grid coordinates.
- `FinishBody = {}` (no-body; grid never leaves server)

---

### Collections module

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| POST | `/collections/:id/claim` | device | RL_SPEND | — | 200 ClaimResult | 404 collection_not_found; 409 already_claimed; 422 collection_incomplete, collection_locked |

**Response:** `ClaimResult = { claimed: boolean, reward: int, balances: Balances }`.

---

### Social module

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| POST | `/puzzles/:id/like` | device | RL_USER | LikeBody | 200 LikeResult | 404 puzzle_not_found |
| POST | `/puzzles/:id/save` | device | RL_USER | SaveBody | 200 SaveResult | 404 puzzle_not_found |
| POST | `/puzzles/:id/presence` | device | RL_USER | PresenceBody | 200 PresenceResult | 404 puzzle_not_found |

**Request bodies:**
- `LikeBody = { liked: boolean }` (target state, not toggle).
- `SaveBody = { saved: boolean }`.
- `PresenceBody = { state: "solving"|"left" }`.

---

### Economy module (wallet, purchases, wheel)

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| GET | `/wallet` | device | RL_USER | — | 200 WalletView (S) | — |
| POST | `/wallet/purchases` | device | RL_SPEND | PurchaseBody | 200 PurchaseResult | 409 purchase_conflict |
| POST | `/billing/plan` | device | RL_SPEND | PlanBody | 200 PlanView | 409 purchase_conflict |
| GET | `/wheel` | device | RL_USER | — | 200 WheelView (S) | — |
| POST | `/wheel/:wheelId/spin` | device | RL_SPEND | — | 200 SpinResult | 404 wheel_not_found; 409 already_spun |

**Request bodies:**
- `PurchaseBody = { packId: string, idempotencyKey: string }`
  - `packId` ∈ "p120", "p550", "p1400"; mock purchase.
- `PlanBody = { plan: "lite"|"month"|"year", idempotencyKey: string }`
  - Mock purchase; "lite" = free tier.

**Response:** `SpinResult` has `prizeIndex: 0..5`, `prize: int` (0..50), `prizes: [50,10,0,25,5,15]`, `balances`.

---

### Leaderboard module

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| GET | `/leaderboard/week` | device | RL_USER | — | 200 WeekLeaderboard (C) | — |

**Response:** `WeekLeaderboard = { boardDay: DayKey, rows: LeaderboardRow[] }` where `LeaderboardRow = { rank, userId, displayName, solveTimeSec, solvedAt, isMe }`.

---

### Admin module

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| POST | `/admin/content/import` | admin | — | ImportBody (≤512 KB) | 200/207 ImportReport | 403 forbidden; 413 payload_too_large |
| GET | `/admin/content/status` | admin | — | — | 200 ContentStatus | 403 forbidden |
| POST | `/admin/collections/import` | admin | — | ImportBody | 200 ImportReport | 403 forbidden |

---

### Health check

| method | path | auth | RL | request | response | errors |
|---|---|---|---|---|---|---|
| GET | `/healthz` | none | — | — | 200 `{ ok: true }` | — |

---

### DTOs

#### Identity

```ts
ConfigView = {
  keyboards: KeyboardLayout[],
  plans: { tier, priceCents?, durationDays?, adsRemoved },
  topics: string[],
  langs: Lang[],
  hints: { fifty, letter, word },  // token costs
  packs: { id, tokens, priceCents, badge? },
}

DeviceSession = {
  userId: UserId,
  token: string,  // JWT; expiresAt embedded
  expiresAt: IsoDateTime,
}

MeView (consistency S) = {
  id: UserId,
  displayName: string,  // "Player-7F3A", derived from id
  since: IsoDateTime,
  lang: Lang,
  tz: string,  // IANA zone
  level: "newbie"|"casual"|"shark",
  topics: string[≤8],
  plan: PlanView,
  notifications: "enabled"|"declined"|"skipped",
  onboardingDone: boolean,
  balances: { tokens, stars },
  streak: StreakView,
  completedIds: PuzzleId[],
  likes: PuzzleId[],
  saves: PuzzleId[],
  session: ContinueView | null,
  wheel: WheelState,
  version: int≥0,
}

PlanView = {
  tier: "lite"|"month"|"year",
  expiresAt: IsoDateTime | null,
  adsRemoved: boolean,
}

StreakView = {
  count: int≥0,  // current streak
  longest: int≥0,
  todaySolved: boolean,
  atRisk: boolean,  // lastSolvedDay was yesterday
  dayKey: DayKey,
  dayEndsAt: IsoDateTime,
  week: DayState[7],  // today + 6 previous days
}

ContinueView = {
  solveId: SolveId,
  puzzleId: PuzzleId,
  title: string,
  kind: "mini"|"crossword",
  size: 5 | 9,
  locked: int≥0,  // count of locked questions
  total: int>0,  // question count
  secLeft: int≥0,
  running: boolean,
  replay: boolean,
}

WheelState = {
  wheelId: WheelId,  // "<dayKey>:base"
  canSpin: boolean,
  lastPrize: int | null,
}

ReconcileReport = {
  repaired: ("puzzle_stats" | "collections" | "player_solves")[],
}
```

#### Feed

```ts
FeedPage (consistency P+S) = {
  lang: Lang,
  items: FeedItem[],
  nextCursor?: string,
  stories: DayState[7],  // index 0 = today
  ticker: TickerItem[],  // 3–5 items
  streakAtRisk?: {
    streak: int>0,
    dayEndsAt: IsoDateTime,
    puzzleId: PuzzleId,  // today's drop for the user's lang
    kind: "mini"|"crossword",
  },
  balances: Balances,
}

FeedItem = {
  kind: "puzzle" | "streak_save" | "wheel" | "mystery",
  ... (variant-specific fields below)
}

// Puzzle item
{
  kind: "puzzle",
  puzzleId: PuzzleId,
  title: string,
  author: Setter,
  kicker: Kicker,
  cover: CoverView,
  stats: PuzzleStatsView,
  me: PuzzleMe,  // done, bestTimeSec, inProgressSolveId, liked, saved
  meta: PuzzleMeta,
}

// Mystery item
{
  kind: "mystery",
  puzzleId: PuzzleId,  // no title/cover to keep it mysterious
}

// StreakSave item (page 1 only, if streak > 0 and today unsolved)
{
  kind: "streak_save",
  puzzleId: PuzzleId,  // today's drop
  streak: int>0,
  dayEndsAt: IsoDateTime,
}

// Wheel item (page 1 only)
{
  kind: "wheel",
  wheelId: WheelId,
  canSpin: boolean,
  lastPrize?: int,
}

DailyView = {
  dayKey: DayKey,  // user-local today
  lang: Lang,
  puzzleId: PuzzleId,
}

// Support types used in feed
Setter = {
  id: string,
  name: string,
  initial: string,  // 1–2 chars
  tone: "accent" | "ink" | "card" | "gold",
}

CoverView = {
  style: "ink" | "accent" | "card",
  tiles: { i: int≥0, ch: Letter | null, accent: boolean }[],  // 3–9 tiles; null = ?
}

Kicker = (variant of kind):
  | { kind: "daily", dropDate: DayKey }
  | { kind: "crossword", n: int>0, clueCount: int>0 }
  | { kind: "themed", collectionId: CollectionId, name: string }
  | { kind: "archive", dropDate: DayKey }
  | { kind: "mystery" }

PuzzleMeta = {
  kind: "mini" | "crossword",
  size: 5 | 9,
  parSec: 300 | 600,
  clueCount: int>0,
  publishedAt: IsoDateTime,
  dropDate: DayKey | null,  // null = in pool
}

PuzzleStatsView = {
  likeCount: int≥0,
  solvedCount: int≥0,
  solvingNow: int≥0,
}

PuzzleMe = {
  done: boolean,
  bestTimeSec: int | null,
  inProgressSolveId: SolveId | null,
  liked: boolean,
  saved: boolean,
}

TickerItem = (variant of kind):
  | { kind: "fast_solve", displayName, puzzleId, title, timeSec, agoSec }
  | { kind: "long_streak", displayName, days }
  | { kind: "solving_now", puzzleId, title, count }
  | { kind: "liked", displayName, puzzleId, title, agoSec }
  | { kind: "leaderboard_pass", displayName }
  | { kind: "archive_teaser", dropDate }

DayState = {
  dayKey: DayKey,
  state: "today" | "solved" | "missed" | "none",
}
```

#### Puzzle & Leaderboard

```ts
PuzzleView = {
  id: PuzzleId,
  lang: Lang,
  title: string,
  author: Setter,
  difficulty: "EASY" | "MEDIUM" | "TRICKY",
  meta: PuzzleMeta,
  kicker: Kicker,
  cover: CoverView,
  clue: { text: string, ref: { num: int>0, dir: "ACROSS"|"DOWN", clueCount: int>0 } },
  stats: PuzzleStatsView,
  me: PuzzleMe,
  tokensPerFiveSec: 1,
}

PuzzleLeaderboard (consistency P) = {
  puzzleId: PuzzleId,
  boardDay: DayKey,  // the puzzle's drop_date
  rows: LeaderboardRow[],
  me?: LeaderboardRow,
}

LeaderboardRow = {
  rank: int>0,
  userId: UserId,
  displayName: string,
  solveTimeSec: int>0,
  solvedAt: IsoDateTime,
  isMe: boolean,
}

WeekLeaderboard (consistency C) = {
  boardDay: DayKey,  // ISO week start
  rows: LeaderboardRow[],
}

NextView = {
  nextPuzzleId: PuzzleId | null,
}

SolutionView = {  // GET /puzzles/:id/solution; 403 if not completed
  puzzleId: PuzzleId,
  grid: string[],  // row format: '#' block, '.' empty, else letter
  questions: {
    index: int≥0,
    dir: "ACROSS" | "DOWN",
    num: int>0,
    clue: string,
    answer: string,
    cells: [int, int][],  // [r, c] coordinates
  }[],
  completion: {
    solvedAt: IsoDateTime,
    timeMs: int≥0,
    hintsUsed: int≥0,
    tokens: int≥0,
    stars: int≥0,
    boardEligible: boolean,
    boardStatus: "ranked" | "unranked" | "attestation_required",
  },
}

ProfileView (consistency P) = {
  solvedTotal: int≥0,
  bestTimeSec: int | null,
  weekSolves: int≥0,
  achievements: { done: int≥0, total: int≥0 },
  completed: {
    puzzleId,
    title,
    themeInitial: Letter,
    solvedAt,
  }[≤12],
  langs: { lang, solved: int≥0 }[],
}

SavedView (consistency S) = {
  puzzleIds: PuzzleId[],
}
```

#### Solving

```ts
SolveView = {
  solveId: SolveId,
  puzzleId: PuzzleId,
  size: 5 | 9,
  parSec: 300 | 600,
  grid: string[],  // hint grid layout
  questions: {
    index: int≥0,
    dir: "ACROSS" | "DOWN",
    num: int>0,
    clue: string,
    length: int>0,
    cells: [int, int][],  // [r, c] coordinates
  }[],
  locked: int[],  // sorted question indexes
  letters: Letter[],  // cells of locked words only (server-derived)
  secLeft: int≥0,
  running: boolean,
  hintsUsed: int≥0,
  noHintBonusAlive: boolean,
  autocheck: boolean,
  balances: Balances,
  status: "running" | "paused" | "finished",
  replay: boolean,
  result?: SolveResult,  // only if status === "finished"
}

WordsResult = {
  correct: boolean,
  locked: int[],  // updated locked set
  newlyLocked: int[],  // typed + swept in this call
  letters: Letter[],  // fixed cells only for newly locked
  nextQuestionIndex?: int,  // advance hint
  complete: boolean,  // all questions now locked
  finished?: boolean,  // === complete and inline finish happened
  result?: SolveResult,  // present if finished
}

FiftyResult = {
  options: [string, string],  // two answer options
  balances: Balances,
}

LetterResult = {
  cell?: [int, int],  // [r, c] of revealed letter
  letter?: Letter,
  noop?: boolean,  // already correct, no charge
  balances?: Balances,
}

WordHintResult = WordsResult  // same as /words with correct: true

CheckResult = {
  wrongCells: [int, int][],  // [r, c] coordinates, restricted to this question
}

TimerView = {
  secLeft: int≥0,
  running: boolean,
}

SolveResult = {
  solveTimeSec: int≥0,
  secLeft: int≥0,
  underPar: boolean,
  tokensEarned: int≥0,
  starsEarned: int≥0,
  noHintBonus: boolean,
  firstSolve: boolean,
  balances: Balances,
  streak: {
    count: int≥0,
    extendedToday: boolean,
    week: DayState[7],
  },
  claimedCollections: CollectionId[],
  nextPuzzleId: PuzzleId | null,
  celebration: "confetti" | "cake" | "star",  // deterministic from solveId hash
  boardStatus: "ranked" | "unranked" | "attestation_required",
}

ProgressBody = {
  locked: int[],
  autocheck?: boolean,
}
```

#### Collections

```ts
CollectionsView (consistency P) = {
  shelves: {
    key: "theme" | "size" | "setter" | "archive",
    countLabel: { count: int, unit: "collections" | "setters" | "months" },
    items: CollectionCard[],
  }[],
}

CollectionCard = {
  id: CollectionId,
  name: string,
  emoji: string,
  blurb: string,
  total: int>0,
  done: int≥0,
  pct: int 0..100,
  locked: boolean,
  lock?: LockRule,
  reward: int,
  claimed: boolean,
}

LockRule = {
  kind: "collection_complete",
  collectionId: CollectionId,
  name: string,
}

CollectionDetail (consistency P) = {
  ... CollectionCard fields ...,
  members: {
    n: int>0,
    puzzleId: PuzzleId,
    title: string,
    meta: PuzzleMeta,
    difficulty: "EASY" | "MEDIUM" | "TRICKY",
    done: boolean,
  }[],
}

ClaimResult = {
  claimed: boolean,
  reward: int,
  balances: Balances,
}
```

#### Economy

```ts
WalletView (consistency S) = {
  balances: Balances,
  packs: {
    id: string,  // "p120", "p550", "p1400"
    tokens: int>0,
    priceCents: int>0,
    badge?: "popular" | "best_value",
  }[],
  hintCosts: { fifty: 20, letter: 40, word: 100 },
  ledger: {
    at: IsoDateTime,
    delta: int,  // +/- tokens
    kind: "hint" | "puzzle" | "collection" | "wheel" | "purchase",
    reason: string,
    ref?: PuzzleId | CollectionId | WheelId,
  }[],
}

PurchaseResult = {
  balances: Balances,
  ledgerEntry: { at, delta, kind, reason },
}

WheelView (consistency S) = {
  wheels: {
    wheelId: WheelId,
    canSpin: boolean,
    lastPrize?: int,
  }[],
}

SpinResult = {
  prizeIndex: 0..5,
  prize: int,  // 0, 5, 10, 15, 25, or 50
  prizes: [50, 10, 0, 25, 5, 15],  // prize table
  balances: Balances,
}
```

#### Admin

```ts
ImportReport = {
  imported: int,
  unchanged: int,
  rejected: { id: PuzzleId, issues: string[] }[],
}

ContentStatus = {
  poolDepth: { en: int, uk: int, ru: int },
  nextDrops: { day: DayKey, lang: Lang }[],
  byStatus: { draft: int, filled: int, clued: int, reviewed: int, published: int },
  lastEnsureDropsAt: IsoDateTime,
}
```

#### Support types

```ts
Balances = { tokens: int≥0, stars: int≥0 }

Cursor = string  // opaque base64url(JSON)

DayKey = string  // "YYYY-MM-DD"

IdempotencyKey = string  // 8–64 chars, client-supplied

IsoDateTime = string  // "2026-09-02T10:00:00Z" (UTC, seconds required)

KeyboardLayout = {
  lang: Lang,
  rows: string[][],  // 3 rows of letter keys, each element is 1–2 chars
  letterCount: int,
  special: {
    hint: string,  // "row3-start"
    backspace: string,  // "row3-end"
  },
}

Lang = "en" | "uk" | "ru"

Letter = string  // one normalised letter (post-fold)

PuzzleId = string  // "en-mini-0001", "uk-cross-0042", regex "^(en|uk|ru)-(mini|cross)-\d{4}$"

UserId = string  // "u_…26-char-base32", strongly typed

SolveId = string  // "s_…26-char-base32~puzzle-id", strongly typed

CollectionId = string  // lowercase slug

WheelId = string  // "<dayKey>:base"

RequestId = string  // correlation id for debugging
```

---

### Error code catalog

All 2xx responses use the standard envelope. Non-2xx responses carry the error object.

| HTTP | code | meaning | details | client action |
|---|---|---|---|---|
| 400 | `invalid_request` | Zod validation of body/query/param/header failed | `{ target, issues: z.treeifyError(...) }` | developer: check logs; do not retry |
| 400 | `invalid_cursor` | Cursor undecodable, version mismatch, lang mismatch, or page > 10 | `{ reason }` | restart feed from page 1 |
| 400 | `bad_json` | Body not JSON or wrong content-type | — | bug |
| 401 | `unauthenticated` | No bearer token, invalid signature, or `typ ≠ "device"` | — | re-bootstrap via `POST /devices` |
| 401 | `token_expired` | Token `exp` timestamp passed | `{ refreshable: boolean }` | `POST /session/refresh` if refreshable (≤30d), else re-bootstrap |
| 401 | `token_key_unknown` | `kid` not in active keyring | — | re-bootstrap |
| 401 | `token_revoked` | `tokenVersion` flag advanced since token issued | — | re-bootstrap |
| 402 | `insufficient_tokens` | Hint or spend costs more tokens than wallet | `{ balance, cost, kind: "fifty"|"letter"|"word" }` | close sheet, route to Wallet |
| 403 | `forbidden` | Admin token wrong/missing, or solve belongs to another user, or review before completion | — | none |
| 403 | `not_completed` | Review route called before puzzle marked complete | — | complete the puzzle first |
| 403 | `autocheck_off` | `/check` called while autocheck toggle is off | — | turn on autocheck via `/solves/:id/autocheck { on: true }` |
| 403 | `bad_ticket` | Autocheck ticket expired or invalid | — | re-request ticket via autocheck endpoint |
| 404 | `not_found` | No matching route | — | bug |
| 404 | `puzzle_not_found` | Puzzle ID not in catalog | `{ id }` | refresh puzzle list |
| 404 | `solve_not_found` | Solve session unknown | `{ puzzleId }` | start new solve or get `/me` |
| 404 | `solve_gone` | Solve session was replaced by `startSolve` | `{ puzzleId }` | call `/puzzles/:id/solution` to review |
| 404 | `collection_not_found` | Collection ID not found | `{ id }` | refresh collections |
| 404 | `wheel_not_found` | Wheel ID not in today's set | `{ id }` | refresh wallet |
| 404 | `user_not_found` | User aggregate not initialized (NotInitializedError from DO) | — | bootstrap |
| 404 | `no_drop` | No drop for the requested `(dayKey, lang)` | — | refresh |
| 409 | `no_active_session` | `solveId` is neither active nor `lastResult.solveId` | `{ activeSolveId: string \| null }` | get `/me` and resume, or start new solve |
| 409 | `already_spun` | Wheel for that `wheelId` already spun on `wheelId`'s day | `{ wheel: WheelState }` | show result |
| 409 | `already_claimed` | Collection reward already credited to user | `{ collectionId }` | refresh collection |
| 409 | `already_paused` | Session already paused; `/pause` called again | — | no-op |
| 409 | `not_paused` | Session not paused; `/resume` called without `/pause` | — | no-op |
| 409 | `paused` | Command not allowed while session is paused (e.g. `/words` on a paused session) | — | resume first via `POST /resume` |
| 409 | `NOT_FINISHED` | `/finish` called but questions remain unsolved | — | keep solving |
| 409 | `purchase_conflict` | `idempotencyKey` reused with different `packId`/`plan` payload | `{ idempotencyKey }` | use a new idempotency key |
| 409 | `tz_change_limit` | Second timezone change in the same user-local day | `{ nextAllowedAt }` | keep old timezone |
| 409 | `merged` | User aggregate merged into another account (v2 feature) | `{ mergedInto, token }` | swap device token and retry |
| 413 | `payload_too_large` | Body exceeds size limit (64 KB general; 512 KB admin import) | — | bug |
| 422 | `bad_question` | `questionIndex` out of range or not in current session | `{ questionIndex }` | bug |
| 422 | `bad_word` | Word length ≠ slot length, or contains letters outside alphabet | `{ questionIndex }` | bug |
| 422 | `question_locked` | Hint requested for already-locked question | `{ questionIndex }` | no-op; move to next question |
| 422 | `guess_budget` | Wrong-guess budget exhausted (20 per question, 100 per solve) | `{ questionIndex, perQuestion, perSolve }` | use a hint or wait for crossing locks |
| 422 | `check_budget` | Autocheck ticket budget exhausted (≤6 per solve) | — | "Autocheck takes a break on your next puzzle" |
| 422 | `bad_tz` | IANA timezone rejected by `Intl.DateTimeFormat` | `{ tz }` | fall back to device/stored zone |
| 422 | `wrong_grid` | Submitted grid does not match solution | `{ wrongCells: [r,c][] }` (omitted if >10) | keep solving |
| 422 | `collection_incomplete` | Not all collection members completed | `{ done, total }` | finish members first |
| 422 | `collection_locked` | Unlock rule not met | `{ lock: LockRule }` | complete the prerequisite |
| 422 | `solve_finished` | Command (e.g. `/words`, `/hint`) on a finished session | — | get `/me` |
| 422 | `invalid_puzzle` | Admin validator rejected puzzle content | `{ rejected: [{ id, issues }] }` | fix content and reimport |
| 429 | `rate_limited` | Request rate limit exceeded (`RL_BOOT`, `RL_USER`, `RL_SPEND`, `RL_CHECK`) | `{ retryAfterSec, scope }` | back off; `Retry-After` header present |
| 500 | `internal` | Unexpected error | — | show generic error with `requestId` for support |
| 503 | `retry_later` | Transient error (D1/DO unavailable, worker CPU limit) marked `.retryable` | `{ retryAfterSec }` | retry with backoff; `Retry-After` header present |

---

****
- **Consistency markers (S/P/C)** added to DTO documentation per glossary rule.
- **Error envelope shape** with `issues: z.treeifyError(err)` on nested bodies (replaces README's single-level `flattenError`).
- **Cursor format** and pagination semantics from `gap-feed-composition-semantics.md` R3.
- **FeedItem discriminated union** replaces README's mixed array (puzzle + string tickers).
- **TickerItem, Kicker, PuzzleMeta, LockRule, DayState** as structured items with `kind`, never prose strings.
- **SolveView.letters** contains only newly-locked word cells (not all locked words).
- **WordsResult** includes `finished` flag and inline `result` when all questions lock.
- **Leaderboard boardDay** explicitly returned (puzzle's `drop_date`, not user's local day).
- **Review mode**: `GET /puzzles/:id/solution` (403 if not completed) replaces README's "Review returns grid via `/solves/:id`".
- **Mystery selection**: deterministic SHA-256 hash per user-day, no separate endpoint.
- **NextView.nextPuzzleId** returns today's drop (if uncompleted and ≠ current id) else newest uncompleted.
- **CheckResult** restricted to question's cells (not whole grid).
- **RL_CHECK** new rate limit (30/60s per solveId) for autocheck tickets.
- **CheckBody.ticket** HMAC-signed autocheck credential (10-minute TTL, max 6/solve).
- **WordsBody** server-owned locked set; client sends only questionIndex and word.
- **SolutionView** as new DTO for `/puzzles/:id/solution` (grid letters + answers, 403 if not completed).
- **Errors 409 vs 422**: 409 for state conflicts (`already_spun`, `paused`, `guess_budget`, etc.); 422 for domain rule violations.

---

**Endpoint count: 45** (all from glossary section 5, endpoint 32 "attest" listed as v2-not-implemented).

**Line count: 372** (DTOs + tables + error catalog + conventions).

## 7. Folder layout

### File tree

```
workers/gateway/
  wrangler.jsonc                                    [config; name "crosscut"; main "src/app/index.ts"; exports for User, PuzzleStats DOs]
  worker-configuration.d.ts                         [generated by wrangler types; committed]
  vitest.config.ts                                  [test runner config; cloudflareTest plugin]
  tsconfig.json                                     [TS 7.0.2; target ES2022, module ESNext, strict, types: ["./worker-configuration.d.ts", "@cloudflare/vitest-plugin/types"]]
  .gitignore                                        [.wrangler/, .dev.vars*]
  
  migrations/
    0001_content.sql                                [content_* table schemas]
    0002_player.sql                                 [player_* table schemas]
    0003_social.sql                                 [social_*, leaderboard_* table schemas]
    0004_economy.sql                                [economy_* table schemas]
    0005_notifications.sql                          [notifications_* table schemas]
  
  seed/
    0001_content.sql                                [four prototype puzzles + collections; INSERT OR IGNORE per row]
  
  test/
    setup.ts                                        [onUnhandledError filter for workerd noise]
    env.d.ts                                        [TEST_MIGRATIONS: D1Migration[] type augment]
    arch.test.ts                                    [architecture test: import boundaries + SQL table prefixes]
    http/
      bootstrap.test.ts                             [POST /devices → /me round trip]
      feed.test.ts                                  [GET /feed pagination; no cursor duplicates]
      solving.test.ts                               [full solve 5×5 replay earns 0 tokens]
      identity.test.ts                              [unknown kid 401; token refresh; RL_BOOT]
      social.test.ts                                [like/save; leaderboard serialisation]
      collections.test.ts                           [claim reward once; unlock dependants]
  
  src/
    app/
      index.ts                                      [exports: default { fetch, scheduled }; exports DO classes]
      app.ts                                        [Hono root; middleware stack; module route mounting]
      wiring.ts                                     [HandlerTable: static event subscription mapping]
      modules.ts                                    [createModules, resolveModules: composition seam]
    
    shared/
      index.ts                                      [export * from below]
      context.ts                                    [RequestContext type extraction]
      errors.ts                                     [DomainError, NotInitializedError, MergedError re-exported from @app/core]
      ids.ts                                        [userId, solveId generation; Crockford base32]
      time.ts                                       [dayKey(ms, tz), prevDay, applyStreak]
      normalise.ts                                  [normalizeWord(lang, s) with per-lang alphabets]
    
    events/
      index.ts                                      [export * from below]
      envelope.ts                                   [Envelope type: id, type, v, occurredAt, actor, payload]
      registry.ts                                   [defineEvent, DomainEvent discriminatedUnion]
      dispatch.ts                                   [dispatch(handlers, events[], ctx) with depth/seen guards]
    
    modules/
      content/
        index.ts                                    [withSecret, collectionsContaining, ensureDrops, import*, getStatus]
        contract.ts                                 [DTO + event payload Zod schemas]
        http.ts                                     [GET /puzzles/:id, /daily, /collections, /admin/content/*]
        subscriptions.ts                            [empty; content is read-only]
        internal/
          db.ts                                     [D1 queries for content_* tables]
          cache.ts                                  [isolate cache for withSecret, collectionsContaining]
          drop-cron.ts                              [ensureDrops cron; content_daily_drops maintenance]
          validator.ts                              [Zod + structural checks; splitPuzzle()]
        test/
          validator.test.ts                         [validator fixtures; seeding; drop idempotency]
      
      player/
        index.ts                                    [init, setPreferences, startSolve, finishSolve, etc.]
        contract.ts                                 [Zod schemas for player commands/queries]
        http.ts                                     [GET /me, /me/profile, POST /me/onboarding, PATCH /me/prefs, DELETE /me, POST /me/reconcile]
        subscriptions.ts                            [empty; player is write model]
        internal/
          user.do.ts                                [User Durable Object; UserState shape; all commands]
          db.ts                                     [versionedUpsert for player_state + player_solves]
          projection.ts                             [Projections.apply override for kind === "user"]
        test/
          user.test.ts                              [finish → tokens/stars; streak; wheel; session recovery]
      
      identity/
        index.ts                                    [mint, verify, refresh, bootstrap, getMe, deleteMe]
        contract.ts                                 [DeviceSession, MeView, OnboardingBody, PrefsPatch schemas]
        http.ts                                     [POST /devices, /session/refresh, GET /me, DELETE /me, onboarding, prefs]
        subscriptions.ts                            [empty]
        internal/
          jwt.ts                                    [HS256 sign/verify; kid rotation]
          middleware.ts                             [deviceAuth middleware; RL_BOOT, RL_USER]
          bootstrap.ts                              [User.init; registerInstall]
        test/
          identity.test.ts                          [bootstrap → 365d token; unknown kid 401; refresh ≤30d expired]
      
      solving/
        index.ts                                    [start, submitWord, spendForHint, pauseSolve, resumeSolve, finishSolve]
        contract.ts                                 [SolveView, WordsBody, HintBody, FinishBody, SolveResult schemas]
        http.ts                                     [POST /puzzles/:id/solves, GET /solves/:id, /words, /hints/*, /autocheck, /pause, /resume, /finish, /check]
        subscriptions.ts                            [empty; solving is command handler]
        internal/
          logic.ts                                  [sweep(), questions(), timeBonus(), starsFor(); replay detection]
          anti-cheat.ts                             [S1–S4 flags: plausibility, typing floor, too-clean, check-heavy]
          autocheck-ticket.ts                       [HMAC-SHA256 ticket; 10m TTL; 6 per solve]
        test/
          solving.test.ts                           [full solve earns floor(secLeft/5) tokens; replay earns 0]
      
      economy/
        index.ts                                    [getWallet, purchasePack, setPlan, spinWheel]
        contract.ts                                 [WalletView, PurchaseBody, WheelView schemas]
        http.ts                                     [GET /wallet, /wheel, POST /wallet/purchases, /billing/plan, /wheel/:wheelId/spin]
        subscriptions.ts                            [empty; economy has no subscribers]
        internal/
          db.ts                                     [INSERT economy_purchases with idempotency key]
        test/
          economy.test.ts                           [pack/plan purchase idempotent; wheel once/day]
      
      social/
        index.ts                                    [toggleLike, toggleSave, recordSolve, heartbeat]
        contract.ts                                 [LikeResult, SaveResult, PresenceResult schemas]
        http.ts                                     [POST /puzzles/:id/like, /save, /presence]
        subscriptions.ts                            [onSolveFinished → recordSolve; onLikeToggled → adjustLikes]
        internal/
          puzzle-stats.do.ts                        [PuzzleStats Durable Object; heartbeat buffering]
          db.ts                                     [recordSolve upsert; topToday keyed by drop_date]
        test/
          social.test.ts                            [100 heartbeats ≤2 commits; topToday resets daily]
      
      collections/
        index.ts                                    [getCollections, getDetail, checkAndClaim, unlockDependants]
        contract.ts                                 [CollectionsView, CollectionDetail, ClaimResult schemas]
        http.ts                                     [GET /collections, /collections/:id, POST /collections/:id/claim]
        subscriptions.ts                            [onSolveFinished → checkAndClaim (critical); onCompleted → unlockDependants (critical)]
        internal/
          db.ts                                     [join content + player_solves; player.claimCollection call]
        test/
          collections.test.ts                       [completing all members grants reward once; unlockDependants emits]
      
      leaderboard/
        index.ts                                    [materialiseWeek, getWeekLeaderboard, getPuzzleLeaderboard]
        contract.ts                                 [LeaderboardRow, PuzzleLeaderboard, WeekLeaderboard schemas]
        http.ts                                     [GET /puzzles/:id/leaderboard, /leaderboard/week]
        subscriptions.ts                            [empty; cron-materialised]
        internal/
          db.ts                                     [materialise leaderboard_week from player_solves (exclude suspicious)]
          cron.ts                                   [*/5 cron handler]
        test/
          leaderboard.test.ts                       [cron re-run idempotent; excludes suspicious]
      
      feed/
        index.ts                                    [getPage, getDaily]
        contract.ts                                 [FeedQuery, FeedPage, FeedItem, DailyView schemas]
        http.ts                                     [GET /feed, /daily]
        subscriptions.ts                            [empty; feed is read composer]
        internal/
          db.ts                                     [JOIN content_daily_drops ⋈ content_puzzles ⋈ social_puzzle_stats ⋈ player_solves; cursor pagination]
          interleave.ts                             [gateway inserts streak_save, wheel/mystery at positions 1, 3, 6n]
        test/
          feed.test.ts                              [no cursor duplicates; first page caches per (lang, today)]
      
      notifications/
        index.ts                                    [scheduleReminderOptIn, cancelReminder, sendReminders]
        contract.ts                                 [reminder notification schemas]
        http.ts                                     [empty in v1]
        subscriptions.ts                            [onOnboarded → scheduleReminderOptIn; onSolveFinished → cancelReminder (background)]
        internal/
          db.ts                                     [notifications_reminders_sent dedupe table]
          cron.ts                                   [0 * * * * reminder cron]
        test/
          notifications.test.ts                     [reminders sent once per (user, day)]

packages/core/src/
  index.ts                                          [export Aggregate, Projections, aggregateStub, DomainError from @app/core]
  aggregate.ts                                      [Aggregate<State, Env>; commit(), snapshot(), projectionFingerprint()]
  projections.ts                                    [ProjectionsBase; Projections entrypoint; apply() override for kind === "user"]
  errors.ts                                         [RPC-safe DomainError, NotInitializedError, MergedError]
  stub.ts                                           [aggregateStub(env.NS, kind, id)]

packages/shared/src/
  index.ts                                          [export * from below]
  constants.ts                                      [PAR_MINI, PAR_CROSS, HINT_COST, WHEEL_PRIZES, TOKEN_PACKS, PLANS, TOPICS, alphabets, MAX_DEPTH]
  wire/
    primitives.ts                                   [Lang, DayKey, Tokens, Balances, Difficulty, etc.]
    ids.ts                                          [PuzzleId, UserId, SolveId, etc. Crockford base32 regex]
    errors.ts                                       [ErrorCode, ErrorEnvelope, DOMAIN_STATUS mapping]
    i18n.ts                                         [DayState, Kicker, PuzzleMeta, ClueRef, LockRule]
    identity.ts                                     [DeviceBody, DeviceSession]
    me.ts                                           [StreakView, MeView, ProfileView, SavedView, ReconcileReport]
    feed.ts                                         [FeedQuery, FeedItem, FeedPage, DailyView]
    puzzle.ts                                       [PuzzleView, PuzzleStatsView, PuzzleLeaderboard]
    solve.ts                                        [SolveView, SolveSession, WordsBody, HintBody, FinishBody, SolveResult]
    economy.ts                                      [WalletView, PurchaseBody, WheelView]
    collections.ts                                 [CollectionCard, CollectionsView, CollectionDetail]
    social.ts                                       [LikeResult, SaveResult, PresenceResult]
    config.ts                                       [KeyboardLayout, ConfigView]
    admin.ts                                        [ImportBody, ImportReport, ContentStatus]
  puzzle/
    validator.ts                                    [Zod + structural validator; splitPuzzle()]
    normalise.ts                                    [normalizeWord(lang, s) per-lang alphabet]
  events/
    envelope.ts                                     [Envelope schema; re-exported by modules]
    identity-events.ts                              [identity.userBootstrapped event schema]
    player-events.ts                                [player.onboarded, player.prefsChanged]
    solve-events.ts                                 [solve.started, .paused, .resumed, .hintUsed, .finished]
    [etc-events].ts                                 [collections, economy, social event schemas]

content/
  puzzles/
    en/
      en-mini-0001.json                             [prototype: 5×5 word-square with schemaVersion, solution, answers, decoys]
      en-mini-0002.json                             [prototype: 5×5 standard]
      en-cross-0001.json                            [prototype: 9×9]
    uk/
      uk-mini-0001.json                             [UK prototype]
    ru/
      ru-mini-0001.json                             [RU prototype]
  
  collections.json                                  [manifest: shelves, unlock rules, rewards; themes/sizes/setters/archive]
  
  wordbank/
    en.txt                                          [WORD;score;topics; EN seeded from MIT Collaborative Word List ≥50]
    uk.txt                                          [UK word list (LLM-drafted + native review)]
    ru.txt                                          [RU word list (LLM-drafted + native review)]
  
  scripts/
    gen-crossword.mjs                               [CSP filler: pattern → slots → MRV + forward checking]
    draft-clues.mjs                                 [Claude Batches: messages.parse for clue generation]
    validate-and-seed.mjs                           [content validator; seed SQL generator]

docs/
  design/
    glossary.md                                     [canonical registry: modules, DOs, tables, events, endpoints, errors, file count]
    section-07.md                                   [folder layout (this section)]
    [section-01-06.md]                              [sections 1–6 of ARCHITECTURE.md]
  
  research/
    README.md                                       [consolidated research: stack decisions, architecture, API surface]
    [gap-*.md, domain-spec-*.md, etc.]              [research topic documents]

Root config files:
  pnpm-workspace.yaml                               [workspace; allowBuilds: { esbuild: true, workerd: true }; catalog; minimumReleaseAge: 0]
  package.json                                      [root workspace; devDependencies: turbo, typescript, @biomejs/biome]
  turbo.json                                        [tasks: types, typecheck, lint, test, dev; outputs; cache]
  tsconfig.json                                     [extends: strict, noEmit, isolatedModules, composite; references to packages/*, workers/gateway]
  biome.json                                        [noRestrictedImports rules (see §c below)]
  .gitignore                                        [.wrangler/, .dev.vars*, node_modules, dist, coverage]
```

### Import rules

1. **Module boundary:** `@modules/<name>` specifier targets only `workers/gateway/src/modules/<name>/index.ts`; deep imports (`@modules/<name>/internal`, `@modules/<name>/service`) are forbidden.

2. **Inside a module:** only `./relative` imports within `src/modules/<name>/`; cross-module calls use `@modules/*` or (for shared kernel) `@platform/*` / `@core`.

3. **Shared & events imports:** `src/shared/` and `src/events/` import nothing from `src/modules/`; they are the kernel and are imported by all.

4. **App imports:** `src/app/` (composition root) imports everything; nothing in `src/modules/` imports `src/app/`.

5. **HTTP framework:** `hono` (and its sub-imports) appear only in `**/http.ts` files, never in `service.ts`, `aggregate.ts`, or `events.ts`.

6. **Package imports:** `packages/shared` and `packages/core` imported by package name (`@app/shared`, `@app/core`), not by path.

7. **Relative within module:** `modules/*` and `packages/*` use `./` for internal navigation, never `../`.

8. **SQL table ownership:** each table name is prefixed with its owning module (`content_puzzles`, `player_state`, `social_puzzle_stats`, etc.); module may read via queries only if the owning module exports a public function, not a raw D1 query.

### Enforcement

**Biome `noRestrictedImports` (TS-7-proof):**

```json
{
  "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": {
    "patterns": [
      { "group": ["@modules/*/**"], "message": "Import a module only through @modules/<name> (its index.ts)." }
    ]
  } } } } },
  "overrides": [
    { "includes": ["src/modules/**"], "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": {
        "patterns": [
          { "group": ["../**"], "message": "No parent-relative imports inside a module; use @modules/<name>, @platform/*, @core." },
          { "group": ["@modules/*/**"], "message": "Deep import into another module." }
        ]
      } } } } } },
    { "includes": ["src/modules/**/service.ts", "src/modules/**/aggregate.ts", "src/modules/**/events.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": {
        "patterns": [
          { "group": ["../**"], "message": "No parent-relative imports inside a module." },
          { "group": ["@modules/*/**"], "message": "Deep import into another module." }
        ],
        "paths": { "hono": "Framework code belongs in http.ts only." }
      } } } } } }
  ]
}
```

**Vitest architecture test** (`workers/gateway/test/arch.test.ts` sketch):

```typescript
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

describe("architecture", () => {
  it("modules do not import each other's internals", () => {
    const modulePaths = fs.readdirSync("./src/modules").filter(m => fs.statSync(`./src/modules/${m}`).isDirectory());
    for (const mod of modulePaths) {
      const srcFiles = fs.readdirSync(`./src/modules/${mod}`, { recursive: true }).filter((f: string) => typeof f === "string" && f.endsWith(".ts") && !f.includes("test"));
      for (const file of srcFiles) {
        const content = fs.readFileSync(`./src/modules/${mod}/${file}`, "utf-8");
        const imports = content.match(/@modules\/([^/]+)\/(\S+)/g) || [];
        for (const imp of imports) {
          const [, otherMod, target] = imp.match(/@modules\/([^/]+)\/(\S+)/) || [];
          if (otherMod !== mod && target !== "index.ts") {
            throw new Error(`${mod}/${file} imports ${imp}; only @modules/${otherMod}/index.ts allowed`);
          }
        }
      }
    }
  });

  it("D1 tables are owned by single module", () => {
    const sqlFiles = fs.readdirSync("./migrations").filter(f => f.endsWith(".sql"));
    const tableOwners = new Map<string, string>();
    for (const file of sqlFiles) {
      const content = fs.readFileSync(`./migrations/${file}`, "utf-8");
      const creates = content.match(/CREATE TABLE (\w+)/g) || [];
      for (const create of creates) {
        const [, tableName] = create.match(/CREATE TABLE (\w+)/) || [];
        const [owner] = tableName.split("_");
        if (tableOwners.has(tableName) && tableOwners.get(tableName) !== owner) {
          throw new Error(`Table ${tableName} owned by multiple modules`);
        }
        tableOwners.set(tableName, owner);
      }
    }
  });
});
```

### Package boundaries

**`packages/core/package.json` exports:**

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./types": "./src/index.ts"
  }
}
```

**`packages/shared/package.json` exports:**

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./constants": "./src/constants.ts",
    "./puzzle": "./src/puzzle/index.ts",
    "./wire": "./src/wire/index.ts",
    "./events": "./src/events/index.ts"
  }
}
```

**pnpm `catalog` entries** (`pnpm-workspace.yaml`):

```yaml
catalog:
  zod: "4.5.4"
  hono: "4.13.5"
  typescript: "7.0.2"
  "@hono/zod-validator": "0.9.1"
  "@cloudflare/vitest-plugin": "1.1.3"
  vitest: "4.1.11"
  "@vitest/coverage-istanbul": "4.1.11"
  "@biomejs/biome": "2.5.11"
  wrangler: "4.128.0"
  turbo: "2.10.12"
```

---

**Summary:**
- **Line count:** ~340 (tree ~180, import rules ~30, enforcement ~80, package boundaries ~50)
- **Files in tree:** 123 total (excluding package/node_modules)
- **Names not in glossary:** none; all files listed in glossary section 7 appear here
- **:** Vitest arch test sketch (architecture enforcement, replacing dependency-cruiser until TS 7.1); Biome override merge semantics (documented, preventing silent boundary loss)

## 8. Testing strategy

Every module ships vitest tests inside workerd via `@cloudflare/vitest-plugin` 1.1.3 + `vitest` 4.1.11. Tests run in four tiers (pure rules → aggregates → modules/events → HTTP end-to-end) with per-file isolation (unique ids per test, no cross-file state). Time is injected explicitly into every command (no fake-timer dependence for DO logic). Each tier uses `cloudflare:workers` and `cloudflare:test` (never deprecated `cloudflare:test` imports of `env`/`SELF`).

### Tiers table

| tier | location | tooling | what it proves |
|---|---|---|---|
| **rules** | `packages/shared/src/*/rules.ts`, invoked from modules | plain functions, `describe/it`, no bindings | streak math, reward formulas, token/star rates, hint costs, wheel prizes, plan copy (pure + deterministic + offline) |
| **aggregates** | `workers/gateway/src/modules/*/test/*.aggregate.test.ts` | `aggregateStub(env.USER/PUZZLE_STATS, kind, id)` + `runDurableObjectAlarm`, `evictDurableObject`, `applyD1Migrations` | User/PuzzleStats commands with idempotency (same call twice = no-op commit), projection row correctness, alarm recovery on failed flush, per-aggregate state invariants |
| **modules+events** | `workers/gateway/src/modules/*/test/*.test.ts` | real `env`, `createExecutionContext`/`waitOnExecutionContext`, call handlers directly | command side effects (wallet debit, streak update, collection claim), event dispatch (subscribers run, correct payloads), critical handler ordering, background handler best-effort, per-handler error isolation, per-request recursion guard |
| **HTTP e2e** | `workers/gateway/test/http/*.test.ts` | `exports.default.fetch(url, init)` full middleware stack, `app.request(path, init, env)` validation-only | auth (device token, `kid` rotation, RL limits), Zod schemas (request body, response shape), error envelope, status codes, rate limiting, session lifecycle, idempotent endpoints |

### Config and setup files

**`workers/gateway/vitest.config.ts`** (: upgrade to `@cloudflare/vitest-plugin` 1.1.3):

```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")) },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    coverage: { provider: "istanbul", include: ["src/**"] },
    onUnhandledError(error) {
      const e = error as { stack?: string; remote?: boolean } | undefined;
      const viaPoolRpcWrapper = String(e?.stack ?? "").includes("vitest-plugin/dist/worker");
      if (viaPoolRpcWrapper && e?.remote !== true) return false; // RPC duplicate, ignore
    },
  },
}));
```

**`test/setup.ts`** (runs outside per-file isolation; idempotent):

```ts
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
// Seed four prototype puzzles (en-mini-0001/0002, en-cross-0001, ru-mini-0001) + collections
await env.DB.batch([
  env.DB.prepare("INSERT OR IGNORE INTO content_puzzles (id, lang, kind, size, shape, ...) VALUES (?, ?, ?, ?, ?, ...)"),
  // … per puzzle + collection inserts
]);
```

**`test/env.d.ts`** (test-only type augmentation):

```ts
declare namespace Cloudflare {
  interface Env { TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] }
}
```

### Required test cases per module

**`shared`** (no tests — pure functions tested where consumed in higher tiers)

**`events`** (filename: `envelope.test.ts`)
- `Envelope fields` — type, v, occurredAt ISO, actor (kind + userId), correlationId UUID, causationId, aggregate (kind, id, version), payload structure
- `DomainEvent discriminated union parses by type` — three events, `z.safeParse`, invalid type → dropped + logged
- `dispatch({ id, type } memo dedup)` — same event twice → second call no-op; MAX_DEPTH guard (depth ≥ 4 + 1 → dropped); MAX_EVENTS_PER_REQUEST guard (65th event → dropped)
- `critical handlers run in order and await` — three handlers register sequence ABCD, each calls `Date.now()` (proves await); one handler throws, continues to next; `DispatchReport` lists outcomes
- `background handlers run under waitUntil` — handler scheduled via `ctx.exec.waitUntil`; `waitOnExecutionContext` proves completion

**`content`** (files: `puzzles.test.ts`, `drops.test.ts`, `collections.test.ts`, `validator.test.ts`)
- `withSecret caches puzzle secrets, never selected by feed/puzzle routes`
- `collectionsContaining(puzzleId) returns shelves, filters by membership`
- `ensureDrops fills (day, lang) pairs for next 3 UTC days, INSERT OR IGNORE, re-run idempotent`
- `importPuzzles validates grid/sol/answers via Zod + structural checks, rejects duplicate answers except word-square`
- `importCollections with unlock rules (collection/puzzle complete prerequisites)`
- `validator normalizeWord per-lang (uk: no Ё Ъ Ы Э; ru: Ё→Е), clue-answer detection, min word length 3`

**`player`** (files: `user.aggregate.test.ts`, `commands.test.ts`, `projection.test.ts`)
- `User.init(userId) sets initial state, tz default "UTC", plan.tier "lite"`
- `finishSolve idempotent by solveId` — tokens/stars credited, streak updated, completions[puzzleId] set, session = null, lastResult cached; retried same solveId → same result
- `finishSolve streak on prev day increments, on older day resets to 1`
- `finishSolve at midnight boundary (now crosses dayKey, userTz changes)` — streak computed from dayKey(now, tz), not server UTC
- `finishSolve sets suspicious flag (S1 plausibility floor, S2 typing floor, S3 too-clean, S4 check-heavy)`
- `finishSolve with hints sets hintsUsed, no-hint bonus only if 0`
- `failed flush → alarm → recovery via Projections.apply` — evict user, alarm fires, snapshot replayed to D1 atomically
- `spinWheel once per local day, ALREADY_SPUN 409` — uses crypto.getRandomValues per WHEEL_PRIZES
- `toggleLike idempotent, like count never negative`
- `projection player_state upsert and player_solves INSERT OR IGNORE` — leaderboard fact row with (user_id, puzzle_id) PK
- `versionedUpsert only bumps version when JSON differs` — dupe commit = free no-op

**`identity`** (files: `bootstrap.test.ts`, `jwt.test.ts`, `rl.test.ts`)
- `POST /devices mints HS256 bearer token, exp 365d, kid rotation on re-mint`
- `token unknown kid → 401` — keyring lookup fails
- `token_expired with refreshable: true within 30d grace → POST /session/refresh re-mints`
- `token_expired > 30d → 401 not-refreshable`
- `tokenVersion bumped → 401 revoked` — earlier token invalidated
- `POST /devices RL_BOOT 10/60s per IP` — miniflare simulates, verified locally
- `POST /session/refresh RL_USER per user`
- `GET /me RL_USER` — rate limit check

**`solving`** (files: `session.test.ts`, `words.test.ts`, `hints.test.ts`, `finish.test.ts`, `anti-cheat.test.ts`)
- `POST /puzzles/:id/solves starts session (solveId, status running, locked: [], hintsUsed: 0, session replaces prior)`
- `replay: true when puzzleId ∈ completions`
- `submitWord correct answer locks question, sweep unlocks dependent questions, returns fixedLetters`
- `submitWord wrong answer tallies guess counter, 20/question limit → 422 GUESS_BUDGET, returns locked: []`
- `submitWord with all questions locked calls finishSolve logic inline → SolveResult (tokens, stars, streak)`
- `hints/fifty charges 20 tokens, INSUFFICIENT_TOKENS 402, stores two options`
- `hints/letter charges 40 (or noop if already locked), reveals first wrong-or-empty cell`
- `hints/word charges 100, reveals whole word`
- `check POST with autocheck ticket (HMAC-SHA-256, issued by DO, 10m TTL, ≤6/solve)` — RL_CHECK 30/60s per solveId
- `finish idempotent per solveId, cached lastResult returned on retry`
- `S1 plausibility floor = max(12s, 400ms × fillableCells)`
- `S2 typing floor = 80ms per character for consecutive locked words`
- `S3 audit = no-hints + ultra-fast (elapsed < 2 × minPlausible)`
- `S4 audit = check > 6 × fillableCells (per-solve, via checkTickets counter)`
- `boardEligible = firstSolve && !suspicious && pauseCount === 0 && (veteran ≥ 3 on ≥ 2 days)` (v2: OR attested)

**`economy`** (files: `purchases.test.ts`, `wheel.test.ts`)
- `purchasePack(packId, idempotencyKey) → creditPurchase → 1 DO commit per purchase ID` — true duplicate rejects PURCHASE_CONFLICT
- `setPlan(tier, idempotencyKey) idempotent`
- `spinWheel (one per local day) + emits economy.wheelSpun event`
- `already_spun 409 on second spin same wheelId`

**`social`** (files: `likes.test.ts`, `presence.test.ts`, `stats.test.ts`)
- `toggleLike (toggleSave similar) emits social.likeToggled → PuzzleStats.adjustLikes`
- `toggleLike idempotent per (userId, puzzleId)`
- `PuzzleStats.heartbeat memory-mapped: 100 solves → ≤2 commits (batches by 60s TTL or count)`
- `recordSolve keyed by boardDay (puzzle.drop_date), sorted by timeMs ≤10 rows`
- `topToday resets when day changes (not dayKey, not user local time — puzzle's published date)`
- `recordSolve excluded if solve.suspicious`
- `likes counter never negative` — concurrent toggles serialized per puzzle

**`collections`** (files: `progress.test.ts`, `claim.test.ts`)
- `checkAndClaim (on solve.finished event) — queries member puzzles, checks all solved, calls player.claimCollection`
- `claimCollection idempotent per (userId, collectionId)` — reward credited once, emits collections.completed`
- `collections.completed → unlockDependants → emits collections.unlocked` — critical handlers ordered
- `unlock rule dependencies (e.g. "complete collection X first")` — prevents cycles, re-run idempotent

**`leaderboard`** (files: `materialise.test.ts`)
- `materialiseWeek (cron `*/5 * * * *`) aggregates player_solves by week_key, sums stars per user, excludes suspicious`
- `cron re-run idempotent` — same week_key with same ranks
- `topToday per puzzle — player_solves index (puzzle_id, suspicious, time_ms), sorted by time`

**`feed`** (files: `page.test.ts`)
- `GET /feed returns daily drops ⋈ content_puzzles ⋈ social_puzzle_stats, paginated`
- `cursor base64url([day, id]), next page no duplicates`
- `gateway interleaves streak_save card (position 1, if today unsolved), wheel (position 3, if canSpin), mystery (every 6th)`
- `lang override binds into cursor`
- `first page cacheable 30–60s per (lang, today)`
- `liked/saved from User snapshot`

**`notifications`** (files: `reminders.test.ts`)
- `scheduleReminderOptIn on player.onboarded` — creates D1 reminder entry if notifications enabled
- `sendReminders cron checks player_state.local_day_ends_at, marks sent per (user_id, day_key)`
- `reminders sent once per (user, day) — INSERT OR IGNORE`
- `cron re-run idempotent`

**`app/integration`** (files: `smoke.test.ts`)
- Full `POST /devices → /me → /feed → /puzzles/:id/solves → words → finish → /wallet → /leaderboard` loop

### Architecture test

**`test/arch.test.ts`** — scans import boundaries and D1 table prefixes:
- Each module imports only from its own `index.ts/contract.ts` and from `shared/events`
- `app` imports everything; `shared/events` imports nothing from `modules/*`
- Each D1 table's prefix matches its owning module (e.g., `content_*` read by `content` only; `player_*` read by `player`, `identity`, `collections`, `leaderboard`, `feed`)
- No cross-module D1 direct access except `feed`'s composed query (delegated through each module's query function)

### Smoke test script

**`scripts/smoke.sh`** — curl against a live `wrangler dev` on port 8787 with known seed data:

```bash
#!/bin/bash
set -e

# Start wrangler dev in background
wrangler dev --ip 0.0.0.0 --port 8787 &
DEV_PID=$!
trap "kill $DEV_PID" EXIT
sleep 3  # boot time

BASE="http://localhost:8787/v1"

# Bootstrap
DEVICE=$(curl -s -X POST "$BASE/devices" -H "content-type: application/json" \
  -d '{"installId":"'$(uuidgen)'","platform":"ios","appVersion":"1.0.0","tz":"UTC"}' | jq -r '.userId, .token')
USER_ID=$(echo "$DEVICE" | head -1)
TOKEN=$(echo "$DEVICE" | tail -1)

# Verify auth
curl -s "$BASE/me" -H "authorization: Bearer $TOKEN" | jq .id | grep -q "$USER_ID"
echo "✓ Bootstrap + /me"

# Feed (today's drop)
PUZZLE=$(curl -s "$BASE/feed" -H "authorization: Bearer $TOKEN" | jq '.items[0] | {id, kind}')
echo "✓ Feed: $PUZZLE"

# Start solve (en-mini-0001)
SOLVE=$(curl -s -X POST "$BASE/puzzles/en-mini-0001/solves" -H "authorization: Bearer $TOKEN" | jq '.solveId, .questions')
SOLVE_ID=$(echo "$SOLVE" | head -1 | tr -d '"')
QUESTIONS=$(echo "$SOLVE" | tail -1)
echo "✓ Start solve: $SOLVE_ID"

# Submit words (all locked: the five across/down answers)
# Puzzle en-mini-0001 is a 5×5 word square with known answers (seeded in setup.ts)
# Assume answers: Q0 "ADIEU", Q1 "DROIT", etc.
curl -s -X POST "$BASE/solves/$SOLVE_ID/words" -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{"questionIndex":0,"word":"ADIEU","locked":[]}' | jq '.correct, .locked' | head -1 | grep -q true
echo "✓ Words"

# Finish
RESULT=$(curl -s -X POST "$BASE/solves/$SOLVE_ID/finish" -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"grid":["ADIEU","DROIT","IXORA","ELATE","UTERI"]}')
TOKENS=$(echo "$RESULT" | jq '.tokensEarned')
echo "✓ Finish: earned $TOKENS tokens"

# Wallet
curl -s "$BASE/wallet" -H "authorization: Bearer $TOKEN" | jq '.balances.tokens' | grep -q "$TOKENS"
echo "✓ Wallet"

# Leaderboard
curl -s "$BASE/puzzles/en-mini-0001/leaderboard" -H "authorization: Bearer $TOKEN" | jq '.rows | length' | grep -q "1"
echo "✓ Leaderboard"

echo "Smoke test passed ✓"
```

### CI order

`pnpm install --frozen-lockfile` → `wrangler types --check` → `turbo typecheck test` → optional `vitest run --coverage`

**Test files (turbo `test` task dependencies)**:
- `migrations/**/*.sql` (migrations inputs)
- `$TURBO_DEFAULT$` (source files)
- Outputs: `coverage/**`

---

**Test count summary**: 6 rules files, 31 test suites across 12 modules + app/arch/smoke, ≈140 test cases total. Every module has ≥3 tests for idempotency, replay, and alarm recovery where applicable. Critical path tests (finish, collections.claim, social.like) each have ≥5 cases covering event subscriptions and anti-cheat flags.

## 9. Local dev & deploy

### Prerequisites

- **Node 26** (pnpm 11 minimum requirement is ≥ 22; verified on 26.8.1)
- **pnpm 11.24** (`npm install -g pnpm@11.24` or `corepack enable`)
- **wrangler 4.128.0** (pinned in workspace `devDependencies`)
- **No Cloudflare login required locally** (only at first deploy). `.dev.vars` holds secrets; offline commands (type-check, test, local dev) need none.

### Configuration files

#### workers/gateway/wrangler.jsonc

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "crosscut",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-02",
  // nodejs_compat (default ≥ 2026-08-04) and enable_ctx_exports (default ≥ 2025-11-17) are implied.
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "triggers": { "crons": ["0 * * * *", "*/5 * * * *", "0 6 * * *"] },

  "exports": {
    "User":        { "type": "durable-object", "storage": "sqlite" },
    "PuzzleStats": { "type": "durable-object", "storage": "sqlite" }
  },

  "durable_objects": { "bindings": [
    { "name": "USER",        "class_name": "User" },
    { "name": "PUZZLE_STATS", "class_name": "PuzzleStats" }
  ]},
  "d1_databases":  [{ "binding": "DB", "database_name": "crosscut", "database_id": "local-dev" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "local-dev" }],
  "ratelimits": [
    { "name": "RL_BOOT",  "namespace_id": "1001", "simple": { "limit": 10,  "period": 60 } },
    { "name": "RL_USER",  "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } },
    { "name": "RL_SPEND", "namespace_id": "1003", "simple": { "limit": 20,  "period": 60 } },
    { "name": "RL_CHECK", "namespace_id": "1004", "simple": { "limit": 30,  "period": 60 } }
  ],
  "vars": { "APP_ENV": "dev" },
  "dev": { "port": 8787 },

  "env": {
    "production": {
      "vars": { "APP_ENV": "production" },
      "durable_objects": { "bindings": [
        { "name": "USER",        "class_name": "User" },
        { "name": "PUZZLE_STATS", "class_name": "PuzzleStats" }
      ]},
      "d1_databases":  [{ "binding": "DB", "database_name": "crosscut", "database_id": "<UUID from wrangler d1 create>" }],
      "kv_namespaces": [{ "binding": "CACHE", "id": "<id from wrangler kv namespace create>" }],
      "ratelimits": [
        { "name": "RL_BOOT",  "namespace_id": "1001", "simple": { "limit": 10,  "period": 60 } },
        { "name": "RL_USER",  "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } },
        { "name": "RL_SPEND", "namespace_id": "1003", "simple": { "limit": 20,  "period": 60 } },
        { "name": "RL_CHECK", "namespace_id": "1004", "simple": { "limit": 30,  "period": 60 } }
      ]
    }
  }
}
```

#### workers/gateway/package.json (scripts section)

```json
{
  "scripts": {
    "dev":            "wrangler dev --ip 0.0.0.0 --port 8787",
    "types":          "wrangler types",
    "typecheck":      "wrangler types --check && tsc --noEmit",
    "test":           "vitest run",
    "migrate:local":  "wrangler d1 migrations apply crosscut --local",
    "seed:local":     "wrangler d1 execute crosscut --local --file ./seed/0001_content.sql",
    "deploy":         "wrangler deploy --env production",
    "tail":           "wrangler tail --env production --format pretty"
  },
  "devEngines": { "packageManager": "pnpm@11.24" },
  "devDependencies": {
    "wrangler": "^4.128.0",
    "@cloudflare/vitest-plugin": "^1.1.3",
    "vitest": "4.1.11",
    "typescript": "^7.0.2"
  }
}
```

#### pnpm-workspace.yaml (root)

```yaml
packages:
  - "workers/*"
  - "packages/*"
allowBuilds:
  esbuild: true
  workerd: true
catalog:
  zod: ^4.5.4
  hono: ^4.13.5
  typescript: ^7.0.2
```

#### turbo.json (root)

```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "tasks": {
    "types":     { "inputs": ["wrangler.jsonc", "src/**/*.ts"], "outputs": ["worker-configuration.d.ts"] },
    "typecheck": { "dependsOn": ["types", "^typecheck"] },
    "test":      { "dependsOn": ["types"], "inputs": ["$TURBO_DEFAULT$"], "outputs": ["coverage/**"] },
    "dev":       { "cache": false, "persistent": true },
    "migrate:local": { "cache": false },
    "seed:local":    { "cache": false }
  }
}
```

#### .dev.vars.example

```
DEVICE_TOKEN_KEYS={"active":"2026-09","keys":{"2026-09":"<32+ random bytes, base64url>"}}
CONTENT_ADMIN_TOKEN=<bearer token for POST /admin/content/import>
```

Generate random keys locally (Node):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Local dev loop

Run these commands in order. Each step depends on the previous; `pnpm install` must run first after cloning.

```bash
# 1. Install workspace dependencies (runs once after clone; ~10 s with cache)
pnpm install

# 2. Generate worker types from wrangler.jsonc (required after any config change)
pnpm --filter gateway types

# 3. Apply D1 migrations to local database
pnpm --filter gateway migrate:local

# 4. Seed with four prototype puzzles + collections (one-time)
pnpm --filter gateway seed:local

# 5. Start development server (continues running; Ctrl+C to stop)
pnpm dev

# 6. In another terminal, run HTTP smoke test
curl http://localhost:8787/healthz
# Expected: 200 { "ok": true }

# 7. Optional: watch tests as you edit
pnpm --filter gateway vitest
```

**To expose to a phone on the LAN,** the `dev` script already binds `--ip 0.0.0.0`. From your phone:
- Find your Mac's LAN IP: `ifconfig | grep inet | grep -v 127`
- Navigate to `http://<your-ip>:8787/healthz` in the phone's browser or via curl

**To reset local state** (nuke the local D1 and Durable Objects):
```bash
rm -rf workers/gateway/.wrangler/state
pnpm --filter gateway migrate:local seed:local
```

**Expected outputs:**
- `migrate:local`: "Executing on local database crosscut (…) from .wrangler/state/v3/d1" → applied 5 migrations
- `seed:local`: one `INSERT` per puzzle; "Executed 1 statement" ×4
- `pnpm dev`: starts `wrangler dev` on port 8787; press `e` to open the Local Explorer for D1/KV inspection

### Crons and scheduled handlers

Three cron schedules defined in `wrangler.jsonc` under `triggers.crons`:

| schedule | handler | runs | functions | idempotency |
|----------|---------|------|-----------|-------------|
| `0 * * * *` | UTC hourly | Fill daily drops 3 days ahead per language; init PuzzleStats objects | `ensureDrops`, `initPuzzleStats` | Re-running fills only missing rows; safe to repeat |
| `*/5 * * * *` | Every 5 minutes UTC | Materialise weekly leaderboard from `player_solves` rows (exclude `suspicious`) | `materialiseWeek` | Re-running overwrites; rows keyed by `(week, userId)` so duplicates merge |
| `0 6 * * *` | 06:00 UTC | Alert if pool depth < 14 unpublished puzzles per language | Pool status check; logs to Workers Logs | Side-effect-free check; safe to repeat |

**Test locally** (with `wrangler dev` running):
```bash
# Test the hourly cron
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"

# Test the leaderboard cron
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"

# Test the alert cron
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+6+*+*+*"

# Expected: HTTP 200, logs printed to terminal
```

All crons must be **idempotent**: a scheduled invocation that throws or times out is silently lost until the next tick (no retry, no alert). Because `ensureDrops` is the only writer of `daily_drops` rows, if it fails for hours, users will see stale drops. (set up monitoring (Workers Logs dashboard, or a separate alert cron) to check that `daily_drops` has rows for today + 3 days per language).

### First-deploy checklist

1. **Log in to Cloudflare**
   ```bash
   wrangler login
   # Opens OAuth flow in browser; callback to localhost:8976
   ```

2. **Create D1 database**
   ```bash
   wrangler d1 create crosscut --env production
   # Output includes database_id (a UUID)
   ```

3. **Update wrangler.jsonc `env.production.d1_databases[0].database_id`** with the UUID from step 2

4. **Create KV namespace** (if using cache binding)
   ```bash
   wrangler kv namespace create CACHE
   # Output includes the namespace id
   ```

5. **Update wrangler.jsonc `env.production.kv_namespaces[0].id`** with the id from step 4

6. **Apply migrations to production**
   ```bash
   pnpm --filter gateway run migrate:local  # First verify locally
   wrangler d1 migrations apply crosscut --remote --env production
   ```

7. **Set secrets in production** (read from `.dev.vars` and set on Cloudflare)
   ```bash
   wrangler secret put DEVICE_TOKEN_KEYS --env production
   # Paste the JSON from .dev.vars; prompted interactively
   
   wrangler secret put CONTENT_ADMIN_TOKEN --env production
   ```

8. **Deploy the Worker**
   ```bash
   wrangler deploy --env production
   # Prompted to register a workers.dev subdomain (do it; it's free)
   # Deployment URL: https://crosscut-production.<your-subdomain>.workers.dev
   ```

9. **Stream logs and verify**
   ```bash
   wrangler tail --env production --format pretty
   # In another terminal, test the production endpoint
   curl https://crosscut-production.<your-subdomain>.workers.dev/healthz
   ```

**⚠ Critical: never mix exports and migrations.** Once deployed with `exports`, subsequent deployments with `migrations` are rejected. Commit to `exports` from day one.

### DEVICE_TOKEN_KEYS rotation runbook

The `DEVICE_TOKEN_KEYS` secret holds a keyring: one active key, plus old keys for at least 30 days after rotation. Tokens expire after 365 days; the refresh endpoint accepts tokens up to 30 days past expiry. So keep a key for ≥ 60 days (refresh window + grace).

**When to rotate:** on a schedule (e.g. monthly) or after a suspected compromise.

**Rotation steps:**

1. **Generate a new key** (Node, locally)
   ```bash
   node -e "console.log(JSON.stringify({active:'2026-10',keys:{'2026-10':'<new-base64>','2026-09':'<old-base64>'}}))"
   ```

2. **Update the secret in production**
   ```bash
   wrangler secret put DEVICE_TOKEN_KEYS --env production
   # Paste the new JSON
   ```

3. **Verify** (tokens signed with the new key work; old key still verifies)
   ```bash
   # Next POST /v1/session/refresh will mint a token with the new key
   # Tokens signed before the rotation still verify via the old key for 30+ days
   ```

4. ** (after 60 days, remove the old key)** (breaking change: old tokens fail to verify → 401 → client re-bootstraps as new user)
   ```bash
   # Update the secret again, keeping only the active key
   ```

Track rotation dates in a `CHANGELOG.md` or operator runbook so no key is dropped prematurely.

## 10. Work breakdown

See `docs/IMPLEMENTATION-PLAN.md`.

## 11. Risks and trade-offs

This section itemizes risks that could affect release, operation, or future scaling; deliberate design trade-offs and deferrals; anti-cheat boundaries; and open product questions that were resolved with v1-specific defaults. Risks marked `[UNVERIFIED]` are claims from the research documents that could not be confirmed against official primary sources; they carry lower confidence and should be validated on first deploy or during milestone gates. The "trigger to revisit" column names the condition that should prompt a re-architecture; until then, the mitigation applies.

Most operational risks are mitigated through idempotent design: cron handlers run safely when duplicated, projection flushes can be re-driven without double-counting, and the `reconcile` endpoint heals lost fan-out. The main technical risks are [UNVERIFIED] platform guarantees (D1 UPSERT production behavior, Rate Limiting Free-plan availability, timezone support) that will be validated early in M0–M2.

### Risk register

The table below collects every [UNVERIFIED] fact the design relies on (e.g. D1 UPSERT support in production, rate-limit binding availability, timezone handling in workerd), plus operational risks (hot objects, snapshot growth, cron idempotency, key rotation) that are mitigated in v1 but could require structural change if conditions change. Each row names the impact on users or operators if the risk materializes, the current likelihood (low/medium based on third-party confidence and scope of the assumption), how v1 mitigates it, and the operational metric that would trigger a redesign.

Risks are organized by domain: platform ([UNVERIFIED] Cloudflare features and docs), runtime (workerd and Intl support), storage (D1 and DO), state (snapshot size and idempotency), operations (cron reliability and key rotation), and concurrency (hot objects and rate limiting). Most risks are low-likelihood because the design either avoids the risk (no ORM, no outbox without ack, no cross-DO transactions) or tolerates it (cron duplicates are harmless, clock skew is detected, snapshot growth is guarded).

| id | risk | impact | likelihood | mitigation in v1 | trigger to revisit | owning section |
|---|---|---|---|---|---|---|
| **R1** | D1 UPSERT (`ON CONFLICT … DO UPDATE … WHERE`) and `RETURNING` verified only in local engine; not on official D1 pages | Projection flush fails in production | low | Production smoke test of `versionedUpsert` on first deploy; avoid `RETURNING` in critical paths | Confirmed unavailable in prod docs or seen in-flight | §3, §4 player |
| **R2** | Cron Trigger delivery/retry guarantee undocumented; `controller.noRetry()` implies retries can occur | Drop cron duplicates a puzzle, or misses a day entirely | medium | Windowed, idempotent, duplicate-tolerant handlers; 06:00 health check alerts on staleness | Cloudflare documents policy or production shows drift | §2 drops, §6 leaderboard |
| **R3** | Rate Limiting binding availability on the Free plan; pricing at scale [UNVERIFIED] | Bootstrap or spend routes unthrottled; account-abuse replay; Free tier exhausts quota before launch | low | Verify on first staging deploy; fall back to guarding bootstrap/spend only if absent | Confirmed unavailable or pricing exceeds budgeted cost | §5 identity, middleware |
| **R4** | `Intl.DateTimeFormat` and `timeZone` support in workerd; IANA zone names (Kyiv vs Kiev) [UNVERIFIED] | User timezone changes silently to UTC; `dayKey` mismatch between server and client | low | Vitest integration test over every distinct timezone the client can send; validate by constructing a `DateTimeFormat` and comparing formatted keys, not zone names | Test fails for a valid zone | §2 player timezone, §8 content drops |
| **R5** | DO stub calls (`aggregateStub`, PuzzleStats) count toward the 32-invocation-per-request cap | Finishing a puzzle hits the cap; unrelated reads block or fail | low | Irrelevant until a Worker split; budget conservatively (M3: ~2 stubs per request) | Split planned or cap exceeded in production | §4 solving finish, composition |
| **R6** | `waitUntil` budget of an RPC-invoked entrypoint; AsyncLocalStorage across `waitUntil` continuations [UNVERIFIED] | Background event handlers on outbox recovery lose the 30 s budget; correlation IDs cannot be threaded across `waitUntil` boundaries | low | Not relied upon in v1 (no outbox entrypoint, no async local storage); background handlers run within alarm lifetime only | Outbox path adopted in v2 | §3 event dispatch |
| **R7** | Per-puzzle `PuzzleStats` is a single hot object (one DO for all likes, solves, presence) | At ~50k DAU with feed reads on D1 and heartbeat writes every 15 s, write contention may cause transient tail latency or commit timeouts | low | Monitor `PuzzleStats` lock hold times via observability; shard by `hash(userId) % N` if latency exceeds SLA (typical threshold: p99 > 1s) | p99 latency > 1 s or operational alert during traffic spike | §5 social |
| **R8** | zod 4.5.4 on a physical Hermes device (Expo SDK 54/55) [UNVERIFIED] | Shared types fail at runtime on Android; inbound validation breaks the app | low | Run `packages/shared` in a development build early in M1; test on a physical device before M3 merge | Test fails or schema validation errors appear | §2 shared, packages/shared |
| **R9** | iOS Keychain `AFTER_FIRST_UNLOCK` persistence across iCloud restore | Device token re-minting required after restore; old token stays in the keychain and causes token-conflict errors on the same device | medium | No v1 mitigation; device test on a real iPhone after restore, document the experience, add FAQ entry | Restore test fails | §5 identity bootstrap |
| **R10** | Keyboards: Free plan of Cloudflare Rate Limiting binding; ЙЦУКЕН layout coverage and key widths for uk/ru [UNVERIFIED] | 12-key row on 390 px frame needs ~25 px keys (below 44 px guidance); bootstrap floods unthrottled; Cyrillic input blocked | low | Verify Rate Limiting on deploy; confirm 4-row layout or long-press solution for Cyrillic before M2 | Test or design review fails | §2 config, §8 content |
| **R11** | D1 SQLite version unknown (production version unspecified) | Cursor or query-plan changes in production break feed pagination or leaderboard materialization | low | Re-run feed pagination test against production database on first deploy (`wrangler d1 execute --remote --command "EXPLAIN QUERY PLAN …"`) | Query plan differs materially from local |  §5 feed, leaderboard |
| **R12** | Clock skew between Worker and client; Intl arithmetic without Date constructors | Timezone edge cases (DST transitions, offset drift); hint-cost timestamp validation fails | low | Sent clock times on every response; client validates `occurredAt` is within ±5 min; DST drift cron re-derives offsets for ~40 zones once per day | Observed clock drift > 5 min or DST gap failure | §5 solving, notifications |
| **R13** | Snapshot size growth (user completions, like/save arrays, hint logs) | User state exceeds 256 KiB (warn) or 1 MiB (throw) after months of play | low | Guard in `Aggregate.commit()` (warn > 256 KiB, throw > 1 MiB); lazy-archive completions and hint logs after 90 days to D1 if size approaches limit | User snapshot exceeds guard | §3 player aggregate |
| **R14** | Key rotation mistakes (`DEVICE_TOKEN_KEYS` mismatch, `LOCK_PROOF_KEY` loss) | Old tokens rejected after key removal; mid-flight solves lose their proofs; `POST /session/refresh` returns 401 | low | Secrets never rotated mid-day; key rotation is a deployment + rollback-window choice; archive old keys 30 days after deactivation; test key rollover in staging | Production key loss observed | §5 identity |
| **R15** | Pool exhaustion of published puzzles (not scheduled) | `ensureDrops` has no queue; `INSERT OR IGNORE` fails silently if the pool has < 3 days of puzzles ahead | low | 06:00 cron alerts when pool depth < 14; manual top-up via admin import if depletion occurs | Alert fires or feed shows "no puzzle available" | §2 drops, §8 content |
| **R16** | Hint debit partial failure (token debit succeeds, decoy retrieval fails) | User sees balance reduced but no hint content; no retry path except `GET /solves/:id` resync | low | Never possible in v1 (hints commit atomically in `User.spendForHint`); idempotent per `(solveId, questionIndex, kind)` so retry is safe | Impossible in design | §5 solving hints |
| **R17** | Cron duplicate runs (subscription edge cases, platform transient) | Leaderboard materialization or drop cron runs twice in 5 min; duplicate rows, double-counting | medium | Handlers written to be idempotent (leaderboard uses `week_key + user_id` as key, cron queries `lastEnsureDropsAt`); `INSERT OR IGNORE` prevents duplicate drop keys | Observed duplicate board entries or drop records | §2 drops, §6 leaderboard cron |
| **R18** | Solve finishing without recording the completion | Session marked finished but `player_solves` fact row never inserted (projection-flush timeout, alarm dropped) | low | `Player.finishSolve` writes state + completion atomically in one `User` commit; projection-flush failure is healed by `POST /me/reconcile`; no "silent loss" path | User reports puzzle resets despite solving | §3 solving finish, reconcile |

### Deliberately not built in v1

The following features appear in the research docs, concepts, or future roadmaps but are explicitly **not** in v1 scope. Each has a clear seam in the code (file/module) and a list of conditions (scale, user requests, store requirements, or feature dependency) that would trigger its implementation. Deferring these items reduces the v1 scope to a launchable baseline while keeping the code structured so each can be added independently in v2+. No feature in this table has a hidden dependency on any other; the code is written so that, for example, adding Better Auth does not require rebuilding Push delivery or vice versa.

| item | why deferred | what would trigger building it | where the seam is |
|---|---|---|---|
| **Outbox/ack/alarm redelivery** | Event fan-out is in-process with critical handlers awaited and background handlers under `ctx.waitUntil` (30 s budget). Loss is healed by idempotent `reconcile`. This is sufficient for analytics and notifications; money operations commit to the aggregate. | Money-relevant background handlers (a v2 push partner, a refund processor, a pay-per-hint store) that cannot afford loss; or a second Worker entrypoint subscribing to the event stream. | `in-process-event-bus.md` R1–R7; sketch in `wiring.ts`; add `Outbox` DO and `Events` entrypoint (alarm-driven retry loop with processed-event dedupe) |
| **Better Auth accounts** | v1 uses server-minted HS256 device tokens (`hono/jwt`); no accounts, no email, no password reset | Supporting account sign-in, device merging, multiple-device logins, or OAuth integrations | `identity/internal/jwt.ts` (replace with Better Auth adapter); `identity/contract.ts` (add `AccountSession` type) |
| **Push delivery (APNs/FCM)** | Notifications stub: reminder dedupe + streak break notices, cron-driven; v1 has no push transport. Expo push used in concepts but is third-party. | Building direct APNs/FCM integrations for native push, web push via VAPID, or expanding notification types beyond reminders | `notifications/` module (add `notifications.http.ts` routes); `gap-push-notifications-delivery.md` R1–R8 (HTTP/2 outbound probe required) |
| **OpenAPI schema** | Only client is the typed Expo app (via `hc`); no public API docs or SDK generated | Public REST API, automatic doc generation, or code generation for partners | `hono-openapi` 1.3.1 (one route-by-route later); never `.openapi()` on shared schemas (`zod4-usage.md` F8); use `.meta({ id, ref })` instead |
| **PuzzleStats sharding** | Single `PuzzleStats` DO per puzzle (one object, no partition key); contention acceptable to ~50k DAU | Scaling to 100k+ DAU with high write throughput on popular puzzles; p99 latency > 1 s | `social/internal/puzzle-stats.do.ts` (refactor to shard by `hash(userId) % 16`); fan-out reads in `feed` and `leaderboard` |
| **Device attestation** | Glossary v1 scope note: attestation (iOS App Attest, Android Play Integrity) is v2. Anti-cheat in v1 = server-side timing, locked set, wrong-guess budgets, plausibility floor, suspicious flag. | Confidence in leaderboard integrity, requirement by app stores for paid features, or abuse increase | `solving/internal/attest.ts` (Apple/Android SDK integration); `POST /v1/solves/:solveId/attest`, `attestFinish`; `attest_keys` table; glossary marked "v2 — no v1 migration" |
| **RevenueCat/Stripe purchasing** | v1 mocks all purchases (`economy_purchases` inserts, `creditPurchase` calls). RevenueCat/Stripe is the v2 path for real transactions. | Monetization launch, app-store compliance, or subscription management | `economy/internal/db.ts` (replace mock with RevenueCat API calls); `identity` (track `revenueCatUserId` on `User`); add webhook handler for purchase notifications |
| **Expo app** | Backend design assumes iOS/Android clients exist; Expo app code is in the `IOSApp` sibling project, not in this repo | Expo SDK packaging, TestFlight distribution, or cross-platform (web) client | `workers/gateway` has no Expo dependencies; client split is clean (only depends on `/v1` API contract) |
| **Admin UI** | v1 uses the repo as a CMS: JSON files in `content/puzzles/` + `content/collections.json`, imported via `POST /admin/content/import` and `POST /admin/collections/import` | Editorial dashboard, live puzzle scheduling, user lookup/moderation, analytics reporting | `content/http.ts` (add `/admin/`* routes); new `admin/` module or extend `content`; seam is `POST /admin/content/import` contract (§5 endpoints #42–44) |
| **ORM** | Raw D1 SQL + `versionedUpsert` from `packages/core`; bundle size is smaller, locking semantics are explicit, and SQLite feature parity is easier to verify | Adopting Better Auth v2 (if its Drizzle adapter is preferred), moving to a second database (PostgreSQL), or database schema complexity explosion | `packages/core/aggregate.ts` (replace `versionedUpsert` with Drizzle/Prisma adapter); seed, migrations, and test utilities must follow the ORM's model |

### Anti-cheat limits

Per the glossary v1 scope note, device attestation (iOS App Attest and Android Play Integrity) is deferred to v2. The anti-cheat strategy in v1 is server-side: timing validation, server-owned invariants, budgets, and suspicious-solve flagging rather than device identity.

**What v1 catches:**
- **Implausible speed** (S1): Server-side puzzle-start and finish timestamps validate that solutions cannot be solved faster than `MIN_PLAUSIBLE_MS` (max `12 s + 400 ms/cell` for larger grids). Solves below this threshold are marked `suspicious`.
- **Backwards unlocking** (server-owned locked set): Clients cannot unlock cells they have locked once; the server state tracks which questions have been locked, preventing trivial grid enumeration.
- **Enumeration attacks** (wrong-guess budgets): 20 wrong guesses per question and 100 per solve force the solver to use hints or strategy rather than brute-force the grid.
- **Oracle brute-force** (check rate limits): Per-cell `check` is rate-limited to 30/60 s per user (RL_CHECK), and autocheck tickets are capped at 6 per solve (10 min each), preventing client-side oracle loops.
- **Check-heavy solving** (S4 heuristic): Solves that rely heavily on the check feature to fill the grid are marked suspicious and excluded from leaderboards and social counters.
- **First-solve and leaderboard filtering**: Solves marked `suspicious` are never included in leaderboard materialization, social stats (top-today, solved count), or first-solve rewards.

**What v1 cannot:**
- Bots or automation that pace themselves within the plausibility window to mimic human behavior.
- Shared accounts playing across multiple devices, regions, or languages in short time windows.
- Coordinated fraud (e.g. account farming, collusive voting on likes).

**v2 answer:** Device attestation (iOS App Attest for iOS, Android Play Integrity for Android) cryptographically binds each solve to a single physical device and developer account. The server pins each `userId` to a device identifier and rejects solves from new or mismatched devices until the user re-attests, adding a hardware-level barrier to account farming. Attestation happens in a separate `POST /v1/solves/:solveId/attest` endpoint and populates `attest_keys` table (marked "v2 — no v1 migration" in the glossary).

### Open product questions

The research documents listed the following design questions—drawn from gap analyses, architecture decisions, and content pipeline considerations—that required early decisions for v1 scope and completeness. Each has been resolved below with a product default; these choices ensure the API contract, domain model, and database schema are complete and internally consistent by M2 and testable by M3. UX copy, editorial policies, and configuration may evolve after launch without requiring backend changes.

v1 defaults chosen (from research/* open-question sections):

1. **Replay rewards** [gap-api-contract-freeze Q10]: A replay of a completed puzzle earns 0 tokens and 0 stars. Replays update best time tracking but do not extend the streak, grant a first-solve bonus, or appear on leaderboards.

2. **Streak extension** [gap-feed-composition-semantics Q2]: Any solve that is a first-solve for the user extends the streak on that local day, regardless of language, puzzle kind, or difficulty. Bilingual users can earn streak points in both English and Ukrainian on the same day; the streak counts unique local days of solving, not unique puzzles. Replays do not extend; neither do suspicious solves.

3. **Wheel cadence** [gap-api-contract-freeze Q4]: One free spin per user per local day (not per session, not per puzzle). The v1 choice keeps economy simple and prevents session-long abuse. Reward tiers are `[50, 10, 0, 25, 5, 15]` tokens (client animates to the server-chosen index over 3.4 s). The middle (index 2) offers 0 tokens as a "loss" outcome to match the prototype's game feel.

4. **Pause semantics** [gap-solve-protocol-integrity Q1]: Explicit `POST /solves/:id/pause` and `/resume` with no v1 cap on pause count; `pausedMs` accumulates and counts against solve time. Paused sessions do not appear on leaderboards (`boardStatus: unranked`).

5. **50/50 decoy source** [gap-api-contract-freeze Q3]: Decoy words come from a curated `decoys` list in the puzzle JSON (if present) or the language word bank (length-matched, never any grid answer). Word bank must exist for `uk` and `ru` before M3; missing banks return 422 `bad_question`.

6. **Cyrillic alphabets and Ё→Е folding** [gap-api-contract-freeze Q5, crossword-content-pipeline O3]: Russian alphabet includes Ё but `normalizeWord("ru")` folds Ё→Е at check time so solvers typing Ё see it as Е, making either form acceptable. Ukrainian keeps all 33 letters (Є, І, Ї, Ґ included; no Ё, Ъ, Ы, Э). Keyboard layout is ЙЦУКЕН (33 keys for `uk`, 32 for `ru` after folding). No reshuffling, no long-press alternatives, no conditional showing/hiding of Ё in v1.

7. **Word-square minis** [crossword-content-pipeline O4]: Allowed to repeat the same clue text for across and down slots of the same word (matches prototype, lowers editorial overhead).

8. **Crossword (9×9) symmetry and checking** [gap-solve-protocol-integrity Q12]: 9×9 crosswords have no symmetry requirement and no fully-checked policy (unlike minis: 5×5 fully-checked word-squares or standard grids). Validators do not enforce symmetry or block odd layouts.

9. **Daily schedule** [gap-feed-composition-semantics R2]: One puzzle per `(day, language)` pair. No per-level, per-difficulty, or per-user variation; all users see the same daily for their language on a given day.

10. **Social counters (real vs fuzzed)** [gap-feed-composition-semantics Q8]: Real counts from day one (like count, solve count, "solving now" presence). No fuzzing, no fuzzy-count animations; drift between `User` and `PuzzleStats` is accepted and can be healed later. A nightly audit cron or `reconcile` recount is a v2 optimization; users see honest numbers in v1.

11. **Achievements and badges** [gap-api-contract-freeze Q9]: Undefined in v1; collections unlock via unlocking rules (e.g. "solve 3 puzzles in the 'Travel' collection"), not via achievement points or milestone badges. `CollectionCard.badge` field is left `null` in the schema; badges and gamification are a v2 design once engagement patterns are observed.

12. **Reset-my-data UX**: `DELETE /me` is available at the API level and purges aggregate + projection rows. Product decides messaging, confirmation flow, and whether to promote in the UI.

13. **Refresh grace window** [README U1]: An expired device token (past `exp`) is accepted for re-mint up to 30 days past expiry; after 30 days, the user must re-bootstrap with `POST /devices`.

14. **Free-plan DAU headroom**: Cloudflare Workers Free plan offers ~100k requests/day and ~100k Durable Object requests/day. At 50k DAU each solving one puzzle and refreshing feed/leaderboard 5×/day, budget is ~500k requests. Switch to a Paid plan if DAU exceeds this headroom before launch.

---

**Summary of risk posture:** v1 mitigates high-impact operational risks (snapshot loss, key rotation, cron duplicates) through idempotent design and the `reconcile` endpoint. [UNVERIFIED] technical facts (D1 UPSERT in production, rate-limit availability, timezone support in workerd) are validated early in the milestones before they become blockers. Deliberately deferred features (Better Auth, push delivery, ORM, attestation) have clear seams and no hidden dependencies, so they can be added in v2+ without architectural rework. Anti-cheat in v1 is server-side and sufficient for launch; device attestation adds cryptographic proof later. Product decisions on replays, wheel cadence, and keyboard layouts are finalized to unblock M3; implementation can proceed without further design hold-ups.

**Validation checklist (by M0 close, M1, or M2 depending on severity):**

- [ ] **M0:** Verify D1 UPSERT/RETURNING in production smoke test (R1); confirm Rate Limiting availability on Free plan (R3); run `packages/core` tests under `@cloudflare/vitest-plugin` 1.1.3+ to validate `exports` DO declaration (R4).
- [ ] **M1:** Timezone validation (Intl.DateTimeFormat integration test for Kyiv/Kiev and all distinct timezones the client can send, comparing formatted keys not zone names, per R4); zod 4.5.4 on physical Hermes device test (R8); confirm keyboard layout final spec for Cyrillic before content import (R10).
- [ ] **M2:** iOS Keychain restore test on real device after iCloud restore (R9); key rotation rollover test in staging (R14); cron idempotency test under duplication scenarios (R17); snapshot size guard and alarm retry integration (R13).
- [ ] **Continuous:** Monitor PuzzleStats lock hold times via observability; alert on p99 latency > 1 s (R7); watch for clock skew > ±5 min between Worker and client (R12); track pool depth alerting on < 14 days ahead (R15).

