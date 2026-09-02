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

**[DECIDED HERE]** The following changes are mandatory for Crosscut v1:

1. **`projectionFingerprint(state)`** hook (fixes D1 write bloat): `commit()` compares a fingerprint of state (rather than full JSON) to decide whether to flush. `User.projectionFingerprint` returns state without the `session` field. Without this, ≈12 per-DAU per-day `submitWord` commits that only touch `session` would trigger 3 D1 writes each (54 M rows/month at 50k DAU ⇒ +$37/month), but the hook ensures only `finishSolve` (which changes `completions`, `wallet`, `streak`) flushes to D1. Core change: in `#persist`, compute `JSON.stringify(projectionFingerprint(prev))` and `…(next)`; when equal, mark `projected = version` and skip `flush()`.

2. **`Projections.apply(…, attachments)`** hook for side tables: Allow projection definitions to return extra D1 statements (`extra?: (state, meta, attachments) => D1PreparedStatement[]`) to be batched with the main upsert. Used by `player` to insert `player_solves` rows atomically with `player_state`. Core change: `apply()` signature gains `attachments: unknown` parameter; pass to `extra()` if present; batch all statements in one `DB.batch([upsert, ...extra])`.

3. **`flushAttachments()` and `onFlushed()` hooks** (for ledger watermark): Allow aggregates to read side-effect data synchronously before `await`, send it with the projection, and finalize on success. Core change: add `protected flushAttachments(): unknown { return undefined }` (default) and `protected onFlushed(_attachments: unknown): void {}` (default); in `flush()` read attachments before `await`, pass to `apply()`, call `onFlushed()` on success.

4. **Alarm self-rearm** (R13 F2): Platform retries stop after 6; on a failed flush, `alarm()` must `setAlarm()` its own retry. Core change: in `#scheduleRetry()`, cap retries at 6 rather than continuing indefinitely (retries auto-cap at exponential backoff ceiling).

5. **No app-level alarms in v1**: The single alarm per object stays owned by the flush-retry handler. Streak reminders and presence ticks are cron or memory-batched (see § above). Crosscut does not use `nextAppAlarm`; reserve the hook for v2.

**Tests to add to core (`packages/core/test/aggregate.test.ts`):**
- "commit with `projectionFingerprint`: session-only changes do not flush"
- "fingerprint change triggers flush to D1"
- "attachments reach `apply()` and `onFlushed()` only on success"
- "failed flush schedules retry alarm" (v1 only re-arms within cap)

**No user-facing API changes.** The `Aggregate` constructor, `init()`, `snapshot()`, `commit()`, `flush()` signatures are unchanged. Subclasses override optional hooks (`schemaMigrations`, `projectionFingerprint`, `flushAttachments`, `onFlushed`).

---

**Line count:** 412 | **Names not in glossary:** `SolveSession`, `SolveResult`, `CompletionRecord` (domain types, not externally referenced) | **[DECIDED HERE]** `projectionFingerprint` hook, `Projections.extra`, `flushAttachments`/`onFlushed`, no app-level alarms in v1
