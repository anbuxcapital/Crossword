# Crosscut v1 wire contract — the normative freeze

Slug: `gap-api-contract-freeze` · File: `docs/research/api-contract-freeze.md` · Date: 2026-09-02

This document is the **single normative contract** for the Crosscut backend (one Cloudflare Worker, Hono 4.13.5, Zod 4.5.4, `@hono/zod-validator` 0.9.1). Where it disagrees with any other document in `docs/research/`, this document wins; the other documents are inputs and are cited by section. It reconciles:

- `docs/research/README.md` §"Modules and allowed dependencies", §"Event catalog", §"API surface" (referred to as **README-R**)
- `docs/research/domain-spec-extraction.md` §(b) endpoints, §(c) events (**DOMAIN**)
- `docs/research/durable-objects-d1-domain.md` R3 (command rules), R5 (leaderboards), R8 (feed query), R11 (**DO**)
- `docs/research/hono-best-practices.md` F3/F4/F6 + Recommendation 4–5 (**HONO**)
- `docs/research/zod4-usage.md` F3/F10 + Recommendation 5–10, Q5 (**ZOD**)
- `docs/research/in-process-event-bus.md` R2/R3 (**BUS**), `docs/research/identity-auth-v1.md` §Endpoints/§Middleware behaviour (**AUTH**), `docs/research/crossword-content-pipeline.md` F3 (**CONTENT**), `docs/research/modular-monolith-principles.md` S7 (**MMP**)
- The design handoff README screens 1–15: `/Users/peter/Projects/IOS Crosswords/Crosswords app with feed/design_handoff_crosscut_feed/README.md` (**HANDOFF**) and the prototype logic `/private/tmp/claude-501/-Users-peter-Projects-IOS-Crosswords/9d054732-b7c8-4939-80a1-8eb9aba21fda/scratchpad/prototype-logic.js` (**PROTO**)

Primary sources checked on 2026-09-02: https://hono.dev/docs/guides/validation , https://hono.dev/docs/guides/rpc , https://zod.dev/api , https://zod.dev/error-formatting , https://github.com/honojs/middleware/tree/main/packages/zod-validator , plus `npm view` (`hono` 4.13.5, `zod` 4.5.4, `@hono/zod-validator` 0.9.1 with peers `zod ^3.25.0 || ^4.0.0`, `hono >=4.11.2`).

## Summary

- **Twenty-two contradictions** were found between the topic docs and README-R (§Findings F1). Each gets exactly one decision here. The structurally important ones: `POST /solves/:id/words` keeps the client-supplied `locked` set but makes it unforgeable with a server HMAC `lockProof`; **`collections` owns the collection reward** (through `player.claimCollection`) and `economy` has **no subscriptions**, which restores the DAG; `PuzzleStats.recordSolve` is keyed on the puzzle's **`dropDate`** (`boardDay`), never on the solver's local `dayKey`; `/check` is stateless and **not gated** on `autocheck` (the toggle is only persisted for resume, via `/progress`; the separate `/autocheck` route is dropped); `GET /me` is the strongly-consistent aggregate snapshot and `GET /me/profile` contains **only** D1-derived statistics (no overlap); `finish` is idempotent because `User` keeps `lastResult` after `session = null`; `GET /feed` takes an optional `lang` override that is bound into the cursor and otherwise uses the user's stored preference.
- **Error envelope** is one shape everywhere: `{ error: { code, message?, details?, issues?, requestId } }` with lower-snake-case `code`; `DomainError` messages *are* the code and the gateway maps code → HTTP status through a fixed table (402/409/422). Validation issues use `z.treeifyError` (bodies are nested; `flattenError` is single-level only).
- **i18n rule**: the server never returns English UI prose. Anything the client renders as a sentence is either *content* (puzzle title, clue text, setter name, collection name — authored per `lang`) or a **structured item with a `kind` and args** (`ticker: TickerItem[]`, `kicker: Kicker`, `meta: PuzzleMeta`, `clue.ref: ClueRef`, `lock: LockRule`, `count: CountUnit`). The Expo app owns all copy for en/uk/ru (ZOD Q5). Validation messages stay English and are for developers only.
- **Keyboards**: the server serves per-`lang` layouts from `GET /v1/config` (public, cacheable): `en` 26 keys (QWERTY), `uk` 33 keys (ЙЦУКЕН rows incl. Ґ Є І Ї), `ru` 32 keys (Ё folded into Е per CONTENT F3 — `normalizeWord("ru")` folds `Ё→Е` on both the stored solution and typed letters; `uk` folds nothing).
- All schemas live in `packages/shared/src/wire/*.ts`: `z.object` for inbound bodies/queries, `z.strictObject` for every DTO and event payload, `z.discriminatedUnion` for `FeedItem`/`TickerItem`/`Kicker`/events, ids via regex + `.brand()`, timestamps via `z.iso.datetime()` (seconds mandatory in Zod 4.5). Handlers return `c.json(dto satisfies z.output<typeof Dto>, 200)` with an explicit status so `hc` narrows on `res.status`; contract tests parse every response with the DTO schema.
- The reconciled module graph is a DAG (§Recommendation, "Dependency graph") and `test/arch.test.ts` enforces it (imports only via `index.ts`/`contract.ts`, `subscriptions.ts` may only import `contract.ts` of lower layers, `economy` has no `subscriptions.ts`, SQL table prefixes match the owner).

## Findings

### F1. Cross-document contradictions and the decision for each

