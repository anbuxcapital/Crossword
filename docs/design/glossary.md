# Crosscut Backend — Glossary & Name Registry

**Canonical registry for the Crosscut backend** (one Cloudflare Worker, modular monolith, Hono + Zod + Durable Objects + D1). All design and coding agents must use these names verbatim. Authoritative sources: `/Users/peter/Projects/IOS Crosswords/docs/research/README.md`, `gap-api-contract-freeze.md`, `gap-solve-protocol-integrity.md`, and other gap documents dated 2026-09-02.

**Date compiled:** 2026-09-02

**v1 scope note (orchestrator, 2026-09-02):** Device attestation (iOS App Attest / Play Integrity) is **v2**: `POST /v1/solves/:solveId/attest`, `attestFinish`, `attest.ts` and the `attest_keys` table are listed for completeness but must NOT be implemented in v1. v1 anti-cheat = server-side timing, server-owned locked set, wrong-guess budgets, the plausibility floor and the `suspicious` flag (suspicious solves are excluded from leaderboards). Leaderboard recording happens on `solve.finished` (via `social.recordSolve`), not on attestation.

---

## 1. Modules

| module | one-line responsibility | public index.ts exports |
|---|---|---|
| `shared` | request context, id generation, day keys, word normalisation, error classes | `RequestContext`, `dayKey`, `prevDay`, `normalizeWord`, `DomainError`, `NotInitializedError`, `MergedError` |
| `events` | envelope definition, event registry, dispatch function, subscription types | `Envelope`, `DomainEvent`, `dispatch`, `Subscription` |
| `content` | puzzle catalog (public payload + secrets), daily drops, collections manifest, admin import | `withSecret`, `collectionsContaining`, `ensureDrops`, `importPuzzles`, `importCollections`, `getStatus` |
| `player` | User DO (wallet, streak, completions, session, install tracking); projection; all per-user commands | `init`, `registerInstall`, `setPreferences`, `setTimezone`, `setPlan`, `toggleLike`, `toggleSave`, `startSolve`, `submitWord`, `spendForHint`, `pauseSolve`, `resumeSolve`, `finishSolve`, `spinWheel`, `claimCollection`, `creditPurchase`, `bumpTokenVersion`, `reconcile` |
| `identity` | device-token mint/verify/refresh; auth middleware; bootstrap; account management | `mint`, `verify`, `refresh`, `middleware`, `bootstrap`, `getMe`, `deleteMe` |
| `solving` | solve session orchestration (start, word-check, hints, finish); queries puzzle secrets | `start`, `submitWord`, `spendForHint`, `revealLetter`, `revealWord`, `getAutoCheckTicket`, `renewCheckTicket`, `pauseSolve`, `resumeSolve`, `finishSolve`, `attestFinish` |
| `economy` | wallet view, token packs, plans, wheel spin, hint prices | `getWallet`, `purchasePack`, `setPlan`, `getWheelState`, `spinWheel` |
| `social` | PuzzleStats DO (likes, solved, presence); like/save toggle; leaderboard queries | `toggleLike`, `toggleSave`, `recordSolve`, `heartbeat`, `getStats` |
| `collections` | progress tracking, unlock rule evaluation, reward claim orchestration | `getCollections`, `getDetail`, `checkAndClaim`, `unlockDependants` |
| `leaderboard` | weekly board materialisation (cron-driven), per-puzzle top solvers | `materialiseWeek`, `getWeekLeaderboard`, `getPuzzleLeaderboard` |
| `feed` | page composition (stories, ticker, streak-at-risk, wheel/mystery interleave) | `getPage`, `getDaily` |
| `notifications` | reminder deduplication, streak-break notices (cron-driven; no push in v1) | `scheduleReminderOptIn`, `cancelReminder`, `sendReminders` |
| `app` | composition root: Hono tree, wiring, module factory | `createModules`, `resolveModules`, `routes` (Hono sub-apps), `wiring.ts` (handler table) |

---

## 2. Durable Object Classes

| class | module | kind string | id scheme | env binding | wrangler exports key |
|---|---|---|---|---|---|
| `User` | `player` | `"user"` | `u_<26-char Crockford base32>` | `USER` | `"User"` |
| `PuzzleStats` | `social` | `"puzzle_stats"` | `<puzzleId>` (e.g. `en-mini-0001`) | `PUZZLE_STATS` | `"PuzzleStats"` |
| `Projections` | `packages/core` | (entrypoint) | N/A | `Projections` (loopback via `ctx.exports`) | N/A |

---

## 3. D1 Tables

