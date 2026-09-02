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

**[DECIDED HERE] Feed indexes** (gap-feed-composition-semantics R3–R8):
- `daily_drops_feed (lang, day DESC)` for keyset cursor pagination (`day < ?`).
- `solves_user_puzzle (user_id, puzzle_id)` as a covering index for `done` checks and `NOT EXISTS` in mystery/next queries.
- `solves_user_day (user_id, day_key)` as a covering index for stories (seven-day distinct days).

**[DECIDED HERE] Economy ledger** (gap-wallet-ledger-and-idempotency R1–R4):
- `economy_ledger` mirrors the `User` DO's in-object `ledger` table via watermark attachment (`projected_seq`).
- Rows are inserted by the projection's `extra` statements in the same `DB.batch` as `player_state` upserts.
- `reason` is a closed enum (solve, hint, wheel, collection, purchase, refund, adjust, merge).
- `balance` is the cumulative balance *after* the entry (no need for Σ delta to verify the chain).

---

Total tables: **13** (6 content, 2 player, 1 social, 1 leaderboard, 2 economy, 1 notifications).
Total indexes: **17** (covering nearly every hot read).