| # | topic | doc A says | doc B says | decision (normative) | rationale |
|---|---|---|---|---|---|
| 1 | `POST /solves/:id/words` body | README-R: `{ questionIndex, word, locked: number[] }`, "stateless, no DO hop" | DOMAIN (b): `{ questionIndex, word }`, server-side `Solve` DO holds `locked` | Body = `{ questionIndex, word, locked, lockProof }`. Stateless (no DO hop). `lockProof = base64url(HMAC-SHA256(LOCK_KEY, solveId + "\|" + userId + "\|" + sortedLocked.join(",")))`, minted by the server on every response that changes `locked` (start, words, fifty/pick, word hint, resume) and required on every request that sends `locked`. Empty set has a proof too. Wrong/missing proof → 422 `bad_lock_proof`. | README-R chose stateless per-word checks for latency (DO R3 anti-cheat (a)); but an unverified `locked` claim would let a client "claim" all across words and receive swept down-word letters (`letters`) for free. The HMAC keeps the route stateless and unforgeable; cost is one WebCrypto HMAC. |
| 2 | Who grants the collection reward | README-R module table: `economy` subscribes to `collections.completed` and grants via `player.claimCollection` | README-R event catalog + DO R6: `collections.onSolveFinished` calls `player.claimCollection` itself; `collections.completed` is emitted **after** the reward is committed | `collections` owns the claim (`collections.checkAndClaim` → `player.claimCollection({collectionId, memberIds, reward})` → emit `collections.completed`). `economy` subscribes to **nothing**; `economy/subscriptions.ts` does not exist. | `economy` is declared below `collections` in README-R's layering; an `economy` subscription would import `collections/contract.ts` upward (cycle: `collections → player`, `economy → collections`, `feed → economy`…). Reward amounts are computed once by the producer (README-R "consumers never recompute economy"). |
| 3 | Day key for `PuzzleStats.recordSolve` | README-R aggregate comment + DO R3: "keyed on the puzzle's drop_date … in a fixed reference zone (UTC)" | README-R event catalog: `social.recordSolve` consumes `solve.finished` whose only day field in the consumer text is the solver's `dayKey` (user-local) | `recordSolve({ boardDay })` with `boardDay = event.dropDate ?? utcDay(event.occurredAt)`. `topToday` resets when `boardDay` changes. `GET /puzzles/:id/leaderboard?period=today` returns `boardDay` explicitly. | Two solvers in Kyiv and Los Angeles must land on the same board for the same drop; user-local keys would split it. `dropDate` is already in the payload. |
| 4 | `/check` "stateless" vs gated on `autocheck` | README-R: `POST /solves/:id/check` "stateless; only while autocheck is on" | DO R3 anti-cheat: stateless calls against the cached secret, "no DO hop" | `/check` is stateless and **ungated**; rate-limited under `RL_USER`. `POST /solves/:id/autocheck` is **removed**; the toggle is persisted through `POST /solves/:id/progress { autocheck }` (called on pause/exit) so `GET /solves/:id` restores it. | Gating needs the session (DO hop) or a second proof for a free feature that neither flags `usedHints` nor touches stars (PROTO L555, HANDOFF §12). The leak surface of per-cell checks is the same as an honest autocheck user gets anyway. |
| 5 | `GET /me` vs `GET /me/profile` | README-R: `/me` includes balances, streak, completions, session; `/me/profile` repeats `balances`, `streak` and adds stats | DOMAIN (b): `/me` has `completedCount`, profile has `balances, streak` again | `MeView` (aggregate snapshot, strongly consistent) = identity, prefs, plan, balances, streak (+7-day strip), completedIds, likes, saves, session, wheel. `ProfileView` (D1, eventually consistent) = `solvedTotal, bestTimeSec, weekSolves, achievements, completed[] tiles, langs[]` and **nothing** that `MeView` has. The Profile screen composes both. | One source of optimistic state (README-R "the app's single source"); no field exists in two views with different consistency. |
| 6 | `finish` idempotency vs `session = null` | README-R: "idempotent per sessionId" | README-R/DO R3: `finishSolve` sets `session = null` → a retry finds no session → `NO_ACTIVE_SESSION` | `UserState.lastResult: { solveId, result: SolveResultCore } \| null` is written in the same commit. `finish` with a `solveId` equal to `lastResult.solveId` returns 200 with the stored result (recomputing `claimedCollections` from `collectionsClaimed`); a `solveId` that is neither active nor last → 409 `no_active_session`. `celebration` is derived from `hash(solveId) % 3`, so retries are byte-identical. | Mobile retries after a network timeout are the common case; the Solved screen must not show 409. |
| 7 | Feed `lang` query vs user prefs | README-R: `GET /feed?cursor&lang&limit` | HANDOFF §10: language chips on Profile switch `lang`; DOMAIN F3: `lang` is a stored pref | `lang` is an optional override; default = `MeView.lang`. The cursor encodes `lang`; a cursor whose `lang` differs from the request → 400 `invalid_cursor`. The Profile chips call `PATCH /me/prefs { lang }`. | Pages stay consistent within a scroll; the daily drop and stories always follow the stored preference. |
| 8 | Error envelope shape | HONO F4/Rec 5: `{ error: { code, message?, issues?, requestId } }`, `code: "invalid_request"`, `z.flattenError` | ZOD sketch: `{ error: "VALIDATION", issues: z.treeifyError(...) }`; AUTH: `{ error: "token_expired" }` (bare string); README-R: `402 INSUFFICIENT_TOKENS { balance, cost }`, `409 { error:"merged", mergedInto, token }` | One envelope (§Code sketches `errors.ts`): `{ error: { code, message?, details?, issues?, requestId } }`; `code` lower-snake; `issues` = `z.treeifyError(err)`; `details` carries structured extras (`{ balance, cost }`, `{ mergedInto, token }`, `{ retryAfterSec }`). | `treeifyError` handles nested bodies (`cells[]`, `grid[]`); `flattenError` is documented for single-level schemas (https://zod.dev/error-formatting). A string `error` cannot carry `requestId`. |
| 9 | Domain error code casing | DO R3: `DomainError("insufficient_tokens")`, `"already_spun"`, `"bad_tz"` | README-R: `INSUFFICIENT_TOKENS`, `WRONG_GRID`, `NO_ACTIVE_SESSION`, `ALREADY_SPUN` | lower-snake everywhere; `DomainError.message` **is** the code; `DOMAIN_STATUS` table maps code → 402/409/422. | Errors cross Workers RPC as `{ name, message }` only (https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/), so the code must ride in `message`. |
| 10 | Puzzle id format | ZOD F10/Rec 7: `^(en\|uk\|ru)-(mini\|cross)-[1-9]\d*$` (`en-mini-1`) | README-R content pipeline: `en-mini-0001` (4-digit, zero-padded) | `^(en\|uk\|ru)-(mini\|cross)-\d{4}$`. Aliases `mini1→en-mini-0001`, `cross1→en-cross-0001`, `mini2→en-mini-0002`, `mini3→en-mini-0003` exist only in the seed script. | Zero-padding keeps `ORDER BY id` meaningful inside the feed cursor `(drop_date DESC, id DESC)` (DO R8). |
| 11 | User id format | ZOD Rec 7: `z.uuidv7().brand<"UserId">()` | README-R/AUTH: `"u_" + 26-char Crockford base32` | `^u_[0-9a-hjkmnp-tv-z]{26}$` (lowercase Crockford). Solve ids `^s_…{26}$`. | Matches the identity doc that actually mints the ids; Better Auth (v2) ids get their own branded schema when they arrive. |
| 12 | `SolveView` fields | README-R: `locked, fixedLetters, secLeft, running, usedHints, autocheck, balances, status, replay` (no `filled`) | DOMAIN (b): `filled[][], qIndex, pendingFifty, usedHints` | No `filled` (stateless words; the client persists its own grid locally); no `qIndex` (client-only); no `pendingFifty` (50/50 is idempotent per `(solveId, questionIndex)` and re-requestable without charge); `usedHints` → `hintsUsed: int` + `noHintBonusAlive: boolean`; `fixedLetters` → `letters` (letters of all locked words). | The server holds only what it needs to verify, grant and resume. |
| 13 | `/words` completion signalling | README-R: `complete` | DOMAIN (b): `finished, result?: SolveResult` inside the words response | `complete: boolean` only; rewards come from `POST /solves/:id/finish { grid }`. | A stateless words endpoint cannot commit rewards; the finishing request verifies the whole grid server-side (README-R lifecycle). |
| 14 | Hint idempotency / two-object hazard | DOMAIN "Hints are not atomic across objects … debit first with an idempotency key … compensating refund" | README-R: `spendForHint` on `User` then content from the stateless module; no retry rule | Hints are idempotent per `(solveId, questionIndex, kind)`: `spendForHint` is a no-op when `hintLog` already contains that key; the payload (decoy pair, letter, word) is **deterministic** from `(secret, solveId, questionIndex)` so a retry returns the same content and `charged: false`. No refund path is needed because the debit and the hint log are one commit and the content is a pure function. | Eliminates the compensation logic DOMAIN needed when `Solve` was a second DO. |
| 15 | Letter-hint `filled` shape | README-R: `filled: string[]` | DOMAIN (b): `filled?: string[][]` | `filled: string[]` — rows in the grid format (`#` block, `.` empty, else one normalised letter). Same row format for `POST /finish { grid }`. | One grid encoding on the wire; `z.array(z.string())` is cheaper to validate than nested arrays. |
| 16 | Event type prefixes | README-R rule: `"<module>.<pastTenseFact>"` | README-R catalog uses `solve.*` (module is `solving`) and `player.streakExtended` produced by `solving` | Prefix = producing module: `solving.started/paused/resumed/hintUsed/finished`, `collections.completed/unlocked`, `economy.wheelSpun/packPurchased/planChanged`, `social.likeToggled/saveToggled`, `player.onboarded/prefsChanged`, `identity.userBootstrapped`. `player.streakExtended` is **dropped**; `solving.finished` carries `streak` and `streakExtended: boolean`. | One rule, no exceptions; one event fewer to test. |
| 17 | Leaderboard row fields | README-R: `{ rank, userId, displayName, solveTimeSec }` | DOMAIN (b): adds `finishedAt` | `LeaderboardRow = { rank, userId, displayName, solveTimeSec, solvedAt, isMe }`, plus `boardDay` on the view. | `isMe` avoids a client-side id comparison against a branded id; `solvedAt` supports tie display. |
| 18 | `GET /daily` | README-R: `{ dayKey, puzzleId }` | DOMAIN (b): `{ dayKey, puzzleIds: string[] }` | `{ dayKey, lang, puzzleId }` — one drop per day per language (README-R product default). | |
| 19 | Server-side prose | README-R: `ticker: string[]`, `countLabel`, `lockLabel`, `clueMeta`, `meta` strings, `kicker` strings | ZOD Q5: client owns all copy | §Recommendation "i18n rule": structured items only (`TickerItem`, `Kicker`, `PuzzleMeta`, `ClueRef`, `LockRule`, `CountUnit`). | en/uk/ru UI without server-side locale plumbing. |
| 20 | Stories / week strip length | PROTO L262-270: 6 stories; README-R: `Story[7]`; DOMAIN: `week: [{ dayKey, state }]` in `SolveResult` | | One schema `DayState { dayKey, state: today\|solved\|missed\|none }`, always **7 entries** (today + 6 previous days, newest first), used by `FeedPage.stories`, `MeView.streak.week` and `SolveResult.streak.week`. | One renderer for the stories row and the Solved streak strip (HANDOFF §8 item 2, §13). |
| 21 | Folder/file names inside a module | README-R: `index.ts, contract.ts, http.ts, subscriptions.ts, internal/**` | HONO Rec 1: `routes.ts`, `service.ts`, `aggregate.ts` | README-R names. `http.ts` exports the chained sub-app; `index.ts` the commands/queries; `contract.ts` the DTO/event schemas re-exported from `packages/shared`. | The arch test (§Code sketches) keys on these names. |
| 22 | `already_spun` status | README-R: 422 | (state conflict by nature) | 409. Rule: **409** = state conflict (`already_spun`, `already_claimed`, `no_active_session`, `merged`, `purchase_conflict`, `tz_change_limit`); **422** = the request is well-formed but violates a domain rule (`wrong_grid`, `bad_tz`, `collection_incomplete`, `collection_locked`, `bad_lock_proof`, `question_locked`); **402** only `insufficient_tokens`. | Clients retry 409 after refreshing `/me`; they never retry 422 unchanged. |

Additional smaller alignments applied without a separate row: `hintCosts` and `WHEEL_PRIZES` are constants in `packages/shared/src/constants.ts` and are echoed in `GET /v1/config` and `WalletView` (never authoritative on the client); `Topic` values become lowercase slugs (`travel`, `movies`, `food`, `science`, `music`, `sport`, `art`, `words`) so they are keys, not English labels (HANDOFF §3); token packs get stable ids `p120`, `p550`, `p1400`; `badge` is `popular | best_value | null`.

### F2. Hono validation facts (verified 2026-09-02)

- Targets are `json`, `form`, `query`, `param`, `header`, `cookie`; multiple validators may be stacked on one route; header keys must be lowercase; validated data is read with `c.req.valid(target)`. Source: https://hono.dev/docs/guides/validation
- `zValidator(target, schema, hook?, options?)`; the hook receives `(result, c)` and may return a `Response` to short-circuit (`if (!result.success) return c.text('Invalid!', 400)`). Default parsing uses `.safeParseAsync`; `options.validationFunction` overrides it. `InferInput` from `hono/validator` infers the input type. Source: https://github.com/honojs/middleware/tree/main/packages/zod-validator (README)
- `@hono/zod-validator@0.9.1` peers: `zod ^3.25.0 || ^4.0.0`, `hono >=4.11.2` (`npm view @hono/zod-validator@0.9.1 peerDependencies`). Latest on npm today: `hono` 4.13.5, `zod` 4.5.4, `@hono/zod-validator` 0.9.1 (`npm view … version`).
- The hook's return type replaces the default 400 in the route's RPC response union; without a hook the raw `ZodSafeParseError` becomes the typed failure branch (HONO F3/F6, verified locally there with TS 7.0.2 — TS2339 when reading a 200 field without narrowing).

### F3. Hono RPC facts (verified 2026-09-02, https://hono.dev/docs/guides/rpc)

- `import { hc } from 'hono/client'`; `hc<AppType>(baseUrl)`; routes **must be chained** (`app.route('/authors', authors).route('/books', books)`) for the types to flow.
- Status typing requires an explicit literal in `c.json(data, 200)`; the client narrows with `res.status === 404` or `res.ok`.
- `InferRequestType<typeof $post>['form']`, `InferResponseType<typeof client.posts.$get, 200>` (second type argument = status).
- "Compile your code before using it": `export type Client = ReturnType<typeof hc<typeof app>>; export const hcWithType = (...args: Parameters<typeof hc>): Client => hc<typeof app>(...args)`.
- Known issues: `c.notFound()` is untyped (use `c.json({ error: … }, 404)`); promise chains lose types (use `async/await`); both tsconfigs need `"strict": true`.
- Path params and query values are passed as **strings** (`param: { id: '123' }`, `query: { page: '1' }`) — so every query/param schema uses `z.coerce.*` / `z.stringbool()` and the contract distinguishes `z.input` (wire) from `z.output` (handler).

### F4. Zod 4.5 facts (verified 2026-09-02, https://zod.dev/api and https://zod.dev/error-formatting)

- `z.object()` strips unknown keys; `z.strictObject()` "throws an error when unknown keys are found"; `z.looseObject()` passes them through.
- `z.discriminatedUnion("key", [ … ])` checks the discriminator first; options are object schemas with a literal discriminator (Zod 4 also allows unions/pipes as options — ZOD F3).
- `.brand<"X">()` affects only the inferred type (`{…} & z.$brand<"X">`); direction `"in" | "out" | "inout"` since 4.2; runtime unaffected.
- `z.iso.datetime()`: by default "seconds are required and sub-second precision is arbitrary"; `Z` only unless `{ offset: true }`; `{ local: true }` allows unqualified; `{ precision: 3 }` pins milliseconds.
- `z.int()` restricts to safe integers; `z.coerce.number()` input type is `unknown`; `z.stringbool()` parses `"true"/"1"/"yes"/"on"/"y"/"enabled"` and the falsy set, case-insensitive.
- `.default(v)` short-circuits (value must match the **output** type); `.prefault(v)` is parsed (value must match the **input** type).
- `z.treeifyError(err)` → nested `{ errors: string[], properties?: {…}, items?: […] }`; `z.flattenError(err)` → `{ formErrors, fieldErrors }` ("best for single-level schemas"); `z.prettifyError` → string; `.format()`/`.flatten()` deprecated. `ZodError.issues[]` = `{ code, path, message, … }`.
- `z.templateLiteral` does not encode numeric checks (ZOD F10, measured) → ids use regex + brand.

### F5. Letter normalisation and alphabets (CONTENT F3, measured locally there on Node 26.8.1)

[UNVERIFIED] `normalizeWord(lang, s)` = NFC → strip `[\s’’ʼ\-.]` → `toLocaleUpperCase(lang)` → fold table (`ru: Ё→Е`; `uk`: none; `en`: none) → alphabet whitelist. **Never** NFD + strip marks (merges `й→и`, `ї→і`). The same function runs at import (canonical solution) and at check time (typed word), so the two cannot disagree. [UNVERIFIED] Alphabets: `en` A–Z (26); `uk` `АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ` (33, no Ё Ъ Ы Э); `ru` `АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ` (33) → after folding, the **checkable** `ru` alphabet is 32 letters (no Ё). Alphabet membership is a standard-reference fact (medium confidence; letters verified by code-point probing in CONTENT, sizes not fetched from a primary source).

### F6. What the screens actually need (HANDOFF §1–15 → endpoints)

| screen | reads | writes | notes |
|---|---|---|---|
| 1 Welcome | `GET /v1/config` (public) | `POST /v1/devices` (first launch) | bootstrap before the funnel so "Skip all" can persist defaults |
| 2–4 Quiz Level/Topics/Language | `config.topics`, `config.langs` | — (client state) | |
| 5 Plan Ready | — | `POST /v1/me/onboarding` | idempotent overwrite; returns `MeView` |
| 6 Notifications pre-prompt | — | included in onboarding body `notifications` | no push in v1 |
| 7 Paywall | `config.plans` | `POST /v1/billing/plan` | mock; returns `PlanView` |
| 8 Feed | `GET /v1/me`, `GET /v1/feed` | `POST /v1/puzzles/:id/like`, `/save`, `POST /v1/wheel/:wheelId/spin` | stories, ticker, streak-at-risk, wheel, mystery are in `FeedPage` |
| 9 Browse + Collection detail | `GET /v1/collections`, `GET /v1/collections/:id`; `MeView.session` for "Continue solving" | `POST /v1/collections/:id/claim` | `GET /me/continue` is **dropped**: `ContinueView` is `MeView.session` |
| 10 Profile | `GET /v1/me`, `GET /v1/me/profile`, `GET /v1/leaderboard/week` | `PATCH /v1/me/prefs` | language chips |
| 11 Puzzle page | `GET /v1/puzzles/:id`, `GET /v1/puzzles/:id/leaderboard` | `POST /v1/puzzles/:id/solves` | "Play again" sends `{ restart: true }` |
| 12 Play + Hint sheet | `GET /v1/solves/:solveId`, `config.keyboards[lang]` | `/words`, `/hints/fifty`, `/hints/fifty/pick`, `/hints/letter`, `/hints/word`, `/check`, `/pause`, `/resume`, `/progress`, `POST /v1/puzzles/:id/presence` | |
| 13 Solved | response of `POST /v1/solves/:solveId/finish` | — | `nextPuzzleId` and `celebration` inside `SolveResult` |
| 14 Wallet | `GET /v1/wallet` | `POST /v1/wallet/purchases` | |
| 15 Tab bar | — | — | client only |

## Recommendation for Crosscut

### R1. Contract rules (apply to every endpoint)

1. Base path `/v1`; JSON only; `Authorization: Bearer <device token>` on everything except `POST /devices`, `GET /config`, `GET /healthz`; admin routes use the `CONTENT_ADMIN_TOKEN` bearer.
2. Inbound: `z.object` (strip). Outbound DTOs and event payloads: `z.strictObject`. Unions: `z.discriminatedUnion`. Ids: regex + `.brand()`. Times: `z.iso.datetime()` UTC `Z` strings; durations in integer seconds (`…Sec`) or milliseconds (`…Ms`); day keys `YYYY-MM-DD`.
3. Query/param schemas use `z.coerce.number()`, `z.stringbool()`, `z.enum().prefault()` because `hc` sends strings (F3).
4. Every `zValidator` gets the shared `hook` (F2) — never the default 400 body. Handlers return `c.json(dto satisfies z.output<typeof Dto>, <literal status>)`; contract tests parse the response with the DTO schema (production does not re-parse).
5. Every route is chained on a `createFactory<AppEnv>({ defaultAppOptions: { strict: false } }).createApp()` sub-app; the gateway does `app.basePath("/v1").route("/feed", feed)…`; `export type AppType = typeof routes`; the Expo app consumes the emitted `.d.ts` through `packages/api-client` `hcWithType` (HONO Rec 6).
6. No English sentences in any DTO (R4). Content strings (titles, clues, names, blurbs) are authored per `lang` and returned verbatim.
7. Errors: one envelope, one code list (R3). `WWW-Authenticate: Bearer realm="crosscut"` on every 401; `Retry-After` on every 429 and 503.
8. Idempotency: `finish` per `solveId`; hints per `(solveId, questionIndex, kind)`; purchases/plan/spin per client `idempotencyKey`; onboarding/prefs are overwrites; like/save carry the target state (`{ liked: true }`), never "toggle".
9. Consistency labels in the docs of each DTO: **S** = aggregate snapshot (linearizable per user), **P** = D1 projection (ms lag, minutes while a flush is failing), **C** = cron-materialised (≤ 5 min). From DO R11.

### R2. Endpoint index (normative)

| # | method | path | auth | RL | request schema | 2xx | typed non-2xx |
|---|---|---|---|---|---|---|---|
| 1 | GET | `/config` | none | — | — | 200 `ConfigView` (cache 1 h) | — |
| 2 | POST | `/devices` | none | RL_BOOT | `DeviceBody` | 201 `DeviceSession` | 429 |
| 3 | POST | `/session/refresh` | device (exp ≤ 30 d ago ok) | RL_USER | — | 200 `DeviceSession` | 401, 409 `merged` |
| 4 | GET | `/me` | device | RL_USER | — | 200 `MeView` (S) | 401 |
| 5 | DELETE | `/me` | device | RL_SPEND | — | 204 | 401 |
| 6 | POST | `/me/reconcile` | device or admin | RL_SPEND | — | 200 `ReconcileReport` | |
| 7 | POST | `/me/onboarding` | device | RL_USER | `OnboardingBody` | 200 `MeView` | 422 `bad_tz` |
| 8 | PATCH | `/me/prefs` | device | RL_USER | `PrefsPatch` | 200 `MeView` | 409 `tz_change_limit`, 422 `bad_tz` |
| 9 | GET | `/me/profile` | device | RL_USER | — | 200 `ProfileView` (P) | |
| 10 | GET | `/me/saved` | device | RL_USER | — | 200 `SavedView` (S) | |
| 11 | GET | `/feed` | device | RL_USER | `FeedQuery` | 200 `FeedPage` (P + S for `me.*`) | 400 `invalid_cursor` |
| 12 | GET | `/daily` | device | RL_USER | `DailyQuery` | 200 `DailyView` | 404 `no_drop` |
| 13 | GET | `/puzzles/:id` | device | RL_USER | `PuzzleParam` | 200 `PuzzleView` | 404 `puzzle_not_found` |
| 14 | GET | `/puzzles/:id/leaderboard` | device | RL_USER | `PuzzleParam`, `LeaderboardQuery` | 200 `PuzzleLeaderboard` (P) | 404 |
| 15 | GET | `/puzzles/:id/next` | device | RL_USER | `PuzzleParam` | 200 `NextView` | 404 |
| 16 | POST | `/puzzles/:id/like` | device | RL_USER | `LikeBody` | 200 `LikeResult` | 404 |
| 17 | POST | `/puzzles/:id/save` | device | RL_USER | `SaveBody` | 200 `SaveResult` | 404 |
| 18 | POST | `/puzzles/:id/presence` | device | RL_USER | `PresenceBody` | 200 `PresenceResult` | 404 |
| 19 | POST | `/puzzles/:id/solves` | device | RL_USER | `StartSolveBody` | 201 `SolveView` | 404 |
| 20 | GET | `/solves/:solveId` | device | RL_USER | `SolveParam` | 200 `SolveView` | 404 `solve_not_found`, 409 `no_active_session` |
| 21 | POST | `/solves/:solveId/words` | device | RL_USER | `WordsBody` | 200 `WordsResult` | 422 `bad_lock_proof`, `bad_question` |
| 22 | POST | `/solves/:solveId/progress` | device | RL_USER | `ProgressBody` | 204 | 409, 422 |
| 23 | POST | `/solves/:solveId/hints/fifty` | device | RL_SPEND | `HintBody` | 200 `FiftyResult` | 402, 409, 422 `question_locked` |
| 24 | POST | `/solves/:solveId/hints/fifty/pick` | device | RL_USER | `FiftyPickBody` | 200 `WordsResult` | 422 |
| 25 | POST | `/solves/:solveId/hints/letter` | device | RL_SPEND | `LetterHintBody` | 200 `LetterResult` | 402, 409 |
| 26 | POST | `/solves/:solveId/hints/word` | device | RL_SPEND | `WordHintBody` | 200 `WordHintResult` | 402, 409, 422 |
| 27 | POST | `/solves/:solveId/check` | device | RL_USER | `CheckBody` | 200 `CheckResult` | 422 |
| 28 | POST | `/solves/:solveId/pause` | device | RL_USER | — | 200 `TimerView` | 409 |
| 29 | POST | `/solves/:solveId/resume` | device | RL_USER | — | 200 `TimerView` | 409 |
| 30 | POST | `/solves/:solveId/finish` | device | RL_USER | `FinishBody` | 200 `SolveResult` | 409 `no_active_session`, 422 `wrong_grid` |
| 31 | GET | `/collections` | device | RL_USER | `CollectionsQuery` | 200 `CollectionsView` (P) | |
| 32 | GET | `/collections/:id` | device | RL_USER | `CollectionParam` | 200 `CollectionDetail` (P) | 404 |
| 33 | POST | `/collections/:id/claim` | device | RL_SPEND | — | 200 `ClaimResult` | 404, 409 `already_claimed`, 422 `collection_incomplete`/`collection_locked` |
| 34 | GET | `/leaderboard/week` | device | RL_USER | — | 200 `WeekLeaderboard` (C) | |
| 35 | GET | `/wallet` | device | RL_USER | — | 200 `WalletView` (S) | |
| 36 | POST | `/wallet/purchases` | device | RL_SPEND | `PurchaseBody` | 200 `PurchaseResult` | 409 `purchase_conflict` |
| 37 | POST | `/billing/plan` | device | RL_SPEND | `PlanBody` | 200 `PlanView` | 409 |
| 38 | GET | `/wheel` | device | RL_USER | — | 200 `WheelView` (S) | |
| 39 | POST | `/wheel/:wheelId/spin` | device | RL_SPEND | `WheelParam`, `SpinBody` | 200 `SpinResult` | 404 `wheel_not_found`, 409 `already_spun` |
| 40 | POST | `/admin/content/import` | admin | — | `ImportBody` (512 KB) | 200/207 `ImportReport` | 403 |
| 41 | GET | `/admin/content/status` | admin | — | — | 200 `ContentStatus` | 403 |
| 42 | POST | `/admin/collections/import` | admin | — | `CollectionsImportBody` | 200 `ImportReport` | 403 |
| 43 | GET | `/healthz` | none | — | — | 200 `{ ok: true }` | — |

Removed relative to README-R: `POST /solves/:id/autocheck` (folded into `/progress`), `GET /me/continue` (= `MeView.session`). Added: `GET /config`, `GET /leaderboard/week`, `GET /healthz`.

### R3. Error catalog (numbered, normative)

Envelope (all non-2xx): `{ error: { code, message?, details?, issues?, requestId } }`. `code` is from `ErrorCode`; `message` is developer-facing English and must never be shown to users; `details` is code-specific; `issues` only on `invalid_request`.

| # | HTTP | `code` | when | `details` | client action |
|---|---|---|---|---|---|
| E01 | 400 | `invalid_request` | Zod validation of `json`/`query`/`param`/`header` failed | `target`, `issues` = `z.treeifyError` | bug; log; do not retry |
| E02 | 400 | `invalid_cursor` | cursor undecodable, version/lang mismatch, page > 10 | `{ reason }` | restart feed from page 1 |
| E03 | 400 | `bad_json` | body not JSON / wrong content-type | — | bug |
| E04 | 401 | `unauthenticated` | no/invalid bearer, signature fail, `typ !== "device"` | — | re-bootstrap (`POST /devices`) |
| E05 | 401 | `token_expired` | `exp` passed | `{ refreshable: boolean }` (≤ 30 d) | `POST /session/refresh`, else re-bootstrap |
| E06 | 401 | `token_key_unknown` | `kid` not in key ring | — | re-bootstrap |
| E07 | 401 | `token_revoked` | `tv` < aggregate `tokenVersion` (sensitive commands only) | — | re-bootstrap |
| E08 | 402 | `insufficient_tokens` | hint/spend needs more tokens than the wallet has | `{ balance, cost, kind }` | close sheet, route to Wallet (HANDOFF §12) |
| E09 | 403 | `forbidden` | admin token wrong/missing; solve belongs to another user | — | none |
| E10 | 404 | `not_found` | no route | — | bug |
| E11 | 404 | `puzzle_not_found` / `solve_not_found` / `collection_not_found` / `wheel_not_found` / `user_not_found` / `no_drop` | id unknown, `NotInitializedError` from a DO, no drop for `(day, lang)` | `{ id }` | refresh the parent screen |
| E12 | 409 | `no_active_session` | `solveId` is neither the active session nor `lastResult.solveId` | `{ activeSolveId: string \| null }` | `GET /me`, resume `session` or start a new solve |
| E13 | 409 | `already_spun` | wheel for that `wheelId` already spun today | `{ wheel: WheelState }` | show result |
| E14 | 409 | `already_claimed` | collection reward already credited | `{ collectionId }` | refresh collection |
| E15 | 409 | `purchase_conflict` | `idempotencyKey` reused with a different payload | `{ idempotencyKey }` | new key |
| E16 | 409 | `tz_change_limit` | second tz change in the same local day | `{ nextAllowedAt }` | keep old tz |
| E17 | 409 | `merged` | aggregate merged into an account (v2) | `{ mergedInto, token }` | swap token |
| E18 | 413 | `payload_too_large` | `bodyLimit` (64 KB; admin 512 KB) | — | bug |
| E19 | 422 | `wrong_grid` | submitted grid ≠ solution | `{ wrongCells: [r,c][] }` (count only if > 10) | keep playing |
| E20 | 422 | `bad_lock_proof` | `lockProof` does not match `locked` | — | resync via `GET /solves/:id` |
| E21 | 422 | `bad_question` / `question_locked` / `bad_word` | index out of range / hint on a locked word / word length ≠ slot length or letters outside the alphabet | `{ questionIndex }` | bug / no-op |
| E22 | 422 | `bad_tz` | IANA zone rejected by `Intl.DateTimeFormat` | `{ tz }` | fall back to device zone |
| E23 | 422 | `collection_incomplete` / `collection_locked` | claim before all members solved / unlock rule unmet | `{ done, total }` / `{ lock: LockRule }` | none |
| E24 | 422 | `solve_finished` | words/hint/check on a finished (replay-finished) session | — | `GET /me` |
| E25 | 422 | `invalid_puzzle` (admin) | validator rejected content | `{ rejected: [{ id, issues }] }` | fix content |
| E26 | 429 | `rate_limited` | `RL_BOOT`/`RL_USER`/`RL_SPEND` exceeded | `{ retryAfterSec, scope }` + `Retry-After` header | back off |
| E27 | 500 | `internal` | unexpected | — | show generic error with `requestId` |
| E28 | 503 | `retry_later` | `err.retryable` (D1/DO transient) | `{ retryAfterSec }` + `Retry-After` | retry with jitter |

`DomainError` → status mapping (gateway table, §Code sketches `errors.ts`): 402 `insufficient_tokens`; 409 `no_active_session already_spun already_claimed purchase_conflict tz_change_limit merged`; 422 everything else. `NotInitializedError` → 404 `user_not_found`; `HTTPException` → its status with `code: "http_error"` unless it carries a typed `res`; `ZodError` thrown outside a validator → 400 `invalid_request`; `.retryable` → 503.

### R4. i18n rule

**The server returns data, keys and arguments — never sentences.** Concretely:

| README-R field | replaced by | client renders (en example) |
|---|---|---|
| `ticker: string[]` | `ticker: TickerItem[]` — `fast_solve { displayName, puzzleId, title, timeSec, agoSec }`, `long_streak { displayName, days }`, `solving_now { puzzleId, title, count }`, `liked { displayName, puzzleId, title, agoSec }`, `leaderboard_pass { displayName }`, `archive_teaser { dropDate }` | "wordwasp solved Monday Mini in 0:58 — just now" |
| `meta: "Mini · 5×5 · 2m ago"` | `meta: PuzzleMeta { kind, size, parSec, clueCount, publishedAt, dropDate }` | client formats kind, `size×size`, relative time |
| `kicker: "MONDAY MINI · SEP 1"` | `kicker: Kicker` (`daily { dropDate }`, `crossword { n, clueCount }`, `themed { collectionId, name }`, `archive { dropDate }`, `mystery {}`) | weekday from `dropDate` in the user's locale |
| `clueMeta: "7-Across of 10 clues"` | `clue: { text, ref: { num, dir, clueCount } }` | |
| `countLabel: "4 collections"` | `count: { count, unit: collections \| setters \| months }` | |
| `lockLabel: "Finish Travel to unlock"` | `lock: { kind: "collection_complete", collectionId, name }` | |
| `solvedCountLabel` | `stats: { likeCount, solvedCount, solvingNow }` | |
| `"You won 🪙 n!"` / `"So close"` | `SpinResult.prize` (0 = no win) | |
| `"{streak}-day streak at risk"`, `"9h 14m left"` | `streakAtRisk: { streak, dayEndsAt, puzzleId }` | |
| `displayName: "Player-7F3A"` | stays (identity, not copy); derived from the user id suffix on the server so all clients agree | |
| Difficulty `EASY/MEDIUM/TRICKY` | enum keys (client maps to copy) | |

Content strings (`title`, clue `text`, `author.name`, collection `name`/`blurb`, `themeWord` post-solve) are authored per `lang` and pass through unchanged. Validation `message`s are English developer text; the app maps `issues` paths/codes to its own copy if it ever shows them (ZOD Q5).

### R5. Keyboards served per `lang` (`GET /v1/config`)

`KeyboardLayout = { lang, rows: string[][], letterCount, special: { hint: "row3-start", backspace: "row3-end" } }`. Rows are ordered top → bottom; the client inserts the gold HINT key at the start of row 3 and ⌫ at its end (HANDOFF §12).

| lang | row 1 | row 2 | row 3 | letters | note |
|---|---|---|---|---|---|
| `en` | Q W E R T Y U I O P | A S D F G H J K L | Z X C V B N M | 26 | PROTO L399-402 |
| `uk` | Й Ц У К Е Н Г Ш Щ З Х Ї | Ф І В А П Р О Л Д Ж Є | Я Ч С М И Т Ь Б Ю Ґ | 33 | includes Ґ Є І Ї; no Ё Ъ Ы Э; `normalizeWord("uk")` folds nothing (CONTENT F3) |
| `ru` | Й Ц У К Е Н Г Ш Щ З Х Ъ | Ф Ы В А П Р О Л Д Ж Э | Я Ч С М И Т Ь Б Ю | 32 | Ё omitted because `normalizeWord("ru")` folds Ё→Е in both the stored solution and typed letters (CONTENT F3); the 33-letter variant would add Ё to row 1 |

[UNVERIFIED] The row contents follow the standard ЙЦУКЕН layouts; their exact order is a UI convention, not a data requirement — marked **UNVERIFIED against a primary layout reference** (standard-keyboard fact, medium confidence). Row 1 at 12 keys needs narrower keys than the 26 px prototype key on a 390 px frame (open question Q4). The same alphabets are exported as `ConfigView.alphabets[lang]` so the client can filter pasted input.

### R6. Dependency graph (after reconciliation — a DAG)

```
layer 0   shared
layer 1   events ──────────────────────────────► shared
layer 2   content ─► shared            player ─► shared, events
layer 3   identity ─► shared, player
layer 4   solving  ─► shared, events, content, player
          economy  ─► shared, events, player                    (NO subscriptions; never imports collections)
          social   ─► shared, events, content, player
layer 5   collections ─► shared, events, content, player         (subscribes: solving.finished; calls player.claimCollection)
          leaderboard ─► shared, content, player
layer 6   feed ─► content, player, social, collections, leaderboard, economy   (queries + contract.ts only; no commands)
          notifications ─► shared, events, player                (subscribes: solving.finished, player.onboarded, collections.completed)
layer 7   app ─► everything (wiring.ts builds the handler table; modules never import app)
```

Edges point downward only. Subscriptions are the only "upward-looking" relationship and they are expressed as *the lower module importing the higher module's `contract.ts`* is **forbidden**; instead the higher module's `subscriptions.ts` imports the lower producer's `contract.ts` (`collections/subscriptions.ts` imports `solving/contract.ts`; `social/subscriptions.ts` imports `solving/contract.ts` and its own). Critical handler order for `solving.finished`: `collections.checkAndClaim` → `social.recordSolve` (README-R), then background `notifications.cancelReminder`, `analytics`.

### R7. Where the schemas live

```
packages/shared/src/
  constants.ts           HINT_COST, WHEEL_PRIZES, PACKS, PLANS, TOPICS, PAR
  wire/primitives.ts     Lang, DayKey, IsoDateTime, Tokens, Balances, enums
  wire/ids.ts            PuzzleId, UserId, SolveId, CollectionId, WheelId, Cursor, IdempotencyKey
  wire/errors.ts         ErrorCode, ErrorEnvelope, DOMAIN_STATUS
  wire/i18n.ts           Kicker, PuzzleMeta, ClueRef, TickerItem, CountUnit, LockRule, DayState
  wire/identity.ts       DeviceBody, DeviceSession
  wire/me.ts             MeView, StreakView, ContinueView, WheelState, OnboardingBody, PrefsPatch, ProfileView, SavedView, ReconcileReport
  wire/feed.ts           FeedQuery, FeedItem, FeedPage, DailyQuery, DailyView
  wire/puzzle.ts         Setter, CoverView, PuzzleStatsView, PuzzleView, NextView, LeaderboardRow, PuzzleLeaderboard, WeekLeaderboard
  wire/solve.ts          QuestionView, SolveView, WordsBody, WordsResult, ProgressBody, HintBody, FiftyResult, FiftyPickBody, LetterHintBody, LetterResult, WordHintBody, WordHintResult, CheckBody, CheckResult, TimerView, FinishBody, SolveResult
  wire/economy.ts        WalletView, PurchaseBody, PurchaseResult, PlanBody, PlanView, WheelView, SpinBody, SpinResult
  wire/collections.ts    CollectionCard, Shelf, CollectionsView, CollectionDetail, ClaimResult
  wire/social.ts         LikeBody, LikeResult, SaveBody, SaveResult, PresenceBody, PresenceResult
  wire/config.ts         KeyboardLayout, ConfigView
  wire/admin.ts          ImportBody, ImportReport, ContentStatus
  events/*.ts            Envelope + per-module payloads (strictObject), re-exported by each module's contract.ts
  index.ts               export * from every file above
```

`packages/shared` has `peerDependencies: { zod: "^4.5.4" }`, `import * as z from "zod"` only (never `zod/mini`, `zod/v4`, `z.compile`). Module `contract.ts` files re-export from `@crosscut/shared` and add `examples` for the contract tests.

## Code sketches

All sketches target zod 4.5.4 / hono 4.13.5 / `@hono/zod-validator` 0.9.1 and follow the verified APIs in F2–F4. They are illustrative; field lists are normative.

### `wire/primitives.ts`, `wire/ids.ts`

```ts
import * as z from "zod";

export const Lang = z.enum(["en", "uk", "ru"]);
export const DayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).brand<"DayKey">();
export const IsoDateTime = z.iso.datetime();                    // "2026-09-02T10:00:00Z" — seconds required (zod 4.5)
export const Tokens = z.int().nonnegative();
export const Balances = z.strictObject({ tokens: Tokens, stars: Tokens });
export const Difficulty = z.enum(["EASY", "MEDIUM", "TRICKY"]);
export const PuzzleKind = z.enum(["mini", "crossword"]);
export const Size = z.union([z.literal(5), z.literal(9)]);
export const ParSec = z.union([z.literal(300), z.literal(600)]);
export const CoverStyle = z.enum(["ink", "accent", "card"]);
export const Level = z.enum(["newbie", "casual", "shark"]);
export const Topic = z.enum(["travel", "movies", "food", "science", "music", "sport", "art", "words"]);
export const PlanTier = z.enum(["lite", "month", "year"]);
export const NotificationsChoice = z.enum(["enabled", "declined", "skipped"]);
export const Tz = z.string().min(1).max(64);                    // validated by Intl.DateTimeFormat in the aggregate (DO R3)
export const Cell = z.tuple([z.int().min(0).max(8), z.int().min(0).max(8)]);
export const GridRow = z.string().min(5).max(9);                // '#' block, '.' empty, else one normalised letter
export const Letter = z.string().regex(/^[A-ZА-ЯЇІЄҐ]$/u);      // post-normalisation; Ё is folded for ru before it reaches the wire

// ids.ts
const B32 = "[0-9a-hjkmnp-tv-z]{26}";                            // lowercase Crockford base32
export const PuzzleId = z.string().regex(/^(en|uk|ru)-(mini|cross)-\d{4}$/).brand<"PuzzleId">();
export const UserId = z.string().regex(new RegExp(`^u_${B32}$`)).brand<"UserId">();
export const SolveId = z.string().regex(new RegExp(`^s_${B32}$`)).brand<"SolveId">();
export const CollectionId = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).brand<"CollectionId">();
export const WheelId = z.string().regex(/^\d{4}-\d{2}-\d{2}:base$/).brand<"WheelId">();   // "<dayKey>:base" — one per local day
export const IdempotencyKey = z.string().min(8).max(64);
export const Cursor = z.string().min(1).max(512);               // opaque: base64url(JSON [1, lang, today, dropDate, id, page])
export type PuzzleId = z.infer<typeof PuzzleId>; export type UserId = z.infer<typeof UserId>; export type SolveId = z.infer<typeof SolveId>;
```

### `wire/errors.ts`

```ts
export const ErrorCode = z.enum([
  "invalid_request", "invalid_cursor", "bad_json",
  "unauthenticated", "token_expired", "token_key_unknown", "token_revoked",
  "insufficient_tokens", "forbidden", "not_found",
  "puzzle_not_found", "solve_not_found", "collection_not_found", "wheel_not_found", "user_not_found", "no_drop",
  "no_active_session", "already_spun", "already_claimed", "purchase_conflict", "tz_change_limit", "merged",
  "payload_too_large",
  "wrong_grid", "bad_lock_proof", "bad_question", "question_locked", "bad_word", "bad_tz",
  "collection_incomplete", "collection_locked", "solve_finished", "invalid_puzzle",
  "rate_limited", "internal", "retry_later", "http_error",
]);
export const ErrorEnvelope = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string().optional(),                 // developer English, never shown to users
    details: z.record(z.string(), z.unknown()).optional(),
    issues: z.unknown().optional(),                 // z.treeifyError(ZodError) on invalid_request
    requestId: z.string(),
  }),
});
export const InsufficientTokensDetails = z.strictObject({ balance: Tokens, cost: Tokens, kind: z.enum(["fifty", "letter", "word"]) });

/** DomainError.message === code (errors cross Workers RPC as { name, message } only). */
export const DOMAIN_STATUS: Record<string, 402 | 409 | 422> = {
  insufficient_tokens: 402,
  no_active_session: 409, already_spun: 409, already_claimed: 409, purchase_conflict: 409, tz_change_limit: 409, merged: 409,
};
export const domainStatus = (code: string) => DOMAIN_STATUS[code] ?? 422;
```

### `wire/i18n.ts`

```ts
export const DayState = z.strictObject({ dayKey: DayKey, state: z.enum(["today", "solved", "missed", "none"]) });
export const WeekStrip = z.array(DayState).length(7);            // index 0 = today, then 6 previous days
export const Kicker = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("daily"), dropDate: DayKey }),
  z.strictObject({ kind: z.literal("crossword"), n: z.int().positive(), clueCount: z.int().positive() }),
  z.strictObject({ kind: z.literal("themed"), collectionId: CollectionId, name: z.string() }),
  z.strictObject({ kind: z.literal("archive"), dropDate: DayKey }),
  z.strictObject({ kind: z.literal("mystery") }),
]);
export const PuzzleMeta = z.strictObject({ kind: PuzzleKind, size: Size, parSec: ParSec, clueCount: z.int().positive(), publishedAt: IsoDateTime, dropDate: DayKey.nullable() });
export const ClueRef = z.strictObject({ num: z.int().positive(), dir: z.enum(["ACROSS", "DOWN"]), clueCount: z.int().positive() });
export const CountUnit = z.strictObject({ count: z.int().nonnegative(), unit: z.enum(["collections", "setters", "months"]) });
export const LockRule = z.strictObject({ kind: z.literal("collection_complete"), collectionId: CollectionId, name: z.string() });
export const TickerItem = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fast_solve"), displayName: z.string(), puzzleId: PuzzleId, title: z.string(), timeSec: z.int().positive(), agoSec: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal("long_streak"), displayName: z.string(), days: z.int().positive() }),
  z.strictObject({ kind: z.literal("solving_now"), puzzleId: PuzzleId, title: z.string(), count: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal("liked"), displayName: z.string(), puzzleId: PuzzleId, title: z.string(), agoSec: z.int().nonnegative() }),
  z.strictObject({ kind: z.literal("leaderboard_pass"), displayName: z.string() }),
  z.strictObject({ kind: z.literal("archive_teaser"), dropDate: DayKey }),
]);
```

### `wire/identity.ts`, `wire/me.ts`

```ts
export const DeviceBody = z.object({
  installId: z.uuid(), platform: z.enum(["ios", "android", "web"]), appVersion: z.string().max(32),
  locale: z.string().max(16).optional(), tz: Tz.optional(),
});
export const DeviceSession = z.strictObject({ userId: UserId, token: z.string(), expiresAt: IsoDateTime });

export const StreakView = z.strictObject({
  count: z.int().nonnegative(), longest: z.int().nonnegative(), todaySolved: z.boolean(), atRisk: z.boolean(),
  dayKey: DayKey, dayEndsAt: IsoDateTime, week: WeekStrip,
});
export const ContinueView = z.strictObject({                     // = MeView.session; replaces GET /me/continue
  solveId: SolveId, puzzleId: PuzzleId, title: z.string(), kind: PuzzleKind, size: Size,
  locked: z.int().nonnegative(), total: z.int().positive(), secLeft: z.int().nonnegative(), running: z.boolean(), replay: z.boolean(),
});
export const WheelState = z.strictObject({ wheelId: WheelId, canSpin: z.boolean(), lastPrize: Tokens.nullable(), lastPrizeIndex: z.int().min(0).max(5).nullable() });
export const PlanView = z.strictObject({ tier: PlanTier, expiresAt: IsoDateTime.nullable(), adsRemoved: z.boolean() });

export const MeView = z.strictObject({                            // consistency S
  id: UserId, displayName: z.string(), since: IsoDateTime, lang: Lang, tz: Tz, level: Level, topics: z.array(Topic).max(8),
  plan: PlanView, notifications: NotificationsChoice, onboardingDone: z.boolean(),
  balances: Balances, streak: StreakView,
  completedIds: z.array(PuzzleId), likes: z.array(PuzzleId), saves: z.array(PuzzleId),
  session: ContinueView.nullable(), wheel: WheelState, version: z.int().nonnegative(),
});
export const OnboardingBody = z.object({
  level: Level, topics: z.array(Topic).max(8), lang: Lang, plan: PlanTier, notifications: NotificationsChoice, tz: Tz,
  skippedAt: z.enum(["welcome", "level", "topics", "language", "planReady", "notifs", "paywall"]).optional(),
});
export const PrefsPatch = z.object({ level: Level.optional(), topics: z.array(Topic).max(8).optional(), lang: Lang.optional(), tz: Tz.optional(), notifications: NotificationsChoice.optional() })
  .refine((p) => Object.values(p).some((v) => v !== undefined), { error: "empty patch" });
export const ProfileView = z.strictObject({                       // consistency P; nothing that MeView already has
  solvedTotal: z.int().nonnegative(), bestTimeSec: z.int().positive().nullable(), weekSolves: z.int().nonnegative(),
  achievements: z.strictObject({ done: z.int().nonnegative(), total: z.int().nonnegative() }),
  completed: z.array(z.strictObject({ puzzleId: PuzzleId, title: z.string(), themeInitial: Letter, solvedAt: IsoDateTime })).max(12),
  langs: z.array(z.strictObject({ lang: Lang, solved: z.int().nonnegative() })),
});
export const SavedView = z.strictObject({ puzzleIds: z.array(PuzzleId) });
export const ReconcileReport = z.strictObject({ repaired: z.array(z.enum(["puzzle_stats", "collections", "player_solves"])) });
```

### `wire/puzzle.ts`

```ts
export const Setter = z.strictObject({ id: z.string(), name: z.string(), initial: z.string().min(1).max(2), tone: z.enum(["accent", "ink", "card", "gold"]) });
export const CoverView = z.strictObject({
  style: CoverStyle,
  tiles: z.array(z.strictObject({ i: z.int().nonnegative(), ch: Letter.nullable(), accent: z.boolean() })).min(3).max(9), // ch null = '?' tile
});
export const CoverClue = z.strictObject({ text: z.string(), ref: ClueRef });
export const PuzzleStatsView = z.strictObject({ likeCount: z.int().nonnegative(), solvedCount: z.int().nonnegative(), solvingNow: z.int().nonnegative() });
export const PuzzleMe = z.strictObject({ done: z.boolean(), bestTimeSec: z.int().positive().nullable(), inProgressSolveId: SolveId.nullable(), liked: z.boolean(), saved: z.boolean() });
export const PuzzleView = z.strictObject({
  id: PuzzleId, lang: Lang, title: z.string(), author: Setter, difficulty: Difficulty, meta: PuzzleMeta, kicker: Kicker,
  cover: CoverView, clue: CoverClue, stats: PuzzleStatsView, me: PuzzleMe, tokensPerFiveSec: z.literal(1),
});
export const PuzzleParam = z.object({ id: PuzzleId });
export const NextView = z.strictObject({ nextPuzzleId: PuzzleId.nullable() });
export const LeaderboardQuery = z.object({ period: z.enum(["today"]).prefault("today"), limit: z.coerce.number().int().min(1).max(10).default(3) });
export const LeaderboardRow = z.strictObject({ rank: z.int().positive(), userId: UserId, displayName: z.string(), solveTimeSec: z.int().positive(), solvedAt: IsoDateTime, isMe: z.boolean() });
export const PuzzleLeaderboard = z.strictObject({ boardDay: DayKey, rows: z.array(LeaderboardRow).max(10), me: z.strictObject({ rank: z.int().positive(), solveTimeSec: z.int().positive() }).nullable() });
export const WeekLeaderboard = z.strictObject({
  weekKey: z.string().regex(/^\d{4}-W\d{2}$/),
  rows: z.array(z.strictObject({ rank: z.int().positive(), userId: UserId, displayName: z.string(), stars: Tokens, solves: z.int().nonnegative(), isMe: z.boolean() })).max(100),
  me: z.strictObject({ rank: z.int().positive(), stars: Tokens, solves: z.int().nonnegative() }).nullable(),
});
```

### `wire/feed.ts`

```ts
export const FeedQuery = z.object({
  cursor: Cursor.optional(),
  lang: Lang.optional(),                                          // override; default MeView.lang; bound into the cursor
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type FeedQueryIn = z.input<typeof FeedQuery>;              // what hc sends (strings)
const ItemBase = { key: z.string(), position: z.int().nonnegative() };
export const PuzzlePostItem = z.strictObject({ type: z.literal("puzzle_post"), ...ItemBase,
  puzzleId: PuzzleId, title: z.string(), author: Setter, difficulty: Difficulty, meta: PuzzleMeta, kicker: Kicker,
  cover: CoverView, clue: CoverClue, stats: PuzzleStatsView, me: PuzzleMe, isDaily: z.boolean(),
});
export const StreakSaveItem = z.strictObject({ type: z.literal("streak_save"), ...ItemBase, streak: z.int().nonnegative(), dayEndsAt: IsoDateTime, puzzleId: PuzzleId });
export const WheelItem = z.strictObject({ type: z.literal("wheel"), ...ItemBase, wheel: WheelState });
export const MysteryItem = z.strictObject({ type: z.literal("mystery"), ...ItemBase, puzzleId: PuzzleId });   // client hides the id until tapped
export const FeedItem = z.discriminatedUnion("type", [PuzzlePostItem, StreakSaveItem, WheelItem, MysteryItem]);
// No `skeleton` item: the shimmer blocks are a client loading state; the page ends when nextCursor === null.
export const FeedPage = z.strictObject({
  lang: Lang, today: DayKey, page: z.int().min(1).max(10),
  items: z.array(FeedItem).max(60), nextCursor: Cursor.nullable(),
  stories: WeekStrip, ticker: z.array(TickerItem).max(8),
  streakAtRisk: z.strictObject({ streak: z.int().positive(), dayEndsAt: IsoDateTime, puzzleId: PuzzleId }).nullable(),
  balances: Balances,
});
export const DailyQuery = z.object({ lang: Lang.optional() });
export const DailyView = z.strictObject({ dayKey: DayKey, lang: Lang, puzzleId: PuzzleId });
```

Composition (README-R + DO R8): page 1 = today's drop (`isDaily: true`) → `streak_save` at position 1 only while today is unsolved → archive posts (`drop_date DESC, id DESC`) with `wheel` at position 3 when `canSpin` and `mystery` every 6th; 10-page cap; `key = "${type}:${puzzleId|wheelId|dayKey}#${position}"`.

### `wire/solve.ts`

```ts
export const QuestionView = z.strictObject({ index: z.int().nonnegative(), dir: z.enum(["ACROSS", "DOWN"]), num: z.int().positive(), clue: z.string(), length: z.int().min(3).max(9), cells: z.array(Cell).min(3).max(9) });
export const LockedLetter = z.strictObject({ r: z.int().min(0).max(8), c: z.int().min(0).max(8), ch: Letter });
export const LockProof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);   // base64url(HMAC-SHA256) without padding
export const SolveView = z.strictObject({
  solveId: SolveId, puzzleId: PuzzleId, lang: Lang, title: z.string(), size: Size, parSec: ParSec,
  grid: z.array(GridRow.regex(/^[.#]+$/)).min(5).max(9), questions: z.array(QuestionView).max(64), questionCount: z.int().positive(),
  locked: z.array(z.int().nonnegative()).max(64), lockProof: LockProof, letters: z.array(LockedLetter).max(81),
  secLeft: z.int().nonnegative(), running: z.boolean(), hintsUsed: z.int().nonnegative(), noHintBonusAlive: z.boolean(), autocheck: z.boolean(),
  replay: z.boolean(), status: z.enum(["active", "finished"]), balances: Balances,
  hintCosts: z.strictObject({ fifty: z.literal(20), letter: z.literal(40), word: z.literal(100) }),
});
export const StartSolveBody = z.object({ restart: z.boolean().default(false) });
export const SolveParam = z.object({ solveId: SolveId });
const LockedSet = { locked: z.array(z.int().nonnegative()).max(64), lockProof: LockProof };
export const WordsBody = z.object({ questionIndex: z.int().min(0).max(63), word: z.string().min(1).max(15), ...LockedSet });
export const WordsResult = z.strictObject({
  correct: z.boolean(), locked: z.array(z.int().nonnegative()), lockProof: LockProof, newlyLocked: z.array(z.int().nonnegative()),
  letters: z.array(LockedLetter),                                 // letters of newlyLocked words (typed + swept)
  nextQuestionIndex: z.int().nonnegative().nullable(), complete: z.boolean(),
});
export const ProgressBody = z.object({ ...LockedSet, autocheck: z.boolean() });            // 204; replaces POST /autocheck
export const HintBody = z.object({ questionIndex: z.int().min(0).max(63) });
export const FiftyResult = z.strictObject({ options: z.tuple([z.string(), z.string()]), balances: Balances, charged: z.boolean() });
export const FiftyPickBody = z.object({ questionIndex: z.int().min(0).max(63), word: z.string().min(1).max(15), ...LockedSet });
export const LetterHintBody = z.object({ questionIndex: z.int().min(0).max(63), filled: z.array(GridRow).min(5).max(9) });
export const LetterResult = z.discriminatedUnion("revealed", [
  z.strictObject({ revealed: z.literal(true), cell: Cell, letter: Letter, balances: Balances, charged: z.boolean() }),
  z.strictObject({ revealed: z.literal(false), reason: z.enum(["already_correct"]), balances: Balances }),
]);
export const WordHintBody = z.object({ questionIndex: z.int().min(0).max(63), ...LockedSet });
export const WordHintResult = z.strictObject({ ...WordsResult.shape, word: z.string(), balances: Balances, charged: z.boolean() });
export const CheckBody = z.object({ cells: z.array(z.object({ r: z.int().min(0).max(8), c: z.int().min(0).max(8), ch: z.string().length(1) })).max(81) });
export const CheckResult = z.strictObject({ wrongCells: z.array(Cell) });
export const TimerView = z.strictObject({ secLeft: z.int().nonnegative(), running: z.boolean(), pausedMs: z.int().nonnegative() });
export const FinishBody = z.object({ grid: z.array(GridRow).min(5).max(9) });
export const Celebration = z.enum(["coins", "reels", "marquee"]);
export const SolveResult = z.strictObject({
  solveId: SolveId, puzzleId: PuzzleId, title: z.string(), parSec: ParSec,
  solveTimeSec: z.int().nonnegative(), secLeft: z.int().nonnegative(), underPar: z.boolean(),
  firstSolve: z.boolean(), replay: z.boolean(), suspicious: z.boolean(),
  earnings: z.strictObject({ solveStars: z.union([z.literal(10), z.literal(0)]), noHintStars: z.union([z.literal(2), z.literal(0)]), timeTokens: Tokens }),
  tokensEarned: Tokens, starsEarned: Tokens, balances: Balances,
  streak: StreakView, streakExtended: z.boolean(),
  claimedCollections: z.array(z.strictObject({ collectionId: CollectionId, name: z.string(), reward: Tokens })),
  nextPuzzleId: PuzzleId.nullable(), celebration: Celebration,   // hash(solveId) % 3 — deterministic on retry
  themeWord: z.string().min(3).max(9),                           // safe post-solve; feeds the "reels" celebration
});
```

Formulas (unchanged from README-R/DO R3): `secLeft = max(0, floor((parSec·1000 − elapsedMs)/1000))`, `timeTokens = replay || suspicious ? 0 : floor(secLeft/5)`, `solveStars = replay ? 0 : 10`, `noHintStars = replay || hintsUsed > 0 ? 0 : 2`.

### `wire/economy.ts`, `wire/collections.ts`, `wire/social.ts`, `wire/config.ts`

```ts
export const PackId = z.enum(["p120", "p550", "p1400"]);
export const Pack = z.strictObject({ id: PackId, tokens: Tokens, priceCents: z.int().positive(), currency: z.literal("USD"), badge: z.enum(["popular", "best_value"]).nullable() });
export const Plan = z.strictObject({ tier: PlanTier, priceCents: z.int().nonnegative(), period: z.enum(["forever", "month", "year"]), monthlyEquivalentCents: z.int().nonnegative().nullable(), badge: z.enum(["two_months_free"]).nullable() });
export const LedgerEntry = z.strictObject({ at: IsoDateTime, delta: z.int(), kind: z.enum(["tokens", "stars"]),
  reason: z.enum(["time_bonus", "solve", "no_hint_bonus", "hint", "wheel", "pack", "collection"]), ref: z.string() });
export const WalletView = z.strictObject({ balances: Balances, packs: z.array(Pack).length(3), plans: z.array(Plan).length(3),
  hintCosts: SolveView.shape.hintCosts, ledger: z.array(LedgerEntry).max(50) });
export const PurchaseBody = z.object({ packId: PackId, idempotencyKey: IdempotencyKey, receipt: z.string().max(4096).optional() });
export const PurchaseResult = z.strictObject({ balances: Balances, ledgerEntry: LedgerEntry, mocked: z.literal(true) });
export const PlanBody = z.object({ plan: PlanTier, idempotencyKey: IdempotencyKey });
export const WheelView = z.strictObject({ wheels: z.array(WheelState).length(1) });
export const WheelParam = z.object({ wheelId: WheelId });
export const SpinBody = z.object({ idempotencyKey: IdempotencyKey });
export const SpinResult = z.strictObject({ wheelId: WheelId, prizeIndex: z.int().min(0).max(5), prize: Tokens,
  prizes: z.tuple([z.literal(50), z.literal(10), z.literal(0), z.literal(25), z.literal(5), z.literal(15)]), balances: Balances });

export const Shelf = z.enum(["theme", "size", "setter", "archive"]);
export const CollectionCard = z.strictObject({
  id: CollectionId, shelf: Shelf, name: z.string(), emoji: z.string().min(1).max(4), blurb: z.string(), style: CoverStyle,
  total: z.int().positive(), done: z.int().nonnegative(), pct: z.int().min(0).max(100),
  locked: z.boolean(), lock: LockRule.nullable(), reward: Tokens, claimed: z.boolean(), claimable: z.boolean(),
});
export const CollectionsQuery = z.object({ lang: Lang.optional() });
export const CollectionsView = z.strictObject({ lang: Lang, shelves: z.array(z.strictObject({ key: Shelf, count: CountUnit, items: z.array(CollectionCard) })).length(4) });
export const CollectionParam = z.object({ id: CollectionId });
export const CollectionDetail = z.strictObject({ ...CollectionCard.shape,
  members: z.array(z.strictObject({ n: z.int().positive(), puzzleId: PuzzleId, title: z.string(), author: Setter, meta: PuzzleMeta, difficulty: Difficulty, done: z.boolean() })) });
export const ClaimResult = z.strictObject({ claimed: z.boolean(), reward: Tokens, balances: Balances });

export const LikeBody = z.object({ liked: z.boolean() });
export const LikeResult = z.strictObject({ liked: z.boolean(), likeCount: z.int().nonnegative() });
export const SaveBody = z.object({ saved: z.boolean() });
export const SaveResult = z.strictObject({ saved: z.boolean() });
export const PresenceBody = z.object({ state: z.enum(["solving", "left"]) });
export const PresenceResult = z.strictObject({ solvingNow: z.int().nonnegative() });

export const KeyboardLayout = z.strictObject({ lang: Lang, rows: z.tuple([z.array(Letter), z.array(Letter), z.array(Letter)]), letterCount: z.int().min(26).max(33),
  special: z.strictObject({ hint: z.literal("row3-start"), backspace: z.literal("row3-end") }) });
export const ConfigView = z.strictObject({
  keyboards: z.record(Lang, KeyboardLayout), alphabets: z.record(Lang, z.string()),
  hintCosts: SolveView.shape.hintCosts, wheelPrizes: SpinResult.shape.prizes, packs: z.array(Pack).length(3), plans: z.array(Plan).length(3),
  topics: z.array(Topic).length(8), levels: z.array(Level).length(3), langs: z.array(Lang).length(3),
  par: z.strictObject({ 5: z.literal(300), 9: z.literal(600) }), minAppVersion: z.string(),
});
export const KEYBOARDS = {
  en: [["Q","W","E","R","T","Y","U","I","O","P"], ["A","S","D","F","G","H","J","K","L"], ["Z","X","C","V","B","N","M"]],
  uk: [["Й","Ц","У","К","Е","Н","Г","Ш","Щ","З","Х","Ї"], ["Ф","І","В","А","П","Р","О","Л","Д","Ж","Є"], ["Я","Ч","С","М","И","Т","Ь","Б","Ю","Ґ"]],
  ru: [["Й","Ц","У","К","Е","Н","Г","Ш","Щ","З","Х","Ъ"], ["Ф","Ы","В","А","П","Р","О","Л","Д","Ж","Э"], ["Я","Ч","С","М","И","Т","Ь","Б","Ю"]],   // Ё folded → Е
} as const;
```

### Event envelope and `solving.finished` (`events/*.ts`)

```ts
export const Actor = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("user"), userId: UserId }), z.strictObject({ kind: z.literal("system"), reason: z.string() })]);
export const envelope = <T extends string, P extends z.ZodType>(type: T, payload: P) => z.strictObject({
  id: z.uuid(), type: z.literal(type), v: z.literal(1), occurredAt: IsoDateTime, actor: Actor,
  correlationId: z.string(), causationId: z.string(),
  aggregate: z.strictObject({ kind: z.enum(["user", "puzzle_stats"]), id: z.string(), version: z.int().nonnegative() }),
  payload,
});
export const SolvingFinished = envelope("solving.finished", z.strictObject({
  userId: UserId, puzzleId: PuzzleId, solveId: SolveId, lang: Lang, dropDate: DayKey.nullable(),
  solveTimeMs: z.int().nonnegative(), secLeft: z.int().nonnegative(), parSec: ParSec, hintsUsed: z.int().nonnegative(),
  firstSolve: z.boolean(), replay: z.boolean(), suspicious: z.boolean(), tokensEarned: Tokens, starsEarned: Tokens,
  dayKey: DayKey, streak: z.int().nonnegative(), streakExtended: z.boolean(),
}));
export const CollectionsCompleted = envelope("collections.completed", z.strictObject({ userId: UserId, collectionId: CollectionId, reward: Tokens, causedBySolveId: SolveId.nullable() }));
// Also: identity.userBootstrapped, player.onboarded, player.prefsChanged, solving.started/paused/resumed/hintUsed,
// collections.unlocked, economy.wheelSpun/packPurchased/planChanged, social.likeToggled/saveToggled, player.merged (v2).
```

### Gateway: hook, error handler, one route, `AppType`

```ts
// src/shared/http/validation.ts
import type { Hook } from "@hono/zod-validator";
import * as z from "zod";
export const hook: Hook<unknown, AppEnv, string> = (result, c) => {
  if (!result.success) {
    return c.json({ error: { code: "invalid_request" as const, target: result.target, issues: z.treeifyError(result.error), requestId: c.get("requestId") } }, 400);
  }
};

// src/shared/http/errors.ts
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get("requestId");
  if (err instanceof HTTPException) return err.res ?? c.json({ error: { code: "http_error", message: err.message, requestId } }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: { code: "invalid_request", issues: z.treeifyError(err), requestId } }, 400);
  if (err.name === "DomainError") {                                // message === code; name/message survive Workers RPC
    const code = ErrorCode.safeParse(err.message).success ? (err.message as z.infer<typeof ErrorCode>) : "internal";
    return c.json({ error: { code, details: (err as { details?: Record<string, unknown> }).details, requestId } }, domainStatus(code));
  }
  if (err.name === "NotInitializedError") return c.json({ error: { code: "user_not_found", requestId } }, 404);
  if ((err as { retryable?: boolean }).retryable) { c.header("Retry-After", "2"); return c.json({ error: { code: "retry_later", details: { retryAfterSec: 2 }, requestId } }, 503); }
  console.error({ requestId, name: err.name, message: err.message, stack: err.stack });
  return c.json({ error: { code: "internal", requestId } }, 500);
};

// src/modules/solving/http.ts (chained; literal statuses; DTO checked with `satisfies`)
export const solving = factory.createApp().use(deviceAuth)
  .post("/solves/:solveId/words", zValidator("param", SolveParam, hook), zValidator("json", WordsBody, hook), async (c) => {
    const r = await c.get("modules").solving.submitWord({ ...c.req.valid("param"), ...c.req.valid("json") });
    return c.json(r satisfies z.output<typeof WordsResult>, 200);
  })
  .post("/solves/:solveId/finish", zValidator("param", SolveParam, hook), zValidator("json", FinishBody, hook), async (c) => {
    const r = await c.get("modules").solving.finish({ ...c.req.valid("param"), ...c.req.valid("json") });
    return c.json(r satisfies z.output<typeof SolveResult>, 200);
  });

// src/app/app.ts
const routes = app.basePath("/v1").route("/", config).route("/", identity).route("/", player).route("/", feed).route("/", solving)
  .route("/", economy).route("/", social).route("/", collections).route("/", leaderboard).route("/admin", admin);
export type AppType = typeof routes;
// packages/api-client: export type Client = ReturnType<typeof hc<AppType>>; export const hcWithType = (...a: Parameters<typeof hc>): Client => hc<AppType>(...a);
// apps/app: const res = await api.v1.feed.$get({ query: { limit: "20" } }); if (res.status === 200) { const page: InferResponseType<typeof api.v1.feed.$get, 200> = await res.json(); }
```

### `lockProof` (stateless, unforgeable `locked`)

```ts
// src/modules/solving/internal/lock-proof.ts — key: LOCK_PROOF_KEY secret (32 random bytes, base64), imported once per isolate
export async function lockProof(key: CryptoKey, solveId: string, userId: string, locked: number[]) {
  const msg = new TextEncoder().encode(`${solveId}|${userId}|${[...new Set(locked)].sort((a, b) => a - b).join(",")}`);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, msg)));       // 43 chars
}
// submitWord: verify(lockProof) else DomainError("bad_lock_proof"); normalizeWord(lang, word) === answers[q] → locked ∪ {q} → sweep → new proof.
```

### Contract test and `test/arch.test.ts`

```ts
// test/contract.test.ts — every response parses with its DTO (production handlers use `satisfies`, tests parse)
it("GET /v1/me matches MeView", async () => {
  const res = await exports.default.fetch(new Request("http://x/v1/me", { headers: auth }), env, ctx);
  expect(res.status).toBe(200);
  expect(MeView.safeParse(await res.json()).success).toBe(true);
});

// test/arch.test.ts — TS-API-free (MMP S7), with the reconciled matrix
const MODULES = ["content", "player", "identity", "solving", "economy", "social", "collections", "leaderboard", "feed", "notifications"] as const;
const ALLOW: Record<string, readonly string[]> = {
  content: [], player: [], identity: ["player"],
  solving: ["content", "player"], economy: ["player"], social: ["content", "player"],
  collections: ["content", "player"], leaderboard: ["content", "player"],
  feed: ["content", "player", "social", "collections", "leaderboard", "economy"], notifications: ["player"],
};
const SUBSCRIBES_TO: Record<string, readonly string[]> = {                 // subscriptions.ts may import only these contracts
  social: ["solving", "social"], collections: ["solving", "collections"], notifications: ["solving", "player", "collections"],
};
const NO_SUBSCRIPTIONS = ["economy", "content", "player", "identity", "solving", "leaderboard", "feed"];
// Rules asserted per file (regex over import specifiers, see MMP S7 for the walker):
// 1. `modules/<m>/**` may import `modules/<other>/{index,contract}.ts` only if other ∈ ALLOW[m] (or ∈ SUBSCRIBES_TO[m] from subscriptions.ts).
// 2. Nothing under `modules/` imports `app/`; `shared/` and `events/` import nothing under `modules/`.
// 3. `modules/<m>/http.ts` imports only its own `index.ts`, `contract.ts`, `shared/**`, `@crosscut/shared`, hono, zod.
// 4. `modules/<m>/subscriptions.ts` exists only for m ∈ keys(SUBSCRIBES_TO); `NO_SUBSCRIPTIONS` modules must not have one.
// 5. SQL table identifiers `<prefix>_…` referenced in `modules/<m>/**` must have prefix === m, except `feed/internal/query.ts`
//    which may read `content_*`, `social_puzzle_stats`, `player_solves`, `leaderboard_week` (read-only composed query, README-R).
// 6. `contract.ts` files import only from `@crosscut/shared` and zod (no runtime module code).
// 7. Topological check: build the edge list from rules 1 and 4 and assert no cycle (Kahn's algorithm) so a future edit cannot re-introduce economy → collections.
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | `@hono/zod-validator` supports targets `json`, `form`, `query`, `param`, `header`, `cookie`; validators stack; header keys must be lowercase; data is read with `c.req.valid(target)`. | https://hono.dev/docs/guides/validation | high | confirmed |
| C2 | The zValidator hook is `(result, c) => Response \| void`; returning a Response short-circuits; default parsing is `safeParseAsync`; `validationFunction` overrides it; `InferInput` comes from `hono/validator`. | https://github.com/honojs/middleware/tree/main/packages/zod-validator (README) | high | confirmed |
| C3 | `@hono/zod-validator@0.9.1` peers are `zod ^3.25.0 \|\| ^4.0.0` and `hono >=4.11.2`; npm latest on 2026-09-02: hono 4.13.5, zod 4.5.4, @hono/zod-validator 0.9.1. | `npm view @hono/zod-validator@0.9.1 peerDependencies`; `npm view hono version`; `npm view zod version` | high | confirmed |
| C4 | Hono RPC requires chained routes, explicit status literals in `c.json(data, 200)`, `strict: true` on both sides; `InferResponseType<T, 200>` selects by status; `hcWithType` pre-compilation is the documented performance pattern; `c.notFound()` is untyped; path/query values are strings. | https://hono.dev/docs/guides/rpc | high | confirmed |
| C5 | `z.object()` strips unknown keys, `z.strictObject()` rejects them, `z.looseObject()` passes them through; `z.discriminatedUnion("key", [...])` dispatches on a literal discriminator. | https://zod.dev/api | high | confirmed |
| C6 | `z.iso.datetime()` requires seconds by default and accepts only `Z` unless `{ offset: true }`/`{ local: true }`; `z.int()` is safe-integer; `z.coerce.number()` has `unknown` input; `z.stringbool()` parses true/false string sets case-insensitively; `.default()` short-circuits while `.prefault()` is parsed. | https://zod.dev/api | high | confirmed |
| C7 | `.brand<"X">()` changes only the inferred type (`T & z.$brand<"X">`), not runtime behaviour; direction `in\|out\|inout` since 4.2. | https://zod.dev/api | high | confirmed |
| C8 | `z.treeifyError` returns a nested tree; `z.flattenError` returns `{ formErrors, fieldErrors }` and is "best for single-level schemas"; `.format()`/`.flatten()`/`z.formatError` are deprecated. | https://zod.dev/error-formatting | high | confirmed |
| C9 | README-R's module table has `economy` subscribing to `collections.completed` while its own event catalog has `collections` calling `player.claimCollection` and emitting `collections.completed` afterwards; with `economy` declared below `collections`, the subscription would be an upward import. | README-R L59, L104, L171, L67 (`docs/research/README.md`) | high | confirmed |
| C10 | [UNVERIFIED] README-R's `words` body carries `locked: number[]` and is "stateless"; DOMAIN's `words` body is `{ questionIndex, word }` against a `Solve` DO. | README-R L223; DOMAIN L402 | high | unverifiable |
| C11 | [UNVERIFIED] `PuzzleStats.recordSolve` is described as keyed on the puzzle's `drop_date` (README-R L137, DO R3) while the `solve.finished` payload/consumer text carries the solver's `dayKey` (README-R L170). | README-R L137, L170; `docs/research/durable-objects-d1-domain.md` R3 | high | unverifiable |
| C12 | [UNVERIFIED] README-R declares `/check` stateless yet "only while autocheck is on", and `finish` "idempotent per sessionId" while `finishSolve` sets `session = null`. | README-R L230, L232, L102 | high | unverifiable |
| C13 | Workers RPC preserves only `message` and the prototype `name` of a thrown error, so a domain error code must ride in `message`. | https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ (as cited in HONO F4 and README-R) | high | confirmed |
| C14 | [UNVERIFIED] `normalizeWord` must be NFC → strip separators → `toLocaleUpperCase(lang)` → fold (`ru: Ё→Е`, `uk`: none) → alphabet whitelist; NFD + strip-marks merges `й→и` and `ї→і`. | `docs/research/crossword-content-pipeline.md` F3 (measured on Node 26.8.1) | high | unverifiable |
| C15 | [UNVERIFIED] Ukrainian alphabet has 33 letters incl. Ґ Є І Ї and no Ё Ъ Ы Э; Russian has 33 incl. Ё (32 after folding Ё→Е). | standard reference (CONTENT F3 lists the letters; sizes not fetched from a primary source) | medium | unverifiable |
| C16 | [UNVERIFIED] The ЙЦУКЕН row assignments used in `KEYBOARDS.uk/ru` match the conventional Ukrainian/Russian layouts (Ґ on the extra key, Ъ/Э on the right edge). | standard keyboard convention — UNVERIFIED against a primary layout reference | medium | unverifiable |
| C17 | [UNVERIFIED] `import type { Hook } from "@hono/zod-validator"` and a hook returning `c.json({...}, 400)` type-check on TS 7.0.2 and produce a typed 400 branch in `hc`. | `docs/research/hono-best-practices.md` F3/F6 (verified locally there) | medium | unverifiable |
| C18 | [UNVERIFIED] Branded id types survive into the client's `InferResponseType` unchanged (i.e. Hono's `JSONParsed<T>` keeps the `$brand` intersection). | not verified — UNVERIFIED | low | unverifiable |

## Open questions

1. **Branded ids over `hc`** (C18): if `JSONParsed<T>` drops or mangles `z.$brand`, DTO id fields should use the un-branded regex schema (`PuzzleId.unwrap()`-style plain `z.string().regex()`) while inbound param schemas keep the brand. Decide after the first `tsc` run of `packages/api-client`.
2. **`lockProof` key management**: a dedicated `LOCK_PROOF_KEY` secret vs. deriving from the active `DEVICE_TOKEN_KEYS` entry (rotation would invalidate in-flight solves; a resync via `GET /solves/:id` heals it). Recommendation: dedicated secret, never rotated mid-day.
3. **Deterministic hint payloads**: the 50/50 decoy is `pick(decoysOfLength, seed = hash(solveId, questionIndex))` from the puzzle's curated `decoys` or the language bank. Confirm the bank exists for `uk`/`ru` before M3 (CONTENT R7); otherwise `fifty` returns 422 `bad_question` for those languages.
4. **Cyrillic key widths**: 12 keys in row 1 on a 390 px frame needs ~25 px keys with 5 px gaps (below the 44 px hit-target guidance of HANDOFF §Geometry). Options: 4-row layout for `uk`/`ru`, or drop Ъ/Ь to a long-press. Server-side the layout schema already allows any row lengths.
5. **Ё in Russian answers**: this contract folds Ё→Е (CONTENT F3). If editorial wants Ё visible on the grid, `KEYBOARDS.ru` gains Ё (33 keys) and `normalizeWord("ru")` must stop folding — a content-pipeline decision that changes both sides at once.
6. **`wrong_grid` details**: returning `wrongCells` on 422 leaks correctness per cell just like `/check` does; keep it (autocheck already exposes it) or return only `wrongCount`. Default here: cells when ≤ 10, count otherwise.
7. **Mystery card identity**: `MysteryItem.puzzleId` is in the payload (the client hides it). A stricter variant returns a `mysteryToken` resolved by `GET /mystery/:token`; not worth a route in v1.
8. **Ledger depth** in `WalletView.ledger` (50 entries from the aggregate's ring buffer) — confirm the `UserState` size budget (< 100 KB) with 50 entries × ~80 bytes.
9. **`GET /leaderboard/week`** is new (Profile "This week" card); confirm the product wants a weekly board at all before M5, otherwise `ProfileView.weekSolves` suffices.
10. **`DELETE /me` semantics** when a solve is in progress and when `plan.tier !== "lite"` (mock billing) — purge unconditionally in v1.

## Fact-check log

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://hono.dev/docs/guides/validation |
| C2 | confirmed | https://github.com/honojs/middleware/tree/main/packages/zod-validator |
| C3 | confirmed | npm view @hono/zod-validator@0.9.1 peerDependencies; npm view hono version; npm view zod version |
| C4 | confirmed | https://hono.dev/docs/guides/rpc |
| C5 | confirmed | https://zod.dev/api |
| C6 | confirmed | https://zod.dev/api |
| C7 | confirmed | https://zod.dev/api |
| C8 | confirmed | https://zod.dev/error-formatting |
| C9 | confirmed | docs/research/README.md lines 59 and 104 |
| C10 | unverifiable | Document does not provide sufficient excerpts to verify the exact content of both documents' specifications. |
| C11 | unverifiable | Document does not provide sufficient excerpts to verify the exact wording in both locations. |
| C12 | unverifiable | Document does not provide sufficient excerpts to verify the exact wording in README-R. |
| C13 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ |
| C14 | unverifiable | No primary source URL provided; claim refers to local measurement in CONTENT F3. |
| C15 | unverifiable | Document acknowledges this is standard reference (medium confidence) without primary URL verification. |
| C16 | unverifiable | Document explicitly marks this as UNVERIFIED against a primary layout reference. |
| C17 | unverifiable | Claim verified locally in hono-best-practices F3/F6 but no external primary source URL provided. |
| C18 | unverifiable | Document explicitly marks this as unverified with low confidence. |