| table | owning module | migration | one-line purpose |
|---|---|---|---|
| `content_puzzles` | `content` | `0001_content.sql` | Puzzle catalog (metadata, status, authors, topics, published dates) |
| `content_puzzle_secrets` | `content` | `0001_content.sql` | Solution grid, answers by clue ref, decoys (never selected by feed/puzzle routes) |
| `content_daily_drops` | `content` | `0001_content.sql` | Daily puzzle drops: one puzzle per (day, lang) pair |
| `content_collections` | `content` | `0001_content.sql` | Collection manifest (shelf, emoji, blurb, unlock rule, reward) |
| `content_collection_puzzles` | `content` | `0001_content.sql` | Collection membership (position-ordered) |
| `content_meta` | `content` | `0001_content.sql` | Key-value metadata (lastEnsureDropsAt, etc.) |
| `player_state` | `player` | `0002_player.sql` | Projection: user preferences, plan, wallet, streak, solves count, best time, merged state |
| `player_solves` | `player` | `0002_player.sql` | Fact rows (user + puzzle completions): time, hints used, tokens/stars earned, suspicious flag, board eligibility |
| `social_puzzle_stats` | `social` | `0003_social.sql` | Projection: like count, solve count, no-hint solve count, solving-now count, top 10 today |
| `leaderboard_week` | `leaderboard` | `0003_social.sql` | Cron-materialised: weekly top solvers (stars-based ranking) |
| `economy_ledger` | `economy` | `0004_economy.sql` | Projection: ledger entries from User DO (tokens earned/spent), fed by `player` projection's `extra()` |
| `economy_purchases` | `economy` | `0004_economy.sql` | Purchase ledger (token packs, plans) with client idempotency keys |
| `notifications_reminders_sent` | `notifications` | `0005_notifications.sql` | Dedupe table: reminders already sent (user + day) |
| `attest_keys` | `identity` | N/A (**v2 — no v1 migration**) | Device attestation keys (iOS App Attest, Android Play Integrity) |

---

## 4. Events

| type string | producer module | payload fields | critical subscribers | background subscribers |
|---|---|---|---|---|
| `identity.userBootstrapped` | `identity` | `userId, installId, platform, appVersion` | — | analytics |
| `player.onboarded` | `player` | `userId, level, topics, lang, plan, notifications, tz` | — | notifications.scheduleReminderOptIn |
| `player.prefsChanged` | `player` | `userId, lang?, topics?, tz?` | — | feed cache bust |
| `solve.started` | `solving` | `userId, puzzleId, solveId, at` | — | social.heartbeat (background) |
| `solve.paused` | `solving` | `userId, puzzleId, solveId, at` | — | social.leave (background) |
| `solve.resumed` | `solving` | `userId, puzzleId, solveId, at` | — | social.heartbeat (background) |
| `solve.hintUsed` | `solving` | `userId, solveId, puzzleId, kind, cost, balance` | — | analytics |
| `solve.finished` | `solving` | `userId, puzzleId, solveId, lang, dropDate, solveTimeMs, secLeft, par, hintsUsed, firstSolve, suspicious, tokensEarned, starsEarned, dayKey, streak, streakExtended` | collections.checkAndClaim → social.recordSolve | notifications.cancelReminder, analytics |
| `collections.completed` | `collections` | `userId, collectionId, reward, eventRef` | collections.unlockDependants | notifications (background) |
| `collections.unlocked` | `collections` | `userId, collectionId` | — | feed cache bust |
| `economy.wheelSpun` | `economy` | `userId, wheelId, prizeIndex, prize, balance` | — | analytics |
| `economy.packPurchased` | `economy` | `userId, packId, tokens, purchaseId, mocked` | — | analytics |
| `economy.planChanged` | `economy` | `userId, plan, expiresAt, purchaseId, mocked` | — | analytics |
| `social.likeToggled` | `social` | `userId, puzzleId, liked` | social.adjustLikes (PuzzleStats) (critical) | — |
| `social.saveToggled` | `social` | `userId, puzzleId, saved` | — | — |

---

## 5. Endpoints

All under `/v1`, JSON, base status in `2xx` response. Auth: `none` (unauthenticated), `device` (Bearer device token), `admin` (Bearer CONTENT_ADMIN_TOKEN). Rate limits: `RL_BOOT` 10/60s per IP, `RL_USER` 120/60s per user, `RL_SPEND` 20/60s per user, `RL_CHECK` 30/60s per solveId.

