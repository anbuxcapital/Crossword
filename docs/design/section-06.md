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
| POST | `/solves/:solveId/words` | device | RL_USER | WordsBody | 200 WordsResult | 409 no_active_session, paused; 422 bad_lock_proof, bad_question, bad_word |
| POST | `/solves/:solveId/progress` | device | RL_USER | ProgressBody | 204 | 409 no_active_session, paused; 422 — |
| POST | `/solves/:solveId/hints/fifty` | device | RL_SPEND | HintBody | 200 FiftyResult | 402 insufficient_tokens; 409 no_active_session, paused, already_claimed; 422 question_locked |
| POST | `/solves/:solveId/hints/fifty/pick` | device | RL_USER | FiftyPickBody | 200 WordsResult | 422 bad_question |
| POST | `/solves/:solveId/hints/letter` | device | RL_SPEND | LetterHintBody | 200 LetterResult | 402 insufficient_tokens; 409 no_active_session, paused |
| POST | `/solves/:solveId/hints/word` | device | RL_SPEND | WordHintBody | 200 WordHintResult | 402 insufficient_tokens; 409 no_active_session, paused; 422 question_locked |
| POST | `/solves/:solveId/check` | device | RL_USER | CheckBody | 200 CheckResult | 403 autocheck_off; 409 no_active_session, paused; 422 check_budget |
| POST | `/solves/:solveId/pause` | device | RL_USER | — | 200 TimerView | 409 no_active_session, already_paused |
| POST | `/solves/:solveId/resume` | device | RL_USER | — | 200 TimerView | 409 no_active_session, not_paused |
| POST | `/solves/:solveId/finish` | device | RL_USER | FinishBody | 200 SolveResult | 409 no_active_session; 422 wrong_grid, solve_finished |

**Request bodies:**
- `StartSolveBody = { restart?: boolean }`
  - `restart: true` replaces an in-progress session for the same puzzle.
- `WordsBody = { questionIndex: int≥0, word: string 1–15, locked: int[], lockProof: string }`
  - `lockProof` is an HMAC-SHA256 signature verifying `locked` was issued by the server.
  - Locked questions are sorted and deterministic.
- `ProgressBody = { locked: int[], autocheck?: boolean }`
  - Called on pause/exit; persists the autocheck preference.
- `HintBody = { questionIndex: int≥0 }`
- `FiftyPickBody = { questionIndex: int≥0, word: string, locked: int[] }`
- `LetterHintBody = { questionIndex: int≥0, filled: string[] }`
  - `filled` contains the client's entries for the question's cells (`.` for empty).
- `WordHintBody = { questionIndex: int≥0, locked: int[] }`
- `CheckBody = { questionIndex: int≥0, letters: string[], ticket: string }`
  - `ticket` is a server-issued autocheck HMAC valid for 10 minutes, max 6 per solve.
- `FinishBody = { grid: string[] }`
  - `grid` is the completed grid encoded as strings (`#` blocks, `.` empty, else letter).

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
| 403 | `autocheck_off` | `/check` called while autocheck toggle is off | — | turn on autocheck via `/solves/:id/progress` |
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
| 409 | `purchase_conflict` | `idempotencyKey` reused with different `packId`/`plan` payload | `{ idempotencyKey }` | use a new idempotency key |
| 409 | `tz_change_limit` | Second timezone change in the same user-local day | `{ nextAllowedAt }` | keep old timezone |
| 409 | `merged` | User aggregate merged into another account (v2 feature) | `{ mergedInto, token }` | swap device token and retry |
| 413 | `payload_too_large` | Body exceeds size limit (64 KB general; 512 KB admin import) | — | bug |
| 422 | `bad_lock_proof` | `lockProof` signature verification failed | — | resync via `GET /solves/:solveId` |
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

**[DECIDED HERE]**
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
- **WordsBody.lockProof** HMAC-SHA256 signature verifying submitted `locked[]` was issued by server.
- **SolutionView** as new DTO for `/puzzles/:id/solution` (grid letters + answers, 403 if not completed).
- **Errors 409 vs 422**: 409 for state conflicts (`already_spun`, `paused`, `guess_budget`, etc.); 422 for domain rule violations.

---

**Endpoint count: 45** (all from glossary section 5, endpoint 32 "attest" listed as v2-not-implemented).

**Line count: 372** (DTOs + tables + error catalog + conventions).

**Names not in glossary:** FeedItem, SolveView.noHintBonusAlive, SolveView.result, WordsResult, LetterResult, SolutionView (all authorized by gap docs and handoff).
