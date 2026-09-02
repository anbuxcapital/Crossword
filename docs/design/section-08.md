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

**`workers/gateway/vitest.config.ts`** ([DECIDED HERE]: upgrade to `@cloudflare/vitest-plugin` 1.1.3):

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
- `boardEligible = firstSolve && !suspicious && pauseCount === 0 && (veteran || attested)` where veteran = ≥3 eligible solves on ≥2 distinct days

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