| # | method | path | module | auth | RL | one-line purpose |
|---|---|---|---|---|---|---|
| 1 | GET | `/config` | app | none | — | Keyboards, constants, plan/topic/lang options (cacheable 1h) |
| 2 | POST | `/devices` | identity | none | RL_BOOT | Bootstrap: mint device token + init User DO |
| 3 | POST | `/session/refresh` | identity | device (exp ≤30d ok) | RL_USER | Re-mint token with active kid |
| 4 | GET | `/me` | identity | device | RL_USER | User snapshot (strongly consistent, S) |
| 5 | DELETE | `/me` | identity | device | RL_SPEND | Purge aggregate + projection rows |
| 6 | POST | `/me/reconcile` | app | device or admin | RL_SPEND | Re-drive idempotent fan-out from snapshot |
| 7 | POST | `/me/onboarding` | player | device | RL_USER | Idempotent onboarding commit; returns /me |
| 8 | PATCH | `/me/prefs` | player | device | RL_USER | Update preferences (lang, tz ≤1/day); returns /me |
| 9 | GET | `/me/profile` | player | device | RL_USER | Profile stats from D1 (eventually consistent, P) |
| 10 | GET | `/me/saved` | player | device | RL_USER | Array of saved puzzle IDs |
| 11 | GET | `/feed` | feed | device | RL_USER | Page of daily drops + stories + ticker + interleaves (P+S) |
| 12 | GET | `/daily` | feed | device | RL_USER | Today's drop for the user's lang/tz |
| 13 | GET | `/puzzles/:id` | content | device | RL_USER | Puzzle detail (no answers; me.done/liked/saved from snapshot) |
| 14 | GET | `/puzzles/:id/leaderboard` | leaderboard | device | RL_USER | Top solvers for this puzzle (period=today) |
| 15 | GET | `/puzzles/:id/next` | content | device | RL_USER | Next unplayed puzzle in order |
| 16 | POST | `/puzzles/:id/like` | social | device | RL_USER | Toggle like; returns count |
| 17 | POST | `/puzzles/:id/save` | social | device | RL_USER | Toggle save |
| 18 | POST | `/puzzles/:id/presence` | social | device | RL_USER | Heartbeat (solving/left) for solvingNow count |
| 19 | POST | `/puzzles/:id/solves` | solving | device | RL_USER | Start a solve session (201 SolveView) |
| 20 | GET | `/solves/:solveId` | solving | device | RL_USER | Resume a solve session (or finished session) |
| 21 | GET | `/puzzles/:id/solution` | solving | device | RL_USER | Review-mode grid + answers (only if completions[id] exists) |
| 22 | POST | `/solves/:solveId/words` | solving | device | RL_USER | Submit a word (stateless check + lock) |
| 23 | POST | `/solves/:solveId/progress` | solving | device | RL_USER | **v1 REMOVED** — superseded by server-owned locked set |
| 24 | POST | `/solves/:solveId/hints/fifty` | solving | device | RL_SPEND | 50/50 hint (20 tokens) |
| 25 | POST | `/solves/:solveId/hints/fifty/pick` | solving | device | RL_USER | Pick one of the 50/50 options (no charge) |
| 26 | POST | `/solves/:solveId/hints/letter` | solving | device | RL_SPEND | Reveal one letter (40 tokens) |
| 27 | POST | `/solves/:solveId/hints/word` | solving | device | RL_SPEND | Reveal whole word (100 tokens) |
| 28 | POST | `/solves/:solveId/autocheck` | solving | device | RL_USER | Toggle autocheck on/off; returns ticket if on |
| 29 | POST | `/solves/:solveId/check` | solving | device | RL_CHECK | Per-cell check (needs autocheck ticket) |
| 30 | POST | `/solves/:solveId/pause` | solving | device | RL_USER | Pause the timer |
| 31 | POST | `/solves/:solveId/resume` | solving | device | RL_USER | Resume the timer |
| 32 | POST | `/solves/:solveId/finish` | solving | device | RL_USER | Submit completed grid; returns SolveResult |
| 33 | POST | `/solves/:solveId/attest` | solving | device | RL_USER | **v2 — not in v1.** Post iOS/Android attestation |
| 34 | GET | `/collections` | collections | device | RL_USER | Shelves + collection cards (progress, locks) (P) |
| 35 | GET | `/collections/:id` | collections | device | RL_USER | Collection detail (members list) (P) |
| 36 | POST | `/collections/:id/claim` | collections | device | RL_SPEND | Claim reward (idempotent) |
| 37 | GET | `/leaderboard/week` | leaderboard | device | RL_USER | Global weekly top solvers (C) |
| 38 | GET | `/wallet` | economy | device | RL_USER | Balances, pack prices, ledger (S) |
| 39 | POST | `/wallet/purchases` | economy | device | RL_SPEND | Mock token pack purchase (idempotent key) |
| 40 | POST | `/billing/plan` | economy | device | RL_SPEND | Mock plan subscription (idempotent key) |
| 41 | GET | `/wheel` | economy | device | RL_USER | Wheel state (canSpin, lastPrize) (S) |
| 42 | POST | `/wheel/:wheelId/spin` | economy | device | RL_SPEND | Spin wheel (once per local day); returns prize |
| 43 | POST | `/admin/content/import` | content | admin | — | Bulk import puzzles (≤50, ≤512 KB); validate + upsert |
| 44 | GET | `/admin/content/status` | content | admin | — | Pool depth, next drops, byStatus, lastEnsureDropsAt |
| 45 | POST | `/admin/collections/import` | collections | admin | — | Bulk import collections + members |
| 46 | GET | `/healthz` | app | none | — | Health check (200 `{ ok: true }`) |

---

## 6. Error Codes & HTTP Status

All errors use envelope: `{ error: { code, message?, details?, issues?, requestId } }`. Domain error codes are the message content in Workers RPC (errors cross as `{ name, message }` only).

