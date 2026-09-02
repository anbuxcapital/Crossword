# Implementation plan

Source of truth: `docs/ARCHITECTURE.md` (v1 design, final). Canonical names: `docs/design/glossary.md`. This
plan sequences and partitions file ownership only — it makes no design decisions. Every work package (WP) is
handed to a coding agent with **only** `ARCHITECTURE.md` + `glossary.md` + its own WP section. Agents must
never read another WP's section, never guess names not in the glossary, and never touch a file outside their
"Creates/edits (exclusive)" list.

**Repo root:** `/Users/peter/Projects/IOS Crosswords`. All paths below are relative to this root unless
given absolute.

**Hard rule (re-stated from the brief):** WP-1 through WP-12 may only create/edit files inside their own
`workers/gateway/src/modules/<name>/` folder (or `packages/shared/src/**` for WP-1, or `content/**` for
WP-3), their own pre-numbered migration file under `workers/gateway/migrations/`, and their own test files.
They must never touch `workers/gateway/src/app/*`, another module's folder, `wrangler.jsonc`, or any root
config file. Those are exclusive to WP-0 and WP-13.

**Layering (ARCHITECTURE.md §1 DAG) drives the "Depends on" column:**
`shared/events (WP-1/2)` → `{content, player} (WP-3/4)` → `identity (WP-5)` → `{solving, economy, social}
(WP-6/7/8)` → `{collections, leaderboard} (WP-9/10)` → `{feed, notifications} (WP-11/12)` → `app (WP-13)`.
WP-0 is the prerequisite for all (scaffold must exist and compile before any module code lands). WP-14 runs
last.

---

## WP-0 — Scaffold

**Goal:** Stand up a compiling, testable monorepo skeleton with every config file, stub module, and the
`packages/core` upgrade in place, so WP-1…WP-13 can each work in isolation against a green baseline.

