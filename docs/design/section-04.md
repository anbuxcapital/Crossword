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
6. **User DO commit** (if correct): `{ locked += q, sweep(topology) → recursively lock dependent questions, locks.push({q, at: now, typed: true, swept: [...]}), guesses.total++ }` [DECIDED HERE: sweep is server-owned, not client-claimed]
7. **If all questions locked**: inline finish (flow 6, same commit)
8. **No D1 write** (session-only commit; projected ≠ version, no flush unless finishing)
9. **Response**: `WordResult { correct, locked, newlyLocked, fixedLetters: [] or [for newly locked only], nextQuestionIndex, complete }`

**Cost**: 1 DO round-trip (submitWord) · 0 D1 · 0 events (no-op or guess) · **Errors**: 409 `no_active_session`, 409 `paused`, 422 `solve_finished`, 422 `guess_budget`, 422 `question_locked` (already locked)

---

### (6) Submit finishing word + rewards, streak, completion, projection flush `POST /v1/solves/:solveId/words` (all locked)

1. **(Steps 1–4 as flow 5, then inline finish inside `User.submitWord`)**
2. **User DO inline finish commit** (same transaction as lock): `{ elapsedMs = now − startedAt − pausedMs, secLeft = max(0, floor((parSec × 1000 − elapsedMs) / 1000)), suspicious = S1 || S2 [DECIDED HERE: server-side plausibility + typing floor checks], tokens = replay || suspicious ? 0 : floor(secLeft / 5), stars = replay ? 0 : 10 + (hintsUsed === 0 ? 2 : 0), completions[puzzleId] = {day: dayKey(now, tz), solvedAt, timeMs: elapsedMs, hintsUsed, tokens, stars, suspicious, boardEligible, telemetry: {typed, swept, wrong, checks, hints, pauses, …}}, applyStreak(dayKey(now, tz)), stats: {solved++}, session.status = "finished", finishedAt = now, lastResult = SolveResult (cached), ledgerSeq++ }`
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
4. **player.spendForHint(userId, solveId, "fifty", 20 tokens, now)** → **User.spendForHint** (DO command): check `tokens ≥ 20` else return 402 `INSUFFICIENT_TOKENS { balance, cost: 20, kind: "fifty" }` → debit tokens → `hintsUsed++, hintLog.push({q, kind: "fifty", cost: 20, at: now})` [DECIDED HERE: idempotent by (solveId, q, kind); retried request returns same options without re-debiting]
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
4. [DECIDED HERE: pauseCount recorded; boardEligible requires pauseCount === 0]

**Cost**: 1 DO per command · 0 D1 · 0 events · **Errors**: 409 `paused` (on any command while paused), 409 `no_active_session`

---

### (11) Wheel spin `POST /v1/wheel/:wheelId/spin`

1. **Gateway middleware**: `deviceAuth` (RL_SPEND: 20/60s)
2. **economy.http** → `zValidator("param", { wheelId })` → `economy.spinWheel(wheelId, userId, now)`
3. **User.spinWheel** (DO command): parse `wheelId = dayKey(now, tz) + ":base"` → check `lastSpinDay !== dayKey(now, tz)` else 409 `already_spun` → `crypto.getRandomValues(new Uint8Array(4))` → index modulo WHEEL_PRIZES length → debit (or credit if negative prize) → `wheel.lastSpinDay = dayKey, lastPrize = prize, lastIndex = index`
4. **No D1**; once per local day [DECIDED HERE: picked server-side, not client-sent]
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
3. **Reminder cron**: query `player_state` where `streak.atRisk AND (local_day_ends_at - now < 2 hours)` → for each: `notifications.scheduleReminder(userId, dayKey)` → `INSERT OR IGNORE INTO notifications_reminders_sent (user_id, day_key)` → no-op if already sent today [DECIDED HERE: not pushed in v1, scheduled for later]
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

## Summary

- **Total DO round-trips per solve session**: bootstrap (1) → start (1) → per word (1 each, ≈5–10) → finish (1 critical) + optionally PuzzleStats (1 read) = **8–13 per session**
- **D1 statements**: bootstrap (1 async), feed page (≤30), finish (1 batch atomic), crons (≤ 100 per hour) = **negligible outside crons** (~0.5M rows/month at 50k DAU)
- **Events per solve** (finish dispatch): `solve.finished` → `collections.completed` → `collections.unlocked` → `player.streakExtended` (background) → `notifications.cancelReminder` (background) → **3 critical, 2 background**
- **Rate limits**: `RL_BOOT` 10/60s (bootstrap only), `RL_USER` 120/60s (all authenticated), `RL_SPEND` 20/60s (hints, purchases, spins, wheel), new `RL_CHECK` 30/60s (autocheck per solve)
- **Middleware order (all requests)**: requestId → timing → structured logger → secureHeaders → bodyLimit(64 KB) → deviceAuth (RL per endpoint) → createModules → route handler
- **Critical path invariants**: User DO serializes all money-affecting commands (spendForHint, submitWord finishing, wheel, claimCollection, purchase); PuzzleStats handles like/unlike; solutions never serialized in responses except grid cell letters for locked words or full Review after completion