| HTTP | code | meaning | details | client action |
|---|---|---|---|---|
| 400 | `invalid_request` | Zod validation failed | `{ target, issues: z.treeifyError(...) }` | bug; do not retry |
| 400 | `invalid_cursor` | Cursor undecodable or page > 10 | `{ reason }` | restart feed from page 1 |
| 400 | `bad_json` | Body not JSON / wrong content-type | — | bug |
| 401 | `unauthenticated` | No/invalid bearer; sig fail; typ ≠ "device" | — | re-bootstrap |
| 401 | `token_expired` | Token exp passed | `{ refreshable: boolean }` | refresh if refreshable, else re-bootstrap |
| 401 | `token_key_unknown` | kid not in keyring | — | re-bootstrap |
| 401 | `token_revoked` | tokenVersion advanced | — | re-bootstrap |
| 402 | `insufficient_tokens` | Hint/spend needs more tokens | `{ balance, cost, kind }` | route to Wallet |
| 403 | `forbidden` | Admin token wrong; solve belongs to another user; not completed (Review) | — | none |
| 404 | `not_found` | No route | — | bug |
| 404 | `puzzle_not_found` | Puzzle ID unknown | `{ id }` | refresh screen |
| 404 | `solve_not_found` / `solve_gone` | Session unknown or replaced | `{ puzzleId }` (gone only) | get /me or start new solve |
| 404 | `collection_not_found` | Collection ID unknown | `{ id }` | refresh |
| 404 | `wheel_not_found` | Wheel ID unknown | `{ id }` | refresh |
| 404 | `no_drop` | No drop for (day, lang) | — | refresh |
| 409 | `no_active_session` | solveId is neither active session nor lastResult | `{ activeSolveId }` | get /me or start new |
| 409 | `already_spun` | Wheel for that wheelId already spun today | `{ wheel }` | show result |
| 409 | `already_claimed` | Collection reward already credited | `{ collectionId }` | refresh |
| 409 | `purchase_conflict` | idempotencyKey reused with different payload | `{ idempotencyKey }` | use new key |
| 409 | `tz_change_limit` | Second tz change in same local day | `{ nextAllowedAt }` | keep old tz |
| 409 | `merged` | Aggregate merged into an account | `{ mergedInto, token }` | swap token |
| 409 | `paused` | Command not allowed while paused (e.g. submitWord) | — | resume first |
| 413 | `payload_too_large` | Body exceeds bodyLimit | — | bug |
| 422 | `wrong_grid` | Submitted grid ≠ solution | `{ wrongCells: [r,c][] }` | keep playing |
| 422 | `bad_lock_proof` | lockProof does not match locked | — | resync via GET /solves/:id |
| 422 | `bad_question` | Question index out of range | `{ questionIndex }` | bug |
| 422 | `question_locked` | Hint on an already-locked question | `{ questionIndex }` | no-op |
| 422 | `bad_word` | Word length ≠ slot length or letters outside alphabet | `{ questionIndex }` | bug |
| 422 | `guess_budget` | Wrong-guess budget exhausted (per question or solve) | `{ questionIndex, perQuestion, perSolve }` | use hints or wait for crossing locks |
| 422 | `check_budget` | Autocheck ticket budget exhausted (≤6 per solve) | — | "Autocheck takes a break on your next puzzle" |
| 422 | `bad_tz` | IANA zone rejected by Intl.DateTimeFormat | `{ tz }` | fall back to device zone |
| 422 | `collection_incomplete` | Not all members solved | `{ done, total }` | finish members |
| 422 | `collection_locked` | Unlock rule not met | `{ lock: LockRule }` | none |
| 422 | `solve_finished` | Command on a finished session (replay or review) | — | get /me |
| 422 | `invalid_puzzle` (admin) | Validator rejected content | `{ rejected: [{ id, issues }] }` | fix content |
| 429 | `rate_limited` | RL_BOOT/RL_USER/RL_SPEND/RL_CHECK exceeded | `{ retryAfterSec, scope }` | back off + Retry-After header |
| 500 | `internal` | Unexpected | — | generic error + requestId |
| 503 | `retry_later` | err.retryable (D1/DO transient) | `{ retryAfterSec }` | retry + Retry-After + Backoff-Jitter |

---

## 7. Files & Structure