**Creates/edits (exclusive):**
- `/Users/peter/Projects/IOS Crosswords/package.json` (root)
- `/Users/peter/Projects/IOS Crosswords/pnpm-workspace.yaml`
- `/Users/peter/Projects/IOS Crosswords/turbo.json`
- `/Users/peter/Projects/IOS Crosswords/tsconfig.json` (root)
- `/Users/peter/Projects/IOS Crosswords/.gitignore`
- `workers/gateway/wrangler.jsonc`
- `workers/gateway/package.json`
- `workers/gateway/tsconfig.json`
- `workers/gateway/vitest.config.ts`
- `workers/gateway/.gitignore`
- `workers/gateway/.dev.vars.example`
- `workers/gateway/test/setup.ts`
- `workers/gateway/test/env.d.ts`
- `workers/gateway/migrations/0001_content.sql` (header comment only: `-- owned by: content module; see WP-3`)
- `workers/gateway/migrations/0002_player.sql` (header comment only: `-- owned by: player module; see WP-4`)
- `workers/gateway/migrations/0003_social.sql` (header comment only: `-- owned by: social module; see WP-8`)
- `workers/gateway/migrations/0006_leaderboard.sql` (header comment only: `-- owned by: leaderboard module; see WP-10`)
- `workers/gateway/migrations/0004_economy.sql` (header comment only: `-- owned by: economy module; see WP-7`)
- `workers/gateway/migrations/0005_notifications.sql` (header comment only: `-- owned by: notifications module; see WP-12`)
- `workers/gateway/seed/` (empty dir with `.gitkeep`; content of `0001_content.sql` is WP-3's)
- `workers/gateway/src/app/index.ts` (compiling stub: exports `default { fetch, scheduled }` returning 501, plus placeholder `export {}` for DO classes — real wiring is WP-13's)
- `workers/gateway/src/app/app.ts` (compiling stub: bare `Hono` instance, no module mounts)
- `workers/gateway/src/app/wiring.ts` (compiling stub: empty `HandlerTable`)
- `workers/gateway/src/app/modules.ts` (compiling stub: `createModules`/`resolveModules` returning `{}`)
- `workers/gateway/src/shared/index.ts`, `context.ts`, `errors.ts`, `ids.ts`, `time.ts`, `normalise.ts` (compiling stubs — real logic is WP-1's via `packages/shared`; these files re-export from `packages/shared` once WP-1 lands, but must compile as empty re-export stubs now)
- `workers/gateway/src/events/index.ts`, `envelope.ts`, `registry.ts`, `dispatch.ts` (compiling stubs — real logic is WP-2's)
- `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts` (compiling stub, `export {}`)
- `packages/core/**` — codemod existing files to `@cloudflare/vitest-plugin` 1.1.3 API, PLUS implement the four required changes from ARCHITECTURE.md §2 "Required changes to packages/core": (1) `projectionFingerprint(state)` hook, (2) `Projections.apply(..., attachments)` + `extra()` batched in one `DB.batch`, (3) `flushAttachments()`/`onFlushed()` hooks, (4) snapshot-size guard (warn >256 KiB, throw >1 MiB) in `#persist`. Add the four tests named in §2 to `packages/core/test/aggregate.test.ts`.
- `packages/core/vitest.config.ts` (if changed by the codemod)
- `packages/api-client/package.json`, `packages/api-client/tsconfig.json`, `packages/api-client/src/index.ts` (compiling stub)
- `content/` — empty directory structure only (`content/puzzles/en/`, `content/puzzles/uk/`, `content/puzzles/ru/`, `content/wordbank/`, `content/scripts/`, `content/collections.json` as `{}` placeholder); real content is WP-3's

**Reads:** ARCHITECTURE.md §0 (Decisions: Monorepo, TypeScript, Types generation, Test runner, Test config API, Deploy), §2 "Required changes to packages/core" (all four changes + tests), §7 Folder layout (full tree), §9 Local dev & deploy (wrangler.jsonc, package.json scripts, pnpm-workspace.yaml, turbo.json). Glossary §7 Files & Structure, §2 Durable Object Classes (row `Projections`).

**Depends on:** none (first WP).

**Acceptance:**
```
pnpm install                                    # succeeds, no peer-dep errors
pnpm --filter gateway types                     # generates worker-configuration.d.ts
pnpm -r typecheck                                # 0 errors across all packages/workers
pnpm --filter @app/core test                     # all core tests green, including the 4 new ones
```

**Agent brief:** Build the full repo scaffold exactly as specified in ARCHITECTURE.md §7 (Folder layout)
and §9 (Local dev & deploy config file listings — copy the `wrangler.jsonc`, `package.json` scripts,
`pnpm-workspace.yaml`, and `turbo.json` blocks verbatim, adjusting only what §9 itself says must change per
environment). Every stub file must compile under `strict: true` — use `export {}` or minimal typed no-op
implementations, never `any`. Do not implement business logic in any module stub; that is forbidden — other
agents own that. The one place with real logic in this WP is `packages/core`: implement the four changes
listed in ARCHITECTURE.md §2 precisely as described (fingerprint hook compares `JSON.stringify` of
`projectionFingerprint(prev)` vs `(next)`; `apply()` gains an `attachments: unknown` parameter passed to a
projection's optional `extra(state, meta, attachments): D1PreparedStatement[]`, batched with the main upsert
in one `DB.batch([upsert, ...extra])`; add `protected flushAttachments(): unknown { return undefined }` and
`protected onFlushed(_attachments: unknown): void {}` hooks called around `flush()`; add a snapshot-size
check after `JSON.stringify(state)` in `#persist` — log a warning over 256 KiB, throw over 1 MiB). Preserve
the existing self-rearming alarm retry behavior untouched. Do not change the public `Aggregate`/`init`/
`snapshot`/`commit`/`flush` signatures. Migration files WP-0 creates must contain ONLY a header comment
naming the owning module and WP — no table DDL; the owning WP fills them in. `wrangler.jsonc` at this stage
declares the `User` and `PuzzleStats` DO exports and `USER`/`PUZZLE_STATS` bindings (per glossary §2) and the
D1/KV/ratelimit bindings from §9, even though no module logic exists yet — this file is frozen after WP-0
except for WP-13's final pass reconciling any drift. Verify the acceptance commands actually pass before
finishing.

---

## WP-1 — packages/shared

**Goal:** Implement every wire-format Zod schema, shared constant, and pure helper function that every
other module imports, so downstream WPs never redefine a DTO or a formula.

**Creates/edits (exclusive):**
- `packages/shared/src/index.ts` (real exports, replacing WP-0's stub)
- `packages/shared/src/constants.ts`
- `packages/shared/src/wire/primitives.ts`, `ids.ts`, `errors.ts`, `i18n.ts`, `identity.ts`, `me.ts`, `feed.ts`, `puzzle.ts`, `solve.ts`, `economy.ts`, `collections.ts`, `social.ts`, `config.ts`, `admin.ts`
- `packages/shared/src/puzzle/validator.ts`, `normalise.ts`
- `packages/shared/src/events/envelope.ts` (Zod `Envelope` schema shared by module `contract.ts` files — NOT the dispatcher itself, that's WP-2)
- `packages/shared/test/**` (constants formulas, validator fixtures, normalizeWord per-lang, id regex/brand tests)

**Reads:** ARCHITECTURE.md §0 rows "Zod", "Zod conventions" (import style, `z.strictObject`/`z.object`, `.brand()`, `z.iso.datetime()`); §2 `UserState`/`CompletionRecord`/`SolveSession` interfaces (for DTO shape parity) and the streak algorithm section; §3 `Envelope` interface; §5 D1 schema (for id shapes referenced in DTOs); §6 API surface (every DTO name); Glossary §5 Endpoints (auth/RL columns feed into DTO shape), §6 Error Codes (ErrorCode union + DOMAIN_STATUS mapping), §7 Files & Structure `packages/shared/src/` tree (exact file list and export list per file), §8 Constants (every constant, its value, its defining file — copy verbatim).

**Depends on:** WP-0.

**Acceptance:**
```
pnpm --filter @app/shared typecheck
pnpm --filter @app/shared test
```

**Agent brief:** Implement `packages/shared/src/` exactly per glossary §7's file-by-file export list and
§8's constant table (copy every value verbatim: `PAR_MINI=300`, `PAR_CROSS=600`, `HINT_COST={fifty:20,
letter:40, word:100}`, `WHEEL_PRIZES=[50,10,0,25,5,15]`, `STAR_SOLVE=10`, `STAR_NO_HINT=2`, `TOKEN_PACKS`,
`PLANS`, `TOPICS`, `MAX_DEPTH=4`, `MAX_EVENTS_PER_REQUEST=64`, `CHECK_TICKET_TTL=600000`,
`CHECK_TICKETS_PER_SOLVE=6`, `WRONG_PER_QUESTION=20`, `WRONG_PER_SOLVE=100`,
`TYPING_FLOOR_MS_PER_CHAR=80`, `ALPHABETS`). Every DTO listed in `wire/*.ts` per glossary §7 must be a Zod
schema using `z.strictObject` for wire DTOs/events per ARCHITECTURE.md §0's Zod-conventions row (never
`z.object` for outbound/DTO shapes; `z.object` is for inbound-only stripping cases). Ids (`PuzzleId`,
`UserId`, `SolveId`, `CollectionId`, `WheelId`, `IdempotencyKey`, `Cursor`) use a Crockford base32 regex plus
`.brand()` so they cannot be forged by a plain string — implement the exact regex and pattern from
ARCHITECTURE.md §2 (`u_<26-char Crockford base32>`) and glossary's PuzzleId example (`en-mini-0001`,
`<lang>-<kind>-<nnnn>`). `errors.ts` must define the full `ErrorCode` union and `DOMAIN_STATUS` mapping from
glossary §6 (every code, every HTTP status, verbatim). `puzzle/normalise.ts` implements `normalizeWord(lang,
s)` with the exact per-language alphabet rules from ARCHITECTURE.md open-question #6 (Ukrainian keeps all 33
letters — Є, І, Ї, Ґ, no Ё/Ъ/Ы/Э; Russian folds Ё→Е, 32 letters after folding) and glossary §8 `ALPHABETS`.
`puzzle/validator.ts` implements the structural + Zod validator and `splitPuzzle()` per glossary's puzzle
pipeline references (word-square minis may repeat clue text per open-question #7; 9×9 crosswords enforce no
symmetry per open-question #8). Write unit tests for every formula (streak transitions per §2 streak
algorithm, `dayKey`/`prevDay` in `wire/primitives.ts`'s test — actually the functions themselves belong to
`workers/gateway/src/shared/time.ts` which re-exports from here if you place the implementation here;
confirm by checking glossary §7 which says `shared/time.ts` lives under `workers/gateway/src/shared/`, not
under `packages/shared` — so this WP implements ONLY the wire schemas, constants, validator, and
normalizeWord; do NOT implement `dayKey`/`prevDay`/`DomainError`/id-generation — those belong to
`workers/gateway/src/shared/*` which is a separate concern outside packages/shared per the folder tree, and
is out of this WP's scope. If in doubt, only touch files under `packages/shared/src/` listed above). Do not
import anything from `workers/gateway/` or any `modules/*`.

---

## WP-2 — events module

**Goal:** Implement the in-process typed event dispatcher (envelope, registry helper, `dispatch()`,
subscription types) that every module publishes to and subscribes through.

**Creates/edits (exclusive):**
- `workers/gateway/src/events/index.ts`
- `workers/gateway/src/events/envelope.ts`
- `workers/gateway/src/events/registry.ts`
- `workers/gateway/src/events/dispatch.ts`
- `workers/gateway/src/events/test/*.test.ts` (e.g. `envelope.test.ts`)

**Reads:** ARCHITECTURE.md §3 "Event bus" in full (Envelope interface, `defineEvent()`/registry composition,
`Subscription`/`DispatchContext`/`HandlerTable` types, Dispatch algorithm steps 1–5, `DispatchReport`,
Idempotency-per-handler-kind, Failure semantics table, "Tests the events module must ship" — all 6 test
cases verbatim). Glossary §1 (`events` row: exports `Envelope, DomainEvent, dispatch, Subscription`), §4
Events (full catalog, for the discriminated-union shape only — WP-2 does not define per-module event
schemas, those live in each module's `contract.ts`; WP-2 only builds the composition mechanism), §8
Constants (`MAX_DEPTH=4`, `MAX_EVENTS_PER_REQUEST=64`).

**Depends on:** WP-0, WP-1 (imports `Envelope` Zod base shape from `packages/shared/src/events/envelope.ts`).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/events
```

**Agent brief:** Implement `envelope.ts` with the exact `Envelope<T,P>` field set from ARCHITECTURE.md §3:
`id` (uuid v4, deterministic per `(type, aggregate.id, aggregate.version)`), `type`, `v: 1`, `occurredAt`
(ISO 8601 via `z.iso.datetime()` seconds required per ARCHITECTURE.md §0 Zod-conventions row),
`actor: {kind:"user",userId} | {kind:"system",reason}`, `correlationId`, `causationId`,
`aggregate: {kind, id, version}`, `payload`. Implement `registry.ts`'s `defineEvent(type, v, payloadSchema)`
helper (returns a Zod object schema modules compose per-event in their own `contract.ts`) and the
`EventOf<T>` type helper — but the discriminated union itself (`DomainEvent = z.discriminatedUnion(...)`) is
assembled in `app/wiring.ts` by WP-13, not here; WP-2 only ships the generic machinery. Implement
`dispatch.ts`'s `dispatch(table: HandlerTable, events: DomainEvent[], ctx: DispatchContext): DispatchReport`
per the 5-step algorithm in §3: (1) validate via `safeParse`, log+ack invalid; (2) run critical handlers in
registration order, awaited, try/catch isolated per handler; (3) background handlers via
`ctx.exec.waitUntil(p.catch(log))` when `ctx.exec` exists, no-op otherwise; (4) follow-on events via
`ctx.publish()` re-dispatch at `depth+1` with `causationId = parent.id`, enforcing `MAX_DEPTH=4`,
`MAX_EVENTS_PER_REQUEST=64`, and a per-request `seen: Set<string>` keyed by
`type:aggregate.kind:aggregate.id:aggregate.version`; (5) return a `DispatchReport` with per-handler
outcomes and a `reason` of `"invalid"` or `"loop-guard"` when applicable. `DomainEvent`/`HandlerTable`
generic types are exported for `app/wiring.ts` to specialize. Ship all 6 test cases named in §3's "Tests the
events module must ship" list verbatim: ordering invariant, error isolation, loop guard (depth 4 rejected at
depth 5, and the 65th event rejected), validation failure (logged+acked, reason "invalid"), background
handlers via `createExecutionContext`/`waitOnExecutionContext`, and idempotency (documented as an
integration-level concern — write it as a unit test using a fake in-memory "aggregate" stand-in since real
DO integration is out of this WP's scope). No business-domain event types belong here — only the mechanism.

---

## WP-3 — content module

**Goal:** Own the puzzle catalog, daily drops, and collections manifest: D1 tables, queries, admin import,
`ensureDrops` cron, and seed data (the four prototype puzzles).

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/content/index.ts`, `contract.ts`, `http.ts`, `subscriptions.ts` (empty — content is a read model)
- `workers/gateway/src/modules/content/internal/db.ts`, `cache.ts`, `drop-cron.ts`, `validator.ts`
- `workers/gateway/src/modules/content/test/*.test.ts` (`puzzles.test.ts`, `drops.test.ts`, `collections.test.ts`, `validator.test.ts`)
- `workers/gateway/migrations/0001_content.sql` (fills in the real DDL; WP-0 left only a header comment)
- `workers/gateway/seed/0001_content.sql`
- `content/puzzles/en/en-mini-0001.json`, `en-mini-0002.json`, `en-cross-0001.json`
- `content/puzzles/uk/uk-mini-0001.json`
- `content/puzzles/ru/ru-mini-0001.json`
- `content/collections.json`
- `content/wordbank/en.txt`, `uk.txt`, `ru.txt`
- `content/scripts/gen-crossword.mjs`, `draft-clues.mjs`, `validate-and-seed.mjs`

**Reads:** ARCHITECTURE.md §1 module-map row `content`; §4 flow (14) "Daily drop cron"; §5 D1 schema
`0001_content.sql` in full (every table, every index, every column comment); §5 "Query → index reference"
rows for `Feed page`, `Mystery pick`, `Puzzle /next`, `Pool for cron`; §6 API surface entries for
`/puzzles/:id`, `/puzzles/:id/next`, `/collections*`, `/admin/content/*`; §0 row "Content pipeline"; §11 open
question #5 (50/50 decoy source), #7 (word-square minis), #8 (9×9 symmetry), #9 (daily schedule). Glossary
§1 `content` row (public exports: `withSecret, collectionsContaining, ensureDrops, importPuzzles,
importCollections, getStatus`), §3 D1 Tables (`content_puzzles`, `content_puzzle_secrets`,
`content_daily_drops`, `content_collections`, `content_collection_puzzles`, `content_meta`), §5 endpoints
#13, #15, #34, #35, #43–45, §6 error codes `puzzle_not_found`, `collection_not_found`, `no_drop`,
`invalid_puzzle`, §7 file tree for `modules/content/` and `content/` (exact file names).

**Depends on:** WP-0, WP-1 (uses `packages/shared` wire DTOs, validator, normalizeWord, constants).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/content
```

**Agent brief:** Implement `migrations/0001_content.sql` with the exact DDL from ARCHITECTURE.md §5
(`content_puzzles`, `content_puzzle_secrets`, `content_daily_drops`, `content_collections`,
`content_collection_puzzles`, `content_meta`, all indexes: `puzzles_pkey`, `puzzles_feed`, `puzzles_pool`,
`puzzles_author`, `daily_drops_feed`, `collections_shelf`, `collection_puzzles_by_puzzle`). Implement
`internal/db.ts` query functions matching the "Query → index reference" table rows for content (feed page
join, mystery pick, /next, pool-for-cron) — never write ad-hoc SQL that doesn't hit the documented index;
verify via `EXPLAIN QUERY PLAN` in tests where practical. `index.ts` exports exactly
`withSecret(puzzleId)` (never expose `content_puzzle_secrets` rows to feed/puzzle-detail routes —
"secrets" must never leak through `withSecret`'s public return shape used outside `solving`),
`collectionsContaining(puzzleId)`, `ensureDrops(now, daysAhead)` (fills 3 days per glossary v1 default),
`importPuzzles(items)`, `importCollections(items)`, `getStatus()`. `internal/drop-cron.ts` implements the
hourly `ensureDrops` logic from §4 flow (14): for each of the next 3 UTC days × 3 languages not yet in
`content_daily_drops`, pick from the pool (`puzzles_pool` index, oldest published), `INSERT OR IGNORE`, and
call `PuzzleStats.init` for the new puzzle — but PuzzleStats itself is WP-8's DO, so this WP only emits the
call site behind an injected callback/port passed in by WP-13's wiring (do not import from
`modules/social`). `internal/validator.ts` implements the Zod + structural checks (grid/answers,
duplicate-answer rejection except word-square per open-question #7, min word length 3, per-lang alphabet via
`packages/shared`'s `normalizeWord`) and rejects with `invalid_puzzle` details `{ rejected: [{id, issues}] }`
per glossary §6. Seed exactly the four prototype puzzles named in glossary §7 (`en-mini-0001` 5×5
word-square, `en-mini-0002` 5×5 standard, `en-cross-0001` 9×9, `uk-mini-0001`, `ru-mini-0001` — note
glossary lists 5 seed files across en/uk/ru; seed all of them) plus a `content/collections.json` manifest
with at least one theme/size/setter/archive shelf and one unlock rule referencing another collection, per
§0 "Content pipeline" and glossary's collections description. `content/scripts/*.mjs` are placeholder CLI
tools (CSP filler, Claude Batches clue drafting, validate+seed) — implement them functionally enough to
regenerate the seed SQL from the JSON puzzle files, but they run offline and are not covered by the vitest
tiers. Write the four test files named in ARCHITECTURE.md §8's `content` bullet list verbatim.

---

## WP-4 — player module

**Goal:** Implement the `User` Durable Object (the single per-player aggregate: wallet, streak, session,
completions, likes/saves, hints, wheel) and every command listed in ARCHITECTURE.md §2, plus its D1
projection.

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/player/index.ts`, `contract.ts`, `http.ts`, `subscriptions.ts` (empty — player is a write model)
- `workers/gateway/src/modules/player/internal/user.do.ts`, `db.ts`, `projection.ts`
- `workers/gateway/src/modules/player/test/*.test.ts` (`user.aggregate.test.ts`, `commands.test.ts`, `projection.test.ts`)
- `workers/gateway/migrations/0002_player.sql`

**Reads:** ARCHITECTURE.md §2 in full — the `User` aggregate section end-to-end: `UserState`/
`CompletionRecord`/`SolveSession` interfaces, Projection columns, streak algorithm, and **every** command
(`init`, `registerInstall`, `setPreferences`, `setTimezone`, `setPlan`, `toggleLike`, `toggleSave`,
`startSolve`, `submitWord` including inline finish, `spendForHint`, `pauseSolve`, `resumeSolve`,
`finishSolve`, `spinWheel`, `claimCollection`, `creditPurchase`, `bumpTokenVersion`, `reconcile`, `purge`)
with their preconditions/effects/returns/idempotency/DomainErrors verbatim; §4 flows (1) bootstrap, (2) `/me`
read, (4) start solve, (5)+(6) submit word + inline finish, (7)+(8) hints, (9) autocheck/check (only the
`User.setAutocheck` DO-command portion — ticket HMAC verification itself is WP-6/solving's), (10)
pause/resume, (11) wheel spin, (13) mock purchase, (15) reconcile; §5 `0002_player.sql` DDL in full
(`player_state`, `player_solves`, all indexes) plus the "Query → index reference" rows for feed
overlay/stories/profile stats that read `player_solves`; §11 R13 (snapshot-size guard usage). Glossary §1
`player` row (exports list), §2 DO table row `User`, §3 D1 tables `player_state`/`player_solves`, §4 events
produced by player (`identity.userBootstrapped` is actually emitted from `registerInstall` per §2 — note the
producer is listed as `identity` in glossary §4 but the emitting call site is inside `User.registerInstall`;
follow ARCHITECTURE.md §2's command spec, which says `registerInstall` "Emits `identity.userBootstrapped`
event" — implement the emission here, called by `identity`'s command layer), `player.onboarded`,
`player.prefsChanged`, `solve.finished` (emitted from `submitWord`'s inline finish per §2), `social.
likeToggled`, `social.saveToggled`, `economy.wheelSpun`, `collections.completed` (emitted from
`claimCollection`); §6 error codes `bad_tz`, `tz_change_limit`, `insufficient_tokens`, `no_active_session`,
`paused`, `already_spun`, `already_claimed`, `purchase_conflict`, `collection_incomplete`, `guess_budget`,
`question_locked`, `solve_finished`; §8 constants `HINT_COST`, `WHEEL_PRIZES`, `STAR_SOLVE`, `STAR_NO_HINT`,
`WRONG_PER_QUESTION`, `WRONG_PER_SOLVE`.

**Depends on:** WP-0, WP-1, WP-2 (publishes events through the dispatcher's types), WP-3 (reads
`content.withSecret` shape only for type parity — `startSolve`/`submitWord` receive puzzle data already
resolved by the `solving` module, so `player` itself does NOT import `content`; verify against §1's DAG:
`player` depends only on `shared, events` — do not import `content` here at all, that dependency belongs to
`solving`).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/player
```

**Agent brief:** Implement `internal/user.do.ts` as a class extending `packages/core`'s `Aggregate<UserState,
Env>` with `kind = "user"`. Copy the `UserState`, `CompletionRecord`, and `SolveSession` interfaces from
ARCHITECTURE.md §2 verbatim into this file (or `contract.ts` if you prefer sharing the type, but the DO
state type is internal). Override `projectionFingerprint(state)` to return state without the `session`
field (per §2 required-change #1 — this is how `submitWord`'s session-only commits skip a D1 flush).
Implement every command listed in §2 with exact preconditions, effects, return shapes, idempotency
semantics, and `DomainError` codes — this is the largest and most detail-sensitive WP; do not paraphrase the
spec, copy its algorithm literally (e.g. the streak algorithm's `today`/`prevDay` branching, the inline-finish
formula `elapsedMs`/`secLeft`/`tokens`/`stars`/`suspicious` computation, the `sweep()` cascade-lock
description). `internal/db.ts` implements `versionedUpsert`-based writes to `player_state` plus the
`extra()` attachment hook (per core required-change #2) that inserts up to 5 newest `player_solves` fact
rows atomically with the state upsert in one `DB.batch`, and use `flushAttachments()`/`onFlushed()` (core
required-change #3) to snapshot+finalize the DO's in-object ledger table watermark described in §5's
"Economy ledger" conventions section (mirrors to `economy_ledger` — but that table belongs to migration
`0004_economy.sql` owned by WP-7; this WP writes the `extra()` statements targeting it by table name only,
coordinate the exact INSERT column list against §5's `economy_ledger` DDL, which you may read but not
create — WP-7 owns that migration file). `internal/projection.ts` registers the `player_state` /
`player_solves` projection definitions consumed by the shared `Projections` DO. `migrations/0002_player.sql`
gets the exact DDL from §5 (`player_state`, `player_solves`, indexes `player_state_streak_reminder`,
`player_state_plan`, `solves_by_puzzle_time`, `solves_by_user`, `solves_by_week`, `solves_user_day`,
`solves_user_puzzle`). Write all test cases listed in ARCHITECTURE.md §8's `player` bullet list verbatim,
including the alarm-recovery test (evict + `runDurableObjectAlarm` + verify `Projections.apply` replay) and
the versionedUpsert no-op test.

---

## WP-5 — identity module

**Goal:** Device-token mint/verify/refresh, auth middleware, bootstrap orchestration, and `/me` account
routes (get/delete).

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/identity/index.ts`, `contract.ts`, `http.ts`, `subscriptions.ts` (empty)
- `workers/gateway/src/modules/identity/internal/jwt.ts`, `middleware.ts`, `bootstrap.ts`
- `workers/gateway/src/modules/identity/test/*.test.ts` (`bootstrap.test.ts`, `jwt.test.ts`, `rl.test.ts`)

**Reads:** ARCHITECTURE.md §0 row "Identity v1" (HS256, `kid` rotation, `hono/jwt`, `RL_BOOT`, `exp` 365d,
`tokenVersion`); §4 flow (1) Device bootstrap in full; §6 API surface auth/RL conventions and DTO shapes for
`DeviceBody`/`DeviceSession`/`MeView`/`OnboardingBody`/`PrefsPatch`; §9 "DEVICE_TOKEN_KEYS rotation runbook"
(keyring shape, active `kid`, 30-day refresh grace, 60-day retention). Glossary §1 `identity` row (exports:
`mint, verify, refresh, middleware, bootstrap, getMe, deleteMe`), §5 endpoints #2–5 (`POST /devices`, `POST
/session/refresh`, `GET /me`, `DELETE /me`) and #7–8 (`POST /me/onboarding`, `PATCH /me/prefs` — identity
owns the HTTP routes per glossary's `http.ts` line, but the command logic is `player`'s per glossary §1
`player` row's exports `setPreferences`; identity's `http.ts` calls `player.setPreferences` — do not
duplicate that command here), §6 error codes `unauthenticated`, `token_expired`, `token_key_unknown`,
`token_revoked`, `merged`, `rate_limited` (RL_BOOT), §8 constants `TOKEN_TTL=365 days`,
`TOKEN_REFRESH_GRACE=30 days`.

**Depends on:** WP-0, WP-1, WP-4 (calls `player.init`, `player.registerInstall`, `player.setPreferences` per
the DAG: `identity` depends on `shared, player`).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/identity
```

**Agent brief:** Implement `internal/jwt.ts` with HS256 sign/verify using `hono/jwt`, reading the
`DEVICE_TOKEN_KEYS` secret's keyring JSON (`{active, keys: {kid: base64}}`) and supporting `kid` rotation —
verify against any key in the ring, sign only with `active`. `internal/middleware.ts` implements
`deviceAuth`: extract Bearer token, verify signature + `typ === "device"`, check `exp` (401
`token_expired` with `{refreshable: exp within 30 days}` per glossary), check `kid` known (401
`token_key_unknown`), check `tokenVersion` against the live aggregate value (401 `token_revoked`), and apply
`RL_USER` (120/60s per user) via the `ratelimits` binding. `internal/bootstrap.ts` implements
`bootstrap(installId, platform, appVersion, tz, locale)`: calls `player.init(userId)` then
`player.registerInstall(...)`, then mints a token via `mint()`. `index.ts` exports `mint, verify, refresh,
middleware, bootstrap, getMe, deleteMe` exactly per glossary. `http.ts` wires `POST /devices` (`RL_BOOT`
10/60s per IP, unauthenticated), `POST /session/refresh` (accepts an expired-but-within-30-day token,
re-mints with the active `kid`), `GET /me` (calls `player`'s snapshot read — read-only, do not mutate),
`DELETE /me` (calls a purge path — `User.purge()` is `player`'s command; call through `player`'s public
index, never touch `user.do.ts` directly), `POST /me/onboarding` and `PATCH /me/prefs` (thin wrappers
delegating to `player.setPreferences`/`setTimezone`, returning the refreshed `/me` view). Follow §4 flow (1)
step-by-step for the bootstrap response shape (`201 { userId, token, expiresAt }`) and emit
`identity.userBootstrapped` as background (analytics) exactly where §2's `registerInstall` command spec says
it is emitted — from inside `player`, not duplicated here. Write the test cases listed in ARCHITECTURE.md
§8's `identity` bullet list verbatim (kid rotation, refresh grace boundaries, tokenVersion revocation,
RL_BOOT/RL_USER rate limiting).

---

## WP-6 — solving module

**Goal:** Orchestrate solve sessions end-to-end (start, submit word, hints, autocheck/check, pause/resume,
finish) by composing `content` (puzzle secrets) and `player` (the `User` DO commands) — this module owns no
storage of its own.

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/solving/index.ts`, `contract.ts`, `http.ts`, `subscriptions.ts` (empty — solving is a command handler)
- `workers/gateway/src/modules/solving/internal/logic.ts`, `anti-cheat.ts`, `autocheck-ticket.ts`, `attest.ts` (v2 stub only — do not implement attestation logic, per glossary's v1 scope note; `attest.ts` must exist and compile but every exported function throws/returns a "not implemented in v1" `DomainError`, and `POST /solves/:solveId/attest` must NOT be routed in `http.ts`)
- `workers/gateway/src/modules/solving/test/*.test.ts` (`session.test.ts`, `words.test.ts`, `hints.test.ts`, `finish.test.ts`, `anti-cheat.test.ts`)

**Reads:** ARCHITECTURE.md §4 flows (4) start solve, (5) submit word non-finishing, (6) submit finishing
word + inline finish, (7) hint 50/50, (8) reveal letter/word, (9) autocheck ticket + per-cell check, (10)
pause/resume, all in full; §2 the `submitWord`/`spendForHint`/`pauseSolve`/`resumeSolve`/`finishSolve`
command specs on the `User` aggregate (solving calls these, does not reimplement them); §0 row "Anti-cheat
scope (v1)" (S1–S4 flags, `boardEligible` formula); §11 "Anti-cheat limits" section (what v1 catches, exact
mechanisms) and Risk R16; §8 constant `MIN_PLAUSIBLE_MS` formula and `TYPING_FLOOR_MS_PER_CHAR`; glossary v1
scope note at the top of the file (attestation is v2 — must NOT be implemented). Glossary §1 `solving` row
(exports: `start, submitWord, spendForHint, revealLetter, revealWord, getAutoCheckTicket,
renewCheckTicket, pauseSolve, resumeSolve, finishSolve, attestFinish` — `attestFinish` must exist as a
compiling stub throwing not-implemented, never called from `http.ts`), §5 endpoints #19–22, #24–33
(note #23 is v1-removed, #33 attest is v2-not-in-v1), §6 error codes `wrong_grid`, `bad_lock_proof`,
`bad_question`, `question_locked`, `bad_word`, `guess_budget`, `check_budget`, `no_active_session`, `paused`,
`solve_finished`, `bad_ticket` (403), `rate_limited` (RL_CHECK), §8 `CHECK_TICKET_TTL`,
`CHECK_TICKETS_PER_SOLVE`.

**Depends on:** WP-0, WP-1, WP-3, WP-4 (DAG: `solving` depends on `shared, events, content, player`).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/solving
```

**Agent brief:** This module is a thin orchestration layer with no D1 tables of its own — implement
`index.ts`'s exports as calls that compose `content.withSecret(puzzleId)` (never expose answer letters to
the client beyond what a specific flow requires) and `player`'s DO commands. Implement `start(puzzleId,
userId, restart)` per §4 flow (4): validate puzzle exists via `content`, call `player.startSolve`, emit
`solve.started` (background: social.heartbeat — actually emit the event; the subscriber wiring is WP-13's).
Implement `submitWord(solveId, questionIndex, word)` per flow (5)/(6): extract `puzzleId` from `solveId`
(format `<puzzleId>~<random>` per §2), fetch secret, `normalizeWord` (from `packages/shared`), compute
correctness statelessly, then call `player.submitWord` with the verdict + topology — the server-owned
`locked[]`/`sweep()` logic lives inside the `User` DO (WP-4), this module only supplies inputs and shapes
the HTTP response (`WordResult`). Do not accept a client-supplied `locked` array (reject with 400 if
present, per Naming Conflict Resolution #6 in the glossary). Implement `spendForHint` for fifty/letter/word
per flow (7)/(8) — 50/50 picks decoy options per open-question #5 (curated `decoys` list in puzzle JSON,
else language word bank, length-matched, never a grid answer); letter/word hints call `player.spendForHint`
then `player.submitWord(correct:true, source:"hint")` inline. Implement `internal/autocheck-ticket.ts`: HMAC
SHA-256 ticket `"chk:" + solveId + ":" + issuedAt + ":" + n`, 10-minute TTL, ≤6 renewals per solve (enforced
by `player`'s `checkTickets` counter via `User.setAutocheck`), verified statelessly in `check()` (no DO call
on the hot path per flow (9) step 5). Implement `internal/anti-cheat.ts`'s S1–S4 flags exactly per §0's
"Anti-cheat scope" row and §11's "What v1 catches" bullets: S1 plausibility floor `MIN_PLAUSIBLE_MS =
max(12_000, 400 × fillableCells)`; S2 typing floor `80ms` per character between consecutive locked words;
S3 "too-clean" (no hints + ultra-fast, elapsed < 2× minPlausible); S4 "check-heavy" (checks > 6×
fillableCells via the checkTickets counter) — these flags feed into `player`'s `finishSolve`/inline-finish
`suspicious` computation, so this module's anti-cheat functions are pure predicates called BY `player`'s
inline finish, not a separate gate — confirm the call boundary matches §2's inline-finish pseudocode
(`suspicious = S1 || S2`) and implement S3/S4 as additional flags feeding the same boolean per §11's fuller
list, then export these pure functions from `solving/internal/anti-cheat.ts` for `player`'s `user.do.ts` to
import (this is one of the few cases where a lower-layer module, `player`, imports a pure function from a
higher one — if the DAG boundary conflicts, resolve by placing anti-cheat's pure predicates directly in
`packages/shared` conceptually, but since this WP's exclusive ownership is `solving/internal/anti-cheat.ts`,
export the pure functions from there and have `player`'s WP-4 agent import them directly from
`../solving/internal/anti-cheat` ONLY if `player`'s WP explicitly permits it — since WP-4 already froze its
exclusive-file list and does not list this import as a dependency, default to duplicating the minimal S1/S2
threshold check directly inside `player`'s `user.do.ts` for the inline-finish computation (as the
ARCHITECTURE.md §2 pseudocode shows `suspicious = S1 || S2` computed in-line, self-contained), and use this
module's richer `anti-cheat.ts` only for S3/S4 checks and the standalone `anti-cheat.test.ts` suite that
exercises the formulas in isolation). `attest.ts` must be a compiling no-op stub (per glossary's explicit
v1-scope-note: do NOT implement `POST /solves/:solveId/attest`, `attestFinish`, or Apple/Play SDK
integration — these are v2). Write every test case in ARCHITECTURE.md §8's `solving` bullet list verbatim.

---

## WP-7 — economy module

**Goal:** Wallet view, mock token-pack purchases, mock plan subscription, wheel spin, hint price constants
exposure — thin read/command layer over `player`'s wallet, plus its own `economy_purchases`/`economy_ledger`
D1 tables.

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/economy/index.ts`, `contract.ts`, `http.ts`
- `workers/gateway/src/modules/economy/subscriptions.ts` (EMPTY FILE per glossary — economy has no subscribers; collections owns reward-claim orchestration)
- `workers/gateway/src/modules/economy/internal/db.ts`
- `workers/gateway/src/modules/economy/test/*.test.ts` (`purchases.test.ts`, `wheel.test.ts`)
- `workers/gateway/migrations/0004_economy.sql`

**Reads:** ARCHITECTURE.md §0 rows "Purchase receipts (v1 = mock only)" and "Plan (v1 = mock only)"; §2
`setPlan`, `spinWheel`, `creditPurchase` command specs on `User` (economy calls these, does not
reimplement); §4 flow (11) wheel spin, flow (13) mock purchase, both in full; §5 `0004_economy.sql` DDL
(`economy_ledger`, `economy_purchases`, both indexes) and the "Economy ledger" conventions subsection; §11
open-question #3 (wheel cadence, prize tiers `[50,10,0,25,5,15]`, index-2 is the "loss" slot). Glossary §1
`economy` row (exports: `getWallet, purchasePack, setPlan, getWheelState, spinWheel`), §3 D1 tables
`economy_ledger`/`economy_purchases`, §4 events `economy.wheelSpun`, `economy.packPurchased`,
`economy.planChanged` (economy is the producer of all three; note economy also subscribes to
`collections.completed` per §1's module-map row — re-check: glossary §1's module table row for `economy`
lists "subscribes to: `collections.completed`" but §7's file tree says `subscriptions.ts` is an EMPTY FILE
because "economy has no subscribers (collections owns reward claim)" — this is a resolved conflict per
ARCHITECTURE.md's "Notes on resolutions" bullet "Per-user aggregate: … economy has no subscriptions.ts" —
follow that resolution: `subscriptions.ts` stays empty, ignore the module-map table's stale
"collections.completed" cell), §5 endpoints #38–42, §6 error codes `insufficient_tokens`, `already_spun`,
`purchase_conflict`, §8 constants `HINT_COST`, `WHEEL_PRIZES`, `TOKEN_PACKS`, `PLANS`.

**Depends on:** WP-0, WP-1, WP-4 (DAG: `economy` depends on `shared, events, player`).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/economy
```

**Agent brief:** Implement `migrations/0004_economy.sql` with the exact DDL from §5 (`economy_ledger`
columns `user_id, seq, at, kind, delta, balance, reason, ref, op_key, meta` with PK `(user_id, seq)` and
index `economy_ledger_reason_at`; `economy_purchases` columns `id, user_id, provider, provider_event_id,
product_id, pack_id, tokens, price, currency, store, environment, status, ledger_seq, refund_ledger_seq,
raw_json, purchased_at, created_at` with indexes `economy_purchases_user`, `economy_purchases_event`). Note:
`economy_ledger` rows are written by `player`'s (WP-4) projection `extra()` attachment, not by this module's
own inserts — this module only READS `economy_ledger` for wallet views; do not write to it directly except
via the D1 statements coordinated in WP-4's `extra()` (that file lives in `player/internal/db.ts`, owned by
WP-4 — this WP only owns the migration DDL and read queries). Implement `purchasePack(packId,
idempotencyKey, userId, now)` per flow (13): check `economy_purchases` for the idempotency key first (409
`purchase_conflict` on payload mismatch), call `player.creditPurchase`, `INSERT ... ON CONFLICT(id) DO
UPDATE INTO economy_purchases`, emit `economy.packPurchased` (background: analytics). Implement `setPlan`
similarly, emitting `economy.planChanged`. Implement `spinWheel(wheelId, userId, now)` per flow (11): call
`player.spinWheel`, which enforces "once per local day" and returns 409 `already_spun` — this module is a
thin HTTP/DTO wrapper, all randomness and day-gating lives in `player`'s `User.spinWheel` (WP-4); do not
re-implement the gate here. `getWallet`/`getWheelState` are pure reads composing `player`'s snapshot fields
with `HINT_COST`/`TOKEN_PACKS`/`PLANS` constants for display. Leave `subscriptions.ts` as a truly empty file
(export nothing, or `export {}`) — this is an explicit, deliberate architecture decision, not an oversight.
Write the test cases in ARCHITECTURE.md §8's `economy` bullet list verbatim.

---

## WP-8 — social module

**Goal:** The `PuzzleStats` Durable Object (likes, solved counts, presence, top-10-today), like/save toggle
commands, and leaderboard-adjacent stats queries.

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/social/index.ts`, `contract.ts`, `http.ts`
- `workers/gateway/src/modules/social/subscriptions.ts` (real: `onSolveFinished → recordSolve`, `onLikeToggled → adjustLikes`)
- `workers/gateway/src/modules/social/internal/puzzle-stats.do.ts`, `db.ts`
- `workers/gateway/src/modules/social/test/*.test.ts` (`likes.test.ts`, `presence.test.ts`, `stats.test.ts`)
- `workers/gateway/migrations/0003_social.sql` (the `social_puzzle_stats` table only; `leaderboard_week` was moved to its own file, `0006_leaderboard.sql`, owned exclusively by WP-10 — no coordination needed)

**Reads:** ARCHITECTURE.md §2 the `PuzzleStats` aggregate section in full (`PuzzleStatsState` interface,
projection columns, all 5 commands: `init`, `adjustLikes`, `recordSolve`, `heartbeat`, `leave`); §4 flow (6)
step 4's `social.recordSolve` critical-handler call site, flow (12) like toggle in full; §5
`0003_social.sql` `social_puzzle_stats` DDL (this table only — `leaderboard_week` moved to `0006_leaderboard.sql`,
WP-10's file); §11 Risk R7 (hot-object contention, sharding trigger); §0 row
"Social counters" open-question #10 (real counts, no fuzzing). Glossary §1 `social` row (exports:
`toggleLike, toggleSave, recordSolve, heartbeat, getStats`), §2 DO table row `PuzzleStats`, §3 D1 table
`social_puzzle_stats`, §4 events: social produces `social.likeToggled`/`social.saveToggled`, and subscribes
(critical) to `solve.started`/`solve.paused`/`solve.resumed`/`solve.finished`/`social.likeToggled` per the
module-map row, §5 endpoints #16–18, §6 error code `puzzle_not_found` (optional validation).

**Depends on:** WP-0, WP-1, WP-2, WP-3, WP-4 (DAG: `social` depends on `shared, events, player, content`).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/social
```

**Agent brief:** Implement `internal/puzzle-stats.do.ts` extending `Aggregate<PuzzleStatsState, Env>` with
`kind = "puzzle_stats"`, id scheme = the puzzle id itself (e.g. `en-mini-0001`) per glossary §2. Copy the
`PuzzleStatsState` interface from §2 verbatim. Implement all 5 commands with exact preconditions/effects:
`init` (zeroed state), `adjustLikes(delta)` (never negative, clamp), `recordSolve(userId, timeMs, boardDay,
noHints, boardEligible, now)` (only called by the subscriber when `boardEligible===true`; increments
`solved`/`noHintSolved`, maintains `topToday.rows` ≤10 sorted ascending by time, resets when
`boardDay !== topToday.day` — note `boardDay` is the puzzle's `drop_date`, NOT the solver's local `dayKey`,
per glossary Naming Conflict Resolution #4), `heartbeat(userId, now)` (in-memory `Map`, commits
`solvingNow` only every ≥15s or on a zero-crossing, per Risk R7's contention note — do not commit on every
heartbeat), `leave(userId, now)`. `migrations/0003_social.sql`: write the `social_puzzle_stats` table DDL
from §5 verbatim (id, version, likes, solved, no_hint_solved, solving_now, top_day, top_today_json,
updated_at) — this file is exclusively yours; `leaderboard_week` lives in `0006_leaderboard.sql`, owned by
WP-10, and is never touched here. `subscriptions.ts` implements the two real subscriptions:
`onSolveFinished` (critical, calls `PuzzleStats.recordSolve` only if the event's `suspicious===false` and
boardEligible per the payload) and `onLikeToggled` (critical, calls `PuzzleStats.adjustLikes(+1/-1)`).
`index.ts` exports `toggleLike`/`toggleSave` (thin wrappers calling `player.toggleLike`/`toggleSave` — the
actual `likes[]`/`saves[]` array lives on the `User` aggregate per §2, `social`'s job is only to react via
`adjustLikes` on the `PuzzleStats` side for aggregate counts), `recordSolve`, `heartbeat`, `getStats`. Write
the test cases in ARCHITECTURE.md §8's `social` bullet list verbatim, including "100 heartbeats ≤2 commits"
and "topToday resets on new day (puzzle's day, not user's)".

---

## WP-9 — collections module

**Goal:** Collection progress tracking, unlock-rule evaluation, and reward-claim orchestration (the owner of
reward claims per the DAG note: "collections owns reward claim, not economy").

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/collections/index.ts`, `contract.ts`, `http.ts`
- `workers/gateway/src/modules/collections/subscriptions.ts` (real: `onSolveFinished → checkAndClaim` critical, `onCompleted → unlockDependants` critical)
- `workers/gateway/src/modules/collections/internal/db.ts`
- `workers/gateway/src/modules/collections/test/*.test.ts` (`progress.test.ts`, `claim.test.ts`)

**Reads:** ARCHITECTURE.md §1 "Notes on resolutions" bullet "Per-user aggregate: … collections is the owner
of reward claim (not economy)"; §2 `claimCollection` command spec on `User` in full; §4 flow (6) step 4's
`collections.checkAndClaim`/`collections.unlockDependants` critical-handler chain in full; §5 "Query → index
reference" row "Collection detail (progress)"; §6 error codes `collection_not_found`, `already_claimed`,
`collection_incomplete`, `collection_locked`. Glossary §1 `collections` row (exports: `getCollections,
getDetail, checkAndClaim, unlockDependants`), §4 events: collections produces `collections.completed`,
`collections.unlocked`, subscribes (critical) to `solve.finished`; §5 endpoints #34–36, #45.

**Depends on:** WP-0, WP-1, WP-2, WP-3, WP-4 (DAG: `collections` depends on `shared, events, content,
player`).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/collections
```

**Agent brief:** Implement `checkAndClaim(userId, collectionId)` per flow (6) step 4: query
`content.collectionsContaining(puzzleId)` to find candidate collections for the just-finished puzzle, then
for each candidate query member completeness via `content_collection_puzzles ⋈ player_solves` (the "Query →
index reference" row "Collection detail (progress)" pattern — read `player_solves` through a query function,
never a raw cross-module JOIN import; if `player` does not expose a query helper for this join, implement
the D1 query here reading `player_solves` directly by table name, which is permitted per §5's "Cross-module
boundaries" note that `feed`-style composed queries may read another module's table directly through SQL
even though the owning module's index/DDL is elsewhere — but prefer calling a `player` query function if one
exists per WP-4's `index.ts` exports; if not, note this as an integration point for WP-13 to reconcile). If
all members are solved, call `player.claimCollection(userId, collectionId, memberIds, reward)` (idempotent
by `collectionId` on the `User` aggregate — a second claim is a no-op, so `checkAndClaim` itself must also
be safe to call repeatedly) and emit `collections.completed {userId, collectionId, reward, eventRef}`.
Implement `unlockDependants(userId, collectionId)`: query which collections have `unlock_rule =
"collection:<justCompletedId>"`, emit `collections.unlocked` for each, guarding against unlock cycles (a
collection cannot depend on itself transitively — validate at admin-import time in WP-3's validator, and
defensively no-op here if a cycle is detected). `getCollections`/`getDetail` are pure reads joining
`content_collections`/`content_collection_puzzles` with `player_solves` progress counts, returning
`collection_locked` (422, with `{lock: LockRule}`) when an unlock rule is unmet. Write the test cases in
ARCHITECTURE.md §8's `collections` bullet list verbatim: reward-once, `collections.completed →
unlockDependants` ordering, cycle prevention, idempotent re-run.

---

## WP-10 — leaderboard module

**Goal:** Cron-materialized weekly leaderboard and per-puzzle top-solvers query.

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/leaderboard/index.ts`, `contract.ts`, `http.ts`, `subscriptions.ts` (empty — cron-driven, no event subscriptions)
- `workers/gateway/src/modules/leaderboard/internal/db.ts`, `cron.ts`
- `workers/gateway/src/modules/leaderboard/test/*.test.ts` (`materialise.test.ts`)
- `workers/gateway/migrations/0006_leaderboard.sql` (the `leaderboard_week` table only — exclusive, no coordination with WP-8 needed)

**Reads:** ARCHITECTURE.md §4 flow (14)'s "Weekly leaderboard cron" subsection in full; §5
`0006_leaderboard.sql` `leaderboard_week` DDL and index; §5 "Query → index reference" row "Weekly leaderboard";
§0 row "Crons" (`*/5 * * * *` schedule, idempotent/duplicate-tolerant); §9 crons table row for the
leaderboard cron; §11 Risk R17 (cron duplicate runs, mitigation: keyed by `week_key + user_id`). Glossary §1
`leaderboard` row (exports: `materialiseWeek, getWeekLeaderboard, getPuzzleLeaderboard`), §3 D1 table
`leaderboard_week`, §5 endpoints #14, #37.

**Depends on:** WP-0, WP-1, WP-4 (reads `player_solves`), WP-3 (reads puzzle metadata for display) — DAG:
`leaderboard` depends on `shared, events, player, content` (lower layers only; no event subscriptions).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/leaderboard
```

**Agent brief:** Implement `internal/cron.ts`'s `materialiseWeek(week, now)` per §4 flow (14): `SELECT
user_id, SUM(stars), COUNT(*) FROM player_solves WHERE week_key=? AND suspicious=0 GROUP BY user_id ORDER BY
2 DESC LIMIT 100`, upsert into `leaderboard_week` keyed by `(week_key, rank)` — re-running the cron must be
safe (idempotent overwrite, not additive) per Risk R17. `getPuzzleLeaderboard(puzzleId, period)` reads
`social_puzzle_stats.top_today_json` — do not touch `social`'s migration file; call `social.getStats(puzzleId)`
(a query function on the `social` module's public API) instead of raw SQL against `social_puzzle_stats`, so this
module never depends on `social`'s table layout directly. `getWeekLeaderboard()` reads `leaderboard_week`
directly (this module's own table in `0006_leaderboard.sql`, exclusively owned — no coordination with WP-8
needed). Write the test cases in ARCHITECTURE.md §8's
`leaderboard` bullet list verbatim: cron re-run idempotent, excludes suspicious, `topToday` per-puzzle sort.

---

## WP-11 — feed module

**Goal:** Pure read-side page composition: daily drops, stories row, ticker, streak-at-risk card,
wheel/mystery interleaving, cursor pagination.

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/feed/index.ts`, `contract.ts`, `http.ts`, `subscriptions.ts` (empty — feed is a read composer)
- `workers/gateway/src/modules/feed/internal/db.ts`, `interleave.ts`
- `workers/gateway/src/modules/feed/test/*.test.ts` (`page.test.ts`)

**Reads:** ARCHITECTURE.md §0 row "Feed composition" in full; §4 flow (3) "Feed page, first and cursor" in
full (cursor decode, D1 keyset query, point lookups, interleave logic, response shape, cache headers); §5
"Query → index reference" rows "Feed page (skeleton)", "Feed overlay", "Feed stories", "Mystery pick",
"Puzzle /next"; §6 API surface pagination conventions (cursor format `base64url({v:1,lang,day,n})`, limit
1–50 default 20, 10-page cap); §6 error code `invalid_cursor`. Glossary §1 `feed` row (exports: `getPage,
getDaily`), §5 endpoints #11–12, §6 error code `invalid_cursor` (400).

**Depends on:** WP-0, WP-1, WP-3, WP-4, WP-8, WP-9 (DAG: `feed` depends on `shared, content, player, social,
collections` — the topmost read-composer layer besides notifications).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/feed
```

**Agent brief:** Implement `getPage(userId, lang, cursor, limit)` per §4 flow (3) exactly: decode cursor
`base64url([day, id])` (400 `invalid_cursor` on decode failure or language mismatch), run the keyset D1
query `SELECT * FROM content_daily_drops d WHERE d.lang=? AND d.day<? ORDER BY d.day DESC, d.id DESC
LIMIT ?+1` hitting `daily_drops_feed`, join `content_puzzles`+`social_puzzle_stats`+left-join
`player_solves(userId,puzzleId)` for done/bestTime/inProgress overlay (point lookups, ≤50), then call
`internal/interleave.ts`'s pure function to insert `streak_save` after item 0 (only if today unsolved),
`wheel` after item 1 (page 1 only, only if `canSpin`), `mystery` every 6th item (deterministic SHA-256 pick
from a 90-day pool filtered by level/topics, excluding already-solved via the `NOT EXISTS` pattern in the
"Mystery pick" index-reference row). Response shape and cache header exactly as flow (3) step 7:
`{items, nextCursor, stories: [7 recent day_keys], ticker, streakAtRisk, balances}` with `Cache-Control:
private, no-store`; the skeleton (pre-personalization) response may be cached 30–60s per `(lang, today)` via
`ctx.waitUntil(cache.put(...))` as an optional isolate-LRU optimization, not required for correctness.
`getDaily(userId, lang)` returns just today's drop, reusing the same overlay logic without pagination.
Feed never mutates anything and has no event subscriptions — if you find yourself wanting to write to D1,
stop; that belongs to another module. Write the test cases in ARCHITECTURE.md §8's `feed` bullet list
verbatim: no cursor duplicates, cache window, lang-override-in-cursor, liked/saved sourced from `User`
snapshot (not D1).

---

## WP-12 — notifications module

**Goal:** v1 stub per the corrected §0 decision: reminder-dedupe table and cron only — no push transport, no
per-kind toggles, no HTTP routes.

**Creates/edits (exclusive):**
- `workers/gateway/src/modules/notifications/index.ts`, `contract.ts`
- `workers/gateway/src/modules/notifications/http.ts` (must stay empty — "none in v1" per glossary §7)
- `workers/gateway/src/modules/notifications/subscriptions.ts` (real: `onOnboarded → scheduleReminderOptIn` background, `onSolveFinished → cancelReminder` background, `onCollectionsCompleted → none` — i.e. this handler is a documented no-op)
- `workers/gateway/src/modules/notifications/internal/db.ts`, `cron.ts`
- `workers/gateway/src/modules/notifications/test/*.test.ts` (`reminders.test.ts`)
- `workers/gateway/migrations/0005_notifications.sql`

**Reads:** ARCHITECTURE.md §0 row "Notifications (v1 = stub, no push transport)" in full (this is the
authoritative, corrected v1 shape — `UserState.prefs.notifications` enum and `pushTokens[]` live on `player`,
NOT here; this module owns ONLY `notifications_reminders_sent`); §4 flow (14)'s "Reminder cron" subsection;
§5 `0005_notifications.sql` DDL; §11 "Deliberately not built in v1" row "Push delivery (APNs/FCM)" (confirms
scope boundary — do not build delivery). Glossary §1 `notifications` row (exports:
`scheduleReminderOptIn, cancelReminder, sendReminders`), §3 D1 table `notifications_reminders_sent`, §4
events subscribed: `player.onboarded`, `solve.finished` (background), `collections.completed` (background).

**Depends on:** WP-0, WP-1, WP-2, WP-4 (DAG: `notifications` depends on `shared, events, player`).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test -- src/modules/notifications
```

**Agent brief:** Implement `migrations/0005_notifications.sql` with the exact DDL from §5:
`notifications_reminders_sent (user_id, day_key, sent_at, PRIMARY KEY(user_id, day_key))`. Implement
`scheduleReminderOptIn(userId)` — subscribed to `player.onboarded` in the background — which is a no-op
unless `notifications === "enabled"` on the user's prefs (read via `player`'s snapshot), in which case it
does nothing yet either in v1 beyond being ready to be queried by the cron (per §0: "reacts to
player.onboarded / solve.finished / collections.completed by writing or clearing a reminder row — no HTTP
delivery"). Implement `cancelReminder(userId, dayKey)` — subscribed to `solve.finished` in the background —
`DELETE FROM notifications_reminders_sent WHERE user_id=? AND day_key=?` (clears today's reminder once the
user has solved). Implement `internal/cron.ts`'s `sendReminders(now)` — the hourly reminder cron per flow
(14): query `player_state WHERE streak.atRisk AND (local_day_ends_at - now < 2 hours)`, for each call
`scheduleReminder`-equivalent `INSERT OR IGNORE INTO notifications_reminders_sent (user_id, day_key)
VALUES (...)` — this INSERT is the "would have sent a push" marker in v1, not an actual delivery. Never add
an HTTP route file with content — `http.ts` must exist and export nothing routable (`export {}` or an empty
Hono sub-app), matching glossary's "none in v1" note exactly. The `collections.completed` subscription is a
documented no-op (registered as a handler that does nothing, proving the wiring seam exists for v2 without
behavior) — write a test asserting it doesn't throw and doesn't write. Write the test cases in
ARCHITECTURE.md §8's `notifications` bullet list verbatim: once-per-(user,day) dedupe, cron idempotent.

---

## WP-13 — integration

**Goal:** Wire every module into the Hono composition root: the static event handler table, module factory,
route mounts, exported types, the architecture test, and the `/me/reconcile` route.

**Creates/edits (exclusive):**
- `workers/gateway/src/app/index.ts` (real: `export default { fetch, scheduled }`, exports `User`/`PuzzleStats`/`Projections` DO classes, `export type AppType`)
- `workers/gateway/src/app/app.ts` (real: `createFactory<AppEnv>({defaultAppOptions:{strict:false}}).createApp()`, middleware stack — `requestId → timing → logger → secureHeaders → bodyLimit(64KB)` — and `app.basePath("/v1").route("/feed", feed)...` mounting every module's `http.ts`)
- `workers/gateway/src/app/wiring.ts` (real: the `DomainEvent = z.discriminatedUnion(...)` composed from every module's `contract.ts`, and the static `HandlerTable` mapping every event type from glossary §4 to its critical/background subscribers, in registration order)
- `workers/gateway/src/app/modules.ts` (real: `createModules(ctx)` binding every module's `index.ts` API to the request context; `resolveModules(env, ctx)` for the extraction seam described in ARCHITECTURE.md §1)
- `workers/gateway/src/app/reconcile.ts` (or inline in `app.ts`/a dedicated route file — the `POST /v1/me/reconcile` handler per §4 flow (15))
- `workers/gateway/test/arch.test.ts`
- `workers/gateway/src/app/test/*.test.ts` (wiring/dispatch integration tests, e.g. ordering across real modules)

**Reads:** ARCHITECTURE.md §1 in full (module map, DAG, import rules, ports/extraction pattern — this WP is
the only one allowed to violate module isolation, per Import Rule #4 "Composition root privilege"); §3 in
full (Envelope, registry composition at `app/wiring.ts`, dispatch algorithm, full event catalog table — wire
every one of the 15 rows); §4 flow (15) reconcile in full, plus re-read every other flow's "Event dispatch"
step to confirm the exact critical/background handler assignment matches the wiring table; §6 API surface
common conventions (middleware order, error envelope, base path); §7 folder layout for `src/app/*`; §8
"Architecture test" subsection (exact boundary rules to encode: sanctioned cross-module imports via
index.ts/contract.ts only, no module imports `app/`, kernel isolation, D1 table prefix ↔ owning module
check). Glossary §1 `app` row, §4 full event table (producer/critical/background columns — copy verbatim
into `wiring.ts`), §5 all 46 endpoints (route mount table), §6 all error codes (verify `DOMAIN_STATUS`
mapping from `packages/shared` covers every one).

**Depends on:** WP-0 through WP-12 (all of them — this is the final assembly step before WP-14).

**Acceptance:**
```
pnpm --filter gateway typecheck
pnpm --filter gateway test                       # full suite, all modules + wiring + arch test green
curl -s http://localhost:8787/v1/healthz          # (after `pnpm dev`) → 200 { "ok": true }
```

**Agent brief:** Assemble `app/modules.ts`'s `createModules(ctx)` to bind all twelve modules'
`index.ts` exports (per glossary §1's export lists) into one `Modules` record, partially applying
`RequestContext` so route handlers call `modules.economy.credit({...})` with no visible context argument, per
ARCHITECTURE.md §1's "Ports rule" section — implement `resolveModules(env, ctx)` per the extraction seam
description even though nothing is extracted yet (it should currently always take the in-process branch).
Assemble `app/wiring.ts`'s `DomainEvent` discriminated union from every module's `contract.ts` event
schemas (18 events per the glossary Summary count — cross-check ARCHITECTURE.md §3's "full event catalog"
15-row table against glossary §4's 15-row table; both list the same 15 non-attestation events even though
the Summary line says 18 — reconcile by using the actual per-module `contract.ts` exports as source of truth
once WP-1–WP-12 land, since those are the literal schemas), and the static `HandlerTable` mapping each event
type to its critical handlers (awaited, in registration order) then background handlers (`ctx.exec.
waitUntil`) exactly as documented per event in §3's table and cross-checked against each flow in §4 (e.g.
`solve.finished` → critical `collections.checkAndClaim` then `social.recordSolve`, background
`notifications.cancelReminder` + analytics; `social.likeToggled` → critical `social.adjustLikes`). Assemble
`app/app.ts`'s middleware stack in the exact order given in every flow's step 1
(`requestId → timing → logger → secureHeaders → bodyLimit(64KB) → [rate limiter] → [deviceAuth if
authenticated]`) and mount every module's Hono sub-app under `/v1` per glossary §5's endpoint table (46
routes — verify count, including `GET /config`, `GET /healthz`, all `/admin/*` routes with `admin` auth
instead of `device`). Implement `POST /me/reconcile` per §4 flow (15): read `User.snapshot()`, re-run
`collections.checkAndClaim` per recent completion and `social.recordSolve` if `boardEligible`, return
`{repaired: [...]}` — accessible to the user themselves (device auth) or an admin. Write `test/arch.test.ts`
enforcing: (a) each module imports only its own `index.ts`/`contract.ts` from other modules, never
`internal/**`/`http.ts`/`subscriptions.ts` cross-module; (b) `app` may import anything, `shared`/`events`
import nothing from `modules/*`; (c) D1 table prefixes match owning modules (scan `internal/db.ts`/migration
files for table names and assert prefix ↔ module per glossary §3's table). Do the final reconciliation pass
on `wrangler.jsonc` (owned by WP-0 but frozen except for this WP's final pass) if any module needed a
binding WP-0 didn't anticipate — flag any such change explicitly rather than silently drifting. Run the full
test suite and fix any cross-module integration mismatch (e.g. a DTO shape WP-6 assumed that WP-4 named
differently) by aligning callers to the glossary's canonical names — never invent a new name.

---

## WP-14 — smoke test

**Goal:** An end-to-end curl-based smoke test against a live `wrangler dev`, plus the root README for
running the backend.

**Creates/edits (exclusive):**
- `scripts/smoke.sh`
- `/Users/peter/Projects/IOS Crosswords/README.md` (root)

**Reads:** ARCHITECTURE.md §8 "Smoke test script" subsection (the full `scripts/smoke.sh` listing — copy and
adapt, do not diverge from its flow: bootstrap → /me → feed → start solve → words → finish → wallet →
leaderboard); §9 "Local dev loop" in full (the exact numbered command sequence and expected outputs) and
"First-deploy checklist" (for the README's deploy section). Glossary §7 file tree (confirms `scripts/
smoke.sh` location) and the seeded puzzle ids (`en-mini-0001` etc.) used by the smoke script.

**Depends on:** WP-13 (needs a fully wired app to run against).

**Acceptance:**
```
chmod +x scripts/smoke.sh
./scripts/smoke.sh                                # prints "Smoke test passed" and exits 0
```

**Agent brief:** Adapt ARCHITECTURE.md §8's `scripts/smoke.sh` listing verbatim, adjusting only for any
naming drift that emerged during WP-13's integration pass (e.g. if a response field name changed). The
script must: start `wrangler dev` in the background, bootstrap a device, verify `/me` roundtrips the userId,
fetch `/feed` and confirm an item, start a solve on `en-mini-0001` (the seeded 5×5 word-square from WP-3),
submit all five words with the seeded correct answers, finish, verify `/wallet` reflects the earned tokens,
and check `/puzzles/en-mini-0001/leaderboard` shows exactly one row. Write the root `README.md` covering:
prerequisites (Node 26, pnpm 11.24, wrangler 4.128.0 — per §9), the local dev loop (the exact 7-step
sequence from §9, including the LAN-exposure note and the local-state-reset command), how to run
`./scripts/smoke.sh`, and a condensed first-deploy checklist (login, create D1, create KV, migrate, set
secrets, deploy, tail) linking back to ARCHITECTURE.md §9 for full detail rather than duplicating it. Verify
the smoke script actually passes against a locally seeded database before finishing.
