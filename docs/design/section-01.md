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
`player` owns the single `User` Durable Object that holds all per-user state (wallet, streak, completions, session, likes, saves, preferences, wheel, etc.). Slice modules (economy, solving, collections, social) are *responsibilities* that delegate through `player/index.ts` to command methods on the `User` aggregate. This keeps one aggregate per user, ensuring atomic commits for coupled operations (e.g., "finish a puzzle" = tokens + stars + streak + completion + session close in one transaction). [DECIDED HERE]

**Why `feed` sits at the top:**
Feed is a pure read-side page composer. It queries (never mutates) multiple modules' read models via their query APIs (`content.withSecret`, `player.getSnapshot`, `social.getStats`, `collections.getCollections`) and interleaves results with gateway-computed rows (streak-at-risk card, wheel state, mystery cells). It has no subscribers and no domain events.

### Import rules

Cross-module imports are governed by strict compiler-enforced boundaries:

1. **Sanctioned cross-module imports:** A module may import from another module only via that module's two public files: `modules/<name>/index.ts` (exported commands and queries) and `modules/<name>/contract.ts` (Zod schemas for events and DTOs). All other files in a module (`internal/**`, `http.ts`, `subscriptions.ts`) are private.

2. **Forbidden directions:** The dependency graph must remain a DAG; therefore, a module must never import from `app/` (composition root) or from any module higher in the layer chart above it.

3. **Kernel isolation:** `shared/` and `events/` import nothing from `modules/`; they form the kernel and may only depend on each other.

4. **Composition root privilege:** Only `app/index.ts`, `app/app.ts`, `app/wiring.ts` and `app/modules.ts` may import from any module or directly invoke Durable Objects. No module imports from `app/`.

5. **Subscriber command rule (event handlers):** When a subscriber module's handler receives an event and needs to command other modules, it may only command its own module (no-op idempotency via aggregate state) or the `player` module (shared per-user aggregate); it may not command a third module. To influence a third module, the handler publishes a follow-on integration event that the third module subscribes to. This keeps the dispatcher acyclic and limits the depth of cascading events. [DECIDED HERE]

### Ports rule: how modules are injected and extracted

**In-process (monolith):** `src/app/modules.ts` exports `createModules(ctx: RequestContext)` which returns a `Modules` record binding all module APIs to the current request context. Each module's `index.ts` exports env-free functions (commands and queries) that take a `RequestContext` as their first argument; `createModules` partially applies that context, so callers write `modules.economy.credit({...})` with no context argument visible. Route handlers and subscribers receive this `Modules` object on Hono's context (`c.get("modules")`).

**Extraction (later, via Workers RPC):** When a module is split to its own Worker, the same `createModules` file resolves the module's binding one way: if `env.BINDING` exists (post-split, a service binding), use it; otherwise, use `ctx.exports.ClassName` (loopback, in-process). The binding is typed as `Service<import("...").ClassName>` (Workers RPC), which has the same method signatures as the in-process object. Callers never change; the call site is identical before and after extraction. [DECIDED HERE]

**Concrete example:** Today, `modules/economy/index.ts` exports `export const economy = { credit, debit, spinWheel, ... }` and is imported as `import { economy } from "../modules/economy"`. After extraction to `workers/economy`, `app/modules.ts` checks `env.ECONOMY` and returns either the service binding or the loopback stub. The caller's code remains `modules.economy.credit({...})`, and the RPC-safe DTOs in `economy/contract.ts` (plain JSON, no class instances) are already structured for transmission.