```
workers/gateway/
  wrangler.jsonc                                    [config]
  worker-configuration.d.ts                         [generated by wrangler types, committed]
  vitest.config.ts                                  [test config]
  tsconfig.json                                     [typescript, target ES2022, module ESNext]
  .gitignore                                        [.wrangler/, .dev.vars*]
  
  migrations/
    0001_content.sql                                [content_* tables]
    0002_player.sql                                 [player_* tables]
    0003_social.sql                                 [social_*, leaderboard_* tables]
    0004_economy.sql                                [economy_* tables]
    0005_notifications.sql                          [notifications_* tables]
  
  seed/
    0001_content.sql                                [seed script: four prototype puzzles + collections]
  
  test/
    setup.ts                                        [onUnhandledError filter]
    env.d.ts                                        [TEST_MIGRATIONS binding; Cloudflare.Env type defs]
    arch.test.ts                                    [import boundaries + SQL table prefixes]
    http/
      bootstrap.test.ts                             [POST /devices → /me round trip]
      feed.test.ts                                  [GET /feed pagination, no duplicates]
      solving.test.ts                               [full solve with replay, replay earns 0]
      identity.test.ts                              [unknown kid 401, token refresh, RL_BOOT]
      social.test.ts                                [like/save, leaderboard serialisation]
      collections.test.ts                           [claim reward once, unlock dependants]
  
  src/
    app/
      index.ts                                      [exports: default { fetch, scheduled }, routes: type]
      app.ts                                        [Hono({ strict: false }) + middleware stack]
      wiring.ts                                     [HandlerTable: static event subscriptions]
      modules.ts                                    [createModules(ctx, env), resolveModules(env, ctx)]
    
    shared/
      index.ts                                      [export * from module files below]
      context.ts                                    [RequestContext type; extraction from Hono c]
      errors.ts                                     [DomainError, NotInitializedError, MergedError]
      ids.ts                                        [userId/solveId generation; Crockford base32]
      time.ts                                       [dayKey(ms, tz), prevDay(day), applyStreak]
      normalise.ts                                  [normalizeWord(lang, s); per-lang alphabet tables]
    
    events/
      index.ts                                      [export * from below]
      envelope.ts                                   [Envelope type: id, type, v, occurredAt, actor, payload]
      registry.ts                                   [defineEvent, EventOf<T>, DomainEvent = discriminatedUnion]
      dispatch.ts                                   [dispatch(table, events[], ctx): DispatchReport; depth guard, seen dedup]
    
    modules/
      content/
        index.ts                                    [withSecret, collectionsContaining, ensureDrops, import*, getStatus]
        contract.ts                                 [DTO + event payload Zod schemas; examples]
        http.ts                                     [GET /puzzles/:id, /daily, /collections, /admin/content/*]
        subscriptions.ts                            [none; content is a read model]
        internal/
          db.ts                                     [SQL queries: content_* tables]
          cache.ts                                  [isolate cache: withSecret, collectionsContaining]
          drop-cron.ts                              [ensureDrops; scheduled handler]
          validator.ts                              [Zod + structural checks on puzzle JSON]
        test/
          ...test.ts                                [validator fixtures, seeding, drop idempotency]
      
      player/
        index.ts                                    [init, registerInstall, setPreferences, startSolve, finishSolve, claimCollection, spinWheel, reconcile, etc.]
        contract.ts                                 [Zod schemas; examples]
        http.ts                                     [GET /me, /me/profile, POST /me/onboarding, PATCH /me/prefs, DELETE /me, POST /me/reconcile]
        subscriptions.ts                            [none; player is a write model]
        internal/
          user.do.ts                                [User Durable Object; UserState, all commands]
          db.ts                                     [versionedUpsert for player_state + player_solves batch]
          projection.ts                             [Projections.apply override for kind === "user"]
        test/
          ...test.ts                                [finish → tokens/stars, streak/day boundary, wheel once/day, session recovery on alarm]
      
      identity/
        index.ts                                    [mint, verify, refresh, bootstrap, getMe, deleteMe]
        contract.ts                                 [Zod schemas (DeviceSession, MeView, OnboardingBody, PrefsPatch); examples]
        http.ts                                     [POST /devices, /session/refresh, GET /me, DELETE /me, POST /me/onboarding, PATCH /me/prefs]
        subscriptions.ts                            [none]
        internal/
          jwt.ts                                    [HS256 sign/verify; kid rotation]
          middleware.ts                             [deviceAuth middleware; RL_BOOT, RL_USER per user]
          bootstrap.ts                              [User.init, registerInstall logic]
        test/
          ...test.ts                                [bootstrap → token 365d exp, unknown kid 401, refresh ≤30d expired, RL limits]
      
      solving/
        index.ts                                    [start, submitWord, spendForHint, pauseSolve, resumeSolve, finishSolve, attestFinish]
        contract.ts                                 [Zod: SolveView, WordsBody/Result, HintBody/Result, FinishBody, SolveResult; examples]
        http.ts                                     [POST /puzzles/:id/solves, GET /solves/:id, /solution, /words, /pause, /resume, /finish, /hints/*, /check; POST /attest]
        subscriptions.ts                            [none; solving is a command handler]
        internal/
          logic.ts                                  [sweep(), questions(), timeBonus(), starsFor(); replay detection]
          anti-cheat.ts                             [S1–S4 flags: plausibility, typing floor, too-clean, check-heavy; suspicion verdict]
          autocheck-ticket.ts                       [HMAC-SHA256 ticket issue/verify; 10m TTL, 6/solve limit]
          attest.ts                                 [Apple App Attest + Play Integrity decode/verify (v2 stub)]
        test/
          ...test.ts                                [full solve 5×5 earns floor(secLeft/5) tokens; replay earns 0; hint 19 tokens → 402; words claim all → finish inline; finish idempotent]
      
      economy/
        index.ts                                    [getWallet, purchasePack, setPlan, getWheelState, spinWheel]
        contract.ts                                 [Zod: WalletView, WheelView, PurchaseBody/Result, PlanView; examples]
        http.ts                                     [GET /wallet, /wheel, POST /wallet/purchases, /billing/plan, /wheel/:wheelId/spin]
        subscriptions.ts                            [EMPTY FILE; economy has no subscribers (collections owns reward claim)]
        internal/
          db.ts                                     [INSERT economy_purchases with idempotency key]
        test/
          ...test.ts                                [pack/plan purchase idempotent; wheel once/day; already_spun 409]
      
      social/
        index.ts                                    [toggleLike, toggleSave, recordSolve, heartbeat]
        contract.ts                                 [Zod: LikeResult, SaveResult, PresenceResult; examples]
        http.ts                                     [POST /puzzles/:id/like, /save, /presence]
        subscriptions.ts                            [onSolveFinished → recordSolve; onLikeToggled → adjustLikes]
        internal/
          puzzle-stats.do.ts                        [PuzzleStats Durable Object; heartbeat memory-mapped to commits]
          db.ts                                     [recordSolve: upsert social_puzzle_stats; topToday keyed by boardDay, not dayKey]
        test/
          ...test.ts                                [100 heartbeats ≤2 commits; topToday resets on new day; likes never negative; likeToggled → adjustLikes critical]
      
      collections/
        index.ts                                    [getCollections, getDetail, checkAndClaim, unlockDependants]
        contract.ts                                 [Zod: CollectionsView, CollectionDetail, ClaimResult; examples]
        http.ts                                     [GET /collections, /collections/:id, POST /collections/:id/claim]
        subscriptions.ts                            [onSolveFinished → checkAndClaim (critical); onCompleted → unlockDependants (critical)]
        internal/
          db.ts                                     [content_collection_puzzles + player_solves join; player.claimCollection call]
        test/
          ...test.ts                                [completing all members grants reward once; unlockDependants emits; depend cycles prevented]
      
      leaderboard/
        index.ts                                    [materialiseWeek, getWeekLeaderboard, getPuzzleLeaderboard]
        contract.ts                                 [Zod: LeaderboardRow, PuzzleLeaderboard, WeekLeaderboard; examples]
        http.ts                                     [GET /puzzles/:id/leaderboard, /leaderboard/week]
        subscriptions.ts                            [none; leaderboard is cron-materialised]
        internal/
          db.ts                                     [materialise leaderboard_week from player_solves (exclude suspicious, board_shadow)]
          cron.ts                                   [*/5 cron handler]
        test/
          ...test.ts                                [cron re-run idempotent; excludes suspicious; weekly sums stars per user]
      
      feed/
        index.ts                                    [getPage, getDaily]
        contract.ts                                 [Zod: FeedQuery, FeedPage, FeedItem, DailyView; examples]
        http.ts                                     [GET /feed, /daily]
        subscriptions.ts                            [none; feed is a read composer]
        internal/
          db.ts                                     [JOIN content_daily_drops ⋈ content_puzzles ⋈ social_puzzle_stats ⋈ player_solves; cursor pagination]
          interleave.ts                             [gateway inserts streak_save, wheel/mystery at positions 1, 3, 6n]
        test/
          ...test.ts                                [no cursor duplicates; feed first page caches 30–60s per (lang, today); lang override binds into cursor]
      
      notifications/
        index.ts                                    [scheduleReminderOptIn, cancelReminder, sendReminders]
        contract.ts                                 [Zod schemas; examples]
        http.ts                                     [none in v1]
        subscriptions.ts                            [onOnboarded → scheduleReminderOptIn; onSolveFinished → cancelReminder (background); onCollectionsCompleted → none]
        internal/
          db.ts                                     [notifications_reminders_sent dedupe table]
          cron.ts                                   [0 * * * * reminder cron]
        test/
          ...test.ts                                [reminders sent once per (user, day); cron idempotent]

packages/shared/src/
  index.ts                                          [export * from below]
  
  constants.ts                                      [PAR_MINI, PAR_CROSS, HINT_COST, WHEEL_PRIZES, TOKEN_PACKS, PLANS, TOPICS, alphabet tables, MAX_DEPTH, MAX_EVENTS_PER_REQUEST, token TTL / refresh grace]
  
  wire/
    primitives.ts                                   [Lang, DayKey, IsoDateTime, Tokens, Balances, Difficulty, PuzzleKind, Size, ParSec, Level, Topic, NotificationsChoice, Tz, Cell, GridRow, Letter]
    ids.ts                                          [PuzzleId, UserId, SolveId, CollectionId, WheelId, IdempotencyKey, Cursor; Crockford base32 regex]
    errors.ts                                       [ErrorCode, ErrorEnvelope, InsufficientTokensDetails, DOMAIN_STATUS mapping]
    i18n.ts                                         [DayState, Kicker, PuzzleMeta, ClueRef, CountUnit, LockRule, TickerItem, WeekStrip]
    identity.ts                                     [DeviceBody, DeviceSession]
    me.ts                                           [StreakView, ContinueView, WheelState, MeView, OnboardingBody, PrefsPatch, ProfileView, SavedView, ReconcileReport]
    feed.ts                                         [FeedQuery, FeedItem, FeedPage, DailyQuery, DailyView]
    puzzle.ts                                       [Setter, CoverView, CoverClue, PuzzleStatsView, PuzzleView, PuzzleLeaderboard, NextView, LeaderboardRow, WeekLeaderboard]
    solve.ts                                        [QuestionView, SolveView, SolveSession, SolveStatus, WordsBody, WordsResult, ProgressBody, HintBody, FiftyResult, FiftyPickBody, LetterHintBody, LetterResult, WordHintBody, WordHintResult, CheckBody, CheckResult, TimerView, FinishBody, SolveResult, SolveResult.Completion, BoardStatus, BoardEligibility]
    economy.ts                                      [WalletView, PurchaseBody, PurchaseResult, PlanBody, PlanView, WheelView, SpinBody, SpinResult]
    collections.ts                                 [CollectionCard, Shelf, CollectionsView, CollectionDetail, ClaimResult]
    social.ts                                       [LikeBody, LikeResult, SaveBody, SaveResult, PresenceBody, PresenceResult]
    config.ts                                       [KeyboardLayout, ConfigView]
    admin.ts                                        [ImportBody, ImportReport, ContentStatus]
  
  puzzle/
    validator.ts                                    [Zod + structural validator; splitPuzzle()] [used at content admin import time]
    normalise.ts                                    [normalizeWord(lang, s) per-lang alphabet]
  
  events/
    envelope.ts                                     [Envelope schema; re-exported by each module contract]
    <module-event>.ts                               [Event payload schemas for each module (strictObject + discriminatedUnion)]

packages/core/src/  (copied from ~/Projects/IOSApp/packages/core)
  index.ts                                          [export Aggregate, Projections, aggregateStub, DomainError]
  aggregate.ts                                      [Aggregate<State, Env> base class; commit(), snapshot(), projectionFingerprint() hook]
  projections.ts                                    [ProjectionsBase; Projections entrypoint; apply() override for kind === "user"]
  errors.ts                                         [RPC-safe error classes]

packages/api-client/src/
  index.ts                                          [hcWithType: typed RPC client; generated from workers/gateway's emitted .d.ts via tsc --emitDeclarationOnly]

content/
  puzzles/
    en/
      en-mini-0001.json                             [prototype: 5×5 word-square]
      en-mini-0002.json                             [prototype: 5×5 standard]
      en-cross-0001.json                            [prototype: 9×9]
    uk/
      uk-mini-0001.json                             [translated prototype]
    ru/
      ru-mini-0001.json                             [translated prototype]
  
  collections.json                                  [manifest: theme/size/setter/archive shelves + unlock rules + rewards]
  
  wordbank/
    en.txt                                          [EN word list: WORD;score;topics]
    uk.txt                                          [UK word list (LLM-drafted + native review)]
    ru.txt                                          [RU word list (LLM-drafted + native review)]
  
  scripts/
    gen-crossword.mjs                               [CSP filler: pattern → slots → MRV + forward checking]
    draft-clues.mjs                                 [Claude Batches: clue generation via messages.parse]
    validate-and-seed.mjs                           [Content validator; seed SQL generator]

Root config files:
  pnpm-workspace.yaml                               [allowBuilds: { esbuild: true, workerd: true }, catalog, minimumReleaseAge: 0]
  package.json                                      [root workspace; devDependencies: turbo, typescript, @biomejs/biome]
  turbo.json                                        [tasks: types (worker-configuration.d.ts), typecheck, lint, test, dev]
  tsconfig.json                                     [extends: strict, noEmit, isolatedModules, composite, references to packages/*]
  .gitignore                                        [.wrangler/, .dev.vars*, node_modules, dist, coverage]
```

