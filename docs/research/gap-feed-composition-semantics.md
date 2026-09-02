# Feed composition semantics: personalisation, multi-language drops, mystery/next selection, first-page caching

Slug: `gap-feed-composition-semantics` · Written 2026-09-02 · Status: research, drives M4 (`feed` module)

Inputs read: handoff README §8 Feed / §9 Browse / §2–4 quiz, `prototype-logic.js` (feed builder L284-326, `ORDER`, `openMystery`, stories L262-270), `docs/research/README.md` §Domain model / §API surface / §Content pipeline, `durable-objects-d1-domain.md` R7/R8/R9, `domain-spec-extraction.md` F9/F13/F14 + open questions 2 and 9, `crossword-content-pipeline.md` F7/R3/R4 + migration sketch, `concepts.md` §3 consistency model.

Verification method: official docs fetched as markdown (`developers.cloudflare.com/**/index.md`, hono.dev, tanstack.com, sqlite.org), `EXPLAIN QUERY PLAN` executed locally on the proposed schema with SQLite 3.51.0 (the same engine family D1 runs; D1's exact SQLite version is not published — see Open questions), seeded-RNG and weekday facts executed in Node 26.8.1. Anything not verified against a primary source is marked **UNVERIFIED** and carries `low` confidence in the Claims table.

---

## Summary

1. **Drop calendar (decision):** one drop per `(day, lang)`, unchanged PK. The *kind* is chosen by the calendar weekday of the drop date: Mon–Fri → `mini` (5×5), Sat/Sun → `crossword` (9×9, the "Weekend Grid"). That is exactly the "Casual solver" copy ("Minis on weekdays, a grid on weekends") applied to everyone. `level` and `topics` do **not** change which daily a user sees in v1 — the daily must be shared per language so "8,412 solved today", "Top solvers today" and the cached first page all stay meaningful. `level`/`topics` influence only the **mystery** pick (difficulty band + topic preference). The prototype's base posts map to the chronological stream: "Monday Mini" = today's drop, "Weekend Grid" = the most recent Sat/Sun drop, "Studio Mini" = the previous weekday drop. Nothing is pinned or reordered.
2. **Multi-language (decision):** the feed shows exactly one language per request (`?lang`, default = the player's stored `lang`); switching `lang` shows that language's drops including *its* today's drop, so a bilingual user legitimately has two solvable dailies. `todaySolved` (stories ring, streak-at-risk card) is **any first solve of any puzzle in any language whose user-local `day_key` is today** — derived from `player_solves`, which only receives first solves (`INSERT OR IGNORE`), so replays never count. The cursor embeds `lang`; a cursor for another language is a 400.
3. **Pagination (decision):** keyset cursor `{v, lang, day, n}` over `content_daily_drops(lang, day DESC)`; the page query reads `limit+1` drop rows and does `limit` point lookups on `content_puzzles`, `social_puzzle_stats` and one `IN (...)` lookup on `player_solves`; every plan is `SEARCH … USING INDEX` (verified, §Findings F7). Non-puzzle cards are a pure function of the **puzzle ordinal `n`** carried in the cursor: `streak_save` after `n=0` (only when today is unsolved), `wheel` after `n=1` (page 1 only), `mystery` after every puzzle with `(n+1) % 6 === 0`. No card depends on page size, so no duplicates or gaps across pages, drop insertions, or `limit` changes.
4. **Mystery (decision):** no separate endpoint; the `mystery` card carries `puzzleId`. Selection is server-side and deterministic per user-day: `SHA-256("mystery:" + userId + ":" + dayKey)` → `uint32 % candidates.length` over the last 90 days of that language's drops the user has not completed (≤ 90 rows read), filtered by level band and topic overlap when ≥ 8 candidates remain. `/puzzles/:id/next` = today's drop if uncompleted and ≠ id, else the newest uncompleted drop of the same language, else `null`.
5. **Caching (decision):** split `/feed` into a user-independent **skeleton** (drops ⋈ puzzles ⋈ stats, keyed by `lang/today/cursorDay/limit`) and a per-user **overlay** (`player_state` row + `player_solves` for the page ids). Ship M4 **without** a skeleton cache; add an isolate-memory LRU (30 s TTL) behind a flag when D1 latency shows; add the Workers Cache API only once the API runs on a custom domain, because the Cache API is only functional there and never replicates across data centres. The authenticated `/feed` response itself is always `Cache-Control: private, no-store`; only the internal skeleton `put()` carries `s-maxage`. Republished drops are at most one TTL stale; the day boundary is never stale because `today` is in the key.
6. **Live numbers (contract):** the server sends `stats: { solved, solvingNow, asOf }` (projection values + `updated_at`); tolerance is ≤ 15 s (presence commit throttle) + skeleton TTL. The client never invents increments: the "creeps every 3 s" affordance becomes a count-up tween *toward* the newest server value on refetch plus the 3 s rotation of server-provided `ticker` lines.
7. **Stories:** seven user-local day keys (today and six before) joined with `DISTINCT day_key FROM player_solves WHERE user_id=? AND day_key BETWEEN ?` (new index `(user_id, day_key)`, covering, verified). Day keys are the ones recorded at solve time; they are never recomputed when `tz` changes.
8. **Tests:** workerd tests for (a) full-walk pagination with `limit=5` over 3 languages × 30 days: union equals the set, no duplicates; (b) inserting a new drop for `today` mid-walk does not disturb the remaining pages and appears only on a fresh page 1; (c) a `lang` switch with a stale cursor is a 400 and a fresh walk yields only that language; (d) card ordinals are identical for `limit=5` and `limit=20`; (e) `EXPLAIN QUERY PLAN` via `env.DB` contains `USING INDEX daily_drops_feed` and `meta.rows_read ≤ 90` per page.

---

## Findings

### F1. What the prototype and the existing docs actually specify (local sources)

- Prototype base feed (PROTO L309-326, F9 of `domain-spec-extraction.md`): `[mini1(today)] [streak_save if !todaySolved] [cross1 "Weekend Grid"] [wheel#base] [mini2 "Studio Mini"]`, then per batch `b`: `wheel` (even b) or `mystery` (odd b) followed by two archive posts with kicker `FROM THE ARCHIVE · AUG {30-b}`. `openMystery` navigates to `ORDER[Math.floor(Math.random()*4)]` — i.e. an unseeded random puzzle, chosen on tap. `mini3` never appears in the base feed.
- Stories (PROTO L262-270): six fixed items (Today, Sun ✓, Sat ✓, Fri missed, Thu ✓, Wed ✓); README §8 says "Six items (Mon…Wed)"; the Solved screen's streak strip has seven. Both are fixtures.
- Level copy (README §2–4): `N` "Gentle Minis, generous hints", `C` "Minis on weekdays, a grid on weekends", `S` "Straight to the tricky stuff". Language copy: "Puzzles are written per language, never translated. Your streak counts across all of them."
- Already decided in `README.md` §Domain model: "Any solve in any language extends it; replays do not"; `player_solves` is `INSERT OR IGNORE` keyed `user_id:puzzle_id`; `content_daily_drops` PK `(day, lang)` with index `(lang, day DESC)` and `UNIQUE(puzzle_id)`; `social_puzzle_stats` is a projection with `updated_at`; `PuzzleStats.heartbeat` "commits solvingNow at most every 15 s".
- Already decided in `durable-objects-d1-domain.md` R8/R9: feed reads never touch a Durable Object; cursor = `base64url([day,id])`; "Cache the first page per (lang, today) in the Workers Cache API for 30–60 s if D1 latency shows on the home screen (counts are approximate anyway)".
- Already decided in `crossword-content-pipeline.md` R4/F7: `today = dayKey(now, tz)` with `tz` from `X-Timezone` → stored zone → per-language default; the hourly cron keeps `content_daily_drops` filled 3 UTC days ahead so the row exists before any zone (UTC+14 first) reaches that date.
- Open in `domain-spec-extraction.md`: Q2 "What extends the streak?" and Q9 "one puzzle per day per language, or a mini on weekdays and a 9×9 on weekends … Does `level` change which daily a user sees?". `README.md` §Risks lists the default "[one drop per day per language]". This document closes both.

### F2. Workers Cache API — semantics that constrain the design

Source: https://developers.cloudflare.com/workers/runtime-apis/cache/ (fetched as `index.md`).

- "The Cache API is available globally but the contents of the cache do not replicate outside of the originating data center."
- "Workers deployed to custom domains have access to functional `cache` operations. So do Pages functions … However, any Cache API operations in the Cloudflare Workers dashboard editor and Playground previews will have no impact. For Workers fronted by Cloudflare Access, the Cache API is not currently available." The page does not describe behaviour on `*.workers.dev`; a wrangler warning and third-party write-ups say operations there are no-ops (**[UNVERIFIED]** against an official page — treat `workers.dev` as "no cache").
- `cache.put(request, response)`: "Either a string or a Request object to serve as the key. If a string is passed, it is interpreted as the URL for a new Request object." Throws if the request method is not `GET`, the response status is `206`, or the response has `Vary: *`. "Responses with `Set-Cookie` headers are never cached". Respected response headers: `Cache-Control`, `Cache-Tag`, `ETag`, `Expires`, `Last-Modified`. "The `stale-while-revalidate` and `stale-if-error` directives are not supported when using the `cache.put` or `cache.match` methods."
- `cache.match()`: "never sends a subrequest to the origin. If no matching response is found in cache, the promise … is fulfilled with `undefined`." "Unlike the browser Cache API, Cloudflare Workers do not support the `ignoreSearch` or `ignoreVary` options on `match()`. You can accomplish this behavior by removing query strings or HTTP headers at `put()` time."
- "The `cache.put` method is not compatible with tiered caching."
- Cache-poisoning rule for redirects mentions that `.workers.dev` domains "include the query string in the cache key by default" — encode all cache dimensions in the **path** of a synthetic key URL so behaviour is identical on either domain type.
- Example pattern (https://developers.cloudflare.com/workers/examples/cache-api/): `const cacheKey = new Request(cacheUrl.toString(), request); let response = await cache.match(cacheKey); … response.headers.append("Cache-Control", "s-maxage=10"); ctx.waitUntil(cache.put(cacheKey, response.clone()));`
- `ctx.waitUntil` "extends the lifetime of your Worker, allowing you to perform work without blocking returning a response", explicitly listing "Put items into cache using the Cache API" (https://developers.cloudflare.com/workers/runtime-apis/context/). In Hono: `c.executionCtx.waitUntil(...)` (https://hono.dev/docs/api/context).
- Limits (https://developers.cloudflare.com/workers/platform/limits/): Cache API calls per request 50 (Free) / 1,000 (Paid), object size up to 512 MB; "Each isolate can consume up to 128 MB of memory".
- Cache-Control semantics for Cloudflare's shared cache (https://developers.cloudflare.com/cache/concepts/cache-control/): `private` = "must not be stored by a shared cache like Cloudflare"; `no-store` = "any cache … must not store any part of either the immediate request or response"; `s-maxage` overrides `max-age` in shared caches; with an `Authorization` request header, content "is cached only if must-revalidate, public, or s-maxage is also present". Consequence: never put `public`/`s-maxage` on the *outgoing* authenticated `/feed` response; only on the internal skeleton entry.

### F3. Hono's `hono/cache` middleware — why it is not used for `/feed`

Source: https://hono.dev/docs/middleware/builtin/cache. "The Cache middleware currently supports Cloudflare Workers projects using custom domains"; default `keyGenerator` is `c.req.url`; `vary` option merges `Vary` headers and "Setting this to `*` will result in an error"; entries are stored under an internal key `/.hono/cache?__hono_cache_key=...`, which matters if anything purges by URL. It caches the **whole** response per URL, which for an authenticated, user-specific `/feed` would either leak one user's overlay to another (if keyed by URL) or be useless (if keyed by user). The feed therefore caches only the skeleton, manually.

### F4. Isolate memory as a cache

Sources: https://developers.cloudflare.com/workers/reference/how-workers-works/ ("Because there is no guarantee that any two user requests will be routed to the same or a different instance of your Worker, Cloudflare recommends you do not use or mutate global state"; isolates "may be spun down and evicted" for resource limits) and https://developers.cloudflare.com/workers/platform/limits/ ("a single isolate can handle many concurrent requests"; 128 MB "per-isolate, not per-invocation"). A module-scope `Map` is therefore a legitimate *best-effort* cache: hits are free, misses fall through to D1, correctness never depends on it. A feed skeleton page is ≈ 20 × (`content_json` ≈ 1–2 KB + metadata) ≈ 40–60 KB; 3 languages × 3 hot pages ≈ 0.5 MB — negligible against 128 MB.

### F5. D1 query planning, metering and limits

Sources: https://developers.cloudflare.com/d1/best-practices/use-indexes/, https://developers.cloudflare.com/d1/worker-api/return-object/, https://developers.cloudflare.com/d1/platform/limits/, https://developers.cloudflare.com/d1/sql-api/query-json/.

- D1 "bills by the number of rows read and rows written, not by the number of rows your query returns"; "Use the `meta` object to estimate your usage" — `meta.rows_read` / `meta.rows_written` are on every result (`served_by_primary`, `timings.sql_duration_ms` too).
- "Prepend `EXPLAIN QUERY PLAN`" to see whether a query uses an index; output contains `USING INDEX <name>` or a full scan. Multi-column indexes are used only when the query constrains a left-prefix of the columns.
- Limits: 100 bound parameters per query, 100 KB per statement, each statement in `db.batch()` counts individually. The overlay `IN (...)` lookup for ≤ 50 page ids stays under 100 parameters.
- JSON: `json_extract`, `json_each`, `->>` exist; generated columns "can have indexes defined on them". Not needed in v1: topic filtering happens in the Worker over ≤ 90 candidate rows.
- The `query-d1` best-practices page contains nothing about `EXPLAIN` or pagination (checked); `use-indexes` is the page to cite.

### F6. SQLite `EXPLAIN QUERY PLAN` vocabulary and row-value cursors

Sources: https://www.sqlite.org/eqp.html and https://www.sqlite.org/rowvalue.html.

- "SCAN is used for a full-table scan"; "SEARCH indicates that only a subset of the table rows are visited"; `USING COVERING INDEX` means "all the columns needed by the query are available in the index itself"; `USE TEMP B-TREE FOR ORDER BY` means a sort could not use an index. "The data returned by the EXPLAIN QUERY PLAN command is intended for interactive debugging only. The output format may change between SQLite releases." — so tests should assert `detail LIKE '%USING INDEX daily_drops_feed%'` and the absence of `SCAN content_daily_drops`, not exact strings.
- Row values `(a,b) > (?1,?2)` for keyset pagination have used indexes since SQLite 3.15.0 (2016) and do so "much more efficiently than OFFSET". Because `(day, lang)` is unique, Crosscut's cursor needs only `day < ?` — no row-value comparison, no dependence on D1's SQLite version.

### F7. `EXPLAIN QUERY PLAN` on the proposed schema (verified locally, SQLite 3.51.0, 400 drops × 2 languages, 368 solves for the test user)

```
-- skeleton page (first page and cursor page)
SEARCH d USING INDEX daily_drops_feed (lang=? AND day<?)
SEARCH p USING INDEX sqlite_autoindex_content_puzzles_1 (id=?)
SEARCH ps USING INDEX sqlite_autoindex_social_puzzle_stats_1 (id=?) LEFT-JOIN

-- overlay: done rows for the page's ids
SEARCH player_solves USING INDEX player_solves_user_puzzle (user_id=? AND puzzle_id=?)

-- stories: distinct day keys in a 7-day window
SEARCH player_solves USING COVERING INDEX player_solves_user_day (user_id=? AND day_key>? AND day_key<?)

-- mystery candidates: last 90 days, uncompleted
SEARCH d USING INDEX daily_drops_feed (lang=? AND day>? AND day<?)
CORRELATED SCALAR SUBQUERY 1
  SEARCH s USING COVERING INDEX player_solves_user_puzzle (user_id=? AND puzzle_id=?)
SEARCH p USING INDEX sqlite_autoindex_content_puzzles_1 (id=?)

-- /puzzles/:id/next
SEARCH d USING INDEX daily_drops_feed (lang=? AND day<?)
CORRELATED SCALAR SUBQUERY 1
  SEARCH s USING COVERING INDEX player_solves_user_puzzle (user_id=? AND puzzle_id=?)

-- ensureDrops pool pick by kind (index (lang, status, kind, drop_date))
SEARCH content_puzzles USING INDEX puzzles_pool (lang=? AND status=? AND kind=? AND drop_date=?)
USE TEMP B-TREE FOR ORDER BY          -- sorts the small NULL-drop_date pool by created_at; acceptable
```

Two findings that changed the schema: (1) without `player_solves(user_id, day_key)` the stories query plans as `SCAN player_solves` + `USE TEMP B-TREE FOR GROUP BY`; (2) the pool index must include `kind` once weekend grids are picked by kind. Rows read per skeleton page: `limit+1` drop rows + `limit` puzzle rows + `limit` stats rows (each a PK lookup) ≈ 61 for `limit=20`, plus ≤ 20 overlay rows and ≤ 7 stories rows ≈ 90 rows total. Row-count sanity: the windowed candidate query returned 32 rows for the test user, i.e. bounded by the 90-day window, never by archive size.

### F8. TanStack Query behaviour the server contract must respect

Sources: https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults, https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries, https://tanstack.com/query/latest/docs/framework/react/guides/caching.

- Defaults: `staleTime` 0 ("consider cached data as stale"), `gcTime` 5 minutes, stale queries refetch "when new instances of the query mount, the window is refocused, the network is reconnected"; failed queries retry 3 times with backoff.
- Infinite queries: `initialPageParam` is required; "When an infinite query becomes `stale` and needs to be refetched, each group is fetched `sequentially`, starting from the first one"; `maxPages` bounds how many pages are kept and refetched. Consequence: a 10-page feed must set `maxPages` (3 is enough for the home screen) or a focus refetch fires ten sequential requests.
- The `useQuery` reference page was not reachable (404 at three URLs on 2026-09-02); the `staleTime: 'static'` value is therefore not relied upon. **[UNVERIFIED]** — the recommendation in R4 uses numeric milliseconds instead, which is always supported.

### F9. Workers Vitest integration facts relevant to the feed tests

Sources: https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/, https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/.

- "Storage isolation is per test file … any writes to storage during a test file are not visible to other test files"; share storage with `--max-workers=1 --no-isolate`.
- "Vitest's fake timers do not apply to KV, R2 and cache simulators" — confirms a Cache API simulator exists inside the test runtime, and that TTL expiry cannot be tested by advancing fake time (test the memory LRU's TTL with an injected clock instead). Fake timers do drive `Date` for `dayKey` computations.
- Local Cache API semantics in Miniflare are implemented with `http-cache-semantics` and can differ from production for unusual status codes (github.com/cloudflare/workers-sdk/issues/9040 — **[UNVERIFIED]** beyond that issue; irrelevant for 200 JSON).

### F10. Randomness and dates inside the Worker (verified)

- `crypto.subtle.digest("SHA-256", …)` → first 4 bytes as `uint32` is deterministic: `("u_1","2026-09-02")` → `456187629` twice, `("u_1","2026-09-03")` → `4271436527` (Node 26.8.1; Web Crypto is the same API in workerd per https://developers.cloudflare.com/workers/runtime-apis/web-crypto/). No PRNG library is needed: one hash gives a stable index per user-day; the candidate list order is deterministic (`day DESC`).
- Calendar facts for the launch window: 2026-09-01 is a Tuesday, 2026-09-05 Saturday, 2026-09-06 Sunday (Intl, UTC). Weekday of a `YYYY-MM-DD` drop date is computed on the date string itself (`Date.UTC(y, m-1, d)`) — it is a calendar property, independent of user zone.
- "Date.now() returns the time of the last I/O; it does not advance during code execution" (https://developers.cloudflare.com/workers/runtime-apis/web-standards/) — pass `now` explicitly everywhere, as the rest of the backend already does.

### F11. Streak/`todaySolved` derivation is already free of replays

`player_solves` rows are written with `INSERT OR IGNORE` on `id = user_id:puzzle_id` (README §D1 schema). A replay therefore never creates a row and never produces a `day_key`, so "any first solve in any language" is what `DISTINCT day_key` naturally yields. The `User` aggregate's `streak.lastSolvedDay` is the authoritative value for the *streak count*; the stories row and `todaySolved` are read-model derivations that agree with it under `flushMode: "await"` (concepts.md §3: the command resolves after D1 is updated).

### F12. What "personalisation" can cost

Any per-user change to the *daily* breaks three things at once: the shared social counters ("8,412 solved today" would mix puzzles), the per-puzzle leaderboard "Top solvers today" (its day is the puzzle's `drop_date`), and the cacheable skeleton (the key would need `level` and `topics`, multiplying cache entries by 3 × 2⁸). Personalising only the *mystery* pick and the archive teaser keeps all three intact and still uses the onboarding answers visibly ("Dare you." reveals a puzzle matching your topics and level).

---

## Recommendation for Crosscut

### R1. Drop calendar and the role of `level` / `topics`

| Rule | Decision |
|---|---|
| Rows | One row per `(day, lang)` in `content_daily_drops` (PK unchanged). |
| Kind by weekday | `kindForDay(day)`: Sat/Sun → `crossword` (9×9, par 600, the "Weekend Grid"); Mon–Fri → `mini`. `ensureDrops` picks `status='published' AND kind=? AND drop_date IS NULL` (editor-scheduled `drop_date = day` wins regardless of kind); if the kind pool is empty it falls back to any kind and logs `pool.kindFallback` (06:00 alert reads it). Index becomes `puzzles_pool(lang, status, kind, drop_date)`. |
| Level | No effect on the daily, the stream order, or the streak rule. Used in `mysteryPick`: `newbie → {EASY}`, `casual → {EASY, MEDIUM}`, `shark → any, TRICKY first`. Everything else the level copy promises ("generous hints") is economy, out of scope here. |
| Topics | No effect on the daily or the stream. Used in `mysteryPick`: prefer candidates whose `topics_json ∩ user.topics ≠ ∅` when ≥ 8 such candidates exist. |
| Base posts | `n=0` today's drop (or the newest ≤ today if the cron has not filled today — flagged `isToday:false`), `n=1..` the previous days. The "Weekend Grid" post is simply the most recent Sat/Sun row; "Studio Mini" is the previous weekday row. Nothing pinned. |
| Kicker | Rendered by the client from `day` and `kind` (`MONDAY MINI · SEP 1`, `WEEKEND GRID · SEP 5`, `FROM THE ARCHIVE · AUG 30` for `n ≥ 2`), never stored — fixes F14.11 of the domain spec (reference to `domain-spec-extraction.md` F14.11 unverified; this document's treatment of kickers as client-computed rather than stored remains sound). |
| Streak-save copy | "One Mini keeps it alive" on weekdays, "One grid keeps it alive" on weekends: client copy keyed on `streakAtRisk.kind`. |

Escape hatch if product later wants both a mini and a grid at weekends: add a `slot TEXT NOT NULL DEFAULT 'daily'` column to the PK `(day, lang, slot)` and to the feed index `(lang, day DESC, slot DESC)`; the cursor then carries `[day, slot]` (plan verified: `SEARCH d USING INDEX daily_drops_feed (lang=? AND (day,slot)<(?,?))`). Do not do this in v1.

### R2. Multi-language rules

1. `GET /feed?lang=` defaults to `player_state.lang`; the response echoes `lang`. The client's query key is `['feed', lang]`, so a language switch is a new query, never a continuation.
2. The cursor embeds `lang`; `cursor.lang !== lang` → `400 BAD_CURSOR`. Also `400` for a malformed or version-mismatched cursor. Never silently reinterpret.
3. A user who switches languages sees the other language's drops, including that language's today's drop. Both dailies are solvable and each grants first-solve rewards once (completions are per puzzle id). This is intended: "Puzzles are written per language, never translated."
4. `todaySolved`, `streakAtRisk`, the stories row: computed across **all** languages from `player_solves.day_key` (user-local day recorded at solve time). The daily card's own ✓ (`me.done`) is per puzzle.
5. `streakAtRisk.puzzleId` points at the current language's today drop (or the stream's first puzzle when today's row is missing).
6. `tz` resolution per request: `X-Timezone` header (validated by constructing an `Intl.DateTimeFormat`) → `player_state.tz` → per-language default. `today` and `dayEndsAt` come from it; `today` is also part of the skeleton cache key.

### R3. Page assembly, cursor, cards, mystery, next

**Cursor** = `base64url(JSON.stringify({ v: 1, lang, day, n }))` where `day` is the `day` of the last puzzle on the page and `n` is the ordinal the next page starts at. Page query: `WHERE d.lang = ?1 AND d.day < ?2 ORDER BY d.day DESC LIMIT ?3+1` (first page: `d.day <= today`). `nextCursor` is `null` when fewer than `limit+1` rows came back or when `n ≥ 10 × limit` (10-page cap from the spec; older content is reached through Browse → Archive).

**Cards** are a pure function of ordinals and page-1 flags:

| card | placed after puzzle ordinal | condition | fields |
|---|---|---|---|
| `streak_save` | `n = 0` | page 1 only (cursor absent) and `!todaySolved` and `streak.count > 0` | `{ streak, dayEndsAt, puzzleId, kind }` |
| `wheel` | `n = 1` | page 1 only; always emitted so layout is stable | `{ wheelId: "<today>:base", canSpin, lastPrize }` (from `player_state.wheel_last_spin_day/prize`, new projection columns) |
| `mystery` | every `n` with `(n + 1) % 6 === 0` | `mysteryPuzzleId !== null` | `{ puzzleId }` — same id on every page of the same user-day |

Because ordinals come from the cursor, a page fetched with `limit=5` and one with `limit=20` place cards identically, and a new drop inserted at the top between two page fetches shifts nothing already delivered (the old cursor's `day` bound excludes it). On a fresh page-1 refetch everything is recomputed, which is the correct behaviour at the day boundary.

**Mystery selection** (`mysteryPick(userId, lang, today, level, topics)`): candidates = last 90 days of `lang` drops with `day < today` not in `player_solves` for this user, ordered `day DESC` (≤ 90 rows, F7). Apply the level band; then, if ≥ 8 candidates share a topic with the user, keep only those. `index = sha256_u32("mystery:" + userId + ":" + today) % candidates.length`. Empty → no mystery cards. Properties: stable across pages and refetches within a user-day; changes when the user solves it (it leaves the candidate set) or at the next local day. The `puzzleId` is exposed on the card; the client must render the card without title/difficulty (the id pattern `en-cross-0007` reveals the kind — accepted, see Open questions). No `GET /feed/mystery` endpoint.

**`GET /puzzles/:id/next`**: (1) today's drop of `lang(puzzle)` if `≠ id` and not completed; (2) else the newest drop of that language with `day <= today`, `puzzle_id <> id`, not completed (query in F7, `LIMIT 1`); (3) else `null`. The Solved screen shows "Next puzzle ▸" only when non-null.

### R4. Caching design

Two layers, decided independently:

**Layer A — skeleton per `(lang, today, cursorDay|first, limit)`** (user-independent: drops ⋈ puzzles ⋈ stats). Three implementations behind one interface `SkeletonCache { get(key): Promise<Skeleton|undefined>; put(key, value, ttlSec): Promise<void> }`:

| option | scope | works on workers.dev / in tests | republish staleness | verdict |
|---|---|---|---|---|
| none | — | yes | 0 | **M4 default.** One `DB.batch` of 3 statements ≈ 90 rows read; fine at launch. |
| isolate-memory LRU (`Map`, TTL 30 s, ≤ 64 entries) | per isolate | yes | ≤ 30 s per isolate | **First upgrade** (`FEED_SKELETON_CACHE=memory`). Free hits, no API limits, testable with an injected clock. |
| Workers Cache API (`caches.default`, synthetic key `https://crosscut-cache.internal/feed/v1/<lang>/<today>/<cursorDay>/<limit>`, response `Cache-Control: s-maxage=45`, `put` in `waitUntil`) | per data centre | **no** on `workers.dev`/Playground; yes in the vitest simulator | ≤ 45 s per data centre | **Only after** the API is on a custom domain; gate with `FEED_SKELETON_CACHE=edge`. Encode dimensions in the path, never rely on `Vary`, never pass the user's `Request` (with `Authorization`) as the key. |

Republish consistency: the day boundary is never stale (`today` is in the key). A republished or re-pointed drop (admin `force` import, `ensureDrops` swap) is visible after ≤ TTL; with the Cache API, `cache.delete` only purges the local data centre, so do not build an "instant bust" on it. If instant invalidation is ever required, add `content_meta.content_version` to the key (one 1-row read per request) — not in v1. Social counts are approximate by design (R5).

**Layer B — per-user overlay**: `player_state` row (balances, streak, `last_solved_day`, `likes_json`, `saves_json`, `wheel_*`, `tz`, `lang`) + `player_solves` for the page's ids + the stories window. Never cached server-side; never touches the `User` DO. The client keeps `/me` (strongly consistent) as the winner when merging: `done = me.completedIds.has(id) || item.me.done`, `liked = me.likes.has(id)`, etc., so an optimistic like/solve is never overwritten by a slightly older overlay.

**HTTP headers on `/feed`**: `Cache-Control: private, no-store` (authenticated, user-specific; keeps any intermediary — including Cloudflare's own CDN, which caches `Authorization` responses only when `public`/`s-maxage`/`must-revalidate` are present — from ever storing it). No `Vary` (nothing to vary on when nothing is stored). `ETag` is not worth it: the overlay changes on every solve/like and the body is small.

**Expo client (TanStack Query v5)**: `useInfiniteQuery({ queryKey: ['feed', lang], initialPageParam: null, getNextPageParam: p => p.nextCursor, staleTime: 30_000, maxPages: 3 })`; wire `focusManager` to `AppState` so a foreground return refetches page 1..3 sequentially; after `finish`/`like`/`spin` write the command's snapshot into `['me']` and `invalidateQueries(['feed'])`. `refetchInterval` is not used (see R5).

### R5. "Live" numbers

- Server fields per puzzle card: `stats: { likes, solved, solvingNow, asOf }` with `asOf = social_puzzle_stats.updated_at` (ms). `solvingNow` is at most 15 s stale by construction (heartbeat commit throttle) plus skeleton TTL; `solved`/`likes` are milliseconds behind under `await` flush plus skeleton TTL. Documented tolerance: **≤ 60 s** for all three; the UI must not imply better.
- Client contract ("creeps every 3 s" from README §8): the displayed value is always a value the server sent; on receiving a newer value the number tweens from the previous displayed value to the new one over ≤ 800 ms (this is the "creep"); the 3 s interval only advances the ticker index and, if the app wants perceived motion, re-runs the tween toward the *same* last server value (a no-op) — **no random bumps, no extrapolation from `asOf`**.
- Ticker lines: `ticker: string[]` generated server-side from real data only — fastest solver today (`top_today_json[0]` → display name + time), `"{solvingNow} people are solving {title} right now"` when `solvingNow ≥ 2`, `"{solved} solved {title} today"`, and the static archive teaser from the collections manifest. No invented users (the prototype's `wordwasp`/`klara.m` lines are fixtures).
- Optional later: `GET /puzzles/:id/stats` polled every 30 s only while the today card is on screen; not in v1.

### R6. Stories row

`days = [today, today-1, …, today-6]` as user-local day keys (`dayKey(now - k·86_400_000, tz)` — computed on instants, so DST days are handled by `Intl`). `solvedDays = SELECT DISTINCT day_key FROM player_solves WHERE user_id = ? AND day_key BETWEEN ?6daysAgo AND ?today` (covering index, F7). Item state: `k = 0` → `today` / `todaySolved`; `k > 0` → `solved` if `day ∈ solvedDays`, else `missed` — except days before `player_state.created_at`'s day, which render as `before` (dashed but unlabeled) so a new player does not start with six "Missed" rings. Labels (`MON`, `Today`, `Missed`) are client-rendered from the day key in the device locale. A `tz` change never recomputes past `day_key`s (they were recorded in the zone in effect at solve time, and the aggregate already limits `setTimezone` to once per local day).

### R7. Tests (workerd, `@cloudflare/vitest-plugin`)

Fixtures: `seedDrops(env, { langs: ['en','uk','ru'], days: 30, from: '2026-09-02' })` inserting `content_puzzles` (weekday-correct kinds) + `content_daily_drops` + `social_puzzle_stats` rows; `seedSolves(env, userId, ids, dayKey)`; requests through `app.request('/v1/feed?…', { headers: { Authorization, 'X-Timezone': 'Europe/Kyiv' } }, env)` with a test-only `X-Test-Now` header (or `vi.setSystemTime`) for `now`.

1. **Full walk, no gaps/duplicates**: `limit=5`, follow `nextCursor` to `null`; the multiset of `puzzle` ids equals the seeded `en` ids with `day <= today`, in `day DESC` order; count of pages = `ceil(30/5)`.
2. **Drop insertion mid-walk**: fetch pages 1–2; insert a drop for `today+1` and move `now` forward one day; continue with the page-2 cursor to the end → still no duplicates, the new id absent; a fresh page 1 has the new id at `n=0` with `isToday:true`.
3. **Language switch**: page-1 `uk` cursor sent with `lang=en` → 400 `BAD_CURSOR`; a fresh `lang=uk` walk yields only `uk-*` ids; `stories`/`streakAtRisk` are identical between the `en` and `uk` page 1 for the same user (cross-language derivation).
4. **Card determinism**: cards' `(type, afterOrdinal)` sequence is identical for `limit=5` and `limit=20`; `wheel` appears exactly once (page 1); `streak_save` disappears after a solve dated today in *any* language; `mystery.puzzleId` is identical on every page and on a second walk the same day, differs on the next day, and is never a completed id.
5. **Plans and metering**: `env.DB.prepare('EXPLAIN QUERY PLAN ' + PAGE_SQL).bind(...).all()` → some row's `detail` contains `USING INDEX daily_drops_feed` and none starts with `SCAN content_daily_drops`; `(await env.DB.batch(pageStatements)).reduce(rows_read) ≤ 90`.
6. **Skeleton cache**: with `FEED_SKELETON_CACHE=memory` and an injected clock, a second request within 30 s does not run the skeleton statement (spy on a `SkeletonSource`), a request after 31 s does; a republished drop is visible after expiry. Repeat the same file with `=edge` using the vitest cache simulator (no TTL assertion — fake timers do not apply to the cache simulator, F9).

---

## Code sketches

### 1. Migration delta (`migrations/0004_feed.sql`)

```sql
-- stories window (covering)
CREATE INDEX IF NOT EXISTS player_solves_user_day    ON player_solves (user_id, day_key);
-- overlay lookups + NOT EXISTS in mystery/next (covering)
CREATE INDEX IF NOT EXISTS player_solves_user_puzzle ON player_solves (user_id, puzzle_id);
-- pool pick by kind (weekend grids)
DROP INDEX IF EXISTS puzzles_pool;
CREATE INDEX puzzles_pool ON content_puzzles (lang, status, kind, drop_date);
-- wheel state in the read model (then reproject users)
ALTER TABLE player_state ADD COLUMN wheel_last_spin_day TEXT;
ALTER TABLE player_state ADD COLUMN wheel_last_prize    INTEGER;
```

### 2. Drop kind by weekday (`modules/content/calendar.ts`)

```ts
export type DropKind = "mini" | "crossword";
export function kindForDay(day: string): DropKind {          // day = 'YYYY-MM-DD' calendar date
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();   // 0 = Sun … 6 = Sat; tz-independent
  return dow === 0 || dow === 6 ? "crossword" : "mini";
}
// in ensureDrops(): editor-scheduled first, then the kind pool, then any kind (logged)
const pick = await env.DB.prepare(
  `SELECT id, kind FROM content_puzzles
    WHERE lang = ?1 AND status = 'published' AND (drop_date = ?2 OR (drop_date IS NULL AND kind = ?3))
    ORDER BY (drop_date IS NULL), created_at LIMIT 1`).bind(lang, day, kindForDay(day)).first<{ id: string; kind: DropKind }>()
  ?? await env.DB.prepare(
  `SELECT id, kind FROM content_puzzles WHERE lang = ?1 AND status = 'published' AND drop_date IS NULL
    ORDER BY created_at LIMIT 1`).bind(lang).first<{ id: string; kind: DropKind }>();
```

### 3. Cursor (`modules/feed/cursor.ts`)

```ts
import { z } from "zod";
const Cursor = z.object({ v: z.literal(1), lang: z.enum(["en", "uk", "ru"]), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), n: z.int().nonnegative() });
export type Cursor = z.infer<typeof Cursor>;
const b64u = { enc: (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
               dec: (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/")) };
export const encodeCursor = (c: Cursor) => b64u.enc(JSON.stringify(c));
export function decodeCursor(raw: string | undefined, lang: string): Cursor | null {
  if (!raw) return null;
  const parsed = Cursor.safeParse((() => { try { return JSON.parse(b64u.dec(raw)); } catch { return null; } })());
  if (!parsed.success || parsed.data.lang !== lang) throw new DomainError("BAD_CURSOR");
  return parsed.data;
}
```

### 4. Skeleton + overlay statements (`modules/feed/queries.ts`)

```ts
export const PAGE_SQL = `
SELECT d.day, p.id, p.kind, p.size, p.title, p.author_id, p.author_name, p.difficulty, p.par_sec, p.clue_count,
       p.theme_word, p.reveal_json, p.cover_style, p.content_json,
       ps.likes, ps.solved, ps.solving_now, ps.updated_at AS stats_as_of
FROM content_daily_drops d
JOIN content_puzzles p           ON p.id = d.puzzle_id
LEFT JOIN social_puzzle_stats ps ON ps.id = p.id
WHERE d.lang = ?1 AND d.day < ?2            -- first page passes today + '~' (any string > 'YYYY-MM-DD'), i.e. day <= today
ORDER BY d.day DESC
LIMIT ?3`;                                   // bind limit + 1

export const OVERLAY_SQL = (n: number) =>
  `SELECT puzzle_id, time_ms FROM player_solves WHERE user_id = ?1 AND puzzle_id IN (${Array.from({ length: n }, (_, i) => `?${i + 2}`).join(",")})`;
export const STORIES_SQL = `SELECT DISTINCT day_key FROM player_solves WHERE user_id = ?1 AND day_key BETWEEN ?2 AND ?3`;
export const STATE_SQL   = `SELECT tz, lang, level, topics_json, tokens, stars, streak, last_solved_day, likes_json, saves_json,
                                   wheel_last_spin_day, wheel_last_prize, created_at FROM player_state WHERE id = ?1`;
```

Note the first-page trick: passing `today + "~"` as `?2` keeps one prepared statement for both `<=` (first page) and `<` (cursor page) — `'2026-09-02~' > '2026-09-02'` and `< '2026-09-03'` lexicographically. If that reads as too clever, keep two statements; the plan is identical (F7).

### 5. Composition (`modules/feed/compose.ts`)

```ts
type Card =
  | { type: "puzzle"; n: number; puzzleId: string; day: string; isToday: boolean; kind: DropKind; size: number; title: string;
      author: { id: string; name: string }; difficulty: string; parSec: number; clueCount: number; cover: CoverView;
      stats: { likes: number; solved: number; solvingNow: number; asOf: number }; me: { done: boolean; bestTimeMs: number | null; liked: boolean; saved: boolean } }
  | { type: "streak_save"; streak: number; dayEndsAt: number; puzzleId: string; kind: DropKind }
  | { type: "wheel"; wheelId: string; canSpin: boolean; lastPrize: number | null }
  | { type: "mystery"; puzzleId: string };

export function composePage(input: {
  lang: Lang; today: string; limit: number; cursor: Cursor | null;
  rows: SkeletonRow[];                 // limit + 1 rows max
  state: PlayerStateRow; done: Map<string, number>; todaySolved: boolean; mysteryId: string | null; dayEndsAt: number;
}): { items: Card[]; nextCursor: string | null } {
  const { rows, limit, cursor } = input;
  const page = rows.slice(0, limit);
  const firstPage = cursor === null;
  const n0 = cursor?.n ?? 0;
  const likes = new Set<string>(JSON.parse(input.state.likes_json)), saves = new Set<string>(JSON.parse(input.state.saves_json));
  const items: Card[] = [];
  page.forEach((r, i) => {
    const n = n0 + i;
    items.push({ type: "puzzle", n, puzzleId: r.id, day: r.day, isToday: r.day === input.today, kind: r.kind, size: r.size, title: r.title,
      author: { id: r.author_id, name: r.author_name }, difficulty: r.difficulty, parSec: r.par_sec, clueCount: r.clue_count,
      cover: coverView(r), stats: { likes: r.likes ?? 0, solved: r.solved ?? 0, solvingNow: r.solving_now ?? 0, asOf: r.stats_as_of ?? 0 },
      me: { done: input.done.has(r.id), bestTimeMs: input.done.get(r.id) ?? null, liked: likes.has(r.id), saved: saves.has(r.id) } });
    if (firstPage && n === 0 && !input.todaySolved && input.state.streak > 0)
      items.push({ type: "streak_save", streak: input.state.streak, dayEndsAt: input.dayEndsAt, puzzleId: r.id, kind: r.kind });
    if (firstPage && n === 1)
      items.push({ type: "wheel", wheelId: `${input.today}:base`, canSpin: input.state.wheel_last_spin_day !== input.today, lastPrize: input.state.wheel_last_prize });
    if ((n + 1) % 6 === 0 && input.mysteryId) items.push({ type: "mystery", puzzleId: input.mysteryId });
  });
  const hasMore = rows.length > limit && n0 + page.length < 10 * limit;
  const last = page.at(-1);
  return { items, nextCursor: hasMore && last ? encodeCursor({ v: 1, lang: input.lang, day: last.day, n: n0 + page.length }) : null };
}
```

### 6. Mystery pick and `/next` (`modules/feed/mystery.ts`)

```ts
async function seedU32(...parts: string[]) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join(":")));
  return new DataView(h).getUint32(0);
}
const BAND: Record<Level, string[]> = { newbie: ["EASY"], casual: ["EASY", "MEDIUM"], shark: ["EASY", "MEDIUM", "TRICKY"] };

export async function mysteryPick(db: D1Database, u: { id: string; lang: Lang; today: string; level: Level; topics: string[] }) {
  const from = dayKey(Date.parse(u.today + "T00:00:00Z") - 90 * 86_400_000, "UTC");
  const { results } = await db.prepare(`
    SELECT d.puzzle_id AS id, p.difficulty, p.topics_json FROM content_daily_drops d
    JOIN content_puzzles p ON p.id = d.puzzle_id
    WHERE d.lang = ?1 AND d.day < ?2 AND d.day >= ?3
      AND NOT EXISTS (SELECT 1 FROM player_solves s WHERE s.user_id = ?4 AND s.puzzle_id = d.puzzle_id)
    ORDER BY d.day DESC`).bind(u.lang, u.today, from, u.id).all<{ id: string; difficulty: string; topics_json: string }>();
  let c = results.filter(r => BAND[u.level].includes(r.difficulty));
  if (c.length === 0) c = results;
  if (u.level === "shark") c = [...c.filter(r => r.difficulty === "TRICKY"), ...c.filter(r => r.difficulty !== "TRICKY")];
  const topical = c.filter(r => (JSON.parse(r.topics_json) as string[]).some(t => u.topics.includes(t)));
  if (topical.length >= 8) c = topical;
  if (c.length === 0) return null;
  return c[(await seedU32("mystery", u.id, u.today)) % c.length]!.id;
}

export const NEXT_SQL = `
SELECT d.puzzle_id FROM content_daily_drops d
WHERE d.lang = ?1 AND d.day <= ?2 AND d.puzzle_id <> ?3
  AND NOT EXISTS (SELECT 1 FROM player_solves s WHERE s.user_id = ?4 AND s.puzzle_id = d.puzzle_id)
ORDER BY d.day DESC LIMIT 1`;        // row 1 is today's drop when it is uncompleted → rule (1) and (2) in one query
```

### 7. Skeleton cache interface and the three implementations (`modules/feed/skeleton-cache.ts`)

```ts
export interface SkeletonCache { get(key: string): Promise<SkeletonRow[] | undefined>; put(key: string, rows: SkeletonRow[], ttlSec: number): Promise<void>; }
export const skeletonKey = (p: { lang: string; today: string; cursorDay: string | null; limit: number }) =>
  `https://crosscut-cache.internal/feed/v1/${p.lang}/${p.today}/${p.cursorDay ?? "first"}/${p.limit}`;   // dimensions in the PATH

export const noCache: SkeletonCache = { async get() { return undefined; }, async put() {} };

export function memoryCache(now: () => number, max = 64): SkeletonCache {          // module-scope Map: best effort, per isolate
  const m = new Map<string, { exp: number; rows: SkeletonRow[] }>();
  return {
    async get(k) { const e = m.get(k); if (!e) return undefined; if (e.exp <= now()) { m.delete(k); return undefined; } m.delete(k); m.set(k, e); return e.rows; },
    async put(k, rows, ttl) { if (m.size >= max) m.delete(m.keys().next().value!); m.set(k, { exp: now() + ttl * 1000, rows }); },
  };
}

export function edgeCache(ctx: ExecutionContext): SkeletonCache {                    // only functional on a custom domain
  return {
    async get(k) { const r = await caches.default.match(new Request(k)); return r ? (await r.json()) as SkeletonRow[] : undefined; },
    async put(k, rows, ttl) {
      const res = new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json", "Cache-Control": `s-maxage=${ttl}` } });
      ctx.waitUntil(caches.default.put(new Request(k), res));                         // synthetic GET key, no Authorization, no Vary
    },
  };
}
// route: const cache = env.FEED_SKELETON_CACHE === "edge" ? edgeCache(c.executionCtx) : env.FEED_SKELETON_CACHE === "memory" ? MEMORY : noCache;
// response headers: c.header("Cache-Control", "private, no-store");
```

### 8. Stories (`modules/feed/stories.ts`)

```ts
export function storiesRow(today: string, nowMs: number, tz: string, solved: Set<string>, sinceDay: string, todaySolved: boolean) {
  return Array.from({ length: 7 }, (_, k) => {
    const day = dayKey(nowMs - k * 86_400_000, tz);
    const state = k === 0 ? (todaySolved ? "todaySolved" : "today") : day < sinceDay ? "before" : solved.has(day) ? "solved" : "missed";
    return { day, state } as const;                                              // labels rendered on the client
  });
}
```

### 9. Test skeleton (`test/feed.pagination.test.ts`)

```ts
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import app from "../src/app";
import { seedDrops, seedSolves, bootstrapUser } from "./helpers";

describe("feed pagination", () => {
  it("walks all pages without gaps or duplicates and survives a new drop", async () => {
    const ids = await seedDrops(env, { langs: ["en", "uk"], days: 30, from: "2026-09-02" });
    const { auth } = await bootstrapUser(env, { lang: "en", tz: "Europe/Kyiv" });
    const seen: string[] = []; let cursor: string | null = null; let page = 0; const cursors: (string | null)[] = [];
    do {
      const res = await app.request(`/v1/feed?limit=5${cursor ? `&cursor=${cursor}` : ""}`, { headers: { ...auth, "X-Test-Now": "2026-09-02T10:00:00Z" } }, env);
      expect(res.status).toBe(200);
      const body = await res.json<{ items: any[]; nextCursor: string | null }>();
      seen.push(...body.items.filter(i => i.type === "puzzle").map(i => i.puzzleId));
      cursors.push(cursor = body.nextCursor);
      if (++page === 2) { await seedDrops(env, { langs: ["en"], days: 1, from: "2026-09-03" }); }   // a drop lands mid-walk
    } while (cursor);
    expect(seen).toEqual(ids.en.filter(id => id.day <= "2026-09-02").map(id => id.id));            // ordered day DESC, no dup, new drop absent
    const fresh = await (await app.request(`/v1/feed?limit=5`, { headers: { ...auth, "X-Test-Now": "2026-09-03T10:00:00Z" } }, env)).json<any>();
    expect(fresh.items[0]).toMatchObject({ type: "puzzle", n: 0, isToday: true, puzzleId: ids.enByDay["2026-09-03"] });
  });

  it("rejects a cursor from another language and derives todaySolved across languages", async () => {
    await seedDrops(env, { langs: ["en", "uk"], days: 3, from: "2026-09-02" });
    const { auth, userId } = await bootstrapUser(env, { lang: "en", tz: "Europe/Kyiv" });
    const uk = await (await app.request(`/v1/feed?lang=uk&limit=2`, { headers: auth }, env)).json<any>();
    expect((await app.request(`/v1/feed?lang=en&cursor=${uk.nextCursor}`, { headers: auth }, env)).status).toBe(400);
    await seedSolves(env, userId, ["uk-mini-0000"], "2026-09-02");                                   // solved the uk daily only
    const en = await (await app.request(`/v1/feed?lang=en`, { headers: auth }, env)).json<any>();
    expect(en.items.some((i: any) => i.type === "streak_save")).toBe(false);
    expect(en.stories[0].state).toBe("todaySolved");
    expect(en.items[0].me.done).toBe(false);                                                         // the en daily itself is still open
  });

  it("uses the drop index and stays under the row budget", async () => {
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN " + PAGE_SQL).bind("en", "2026-09-02~", 21).all<{ detail: string }>();
    expect(plan.results.some(r => r.detail.includes("USING INDEX daily_drops_feed"))).toBe(true);
    expect(plan.results.some(r => r.detail.startsWith("SCAN content_daily_drops"))).toBe(false);
    const res = await env.DB.prepare(PAGE_SQL).bind("en", "2026-09-02~", 21).all();
    expect(res.meta.rows_read).toBeLessThanOrEqual(90);
  });
});
```

---

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | Workers Cache API contents "do not replicate outside of the originating data center"; `cache.delete` purges only the local data centre | https://developers.cloudflare.com/workers/runtime-apis/cache/ | high | confirmed |
| C2 | "Workers deployed to custom domains have access to functional `cache` operations"; dashboard editor/Playground operations "will have no impact"; not available behind Cloudflare Access | https://developers.cloudflare.com/workers/runtime-apis/cache/ | high | confirmed |
| C3 | Cache API operations on `*.workers.dev` are no-ops (wrangler warns) — not stated on the official Cache page | github.com/cloudflare/workers-sdk issues / search summary — **UNVERIFIED** | low | unverifiable |
| C4 | `cache.put` throws for non-`GET` keys, `206` responses and `Vary: *`; `Set-Cookie` responses are never cached; `stale-while-revalidate` unsupported on put/match; no `ignoreVary`/`ignoreSearch` on `match()`; a string key "is interpreted as the URL for a new Request object"; `match()` never sub-requests and resolves `undefined` on miss | https://developers.cloudflare.com/workers/runtime-apis/cache/ | high | confirmed |
| C5 | Cache API honours `Cache-Control`, `Cache-Tag`, `ETag`, `Expires`, `Last-Modified` on the stored response; `put` should run in `ctx.waitUntil`; Hono exposes it as `c.executionCtx.waitUntil` | https://developers.cloudflare.com/workers/runtime-apis/cache/, https://developers.cloudflare.com/workers/runtime-apis/context/, https://developers.cloudflare.com/workers/examples/cache-api/, https://hono.dev/docs/api/context | high | confirmed |
| C6 | Cloudflare shared cache: `private` must not be stored by a shared cache; `no-store` forbids storing anything; with an `Authorization` header content is cached "only if must-revalidate, public, or s-maxage is also present"; `s-maxage` overrides `max-age` in shared caches | https://developers.cloudflare.com/cache/concepts/cache-control/ | high | confirmed |
| C7 | `hono/cache` "currently supports Cloudflare Workers projects using custom domains", keys by `c.req.url` by default, stores under `/.hono/cache?__hono_cache_key=…`, errors on `vary: '*'` | https://hono.dev/docs/middleware/builtin/cache | high | confirmed |
| C8 | Isolate global state may persist across requests on one isolate but "there is no guarantee that any two user requests will be routed to the same or a different instance"; 128 MB per isolate; Cache API 50/1,000 calls per request (Free/Paid) | https://developers.cloudflare.com/workers/reference/how-workers-works/, https://developers.cloudflare.com/workers/platform/limits/ | high | confirmed |
| C9 | D1 bills rows read/written, exposes `meta.rows_read`/`rows_written`/`served_by_primary`/`timings.sql_duration_ms`; `EXPLAIN QUERY PLAN` shows `USING INDEX <name>`; composite indexes need a left-prefix | https://developers.cloudflare.com/d1/best-practices/use-indexes/, https://developers.cloudflare.com/d1/worker-api/return-object/ | high | confirmed |
| C10 | D1 limits: 100 bound parameters per query, 100 KB per statement, applied per statement inside `db.batch()` | https://developers.cloudflare.com/d1/platform/limits/ | high | confirmed |
| C11 | EQP vocabulary: `SCAN` = full scan, `SEARCH` = subset, `USING COVERING INDEX` = no table access, `USE TEMP B-TREE FOR ORDER BY` = unindexed sort; output format "may change between SQLite releases" | https://www.sqlite.org/eqp.html | high | confirmed |
| C12 | Row-value keyset comparisons `(a,b) > (?,?)` use an index and beat `OFFSET`; available since SQLite 3.15.0 | https://www.sqlite.org/rowvalue.html | high | confirmed |
| C13 | On the proposed schema every feed/overlay/stories/mystery/next query plans as `SEARCH … USING INDEX` (`daily_drops_feed`, `player_solves_user_puzzle`, covering `player_solves_user_day`); without `(user_id, day_key)` stories is `SCAN player_solves` + temp B-tree; a `limit=20` page reads ≈ 61 skeleton rows | local run, SQLite 3.51.0 (F7) — D1's exact SQLite version is not published | high (plan) / medium (D1 parity) | confirmed |
| C14 | TanStack Query v5: `staleTime` defaults to 0, `gcTime` to 5 min, stale queries refetch on mount/focus/reconnect; infinite queries refetch pages "sequentially, starting from the first one"; `maxPages` bounds retained/refetched pages; `initialPageParam` is required | https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults, …/guides/infinite-queries, …/guides/caching | high | confirmed |
| C15 | Workers Vitest integration: storage isolation is per test file; "fake timers do not apply to KV, R2 and cache simulators" (a cache simulator exists in tests) | https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/, …/known-issues/ | high | confirmed |
| C16 | `SHA-256(seed) → uint32` is deterministic per input (`456187629` for `mystery:u_1:2026-09-02`, different for the next day); Web Crypto `crypto.subtle.digest` is available in Workers | local Node 26.8.1 run; https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ | high | confirmed |
| C17 | 2026-09-01 is a Tuesday, 2026-09-05 a Saturday, 2026-09-06 a Sunday; `Intl.DateTimeFormat("en-CA", …)` yields `YYYY-MM-DD` day keys; `Date.now()` in Workers "returns the time of the last I/O" | local Node run; https://developers.cloudflare.com/workers/runtime-apis/web-standards/ | high | confirmed |
| C18 | D1 supports `json_extract`, `json_each`, `->>`, and indexes on generated columns derived from JSON | https://developers.cloudflare.com/d1/sql-api/query-json/ | high | confirmed |
| C19 | Existing decisions: `player_solves` is `INSERT OR IGNORE` on `user_id:puzzle_id` (replays create no row); streak extends on any first solve in any language; `content_daily_drops` PK `(day, lang)`; `PuzzleStats` commits `solvingNow` at most every 15 s; feed reads never hit a DO | `docs/research/README.md` §Domain model/§D1 schema, `durable-objects-d1-domain.md` R8/R9 | high | confirmed |
| C20 | Prototype composition: `[mini1, streak_save?, cross1, wheel#base, mini2]` then per batch `wheel|mystery + 2 archive posts`; mystery = unseeded random over `ORDER`; stories/streak strip are fixtures | `prototype-logic.js` L262-326; `domain-spec-extraction.md` F9/F14 | high | confirmed |
| C21 | Miniflare's local Cache API uses `http-cache-semantics` and may differ from production for unusual status codes | github.com/cloudflare/workers-sdk/issues/9040 — **UNVERIFIED** (third-party issue, not docs) | low | unverifiable |
| C22 | Cache-Tag purge-by-tag availability/plan requirements for Cache-API-stored entries | not researched — **UNVERIFIED** | low | unverifiable |

---

## Open questions

1. **File name.** The task brief names both `gap-feed-composition-semantics.md` (slug line) and `feed-composition-semantics.md` (focus text). This document is written to the slug name; rename if the index expects the other.
2. **Product sign-off on R1**: weekend grid for *everyone* (including "First timer") versus mini every day with the grid only in the archive. R1 argues the shared daily is required for social counters, leaderboards and caching; the "newbie" experience is handled by hints/economy, not by a different drop. If product insists on a per-level daily, the `slot` escape hatch (two rows per weekend day) is the least damaging variant.
3. **Bilingual double daily**: a user switching `lang` can solve two dailies and earn two first-solve rewards per day. Acceptable (it is the product's stated stance) or should rewards for a *second* daily on the same local day be reduced? Not decided here.
4. **Mystery id exposure**: the card carries `puzzleId` whose pattern reveals the kind (`mini`/`cross`). Alternatives: an opaque `mysteryToken` resolved by `GET /puzzles/mystery/:token`, or ids without the kind segment. Recommend ignoring for v1.
5. **Cache API on `workers.dev`** (C3) is unverified against an official page; until the API has a custom domain, treat the edge cache as unavailable and keep `FEED_SKELETON_CACHE=none|memory`.
6. **D1's SQLite version** is not published; the plans in F7 come from SQLite 3.51.0 locally (and the `wrangler dev`/vitest engine is what the tests will assert against). The design avoids row-value cursors so the only dependency is on `LIMIT`/index selection, which is decades-old behaviour. Re-run test 5 against the production database once on the first deploy (`wrangler d1 execute --remote --command "EXPLAIN QUERY PLAN …"`).
7. **Instant invalidation on republish**: not designed (TTL only). If editors need "fix a clue and see it in 5 s", add `content_meta.content_version` to the skeleton key (one extra 1-row read per request) — decide when the admin tooling exists.
8. **"Solving now" precision**: with heartbeats every 30 s and commits every 15 s the number is a 15–45 s-old estimate. Show it only when `≥ 2`? The prototype shows `297 solving now` always; the honest threshold is a product choice.
9. **Stories for brand-new players**: R6 renders days before `created_at` as `before` rather than `missed`. The design shows six labelled rings; confirm the visual for `before`.
10. **`player_state` wheel columns** require a projection change + `reproject()` of all users (cheap at launch, ~1 DO request per user). Alternative: the client fills `canSpin` from `/me` and the server always emits `canSpin: null`. R3 chose the projection columns for a self-sufficient feed response.

---

## Fact-check log

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/cache/ |
| C2 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/cache/ |
| C3 | unverifiable | https://developers.cloudflare.com/workers/runtime-apis/cache/ (no mention of workers.dev) |
| C4 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/cache/ |
| C5 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/cache/, https://developers.cloudflare.com/workers/runtime-apis/context/, https://hono.dev/docs/api/context |
| C6 | confirmed | https://developers.cloudflare.com/cache/concepts/cache-control/ |
| C7 | confirmed | https://hono.dev/docs/middleware/builtin/cache |
| C8 | confirmed | https://developers.cloudflare.com/workers/reference/how-workers-works/, https://developers.cloudflare.com/workers/platform/limits/ |
| C9 | confirmed | https://developers.cloudflare.com/d1/best-practices/use-indexes/, https://developers.cloudflare.com/d1/worker-api/return-object/ |
| C10 | confirmed | https://developers.cloudflare.com/d1/platform/limits/ |
| C11 | confirmed | https://www.sqlite.org/eqp.html |
| C12 | confirmed | https://www.sqlite.org/rowvalue.html |
| C13 | confirmed | F7 local SQLite 3.51.0 verification in document; exact D1 version unknown but design avoids version dependencies |
| C14 | confirmed | https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults, …/guides/infinite-queries |
| C15 | confirmed | https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/, …/known-issues/ |
| C16 | confirmed | Local Node 26.8.1 verification confirms 456187629; https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ |
| C17 | confirmed | Local Node verification confirms dates; https://developers.cloudflare.com/workers/runtime-apis/web-standards/ |
| C18 | confirmed | https://developers.cloudflare.com/d1/sql-api/query-json/ |
| C19 | confirmed | /Users/peter/Projects/IOS Crosswords/Crosswords app with feed/design_handoff_crosscut_feed/README.md §Domain model/§D1 schema |
| C20 | confirmed | /private/tmp/claude-501/-Users-peter-Projects-IOS-Crosswords/9d054732-b7c8-4939-80a1-8eb9aba21fda/scratchpad/prototype-logic.js L309-326 and L262-270 |
| C21 | unverifiable | github.com/cloudflare/workers-sdk/issues/9040 (third-party, not official documentation) |
| C22 | unverifiable | Not addressed in gap-feed-composition-semantics.md |