---

## 8. Constants

| name | value | defined in | note |
|---|---|---|---|
| `PAR_MINI` | 300 | `packages/shared/src/constants.ts` | seconds; 5×5 puzzle par |
| `PAR_CROSS` | 600 | `packages/shared/src/constants.ts` | seconds; 9×9 puzzle par |
| `HINT_COST` | `{ fifty: 20, letter: 40, word: 100 }` | `packages/shared/src/constants.ts` | tokens per hint type |
| `WHEEL_PRIZES` | `[50, 10, 0, 25, 5, 15]` | `packages/shared/src/constants.ts` | token amounts by prize index |
| `STAR_SOLVE` | 10 | `packages/shared/src/constants.ts` | base stars for completion |
| `STAR_NO_HINT` | 2 | `packages/shared/src/constants.ts` | bonus stars if no hints used |
| `TOKEN_PACKS` | `[{id:"p120", tokens:120, priceCents:99}, {id:"p550", tokens:550, priceCents:399, badge:"popular"}, {id:"p1400", tokens:1400, priceCents:899, badge:"best_value"}]` | `packages/shared/src/constants.ts` | mock purchase options |
| `PLANS` | `[{tier:"lite", price:0}, {tier:"month", priceCents:399, durationDays:30}, {tier:"year", priceCents:2399, durationDays:365}]` | `packages/shared/src/constants.ts` | subscription tiers |
| `TOPICS` | `["travel", "movies", "food", "science", "music", "sport", "art", "words"]` | `packages/shared/src/constants.ts` | enum keys, lowercase slugs |
| `MAX_DEPTH` | 4 | `packages/shared/src/constants.ts` | event dispatch nested causation depth guard |
| `MAX_EVENTS_PER_REQUEST` | 64 | `packages/shared/src/constants.ts` | event dispatch per-request event count guard |
| `RL_BOOT` | 10/60s per IP | `workers/gateway/wrangler.jsonc` | device bootstrap rate limit |
| `RL_USER` | 120/60s per user | `workers/gateway/wrangler.jsonc` | general API rate limit |
| `RL_SPEND` | 20/60s per user | `workers/gateway/wrangler.jsonc` | hints, purchases, spins rate limit |
| `RL_CHECK` | 30/60s per solveId | `workers/gateway/wrangler.jsonc` | autocheck per-cell `check` rate limit |
| `TOKEN_TTL` | 365 days | `workers/gateway/src/identity/internal/jwt.ts` | device token expiration |
| `TOKEN_REFRESH_GRACE` | 30 days | `workers/gateway/src/identity/http.ts` | max age of expired token accepted for refresh |
| `CHECK_TICKET_TTL` | 600,000 ms (10 min) | `packages/shared/src/constants.ts` | autocheck ticket validity |
| `CHECK_TICKETS_PER_SOLVE` | 6 | `packages/shared/src/constants.ts` | max autocheck ticket renewals per solve |
| `WRONG_PER_QUESTION` | 20 | `packages/shared/src/constants.ts` | wrong-guess budget per question |
| `WRONG_PER_SOLVE` | 100 | `packages/shared/src/constants.ts` | wrong-guess budget per solve |
| `MIN_PLAUSIBLE_MS` | `max(12_000, 400 × fillableCells)` | `workers/gateway/src/solving/internal/anti-cheat.ts` | plausibility floor (S1 rule) |
| `TYPING_FLOOR_MS_PER_CHAR` | 80 | `packages/shared/src/constants.ts` | typing speed floor per character (S2 rule) |
| `ALPHABETS` | `{ en: 26 letters, uk: 33 (no Ё Ъ Ы Э), ru: 32 (Ё folded to Е) }` | `packages/shared/src/constants.ts` | per-language valid letters post-normalisation |

---

## Naming Conflict Resolutions

1. **`execute` / `exec`**: Conflict between README's `ExecutionContext` and `exec` abbreviation. **Decision (R)**: Use `ctx: ExecutionContext` in handlers; abbreviate as `ctx.exec` for `waitUntil` access (matches Hono convention; README's inconsistency resolved by using full form).

2. **`session` field in SolveSession vs `session` in UserState**: Both in `player/internal/user.do.ts`. **Decision (R)**: `UserState.session: SolveSession | null` (reading context makes it unambiguous; no conflict).

3. **`lastResult` vs `result`**: Session has `lastResult` (the cached SolveResult after finish). Response field is `result: SolveResult` inside `WordsResult`. **Decision (R)**: Clarify by context: `session.lastResult` is the cache; `words response.result` is the payload (gap-solve-protocol-integrity R2, SolveSession shape).

4. **`dayKey` (user-local calendar day) vs `boardDay` (puzzle's drop-date for leaderboard)**: README used both interchangeably. **Decision (gap-api-contract-freeze.md F3)**: `recordSolve({ boardDay })` where `boardDay = event.dropDate ?? utcDay(event.occurredAt)`. Events carry both as separate fields; code must use the right one per context.

5. **Event type `solve.finished` vs producer module `solving`**: Naming conflict on module prefix. **Decision (orchestrator, 2026-09-02)**: keep README.md's canonical family `solve.*` (`solve.started`, `solve.paused`, `solve.resumed`, `solve.hintUsed`, `solve.finished`) exactly as listed in section 4 above — the `<producingModule>.<pastTenseFact>` rule applies to every other module; the `solving` module's event family is spelled `solve.*` for brevity. Never write `solving.finished`.

6. **`locked` (client-supplied set from prototype) vs `locked: number[]` (server-owned in DO)**: Server owns the locked set per gap-solve-protocol-integrity R1. **Decision (orchestrator, 2026-09-02)**: `locked` is server-owned; client sends only `questionIndex` and `word` in POST /solves/:solveId/words. Internal session `locked: number[]` is server-maintained.

7. **Hint idempotency key (solveId, questionIndex, kind) vs the three-tuple stored in `hintLog`**: No conflict; `hintLog` is a timestamped record, idempotency is detected by `(solveId, q, kind)` lookup. **Decision (R)**: Keep both (gap-solve-protocol-integrity R2: hints are idempotent per tuple; log is timestamped for telemetry).

---

## Summary

- **Modules: 12** (shared, events, content, player, identity, solving, economy, social, collections, leaderboard, feed, notifications, app)
- **Durable Objects: 3** (User, PuzzleStats, Projections)
- **D1 Tables: 13** (6 content, 2 player, 1 social, 1 leaderboard, 2 economy [purchases + ledger], 1 notifications, 1 attest_keys v2-only)
- **Events: 15** (solve.*, player.*, collections.*, economy.*, social.*, identity.*)
- **Endpoints: 46** (REST routes under `/v1` including autocheck; endpoint 23 removed; all base statuses in 2xx response)
- **Error codes: 40** (covering 400, 401, 402, 403, 404, 409, 413, 422, 429, 500, 503; added bad_ticket, NOT_FINISHED)
- **Files: ~120** (root config, workers/gateway, packages/shared, packages/core, packages/api-client, content/)
- **Constants: 25** (game rules, economy, rate limits, policy thresholds)

**Conflicts resolved: 7** — all in favour of README.md and gap docs as primary sources; no substantive renaming required.
