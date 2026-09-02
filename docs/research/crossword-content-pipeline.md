# Crosscut content pipeline — puzzle format, validation, storage, daily drops, generation

Slug: `crossword-content-pipeline` · Research date: 2026-09-02 · Scope: the *content* side of the Crosscut backend (one Cloudflare Worker, Hono + Zod 4, D1, Durable Objects for players/stats only, Cron Triggers, tests in workerd via `@cloudflare/vitest-plugin` + Vitest 4.1+ — see the fact-check note in F7).

Fact-checked 2026-09-02: two claims corrected (C17, C22), nine editorial problems addressed inline (marked "fact-check"), see the *Fact-check log* at the end.

Local sources read completely:

- `README` = `/Users/peter/Projects/IOS Crosswords/Crosswords app with feed/design_handoff_crosscut_feed/README.md`
- `PROTO` = `/private/tmp/claude-501/-Users-peter-Projects-IOS-Crosswords/9d054732-b7c8-4939-80a1-8eb9aba21fda/scratchpad/prototype-logic.js` (the four inline puzzles at L20-53, `questions()` at L75-80)
- `/Users/peter/Projects/IOS Crosswords/IOSApp concepts/concepts.md`, `core-package.md`, and `/Users/peter/Projects/IOSApp/packages/core/src/*.ts`
- Sibling research already written today: `docs/research/domain-spec-extraction.md` (F2/F3 puzzle format), `docs/research/durable-objects-d1-domain.md` (`puzzles` / `puzzle_secrets` / `daily_drops` DDL, R7 daily-drop cron), `docs/research/workers-modular-monolith.md` (module layout). This document stays consistent with those and goes deeper on content only.

Verification scripts (kept in the scratchpad, re-runnable with Node 26.8.1):

- `validate-proto.mjs` — re-derives crossword numbering from `grid` + `sol` for all four prototype puzzles and diffs it against the authored `across`/`down` tuples.
- `norm-check.mjs` — probes Unicode normalization / upper-casing of Cyrillic letters (`ё й ї і є ґ`) to find the pitfalls documented in F3.

## Summary

- **The prototype format is sound and stays.** `grid: string[]` (`.` open / `#` block), `sol: string[]` (uppercase letters, `#` blocks), `across`/`down` as `[num, clue, answer, row, col]` tuples. Re-deriving numbering from the grid reproduces the authored numbers and start cells for all four puzzles, every open cell is covered, no word is shorter than 3, and the payloads are 568–707 bytes each. We adopt it as the *authoring* format, wrap it in a versioned envelope (`schemaVersion`, `lang`, metadata), and split it on import into a public payload (grid + clues + numbers, **no answers**) and a server-only secret (solution rows).
- **Numbering is derived, never trusted.** The validator recomputes numbers and start cells from the grid with the standard rule (a cell gets the next number if it starts an across or a down run of length ≥ 2) and requires the authored tuples to match exactly, so an editor cannot ship a puzzle whose clue numbers disagree with the grid.
- **The "no duplicate answers" rule needs a word-square exception.** Three of the four prototype puzzles are perfect 5×5 word squares (down words equal across words, so 5 of 10 answers are duplicates by construction). The rule is therefore: duplicates forbidden, *unless* the puzzle declares `shape: "word-square"`, in which case the across answer set must equal the down answer set and nothing else may repeat.
- **Cyrillic normalization must be explicit, not "strip diacritics".** In Node 26.8.1, `normalize("NFD")` + remove `\p{M}` maps `ё→е` (wanted for `ru`) **but also `й→и` and `ї→і`** (wrong for both `ru` and `uk`). So: per-language alphabet whitelist (EN 26, RU 33, UK 33 letters), `toLocaleUpperCase(lang)`, an explicit fold table (`ru`: `Ё→Е`; `uk`: none by default), a Latin/Cyrillic homoglyph check, and the same function applied to answers at import and to typed letters at check time.
- **Storage is two D1 tables plus a drop registry.** `puzzles` (metadata columns for feed/archive/collection queries + `content_json` public payload), `puzzle_secrets` (solution), `daily_drops(day, lang, puzzle_id)`. D1's limits (2 MB row, 100 KB statement, 100 bound parameters, `batch()` is a transaction) are comfortable for 1–2 KB rows; JSON columns are queryable with `json_extract`/`->>` and can be indexed through generated columns if ever needed.
- **"Today" is the user's local calendar day, computed on the server with `Intl.DateTimeFormat(..., { timeZone })` from an IANA zone the client sends.** Cron Triggers run on UTC only and the runtime is UTC, so the daily drop is a *date column compared against the user's local day*, not a midnight cron. The hourly cron is only an idempotent safety net that fills `daily_drops` three days ahead per language from an editorial pool.
- **No npm package fills a dense crossword grid.** Every current generator on npm (`crossword-layout-generator`, `cwg`, `crossword-generator`, `crossword-generator-x`, `gen-crossword`, `puzzletide`) takes a *fixed list of answers* and scatters them into a sparse free-form layout — the opposite of what Crosscut needs (fixed 5×5 / 9×9 block pattern, filled from a scored word list). Recommendation: keep an in-house CSP filler (the `scripts/gen-crossword.mjs` lineage: pattern → slots → most-constrained-slot-first with forward checking over a scored word bank), which is a few hundred lines for 5×5/9×9, and use npm only for *parsing* editor-authored files (`@xwordly/xword-parser` for PUZ/iPUZ/JPZ/XD).
- **Clues are drafted by Claude and reviewed by a human.** `client.messages.parse` with a Zod output format produces one structured clue set per puzzle; automated checks reject clues containing the answer or its stem; the Batches API halves the cost for the nightly run. Nothing goes to `published` without an editor flipping the status.
- **Content admin surface for v1 = puzzle JSON in the repo + one protected import endpoint.** `content/puzzles/<lang>/<id>.json` is validated in CI by the shared Zod validator; `pnpm content:seed` writes a `seed.sql` for `wrangler d1 execute --local --file`; `pnpm content:import --remote` POSTs the same JSON to `POST /admin/content/import` (Hono `bearerAuth` + `bodyLimit` + `zValidator`, one atomic `DB.batch` *per puzzle* — `puzzles` + `puzzle_secrets` together, but a 50-puzzle import is 50 batches, not one, so earlier puzzles stay committed if a later one fails; see §5). No dashboard edits of D1 in production.

## Findings

### F1. The prototype format, verified (local)

Source: PROTO L20-53, L75-80; README L17-23 ("Puzzle data already exists as JSON in `workers/gateway/src/puzzles/{en,ru,uk}/` … `en-mini-1`, `en-mini-2`, `en-mini-3` and `cross-en-1`"). Those JSON files do not exist on this machine (checked in `domain-spec-extraction.md` F1), so the inline objects are ground truth.

Shape per puzzle:

```
grid:   string[size]   '.' open cell, '#' block            (row-major)
sol:    string[size]   uppercase letter per open cell, '#' per block
across: [num, clue, answer, row, col][]
down:   [num, clue, answer, row, col][]
+ presentation: id, title, author, size, par, diff, themeWord, reveal[], cover colours, kicker
```

`validate-proto.mjs` output (Node 26.8.1):

| id | size | derived numbering == authored | unique answers | words < 3 | open cells | payload bytes (grid+sol+clues) |
|---|---|---|---|---|---|---|
| mini1 | 5 | across ✓ down ✓ | 5 / 10 (word square) | 0 | 25 | 568 |
| cross1 | 9 | across ✓ down ✓ | 10 / 10 | 0 | 31 | 707 |
| mini2 | 5 | across ✓ down ✓ | 5 / 10 (word square) | 0 | 25 | 670 |
| mini3 | 5 | across ✓ down ✓ | 5 / 10 (word square) | 0 | 25 | 636 |

Consequences:

- `num` is derivable → the validator derives and compares; the stored public payload keeps `num` because the client shows "7-Across" (PROTO L297).
- The client keys play state by *question index* (`across` then `down`, PROTO L75-80), so the public payload must preserve tuple order exactly as authored/derived (across in reading order, then down in reading order). The validator emits the canonical order.
- `cross1` has cells that belong to only one word (e.g. `C` at (4,0) is only in 6-Across `CITE`; `F` at (0,5) is only in 1-Down `FAKE`). Fully-checked grids are a *policy*, not a format requirement; see F2.
- The word-square minis duplicate clue text between across and down (identical strings). This is intentional in the prototype but reads badly in the "QUESTION n OF 10" banner (the same clue appears twice). Option: allow word squares to carry a distinct `down` clue per slot (the format already allows it; only the content repeats).

### F2. Validation rules (derived from the format and standard crossword conventions)

| rule | why | default |
|---|---|---|
| `grid.length === size`, every row length `size`, chars ∈ `{'.', '#'}` | shape | hard |
| `sol` same shape; `#` exactly where `grid` has `#`; letters elsewhere, all in the language alphabet after normalization | consistency | hard |
| Derived numbering (standard rule) equals authored `(num,row,col,dir)` set | prevents wrong clue numbers | hard |
| Every derived slot has exactly one clue tuple and every clue tuple maps to a derived slot | no orphan / missing clues | hard |
| `answer` equals the letters read from `sol` along the slot | answer/solution consistency | hard |
| Every open cell is covered by ≥ 1 slot | reachable by the solver | hard (implied by derivation, but tested) |
| Minimum word length 3 | American-style convention; the prototype satisfies it; 2-letter slots break "Solve this word" hints | hard (configurable) |
| No duplicate answers across all slots, except `shape: "word-square"` where across set must equal down set | fairness | hard |
| Every open cell is in both an across and a down slot ("fully checked") | the previous generator's "hard intersection requirement"; guarantees the recursive lock-sweep in PROTO can lock any cell from two directions | policy: on for `mini`, off for `crossword` (cross1 would fail) |
| Clue must not contain the answer (normalized substring) or the answer minus a 1–2 letter suffix | classic "answer in clue" error, especially likely with LLM clues | hard |
| Clue length ≤ 90 characters | the cover card renders the clue at 800 20/1.25 in quotes inside a 390-wide card (README §8); longer clues wrap past three lines | soft (warn) |
| `themeWord` must equal one of the answers and `reveal[]` indexes must be within it | the feed cover shows `themeWord` tiles with `reveal` indexes lit (PROTO L24, L272-283) | hard |
| `par` ∈ {300 for size 5, 600 for size 9} unless overridden | README "Timer" and PROTO `parFor` | soft (warn if non-default) |
| 180° rotational symmetry of blocks | convention for 9×9 "crosswords"; cross1 is **not** symmetric | off (lint only) |
| Clue count = 10 | the prototype UI hard-codes "of 10"; the server sends `clueCount` so this is not required | lint only |

### F3. Letter normalization for en / uk / ru (verified locally, Node 26.8.1)

`norm-check.mjs` results:

| char | NFD code points | NFD + strip `\p{M}` | `toLocaleUpperCase("uk")` |
|---|---|---|---|
| `ё` U+0451 | `0435 0308` | `е` | `Ё` |
| `й` U+0439 | `0438 0306` | **`и`** (wrong) | `Й` |
| `ї` U+0457 | `0456 0308` | **`і`** (wrong) | `Ї` |
| `і` U+0456, `и` U+0438, `є` U+0454, `ґ` U+0491 | unchanged | unchanged | `І И Є Ґ` |
| `ß` | unchanged | unchanged | `SS` (length 2) |

So the common "strip diacritics" idiom is unsafe for Cyrillic: it would silently merge `й`/`и` and `ї`/`і`, which are distinct letters in both Russian (`й`) and Ukrainian (`й`, `ї`). Rules that follow:

- Normalize to **NFC** first (so a decomposed `и + U+0306` becomes the precomposed `й` and a decomposed `і + U+0308` becomes `ї`), then upper-case with `toLocaleUpperCase(lang)` (locale matters: Turkish `i → İ`; using the puzzle language avoids surprises), then apply an explicit fold table, then check every character against the language alphabet.
- `en`: alphabet `A–Z`. Strip spaces/hyphens/apostrophes from answers at authoring time (`"T-SHIRT"` → `TSHIRT`); the clue can say "(hyph.)".
- `ru`: alphabet `АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ` (33). Fold `Ё→Е` on **both** the stored solution and the typed letter — Russian crosswords conventionally treat ё as е, and the keyboard in README §12 is QWERTY-shaped (a Russian layout would have to fit 33 keys; folding Ё removes one). Whether to keep `Ъ`/`Ь` keys is a keyboard-design question, not a data one (open question O3).
- `uk`: alphabet `АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ` (33; no Ё Ъ Ы Э). **No folding** by default: `ї/і/и` are three different letters and `ґ/г` are distinct; folding them would make correct answers wrong. The apostrophe (`п'ять`) is not a letter — strip it from answers at import (`ПЯТЬ`), same as English hyphens.
- Reject mixed-script answers: a Cyrillic word containing Latin `a c e o p x y` homoglyphs (U+0061 …) is a data-entry error that would make the puzzle unsolvable. Check with `/\p{Script=Latin}/u` vs `/\p{Script=Cyrillic}/u` per language.
- The **same** `normalizeLetter(lang, ch)` function is used at import (to store the canonical solution) and in the solve module when comparing a typed word, so the two can never disagree.

Alphabet sizes and membership are standard-reference facts (medium confidence — not fetched from a primary source in this session; the letters themselves are verified by code-point probing above).

### F4. Zod 4 API for the schema (verified)

Source: https://zod.dev/api and https://zod.dev/v4

- Import: `import * as z from "zod"` (v4; `zod/mini` is the tree-shakeable variant).
- Tuples: `z.tuple([z.int(), z.string(), z.string(), z.int(), z.int()])`; rest form `z.tuple([z.string()], z.number())`.
- `.superRefine((val, ctx) => ctx.addIssue({ code: "custom", message, path, input }))` is "fully supported in v4"; `.check()` is the lower-level API. `.refine(fn, { message, path })` also available.
- `z.strictObject({...})` rejects unknown keys; `z.int()`; `z.array(x).length(n)`; `z.string().regex(re)`, `.trim()`, `.toUpperCase()`; `z.enum([...])`; `z.literal(...)`.
- `@hono/zod-validator@0.9.1` peers: `zod ^3.25.0 || ^4.0.0`, `hono >=4.11.2` (`npm view`), so it accepts the Zod 4.5.4 pinned for this project.

### F5. D1 storage facts (verified)

Sources: https://developers.cloudflare.com/d1/platform/limits/ , https://developers.cloudflare.com/d1/sql-api/query-json/ , https://developers.cloudflare.com/d1/reference/generated-columns/ , https://developers.cloudflare.com/d1/worker-api/d1-database/ , https://developers.cloudflare.com/d1/best-practices/import-export-data/ , https://developers.cloudflare.com/workers/wrangler/commands/d1/ , https://developers.cloudflare.com/d1/reference/migrations/

- Limits: "Maximum string, BLOB or table row size: 2,000,000 bytes (2 MB)", "Maximum SQL statement length: 100,000 bytes (100 KB)", "Maximum bound parameters per query: 100", "Queries per Worker invocation: 1,000 (Workers Paid) / 50 (Free)", "Maximum number of columns per table: 100", database 10 GB (Paid) / 500 MB (Free). A puzzle row is ~1–2 KB; a year of three languages is ~2 MB.
- JSON: `json_extract(json, path)`, the `->>` operator, `json_each`, `json_array_length`, `json_type`, `json_set/insert/patch/remove` are supported. Generated columns: `location AS (json_extract(raw_data, '$.measurement.location')) STORED`; "Generated columns can also have indexes defined against them"; "Columns added to an existing table via ALTER TABLE ... ADD COLUMN must be VIRTUAL" — so put any STORED generated column in the initial `CREATE TABLE`.
- `batch()`: "Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence." → the import endpoint writes `puzzles` + `puzzle_secrets` + `collection_puzzles` in one batch.
- `exec()` is for "maintenance and one-shot tasks (for example, migration jobs)" and "is less safe"; do not use it in the import endpoint.
- `wrangler d1 execute <db> --file=<x.sql>` with `--local` / `--remote` / `--yes` / `--json` / `--preview` / `--persist-to`; import files are "limited to 5GiB"; a "Statement too long" error is fixed by splitting a big multi-row `INSERT` into several statements (relevant: a 100 KB statement cap means ~50 puzzles per literal-SQL `INSERT ... VALUES (...), (...)` at most (100 KB / ~2 KB); the seed script emits one `INSERT` per puzzle). **Fact-check note:** the ~50-row figure only applies to the literal-SQL seed-file path. A *parameterised* multi-row insert through `prepare().bind()` is bounded by the 100-bound-parameters-per-query cap first — at 23 parameters per `puzzles` row that is **4 puzzles per statement**, not 50 — which is why the import endpoint (§5) issues one statement per puzzle.
- Migrations live in `migrations/` (`migrations_dir` in wrangler config), numbered `.sql` files, tracked in the `d1_migrations` table; `wrangler d1 migrations create|list|apply <db> [--local|--remote|--preview]`.
- `wrangler d1 export <db> --output=<file> [--table=<t>] [--no-schema|--no-data]` — an easy content backup (`--table=puzzles --table=puzzle_secrets`).

### F6. Cron Triggers and the scheduled handler (verified)

Sources: https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ , https://developers.cloudflare.com/workers/platform/limits/

- Config: `"triggers": { "crons": ["0 * * * *"] }`; "Cron Triggers execute on UTC time." Five fields with Quartz-like extras (`L`, `W`, `#`); **weekdays are 1 = Sunday … 7 = Saturday**, months and weekdays accept 3-letter names.
- "When deploying a Worker with Wrangler any previous Cron Triggers are replaced with those specified in the `triggers` array."
- Handler: `async scheduled(controller, env, ctx)`; `controller.cron` (the expression that fired — use it to multiplex several schedules in one handler), `controller.scheduledTime` (ms since epoch, UTC), `controller.type === "scheduled"`.
- Local test: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*&time=1745856238000"` (or `?format=json`); the JSON reply has `noRetry: true` when the handler called `controller.noRetry()` — the existence of `noRetry()` implies some retry behaviour on failure, but the docs do not state a delivery guarantee, so the handler must be idempotent. **Fact-check addition:** Cloudflare's docs are silent, but several third-party references (crontap.com, runhooks.app) state that a throwing or timed-out scheduled invocation is simply *lost until the next tick* — no retry and no alert. There is no failure alerting for cron by default (only the dashboard's Past Events table and Workers observability/logs), which matters because the hourly pool-fill cron is the only thing creating `daily_drops` rows. Treat "cron silently failed for N hours" as a monitored condition (R4).
- Limits: 5 Cron Triggers per account (Free) / 250 (Paid); CPU time per Cron Trigger 10 ms (Free) / 30 s for intervals < 1 h, 15 min for ≥ 1 h (Paid); wall-clock 15 min.

### F7. What "today" means — timezone handling (verified + one UNVERIFIED point)

Sources: https://developers.cloudflare.com/workers/local-development/ ("The local `workerd` runtime runs with `TZ=UTC` so that `Date` and `Intl` APIs inside your Worker observe UTC, matching the production Cloudflare runtime regardless of your machine's timezone."), https://developers.cloudflare.com/workers/runtime-apis/web-standards/ ("Date.now() returns the time of the last I/O; it does not advance during code execution."), https://github.com/cloudflare/workerd/issues/2328 (production is UTC).

Three possible definitions of the drop day:

| option | behaviour | verdict |
|---|---|---|
| A. UTC day | one global flip at 00:00 UTC — 03:00 in Kyiv, 17:00 in Los Angeles | wrong for "9h 14m left today" and for streaks; rejected |
| B. User-local day (IANA zone from the client, stored on the User aggregate) | each user gets the new puzzle at *their* midnight; streak "at risk" and "hours left" are exact | **recommended** for feed, streak, stories row |
| C. Fixed zone per language (`en`→`America/New_York`, `uk`→`Europe/Kyiv`, `ru`→ `Europe/Berlin`?) | NYT-style: one editorial clock per audience | fallback when the client sends no zone; also the zone used to *print* the kicker date ("MONDAY MINI · SEP 1") |

Mechanics for B: `dayKey(nowMs, tz) = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs))` → `"2026-09-02"` (verified in Node: 2026-09-01T22:30Z → `2026-09-02` in `Europe/Kyiv`, `2026-09-01` in UTC; an unknown zone throws `RangeError`, which the API maps to 400). Day keys sort lexicographically, so `drop_date <= :today` is a plain string comparison. Because the cron cannot fire "at each user's midnight", the drop is a **data comparison** (`daily_drops.day <= today(userTz)`), and the only cron is a UTC-hourly safety net that keeps `daily_drops` filled ≥ 3 days ahead so the row exists before any zone reaches that date (UTC+14 is the earliest zone; 3 days ahead is generous).

UNVERIFIED: that workerd's bundled ICU data resolves every IANA zone we ship (`Europe/Kyiv` is a 2022 tzdata rename of `Europe/Kiev`). Test it inside workerd for the zones used by the three audiences before relying on it (open question O1).

Fact-check notes (2026-09-02):

- **Test tooling.** Cloudflare's current Vitest docs (https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/ and `write-your-first-test/`) only mention `@cloudflare/vitest-plugin` (v1.1.3, a `cloudflareTest()` Vite plugin; `npm i -D vitest@^4.1.0 @cloudflare/vitest-plugin`). `@cloudflare/vitest-pool-workers` 0.22.0 (`defineWorkersConfig`) is still published (also peer `vitest ^4.1.0`) but is no longer what the docs describe — the implementation plan should target `@cloudflare/vitest-plugin` and Vitest 4.1+.
- **`Europe/Kyiv` and `Intl.supportedValuesOf`.** In both Node 26.8.1 and workerd, `Intl.supportedValuesOf("timeZone")` returns the ICU canonical `Europe/Kiev` (418 entries in workerd) and *not* `Europe/Kyiv`, even though `new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" })` works. So validate zones by constructing a `DateTimeFormat` (the `isValidTz` sketch in §4), and never compare a client zone string against the canonical list for equality — iOS may send `Europe/Kyiv` while the server canonicalises to `Europe/Kiev`.

Anti-abuse: accept the zone from the client but store it on the User aggregate and allow at most one change per local day (already specified in `durable-objects-d1-domain.md` R-streak), so a user cannot "travel" to replay yesterday's drop.

### F8. npm crossword generators, surveyed 2026-09-02 (`npm view` / READMEs)

| package | version / last publish | license | what it actually does | fit |
|---|---|---|---|---|
| `crossword-layout-generator` | 0.1.1 / 2020-01 (repo last push 2025-04-21 — corrected by fact-check; earlier draft said Dec 2024) | MIT | Places a given list of answers into a free-form layout; "The generated layouts don't always contain all of the input words", "not always connected"; slow > 100 words. Source: https://github.com/MichaelWehar/Crossword-Layout-Generator | no (sparse layout, not a filled block grid) |
| `cwg` | 0.2.2 / published 2021-10-11 (2022-04 is only the npm `modified` timestamp — corrected by fact-check) | MIT | Recursive backtracking placement of a given word list; all-or-nothing | no |
| `crossword-generator-x` | 1.0.0 / 2026-03-08 | MIT | Hybrid of the two above (70 % connections / 15 % centrality scoring, then backtracking, 50 retries). Explicitly a *layout* generator | no |
| `crossword-generator` | 1.0.1 / 2025-09-13 | MIT | "creates clean, properly intersecting crossword grids" from a word list; output is a sparse `null`-padded matrix | no |
| `gen-crossword` | 1.0.3 / 2026-08-27 | MIT | Monte-Carlo random restarts, standard numbering, `checkWord` helpers; still "compact, intersecting" free-form layouts from a word list | no (but its numbering/`getMatrix` code is a useful reference) |
| `puzzletide` | 0.2.0 / 2026-07-17 | MIT | CLI for printable word-search/crossword/sudoku worksheets; 30 starter banks. (Fact-check: the README does *not* ban AI clue generation for users — the phrase sits in a hidden HTML comment listing marketing claims the maintainers must not make because the feature is not shipped.) | no |
| `@apiverve/crossword` | 1.2.0 / 2026-07-15 | MIT wrapper | Client for a paid hosted API | no |
| `@some-ui/some-crossword` | 0.0.9 / 2026-08-11 | MIT | WASM "engine for generating and playing"; pre-1.0, README is one line | watch |
| `crossword` (mapmeld/crossword-unicode) | 1.2.4 / 2017 | MIT | Multilingual (Burmese, Tamil, Arabic, Hebrew) placement; PNG output | no, but proves Unicode grids are unremarkable |
| `@xwordly/xword-parser` | 1.1.0 / 2026-03-28 | MIT | "Fast, type-safe TypeScript library for parsing crossword puzzles (PUZ, iPUZ, JPZ, XD)"; unified model. **Correction (fact-check C17):** the README's "only `fast-xml-parser`" wording is marketing — `package.json` declares three runtime dependencies: `buffer ^6.0.3`, `fast-xml-parser ^5.5.9`, `vitiate ^0.3.0` (`npm view @xwordly/xword-parser dependencies`). The `buffer` polyfill matters if the parser is ever run inside the Worker rather than in a Node script | **yes** — import path for editor-authored files (Node script only; keep it out of the Worker bundle) |
| `xd-crossword-tools` / `-parser` | 14.1.0 / 2026-08-05 (puzzmo) | — (check repo) | xd text format ↔ JSON, linting, diffing; "Runs and tested in production in node, browsers, React Native and edge runtimes" | yes as an alternative authoring format |
| `@jaredreisinger/react-crossword` | 5.2.0 / 2022-12 | MIT | React renderer; its data format is `{across: {1: {clue, answer, row, col}}, down: {...}}` — the same fields as the prototype tuples, keyed by number. Source: https://github.com/JaredReisinger/react-crossword | format precedent only |

Conclusion: the npm ecosystem solves *layout-from-answers* (educational/word-game grids), not *fill-a-fixed-pattern-from-a-dictionary* (newspaper crosswords). The latter is a constraint-satisfaction problem — each slot is a variable, its domain is the words of the right length matching the current pattern, crossings are constraints; standard heuristics are most-constrained-slot-first, forward checking (drop any candidate that leaves a crossing slot with zero options) and word scores (the "Dr.Fill" formulation, https://arxiv.org/pdf/1401.4597 ; practitioner write-up https://neilagrawal.com/post/implementing-csp-crossword-generation/ ). For a 5×5 full square (10 slots) or a 9×9 with ~10 slots this is a few hundred lines and runs in milliseconds-to-seconds in Node. Python projects like https://github.com/jhingran/crossword-generator show what naive backtracking without forward checking costs ("167,749 backtracks in 60 seconds without completing a fill" on 15×15) — the heuristics are not optional.

### F9. Word lists and their licences (verified from the sources named)

| list | size | licence | notes |
|---|---|---|---|
| Collaborative Word List (Crossword Nexus) | > 425,000 entries, `word;score` lines | MIT, "free for everyone" | https://github.com/Crossword-Nexus/collaborative-word-list — usable as the English base list |
| spread the word(list) | 314,276 answers, 120,178 scoring ≥ 50 (as of 2026-07-01) | CC BY-NC-SA 4.0 with an explicit allowance that "selling crossword puzzles created with this list is permitted" and free products need attribution | https://www.spreadthewordlist.com/ — better curated (fresher, more inclusive fill); the NC clause needs legal reading for an app with paid tiers even though puzzles-for-sale are allowed |
| XwordInfo list | 253,276 entries | CC BY-NC-SA (reported in search snippets, not confirmed on the page itself); requires an XwordInfo "Angel" account (one-time $50) | https://www.xwordinfo.com/WordList (primary: states the entry count and the Angel-account requirement). Fact-check: the previously cited https://www.georgeho.org/crosswords-datasets-dictionaries/ does not state size, licence or subscription and did not support the numbers. Conclusion unchanged — skip |
| dict_uk / VESUM (Ukrainian) | `out/lemmas.txt`, ~316 K lemmas | data CC BY-NC-SA 4.0, software GPL-3 | https://github.com/brown-uk/dict_uk — the NC clause is a real obstacle for a commercial app; use only for *checking* candidate words, not as the shipped bank (open question O2) |
| OpenCorpora (Russian) | ~400 K tokens annotated; dictionary downloadable | **CC BY-SA 3.0** (corrected by fact-check C22: OpenCorpora publishes corpus and dictionary under CC BY-SA 3.0, not 4.0, per https://opencorpora.org/wiki/FAQ and https://opencorpora.org/?page=export — read via search-engine snippets because opencorpora.org returned HTTP 521 on 2026-09-02; the previously cited https://tatianashavrina.github.io/2018/08/30/datasets/ states no licence at all) | SA on the *dictionary* either way; a derived scored word bank would arguably be an adaptation → keep it out of the repo, or accept SA for the bank file only |

Practical point: Crosscut needs ~10 answers/day/language ≈ 3,650 distinct-ish words per language per year, mostly 3–5 letters. A **curated in-house bank of 4–8 K common words per language with scores and topic tags**, drafted by an LLM and reviewed by a native editor, is smaller than any of the lists above, licence-clean, and gives the topic tags the Browse shelves need (Travel, Food, Art…). The public lists are then only a *cross-check* ("is this a real word / how obscure") during review.

### F10. Interchange formats (verified)

- ipuz v2: JSON; `"version": "http://ipuz.org/v2"`, `"kind": ["http://ipuz.org/crossword#1"]`, `dimensions`, `puzzle` (numbers / `"#"` blocks), `solution`, `clues: { Across: [...], Down: [...] }`; the spec is CC BY-ND 3.0 and Puzzazz grants "a perpetual, irrevocable, free license to use the ipuz format for puzzle data". Source: https://www.puzzazz.com/ipuz (ipuz.org itself refused the connection today).
- `.puz` is the binary AcrossLite format (parsed by `@xwordly/xword-parser`, `@confuzzle/puz-crossword`, `puzjs`); `.xd` is puzzmo's text format (`## Grid` / `## Clues` sections).
- Implication: editors can author in any desktop constructor (Crossfire, CrossHare, Ingrid) and export ipuz/puz; `scripts/content-import.mjs` converts to the Crosscut JSON with `@xwordly/xword-parser`, then the shared validator runs. Crosscut never stores ipuz; it stores its own envelope.

### F11. LLM clue generation (Claude API, from the bundled `claude-api` skill, cached 2026-06-24)

- Structured output: `client.messages.parse({ model, max_tokens, messages, output_config: { format: zodOutputFormat(Schema) } })` from `@anthropic-ai/sdk` (`npm view` → 0.123.0) with `import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"`; `response.parsed_output` is `null` when parsing failed. Default model per the skill: `claude-opus-5` ($5 / $25 per MTok); adaptive thinking is on by default on Opus 5.
- Message Batches run asynchronously at 50 % cost and return results in any order keyed by `custom_id` — right for a nightly "draft clues for every puzzle in `status = 'filled'`" job.
- Cost order of magnitude: one puzzle = 10 answers + instructions ≈ 600 input tokens, ≈ 400 *visible* output tokens → ≈ $0.013 per puzzle at Opus 5 list price, ≈ $0.007 in a batch; a year of three languages ≈ $8–15. Not a cost driver. **Fact-check caveat:** "≈ 400 output tokens" is not what the API will bill — Opus 5 has adaptive thinking on by default and thinking tokens are billed as output tokens, and Claude 4.7+ models use a tokenizer that yields ~30 % more tokens than earlier counts (https://platform.claude.com/docs/en/about-claude/pricing). Budget a few thousand billed output tokens per puzzle; still negligible in absolute terms (tens of dollars a year), but measure with `usage` on the first batch rather than trusting this estimate.
- Quality gates are code, not prompts: answer-in-clue check, clue length, no duplicate clue text across the puzzle, language check (Cyrillic-only for uk/ru clues except allowed Latin proper nouns), and a human "reviewed" flag. The feed's cover shows one clue in quotes at 20 px — the review UI should render exactly that.

### F12. Hono pieces for the admin surface (verified)

- `import { bearerAuth } from "hono/bearer-auth"`; `app.use("/admin/*", bearerAuth({ token }))` or `bearerAuth({ verifyToken: async (token, c) => ... })`; options `prefix`, `headerName`, `hashFunction` ("hashing for safe comparison of authentication tokens"). Source: https://hono.dev/docs/middleware/builtin/bearer-auth
- `import { bodyLimit } from "hono/body-limit"`; `bodyLimit({ maxSize: 50 * 1024, onError: (c) => c.text("overflow", 413) })`; default 100 KB. Source: https://hono.dev/docs/middleware/builtin/body-limit
- `zValidator("json", Schema)` from `@hono/zod-validator` (0.9.1; peers above).

## Recommendation for Crosscut

### R1. Authoring format = prototype format in a versioned envelope

```jsonc
// content/puzzles/en/en-mini-0001.json
{
  "schemaVersion": 1,
  "id": "en-mini-0001",            // <lang>-<kind>-<nnnn>; prototype aliases: mini1→en-mini-0001, cross1→en-cross-0001, mini2→en-mini-0002, mini3→en-mini-0003
  "lang": "en",
  "kind": "mini",                  // mini | crossword
  "size": 5,
  "shape": "word-square",          // word-square | standard   (relaxes the duplicate rule, see F2)
  "title": "Monday Mini",
  "author": { "id": "crosscut-daily", "name": "Crosscut Daily" },
  "difficulty": "EASY",            // EASY | MEDIUM | TRICKY
  "par": 300,
  "themeWord": "BEACH",
  "reveal": [0, 2, 4],
  "cover": "ink",                  // ink | accent | card   (all the hex colours derive from this)
  "kicker": "MONDAY MINI",         // the date suffix is rendered by the client from drop_date
  "topics": ["travel", "words"],
  "grid": [".....", ".....", ".....", ".....", "....."],
  "sol":  ["BEACH", "EXTRA", "ATLAS", "CRAFT", "HASTE"],
  "across": [[1, "Sandy strip where land meets the sea", "BEACH", 0, 0], ...],
  "down":   [[1, "Sandy strip where land meets the sea", "BEACH", 0, 0], ...],
  "decoys": { "1A": ["CORAL", "PLAZA"] },   // optional curated 50/50 decoys; else generated from the bank
  "status": "published",           // draft | filled | clued | reviewed | published
  "publishedAt": "2026-09-01"
}
```

The validator (R2) is the single source of truth and lives in `packages/shared/src/puzzle/` so the Worker, the CLI scripts and CI import the same code.

### R2. Validator = Zod shape + structural pass

Zod checks shape and primitive constraints; a `superRefine` runs the structural pass (numbering derivation, coverage, duplicates, answer/solution consistency, normalization, clue hygiene) and reports every issue with a `path` so an editor sees all errors at once. Output of a successful validation is a **canonical** object: normalized uppercase letters, clues in canonical order, derived `num`s, plus the split `{ public, secret }` pair (R3). See Code sketches §1.

### R3. Storage = `puzzles` + `puzzle_secrets` + `daily_drops` (+ `collections`, `collection_puzzles`)

Same tables as `durable-objects-d1-domain.md` with the columns this topic needs (`published_at`, `shape`, `status`, `content_hash`). `content_json` holds the public payload (grid, numbered clues without answers, `clueCount`, `themeWord`, `reveal`); `puzzle_secrets.solution_json` holds `sol` rows and the per-slot answers. The hot read paths and their indexes:

| query | SQL shape | index |
|---|---|---|
| feed (today + archive, newest first, per language) | `... FROM daily_drops d JOIN puzzles p ON p.id = d.puzzle_id WHERE d.lang = ? AND d.day <= ? ORDER BY d.day DESC LIMIT 20` | `daily_drops(lang, day DESC)` (the PK `(day, lang)` also serves `=` lookups) |
| puzzle page | `SELECT ... FROM puzzles WHERE id = ?` | PK |
| archive shelf by month | `WHERE lang = ? AND drop_date BETWEEN ? AND ? ORDER BY drop_date` | `puzzles(lang, drop_date)` |
| collection detail | `SELECT p.* FROM collection_puzzles cp JOIN puzzles p ... WHERE cp.collection_id = ? ORDER BY cp.position` | PK `(collection_id, position)` |
| "which collections contain this puzzle" (reward check) | `WHERE puzzle_id = ?` | `collection_puzzles(puzzle_id)` |
| pool for the cron | `WHERE lang = ? AND status = 'published' AND drop_date IS NULL ORDER BY created_at LIMIT 1` | `puzzles(lang, status, drop_date)` |
| Browse "by setter" | `WHERE lang = ? AND author_id = ? AND status='published'` | `puzzles(lang, author_id)` |

Do not index JSON in v1; if a JSON-derived filter is ever needed, add a `STORED` generated column in a new table or a `VIRTUAL` one via `ALTER TABLE` (F5).

### R4. Daily drops

- Editors set `drop_date` (or leave `NULL` = pool). `daily_drops` is the resolved calendar, one row per `(day, lang)`.
- `GET /feed` takes the user's zone (header `X-Timezone`, validated by constructing an `Intl.DateTimeFormat`; fallback to the User aggregate's stored zone, then to the per-language default zone) and computes `today = dayKey(now, tz)`. Everything with `day <= today` is visible; `day == today` is "Today's drop"; the stories row is the last 7 day keys joined with the user's completions.
- Cron `0 * * * *` (UTC, hourly): for each `lang` and each of the next 3 UTC days, ensure a `daily_drops` row exists (editor-scheduled `drop_date` first, else oldest pool puzzle → set its `drop_date`), all inside one `DB.batch` per language; also `init()` the `PuzzleStats` object. Idempotent, window-based, safe to re-run.
- Also a second trigger `0 6 * * *` (06:00 UTC) sends an internal alert when a language's pool has < 14 unscheduled puzzles.
- **No default failure alerting for cron (fact-check).** A scheduled invocation that throws or times out is lost until the next tick with no retry and no notification (third-party references; Cloudflare docs are silent). Because the hourly cron is the only writer of `daily_drops`, the 06:00 alert job must also check that `daily_drops` has rows for today + 3 days per language (i.e. that the hourly cron has actually been succeeding), and `GET /admin/content/status` should expose the last successful `ensureDrops` time (store it in a `content_meta` row or KV). The 3-day-ahead window gives ~72 hours of tolerance for a broken cron before users notice.
- Leaderboard "today" for a puzzle stays the puzzle's `drop_date` (already decided in the DO document); it is the only place where the day is not user-local.

### R5. Seeding the four prototype puzzles

`content/puzzles/en/` gets `en-mini-0001` (mini1, `drop_date` = launch day), `en-cross-0001` (cross1, next Saturday — `shape: "standard"`, `fullyChecked: false`), `en-mini-0002` (mini2), `en-mini-0003` (mini3). Collections from PROTO L54-70 are seeded with real ids (the prototype repeats the same four ids to pad shelves; seed with the four once and let the archive shelves grow from `daily_drops`). `pnpm content:seed` regenerates `seed/0001_prototype_content.sql`; `wrangler d1 execute crosscut --local --file=seed/0001_prototype_content.sql` for dev; production goes through the import endpoint (R6) so the same validation runs.

### R6. Content admin surface (v1)

1. **Repo is the CMS.** Puzzles are JSON files reviewed in pull requests; CI runs `pnpm content:validate` (the shared validator over every file, plus cross-file checks: unique ids, no two puzzles with the same `drop_date` + `lang`, `themeWord` uniqueness within 30 days).
2. **`POST /admin/content/import`** — `bearerAuth` with a secret from `wrangler secret put CONTENT_ADMIN_TOKEN`, `bodyLimit({ maxSize: 512 * 1024 })`, `zValidator("json", ImportBatch)`, runs the validator again server-side, then one `DB.batch([...])` per puzzle (`INSERT ... ON CONFLICT(id) DO UPDATE` guarded by `content_hash`, so re-importing unchanged content is a no-op; a *published* puzzle whose grid changed is rejected unless `force=true`). Returns `{ imported, unchanged, rejected: [{ id, issues }] }`. Not exposed on the client's route tree; lives in the `content` module.
3. **`GET /admin/content/status`** — pool depth per language, next 14 `daily_drops`, puzzles by status. Used by the alert cron and by whoever schedules content.
4. Local dev uses the seed SQL; staging/production use the endpoint; `wrangler d1 export --table=puzzles --table=puzzle_secrets --table=daily_drops` is the backup.

Deferred (v2): a web admin page that renders a puzzle from JSON, an "unpublish" endpoint, per-setter accounts.

### R7. Producing more puzzles (v1 pipeline)

```
word bank (repo, per lang, word;score;topics)  ──┐
pattern library (5×5 full; ~12 symmetric 9×9)   ──┼─▶ scripts/gen-crossword.mjs (CSP fill) ─▶ content/drafts/*.json (status: filled)
                                                    │
Claude Batches (messages.parse + Zod format) ◀──────┘        ─▶ status: clued  ─▶ human review (PR) ─▶ status: reviewed/published ─▶ import
```

- **Word bank**: `content/wordbank/<lang>.txt` lines `WORD;score;topic,topic`. English seeded from the Collaborative Word List (MIT) filtered to score ≥ 50 and length 3–9, then hand-pruned; `uk`/`ru` seeded by an LLM draft of 3–5 K common nouns/verbs/adjectives per language with topic tags, reviewed by a native editor (F9). Public NC-licensed lists are used only for cross-checking during review.
- **Filler**: for each slot compute candidates matching the current pattern; pick the slot with the fewest candidates; try candidates in descending score with a random tiebreak (seeded RNG so a draft is reproducible from `{pattern, seed}`); forward-check every crossing slot; reject duplicate answers; enforce the fully-checked policy for minis; stop at the first complete fill or after N nodes. Theme support: pin `themeWord` into a chosen slot before filling (the design needs a `themeWord` per puzzle for the cover tiles). 5×5 double word squares are the hardest case (all 10 slots interlock): with a 4 K bank expect many seeds to fail — acceptable, the script loops seeds; if the yield is too low, allow one or two black squares (`shape: "standard"`, still fully checked).
- **Clues**: one batch request per puzzle with the full answer list, language, difficulty, topics and the style guide (descriptive/definitional clues as in the prototype, no wordplay for EASY, ≤ 90 chars, never contain the answer or its root, Cyrillic-only for uk/ru). The structured output schema is `{ clues: [{ slot: "1A", clue: string, difficulty: 1..3 }] }`; code checks run before the file is written. Decoys for 50/50 come from the bank (same length, same first-letter distribution, score ≥ 40), not from the LLM.
- **Review**: a PR per week of content; the reviewer sees the grid rendered as ASCII in the PR description (script output) and edits clue text in place. Publishing = merging + `pnpm content:import --remote`.

Throughput: 3 languages × 7 puzzles/week = 21 puzzles/week; the filler produces hundreds per minute, clue drafting is a single batch, and review is ~2 minutes per mini. The bottleneck is editorial, as it should be.

## Code sketches

All sketches are illustrative (no app code is created by this document). Imports use the verified APIs from F4/F12.

### 1. Zod schema + structural validator (`packages/shared/src/puzzle/schema.ts`)

```ts
import * as z from "zod";

export const Lang = z.enum(["en", "uk", "ru"]);
export type Lang = z.infer<typeof Lang>;

const ALPHABET: Record<Lang, string> = {
  en: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ru: "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ",
  uk: "АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ",
};
const FOLD: Record<Lang, Record<string, string>> = { en: {}, ru: { Ё: "Е" }, uk: {} };
const STRIP = /[\s'’ʼ\-.]/g; // apostrophes (uk), hyphens, spaces, periods

/** Same function at import and at answer-check time. NFC first — never NFD+strip (F3). */
export function normalizeWord(lang: Lang, raw: string): string {
  const up = raw.normalize("NFC").replace(STRIP, "").toLocaleUpperCase(lang);
  let out = "";
  for (const ch of up) {
    const folded = FOLD[lang][ch] ?? ch;
    if (!ALPHABET[lang].includes(folded)) throw new Error(`letter "${ch}" is not in the ${lang} alphabet`);
    out += folded;
  }
  return out;
}

const Clue = z.tuple([z.int().positive(), z.string().trim().min(1).max(200), z.string().min(3).max(15), z.int().nonnegative(), z.int().nonnegative()]);

export const PuzzleFile = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^(en|uk|ru)-(mini|cross)-\d{4}$/),
  lang: Lang,
  kind: z.enum(["mini", "crossword"]),
  size: z.union([z.literal(5), z.literal(9)]),
  shape: z.enum(["word-square", "standard"]).default("standard"),
  fullyChecked: z.boolean().optional(),          // default: kind === "mini"
  title: z.string().min(1).max(40),
  author: z.strictObject({ id: z.string(), name: z.string() }),
  difficulty: z.enum(["EASY", "MEDIUM", "TRICKY"]),
  par: z.int().positive(),
  themeWord: z.string().min(3),
  reveal: z.array(z.int().nonnegative()).min(1),
  cover: z.enum(["ink", "accent", "card"]),
  kicker: z.string().max(40),
  topics: z.array(z.string()).default([]),
  grid: z.array(z.string().regex(/^[.#]+$/)),
  sol: z.array(z.string()),
  across: z.array(Clue),
  down: z.array(Clue),
  decoys: z.record(z.string(), z.array(z.string())).optional(),
  status: z.enum(["draft", "filled", "clued", "reviewed", "published"]),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).superRefine(structural);

type Slot = { key: string; dir: "A" | "D"; num: number; row: number; col: number; cells: [number, number][]; answer: string };

/** Standard numbering: a cell gets the next number if it starts an across or a down run (length ≥ 2). */
export function deriveSlots(grid: string[], sol: string[]): Slot[] {
  const n = grid.length;
  const open = (r: number, c: number) => r >= 0 && r < n && c >= 0 && c < n && grid[r][c] === ".";
  const slots: Slot[] = [];
  let num = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!open(r, c)) continue;
    const startA = !open(r, c - 1) && open(r, c + 1);
    const startD = !open(r - 1, c) && open(r + 1, c);
    if (!startA && !startD) continue;
    num++;
    if (startA) { const cells: [number, number][] = []; for (let cc = c; open(r, cc); cc++) cells.push([r, cc]);
      slots.push({ key: `${num}A`, dir: "A", num, row: r, col: c, cells, answer: cells.map(([a, b]) => sol[a][b]).join("") }); }
    if (startD) { const cells: [number, number][] = []; for (let rr = r; open(rr, c); rr++) cells.push([rr, c]);
      slots.push({ key: `${num}D`, dir: "D", num, row: r, col: c, cells, answer: cells.map(([a, b]) => sol[a][b]).join("") }); }
  }
  return slots;
}

function structural(p: z.infer<typeof PuzzleFile>, ctx: z.RefinementCtx) {
  const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: "custom", message, path });
  const n = p.size;
  if (p.grid.length !== n || p.grid.some((r) => r.length !== n)) return issue("grid must be size×size", ["grid"]);
  if (p.sol.length !== n || p.sol.some((r) => [...r].length !== n)) return issue("sol must be size×size", ["sol"]);

  // 1. blocks agree; letters normalize
  const sol = p.sol.map((row, r) => [...row].map((ch, c) => {
    if (p.grid[r][c] === "#") { if (ch !== "#") issue(`sol[${r}][${c}] must be '#'`, ["sol", r]); return "#"; }
    try { return normalizeWord(p.lang, ch); } catch (e) { issue((e as Error).message, ["sol", r]); return "?"; }
  }).join(""));

  // 2. derive slots; compare with authored tuples
  const derived = deriveSlots(p.grid, sol);
  const authored = new Map<string, z.infer<typeof Clue>>();
  for (const [dir, list] of [["A", p.across], ["D", p.down]] as const)
    list.forEach((t, i) => { const k = `${t[0]}${dir}`; if (authored.has(k)) issue(`duplicate clue ${k}`, [dir === "A" ? "across" : "down", i]); authored.set(k, t); });
  for (const s of derived) {
    const t = authored.get(s.key);
    if (!t) { issue(`missing clue for ${s.key} at (${s.row},${s.col})`); continue; }
    if (t[3] !== s.row || t[4] !== s.col) issue(`${s.key} starts at (${s.row},${s.col}), not (${t[3]},${t[4]})`);
    if (normalizeWord(p.lang, t[2]) !== s.answer) issue(`${s.key} answer "${t[2]}" ≠ solution "${s.answer}"`);
    if (s.answer.length < 3) issue(`${s.key} is shorter than 3`);
    const clueNorm = normalizeWordLoose(p.lang, t[1]);
    if (clueNorm.includes(s.answer) || (s.answer.length > 4 && clueNorm.includes(s.answer.slice(0, -2)))) issue(`${s.key} clue contains its answer`);
    if (t[1].length > 90) issue(`${s.key} clue longer than 90 chars (soft)`, ["clues"]);
    authored.delete(s.key);
  }
  for (const k of authored.keys()) issue(`clue ${k} does not start a word in the grid`);

  // 3. coverage / fully checked
  const inA = new Set<string>(), inD = new Set<string>();
  for (const s of derived) for (const [r, c] of s.cells) (s.dir === "A" ? inA : inD).add(`${r},${c}`);
  const fully = p.fullyChecked ?? p.kind === "mini";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (p.grid[r][c] === ".") {
    const k = `${r},${c}`;
    if (!inA.has(k) && !inD.has(k)) issue(`cell (${r},${c}) belongs to no word`);
    else if (fully && !(inA.has(k) && inD.has(k))) issue(`cell (${r},${c}) is unchecked (only one word)`);
  }

  // 4. duplicates (word-square exception)
  const A = derived.filter((s) => s.dir === "A").map((s) => s.answer), D = derived.filter((s) => s.dir === "D").map((s) => s.answer);
  if (p.shape === "word-square") {
    if (new Set(A).size !== A.length || new Set(D).size !== D.length || [...A].sort().join() !== [...D].sort().join()) issue("word-square: across set must equal down set, no repeats within a direction");
  } else if (new Set([...A, ...D]).size !== A.length + D.length) issue("duplicate answers");

  // 5. theme word + reveal
  const theme = normalizeWord(p.lang, p.themeWord);
  if (!derived.some((s) => s.answer === theme)) issue("themeWord is not an answer", ["themeWord"]);
  if (p.reveal.some((i) => i >= theme.length)) issue("reveal index out of range", ["reveal"]);
  if (p.par !== (p.size === 5 ? 300 : 600)) issue("non-default par (soft)", ["par"]);
}

/** Clue text: uppercase + fold, but keep non-alphabet chars (used only for the answer-in-clue check). */
function normalizeWordLoose(lang: Lang, s: string) {
  return [...s.normalize("NFC").toLocaleUpperCase(lang)].map((ch) => FOLD[lang][ch] ?? ch).join("");
}

/** Split into what the client may see and what only the server keeps. */
export function splitPuzzle(p: z.infer<typeof PuzzleFile>) {
  const slots = deriveSlots(p.grid, p.sol.map((r) => r)); // already validated
  const pub = {
    id: p.id, lang: p.lang, kind: p.kind, size: p.size, title: p.title, author: p.author,
    difficulty: p.difficulty, par: p.par, themeWord: p.themeWord, reveal: p.reveal, cover: p.cover, kicker: p.kicker,
    grid: p.grid, clueCount: slots.length,
    across: p.across.map(([num, clue, ans, row, col]) => ({ num, clue, len: ans.length, row, col })),
    down:   p.down.map(([num, clue, ans, row, col]) => ({ num, clue, len: ans.length, row, col })),
  };
  const secret = { sol: p.sol, answers: Object.fromEntries(slots.map((s) => [s.key, s.answer])), decoys: p.decoys ?? {} };
  return { pub, secret };
}
```

### 2. D1 migration (content tables)

```sql
-- migrations/0002_content.sql
CREATE TABLE puzzles (
  id            TEXT PRIMARY KEY,
  lang          TEXT NOT NULL,
  kind          TEXT NOT NULL,                 -- mini | crossword
  size          INTEGER NOT NULL,
  shape         TEXT NOT NULL DEFAULT 'standard',
  title         TEXT NOT NULL,
  author_id     TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  difficulty    TEXT NOT NULL,
  par_sec       INTEGER NOT NULL,
  clue_count    INTEGER NOT NULL,
  theme_word    TEXT NOT NULL,
  reveal_json   TEXT NOT NULL,
  cover_style   TEXT NOT NULL,
  kicker        TEXT NOT NULL,
  topics_json   TEXT NOT NULL DEFAULT '[]',
  content_json  TEXT NOT NULL,                 -- public payload, no answers
  content_hash  TEXT NOT NULL,                 -- sha-256 of the canonical file; import no-op when equal
  status        TEXT NOT NULL,                 -- draft | filled | clued | reviewed | published
  drop_date     TEXT,                          -- 'YYYY-MM-DD' or NULL (pool)
  published_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX puzzles_lang_drop   ON puzzles (lang, drop_date);
CREATE INDEX puzzles_pool        ON puzzles (lang, status, drop_date);
CREATE INDEX puzzles_lang_author ON puzzles (lang, author_id);

CREATE TABLE puzzle_secrets (
  puzzle_id     TEXT PRIMARY KEY REFERENCES puzzles(id),
  solution_json TEXT NOT NULL,                 -- { sol: [...], answers: { "1A": "BEACH", ... }, decoys: {...} }
  updated_at    INTEGER NOT NULL
);

CREATE TABLE daily_drops (
  day        TEXT NOT NULL,                    -- 'YYYY-MM-DD' calendar day (compared to the user's local day)
  lang       TEXT NOT NULL,
  puzzle_id  TEXT NOT NULL REFERENCES puzzles(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day, lang)
);
CREATE INDEX daily_drops_feed ON daily_drops (lang, day DESC);
CREATE UNIQUE INDEX daily_drops_puzzle ON daily_drops (puzzle_id);   -- a puzzle drops once
```

**Foreign keys (fact-check):** D1 enforces foreign keys by default (`PRAGMA foreign_keys = ON` unless deferred with `PRAGMA defer_foreign_keys`), and both `puzzle_secrets.puzzle_id` and `daily_drops.puzzle_id` reference `puzzles(id)`. Consequence: `INSERT OR REPLACE INTO puzzles` (the original seed-script sketch) deletes-then-inserts the parent row, which either fails the FK check or — with `ON DELETE CASCADE` — silently deletes the puzzle's secret and drop rows. The seed script therefore uses `INSERT ... ON CONFLICT(id) DO UPDATE` exactly as the endpoint does (§6). If cascading is ever wanted (e.g. an "unpublish" that removes everything), add `ON DELETE CASCADE` deliberately, not as a side effect of `REPLACE`.

### 3. Cron: keep `daily_drops` filled 3 days ahead (idempotent)

```jsonc
// wrangler.jsonc (excerpt)
"triggers": { "crons": ["0 * * * *", "0 6 * * *"] }
```

```ts
// src/modules/content/cron.ts
export async function ensureDrops(env: Env, nowMs: number, daysAhead = 3) {
  for (const lang of ["en", "uk", "ru"] as const) {
    const stmts: D1PreparedStatement[] = [];
    for (let d = 0; d <= daysAhead; d++) {
      const day = dayKey(nowMs + d * 86_400_000, "UTC");            // registry days are plain calendar dates
      const exists = await env.DB.prepare("SELECT 1 FROM daily_drops WHERE day = ? AND lang = ?").bind(day, lang).first();
      if (exists) continue;
      const pick = await env.DB.prepare(
        `SELECT id FROM puzzles WHERE lang = ? AND status = 'published'
           AND (drop_date = ? OR drop_date IS NULL)
         ORDER BY (drop_date IS NULL), created_at LIMIT 1`).bind(lang, day).first<{ id: string }>();
      if (!pick) { console.error(`pool empty for ${lang} on ${day}`); break; }
      stmts.push(
        env.DB.prepare("UPDATE puzzles SET drop_date = ? WHERE id = ? AND (drop_date IS NULL OR drop_date = ?)").bind(day, pick.id, day),
        env.DB.prepare("INSERT OR IGNORE INTO daily_drops (day, lang, puzzle_id, created_at) VALUES (?, ?, ?, ?)").bind(day, lang, pick.id, nowMs),
      );
      await aggregateStub(env.PUZZLE_STATS, "puzzle_stats", pick.id).init(pick.id);  // idempotent
    }
    if (stmts.length) await env.DB.batch(stmts);                     // transaction per language
  }
}

// src/index.ts
export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    if (controller.cron === "0 * * * *") await ensureDrops(env, controller.scheduledTime);
    if (controller.cron === "0 6 * * *") await alertLowPool(env);
  },
} satisfies ExportedHandler<Env>;
```

Local test: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"`.

### 4. Local day key

```ts
export function dayKey(ms: number, tz: string): string {
  // throws RangeError for an unknown zone → map to 400 at the edge
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}
export function isValidTz(tz: string) { try { dayKey(0, tz); return true; } catch { return false; } }
```

### 5. Protected import endpoint (content module routes)

```ts
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import * as z from "zod";
import { PuzzleFile, splitPuzzle } from "@shared/puzzle";

const ImportBatch = z.strictObject({ puzzles: z.array(z.unknown()).min(1).max(50), force: z.boolean().default(false) });

export const contentAdmin = new Hono<{ Bindings: Env }>()
  .use("*", async (c, next) => bearerAuth({ token: c.env.CONTENT_ADMIN_TOKEN })(c, next))
  .post("/import", bodyLimit({ maxSize: 512 * 1024 }), zValidator("json", ImportBatch), async (c) => {
    const { puzzles, force } = c.req.valid("json");
    const report = { imported: [] as string[], unchanged: [] as string[], rejected: [] as { id?: string; issues: unknown }[] };
    for (const raw of puzzles) {
      const parsed = PuzzleFile.safeParse(raw);
      if (!parsed.success) { report.rejected.push({ id: (raw as any)?.id, issues: parsed.error.issues }); continue; }
      const p = parsed.data;
      const hash = await sha256(JSON.stringify(p));
      const cur = await c.env.DB.prepare("SELECT content_hash, status FROM puzzles WHERE id = ?").bind(p.id).first<{ content_hash: string; status: string }>();
      if (cur?.content_hash === hash) { report.unchanged.push(p.id); continue; }
      if (cur?.status === "published" && !force) { report.rejected.push({ id: p.id, issues: "published puzzle changed; pass force=true" }); continue; }
      const { pub, secret } = splitPuzzle(p);
      const now = Date.now();
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO puzzles (id, lang, kind, size, shape, title, author_id, author_name, difficulty, par_sec, clue_count,
            theme_word, reveal_json, cover_style, kicker, topics_json, content_json, content_hash, status, drop_date, published_at, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, difficulty=excluded.difficulty, par_sec=excluded.par_sec, clue_count=excluded.clue_count,
            theme_word=excluded.theme_word, reveal_json=excluded.reveal_json, cover_style=excluded.cover_style, kicker=excluded.kicker,
            topics_json=excluded.topics_json, content_json=excluded.content_json, content_hash=excluded.content_hash, status=excluded.status,
            drop_date=COALESCE(excluded.drop_date, puzzles.drop_date), published_at=COALESCE(puzzles.published_at, excluded.published_at), updated_at=excluded.updated_at`)
          .bind(p.id, p.lang, p.kind, p.size, p.shape, p.title, p.author.id, p.author.name, p.difficulty, p.par, pub.clueCount,
            p.themeWord, JSON.stringify(p.reveal), p.cover, p.kicker, JSON.stringify(p.topics), JSON.stringify(pub), hash, p.status,
            p.publishedAt ?? null, p.status === "published" ? now : null, now, now),
        c.env.DB.prepare(`INSERT INTO puzzle_secrets (puzzle_id, solution_json, updated_at) VALUES (?,?,?)
          ON CONFLICT(puzzle_id) DO UPDATE SET solution_json=excluded.solution_json, updated_at=excluded.updated_at`)
          .bind(p.id, JSON.stringify(secret), now),
      ]);
      report.imported.push(p.id);
    }
    return c.json(report, report.rejected.length ? 207 : 200);
  });
```

(23 bound parameters per statement, well under D1's 100; two statements per puzzle, so a 50-puzzle import is 100 statements + 50 lookups, under the 1,000-queries-per-invocation limit.)

**Atomicity (fact-check):** the sketch performs **50 separate `DB.batch` calls** (one per puzzle), so the import is atomic *per puzzle* (a `puzzles` row never exists without its `puzzle_secrets` row) but **not across puzzles** — if puzzle 37 fails, puzzles 1–36 are already committed. This matches the per-puzzle `{ imported, unchanged, rejected }` report semantics and is the intended behaviour (a bad file should not block the rest of the week's content); do not read the Summary's "atomic `DB.batch`" as batch-level atomicity. If all-or-nothing imports are ever wanted, collect every statement into one `DB.batch` (max 50 puzzles × 2 = 100 statements, fine) and return a single failure instead of a partial report.

### 6. Seed script (`scripts/content-seed.mjs`, Node)

```js
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { PuzzleFile, splitPuzzle } from "../packages/shared/dist/puzzle/index.js";
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
let sql = "";
for (const lang of ["en", "uk", "ru"]) for (const f of readdirSync(`content/puzzles/${lang}`)) {
  const p = PuzzleFile.parse(JSON.parse(readFileSync(`content/puzzles/${lang}/${f}`, "utf8")));   // throws on the first invalid file
  const { pub, secret } = splitPuzzle(p);
  // Fact-check: NOT `INSERT OR REPLACE` — D1 enforces foreign keys by default, and REPLACE deletes the parent `puzzles` row
  // out from under `puzzle_secrets` / `daily_drops` (FK failure, or cascade-delete with ON DELETE CASCADE). Upsert like the endpoint (§5).
  sql += `INSERT INTO puzzles (id, lang, kind, size, shape, title, author_id, author_name, difficulty, par_sec, clue_count, theme_word, reveal_json, cover_style, kicker, topics_json, content_json, content_hash, status, drop_date, published_at, created_at, updated_at) VALUES (${[p.id, p.lang, p.kind, p.size, p.shape, p.title, p.author.id, p.author.name, p.difficulty, p.par, pub.clueCount, p.themeWord, JSON.stringify(p.reveal), p.cover, p.kicker, JSON.stringify(p.topics), JSON.stringify(pub), "seed", p.status, p.publishedAt ?? null].map((v) => v === null ? "NULL" : q(v)).join(",")}, NULL, 0, 0)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, difficulty=excluded.difficulty, par_sec=excluded.par_sec, clue_count=excluded.clue_count, theme_word=excluded.theme_word, reveal_json=excluded.reveal_json, cover_style=excluded.cover_style, kicker=excluded.kicker, topics_json=excluded.topics_json, content_json=excluded.content_json, content_hash=excluded.content_hash, status=excluded.status, drop_date=COALESCE(excluded.drop_date, puzzles.drop_date), updated_at=excluded.updated_at;\n`;
  sql += `INSERT INTO puzzle_secrets (puzzle_id, solution_json, updated_at) VALUES (${q(p.id)}, ${q(JSON.stringify(secret))}, 0)
    ON CONFLICT(puzzle_id) DO UPDATE SET solution_json=excluded.solution_json, updated_at=excluded.updated_at;\n`;
}
writeFileSync("seed/0001_content.sql", sql);   // one statement per row keeps every statement far below 100 KB (literal SQL, so the 100-bound-parameter cap does not apply here)
// then: wrangler d1 execute crosscut --local --file=seed/0001_content.sql
```

### 7. Clue drafting with Claude (script, not in the Worker)

```ts
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod";

const ClueSet = z.object({ clues: z.array(z.object({ slot: z.string(), clue: z.string(), difficulty: z.number().int().min(1).max(3) })) });
const client = new Anthropic();

export async function draftClues(lang: "en" | "uk" | "ru", difficulty: string, slots: { key: string; answer: string }[]) {
  const res = await client.messages.parse({
    model: "claude-opus-5",
    max_tokens: 4000,
    system: STYLE_GUIDE[lang],   // definitional clues, ≤ 90 chars, never contain the answer or its root, no wordplay for EASY, target language only
    messages: [{ role: "user", content: `Difficulty: ${difficulty}\nAnswers:\n${slots.map((s) => `${s.key}: ${s.answer}`).join("\n")}` }],
    output_config: { format: zodOutputFormat(ClueSet) },
  });
  // Fact-check: on Opus 5 a refusal is an HTTP 200 with stop_reason "refusal" and parsed_output null —
  // distinguish it from a schema failure so a refusal on a benign puzzle is retried/logged, not treated as a schema bug.
  if (res.stop_reason === "refusal") throw new ClueRefusal(slots.map((s) => s.key));   // caller: log + retry once with a rephrased prompt, then flag for the editor
  if (res.stop_reason === "max_tokens") throw new Error("clue output truncated; raise max_tokens");
  if (!res.parsed_output) throw new Error("clue parse failed (schema mismatch)");
  return res.parsed_output.clues;    // then run the same answer-in-clue / length checks as the validator before writing the file
}
```

The bundled `claude-api` skill recommends always checking `stop_reason` and, for `claude-opus-5` code, optionally passing the server-side `fallbacks` parameter so a refused/overloaded request is retried on a fallback model without client logic; both apply to the Batches path as well (each result carries its own `stop_reason`).

For the nightly run, submit the same params through `client.messages.batches.create({ requests: [{ custom_id: puzzleId, params }] })` and key results by `custom_id`.

### 8. CSP filler core (`scripts/gen-crossword.mjs`, shape of the algorithm)

```js
// bank: Map<length, {word, score}[]>; slots from deriveSlots(grid) with cells; crossings precomputed per cell.
function fill(slots, bank, rng, budget = 200_000) {
  const grid = new Map();                       // "r,c" -> letter
  const used = new Set();
  const pattern = (s) => s.cells.map(([r, c]) => grid.get(`${r},${c}`) ?? ".").join("");
  const candidates = (s) => { const re = new RegExp(`^${pattern(s)}$`); return bank.get(s.cells.length).filter((w) => re.test(w.word) && !used.has(w.word)); };
  let nodes = 0;
  function step(unfilled) {
    if (!unfilled.length) return true;
    if (++nodes > budget) return false;
    // MRV: the slot with the fewest candidates
    const ranked = unfilled.map((s) => [s, candidates(s)]).sort((a, b) => a[1].length - b[1].length);
    const [slot, cands] = ranked[0];
    if (!cands.length) return false;
    for (const { word } of shuffleWeighted(cands, rng)) {   // higher score first, random tie-break
      const before = slot.cells.map(([r, c]) => grid.get(`${r},${c}`));
      slot.cells.forEach(([r, c], i) => grid.set(`${r},${c}`, word[i]));
      used.add(word);
      // forward check: every crossing slot must still have ≥ 1 candidate
      if (slot.crossings.every((x) => candidates(x).length > 0) && step(unfilled.filter((u) => u !== slot))) return true;
      used.delete(word);
      slot.cells.forEach(([r, c], i) => before[i] === undefined ? grid.delete(`${r},${c}`) : grid.set(`${r},${c}`, before[i]));
    }
    return false;
  }
  return step(slots) ? grid : null;
}
```

Pin the theme word by pre-filling its slot and marking the word used before calling `fill`. A seeded RNG (`rng`) makes `{patternId, seed}` reproduce a draft.

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | Re-deriving numbering from `grid`+`sol` with the standard rule reproduces the authored `[num,row,col]` for all four prototype puzzles; three 5×5 minis are word squares (5 unique answers of 10); no word < 3 letters; payloads 568–707 bytes | `validate-proto.mjs` run 2026-09-02 over PROTO L20-53 | high | confirmed |
| C2 | `NFD` + strip `\p{M}` maps `ё→е` but also `й→и` and `ї→і`; `toLocaleUpperCase("uk")` keeps `Ё Й Ї І Є Ґ` intact; `"ß".toUpperCase()` is `"SS"`; unknown `timeZone` throws `RangeError` | `norm-check.mjs`, Node v26.8.1 | high | confirmed |
| C3 | Zod 4: `import * as z from "zod"`, `z.tuple([...])`, `.superRefine((val, ctx) => ctx.addIssue({code:"custom",...}))` "fully supported in v4", `z.strictObject`, `z.int()` | https://zod.dev/api , https://zod.dev/v4 | high | confirmed |
| C4 | `@hono/zod-validator@0.9.1` peer deps: `zod ^3.25.0 \|\| ^4.0.0`, `hono >=4.11.2` | `npm view @hono/zod-validator@0.9.1 peerDependencies` | high | confirmed |
| C5 | D1 limits: 2 MB max row/string, 100 KB max statement, 100 bound parameters per query, 1,000 queries per invocation (Paid) / 50 (Free), 100 columns per table | https://developers.cloudflare.com/d1/platform/limits/ | high | confirmed |
| C6 | D1 `batch()` statements "are SQL transactions … aborts or rolls back the entire sequence"; `exec()` is for one-shot maintenance and "less safe" | https://developers.cloudflare.com/d1/worker-api/d1-database/ | high | confirmed |
| C7 | D1 supports `json_extract`, `->>`, `json_each`, `json_array_length` etc.; generated columns can be indexed; `ALTER TABLE ... ADD COLUMN` generated columns must be `VIRTUAL` | https://developers.cloudflare.com/d1/sql-api/query-json/ , https://developers.cloudflare.com/d1/reference/generated-columns/ | high | confirmed |
| C8 | `wrangler d1 execute <db> --file=<sql> [--local\|--remote\|--preview] [--yes] [--json]`; import files limited to 5 GiB; "Statement too long" fixed by splitting inserts; `wrangler d1 export --output --table --no-schema/--no-data` | https://developers.cloudflare.com/workers/wrangler/commands/d1/ , https://developers.cloudflare.com/d1/best-practices/import-export-data/ | high | confirmed |
| C9 | D1 migrations: numbered `.sql` files in `migrations/` (`migrations_dir`), tracked in `d1_migrations`; `wrangler d1 migrations create/list/apply` | https://developers.cloudflare.com/d1/reference/migrations/ | high | confirmed |
| C10 | Cron Triggers: `"triggers": { "crons": [...] }`; "Cron Triggers execute on UTC time"; weekdays 1 = Sunday … 7 = Saturday; deploy replaces previous triggers; handler `scheduled(controller, env, ctx)` with `controller.cron`, `controller.scheduledTime`, `controller.type`; local test `curl http://localhost:8787/cdn-cgi/handler/scheduled?cron=...&time=...` | https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ | high | confirmed |
| C11 | Cron Trigger limits: 5 per account (Free) / 250 (Paid); CPU 10 ms (Free) / 30 s (< 1 h interval) or 15 min (≥ 1 h) (Paid); 15 min wall-clock | https://developers.cloudflare.com/workers/platform/limits/ | high | confirmed |
| C12 | Official docs state no at-least-once/retry guarantee for cron; the local test endpoint reports `noRetry` when the handler calls `controller.noRetry()` | https://developers.cloudflare.com/workers/configuration/cron-triggers/ (absence of a guarantee statement); third-party (crontap.com, runhooks.app): failed/timed-out runs are lost until the next tick, no retry, no alert | medium | confirmed |
| C13 | Local workerd runs with `TZ=UTC` so `Date`/`Intl` observe UTC, "matching the production Cloudflare runtime"; `Date.now()` returns the time of the last I/O | https://developers.cloudflare.com/workers/local-development/ , https://developers.cloudflare.com/workers/runtime-apis/web-standards/ | high | confirmed |
| C14 | workerd's ICU data resolves every IANA zone we ship (e.g. `Europe/Kyiv`) — was UNVERIFIED; fact-check confirmed `Intl.DateTimeFormat({ timeZone: "Europe/Kyiv" })` works in workerd and Node 26.8.1, while `Intl.supportedValuesOf("timeZone")` lists only the canonical `Europe/Kiev` (418 entries in workerd) | no primary doc; probed in workerd during fact-check | low → medium | confirmed |
| C15 | No maintained npm package fills a fixed dense block pattern from a dictionary; `crossword-layout-generator` 0.1.1, `cwg` 0.2.2, `crossword-generator` 1.0.1, `crossword-generator-x` 1.0.0, `gen-crossword` 1.0.3, `puzzletide` 0.2.0 are all layout-from-answer-list generators (MIT) | `npm view`/READMEs 2026-09-02; https://github.com/MichaelWehar/Crossword-Layout-Generator | high (for the packages listed), medium (for "no package at all") | confirmed (F8 date/README nits corrected: `cwg` published 2021-10-11; Crossword-Layout-Generator last push 2025-04-21; `puzzletide` "AI clue" phrase is a hidden maintainer note) |
| C16 | `crossword-layout-generator`: "The generated layouts don't always contain all of the input words", "not always connected", slow > 100 words; MIT | https://github.com/MichaelWehar/Crossword-Layout-Generator | high | confirmed |
| C17 | `@xwordly/xword-parser` 1.1.0 (2026-03-28, MIT) parses PUZ, iPUZ, JPZ, XD into one TypeScript model. ~~with only `fast-xml-parser` as a dependency~~ **Corrected:** `package.json` declares three runtime dependencies — `buffer ^6.0.3`, `fast-xml-parser ^5.5.9`, `vitiate ^0.3.0`; the README's "only fast-xml-parser" is marketing | `npm view @xwordly/xword-parser dependencies` ; `npm view @xwordly/xword-parser readme` | high (version/date/licence/formats), dependency claim was wrong | refuted |
| C18 | Naive backtracking without forward checking is impractical on 15×15 ("167,749 backtracks in 60 seconds without completing a fill"); CSP with arc consistency / forward checking recommended | https://github.com/jhingran/crossword-generator ; https://arxiv.org/pdf/1401.4597 | medium | confirmed |
| C19 | Collaborative Word List: MIT, > 425,000 `word;score` entries, "free for everyone" | https://github.com/Crossword-Nexus/collaborative-word-list | high | confirmed |
| C20 | spread the word(list): CC BY-NC-SA 4.0; 314,276 answers, 120,178 scoring ≥ 50 (2026-07-01); "selling crossword puzzles created with this list is permitted" | https://www.spreadthewordlist.com/ | high | confirmed |
| C21 | dict_uk / VESUM Ukrainian dictionary data is CC BY-NC-SA 4.0 (software GPL-3); lemma list in `out/lemmas.txt` | https://github.com/brown-uk/dict_uk | high | confirmed |
| C22 | OpenCorpora (Russian) data is ~~CC BY-SA 4.0~~ **CC BY-SA 3.0** (corrected; the originally cited secondary page states no licence at all; ShareAlike conclusion unchanged) | https://opencorpora.org/wiki/FAQ and https://opencorpora.org/?page=export (via search snippets — site returned HTTP 521 on 2026-09-02); https://tatianashavrina.github.io/2018/08/30/datasets/ (no licence stated) | medium | refuted |
| C23 | ipuz v2: `"version": "http://ipuz.org/v2"`, crossword kind `"http://ipuz.org/crossword#1"`, blocks `"#"`; spec CC BY-ND 3.0 with a perpetual free licence to use the format | https://www.puzzazz.com/ipuz | high | confirmed |
| C24 | Hono: `import { bearerAuth } from "hono/bearer-auth"` with `token`/`verifyToken`/`prefix`/`headerName`/`hashFunction`; `import { bodyLimit } from "hono/body-limit"` with `maxSize`/`onError`, default 100 KB | https://hono.dev/docs/middleware/builtin/bearer-auth , https://hono.dev/docs/middleware/builtin/body-limit | high | confirmed |
| C25 | Claude structured output: `client.messages.parse({ ..., output_config: { format: zodOutputFormat(Schema) } })`, `parsed_output` null on failure; Message Batches run at 50 % cost keyed by `custom_id`; `@anthropic-ai/sdk` latest 0.123.0; Opus 5 $5/$25 per MTok | bundled `claude-api` skill (cached 2026-06-24) + `npm view @anthropic-ai/sdk version` | medium (skill cache, not live docs) | confirmed (billing caveat added in F11: thinking tokens billed as output; 4.7+ tokenizer ~30 % more tokens; `stop_reason: "refusal"` handling added in §7) |
| C26 | Russian alphabet = 33 letters incl. Ё Й Ъ Ы Ь Э; Ukrainian alphabet = 33 letters incl. Ґ Є І Ї and excluding Ё Ъ Ы Э; the Ukrainian apostrophe is not a letter | standard reference knowledge, not fetched this session | medium | confirmed |
| C27 | `react-crossword`'s data model is `{across: {1: {clue, answer, row, col}}, down: {...}}` — same fields as the prototype tuples | https://github.com/JaredReisinger/react-crossword | high | confirmed |

## Open questions

- **O1 (blocking for R4):** Does workerd resolve `Europe/Kyiv`, `Europe/Kiev`, and the full IANA set in `Intl.DateTimeFormat`? Write a workerd test (with `@cloudflare/vitest-plugin` + Vitest 4.1+, not `@cloudflare/vitest-pool-workers` — fact-check, F7) that formats a fixed instant in every zone the client can send before shipping local-day logic. *Do not* build that list from `Intl.supportedValuesOf("timeZone")` and assert equality: the list contains the ICU canonical `Europe/Kiev`, not `Europe/Kyiv` (verified in Node 26.8.1 and workerd), so the test would fail for Kyiv even though `DateTimeFormat` accepts it. Validate each zone by constructing a `DateTimeFormat` (`isValidTz`) and compare *formatted day keys*, not zone names.
- **O2 (legal):** Are CC BY-NC-SA word lists (spread the word list, dict_uk/VESUM) acceptable as *inputs* to a generator whose output is sold inside a freemium app? The spread-the-word-list terms explicitly permit selling puzzles; VESUM's do not say. Recommendation stands: in-house banks for uk/ru, public lists only for review-time checks — confirm with counsel if the team wants to ship a public list in the repo.
- **O3 (product):** Keyboard for uk/ru. The design is QWERTY (README §12); Cyrillic needs a 33-key layout (or 32 with `Ё→Е` folding for ru). Decide whether the data-side fold (`ru: Ё→Е`) is wanted, and whether `Ґ` gets a key or is folded to `Г` in uk (not recommended, but it removes one key).
- **O4 (format):** Word-square minis repeat the same clue text for the across and down slot of the same word. Keep (cheap, matches prototype) or require distinct down clues (better solving experience, more editorial work)?
- **O5 (policy):** Should 9×9 "crossword" puzzles be required to be fully checked and rotationally symmetric? `cross1` is neither. If yes, the pattern library must be built accordingly and `cross1` becomes a `fullyChecked: false` exception.
- **O6 (ops):** Editorial calendar tooling — v1 is JSON-in-repo plus `GET /admin/content/status`. Decide when a visual admin (render grid, edit clues, drag onto calendar) is worth building; likely once a non-engineer edits content.
- **O7 (generation yield):** Double 5×5 word squares from a 4–8 K bank may have low yield. Measure with the first bank; if < 1 fill per 100 seeds, allow one or two symmetric black squares in minis (still 10 slots, still fully checked) or grow the bank of 5-letter words specifically.
- **O8 (secrets):** Whether to keep `puzzle_secrets` in D1 or move solutions into KV for the per-word check path (read-heavy, tiny values). D1 with a cached read in the `Solving` module is enough for v1; revisit if D1 read cost shows up.

## Fact-check log

Fact-check run 2026-09-02 against the 27 claims above. Verdicts: 25 confirmed, 2 refuted, 0 unverifiable. No claim was marked `[UNVERIFIED]`.

| id | verdict | source used by the fact-check |
|---|---|---|
| C1 | confirmed | `validate-proto.mjs` re-run over PROTO L20-53 |
| C2 | confirmed | `norm-check.mjs`, Node v26.8.1 |
| C3 | confirmed | https://zod.dev/api , https://zod.dev/v4 |
| C4 | confirmed | `npm view @hono/zod-validator@0.9.1 peerDependencies` |
| C5 | confirmed | https://developers.cloudflare.com/d1/platform/limits/ |
| C6 | confirmed | https://developers.cloudflare.com/d1/worker-api/d1-database/ |
| C7 | confirmed | https://developers.cloudflare.com/d1/sql-api/query-json/ , https://developers.cloudflare.com/d1/reference/generated-columns/ |
| C8 | confirmed | https://developers.cloudflare.com/workers/wrangler/commands/d1/ , https://developers.cloudflare.com/d1/best-practices/import-export-data/ |
| C9 | confirmed | https://developers.cloudflare.com/d1/reference/migrations/ |
| C10 | confirmed | https://developers.cloudflare.com/workers/configuration/cron-triggers/ , https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ |
| C11 | confirmed | https://developers.cloudflare.com/workers/platform/limits/ |
| C12 | confirmed | Cloudflare cron-triggers docs (silent on retries); crontap.com and runhooks.app state failed/timed-out runs are lost with no retry or alert |
| C13 | confirmed | https://developers.cloudflare.com/workers/local-development/ , https://developers.cloudflare.com/workers/runtime-apis/web-standards/ |
| C14 | confirmed | Probed in workerd and Node 26.8.1: `Intl.DateTimeFormat({ timeZone: "Europe/Kyiv" })` works; `Intl.supportedValuesOf("timeZone")` returns canonical `Europe/Kiev` (418 entries in workerd) |
| C15 | confirmed | `npm view` / READMEs 2026-09-02 (with date corrections: `cwg` 0.2.2 published 2021-10-11; Crossword-Layout-Generator last push 2025-04-21; `puzzletide` "AI clue generation" phrase is a hidden HTML maintainer comment, not a user-facing ban) |
| C16 | confirmed | https://github.com/MichaelWehar/Crossword-Layout-Generator |
| C17 | **refuted** | `npm view @xwordly/xword-parser dependencies` → `{ buffer: '^6.0.3', 'fast-xml-parser': '^5.5.9', vitiate: '^0.3.0' }`; `npm view @xwordly/xword-parser readme`. Version, date, licence and format list are correct; "only fast-xml-parser" is not |
| C18 | confirmed | https://github.com/jhingran/crossword-generator ; https://arxiv.org/pdf/1401.4597 |
| C19 | confirmed | https://github.com/Crossword-Nexus/collaborative-word-list |
| C20 | confirmed | https://www.spreadthewordlist.com/ |
| C21 | confirmed | https://github.com/brown-uk/dict_uk |
| C22 | **refuted** | https://opencorpora.org/wiki/FAQ and https://opencorpora.org/?page=export via search-engine snippets (opencorpora.org returned HTTP 521 at fetch time): licence is CC BY-SA **3.0**, not 4.0. https://tatianashavrina.github.io/2018/08/30/datasets/ states no licence. ShareAlike conclusion unchanged |
| C23 | confirmed | https://www.puzzazz.com/ipuz |
| C24 | confirmed | https://hono.dev/docs/middleware/builtin/bearer-auth , https://hono.dev/docs/middleware/builtin/body-limit |
| C25 | confirmed | bundled `claude-api` skill + `npm view @anthropic-ai/sdk version`; billing caveats from https://platform.claude.com/docs/en/about-claude/pricing |
| C26 | confirmed | standard reference knowledge (alphabet membership), code-point probing in `norm-check.mjs` |
| C27 | confirmed | https://github.com/JaredReisinger/react-crossword |

Additional problems fixed in the text during the fact-check (not tied to a numbered claim):

1. Test tooling renamed to `@cloudflare/vitest-plugin` + Vitest 4.1+ (scope line, F7, O1) — https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/
2. O1 test design: do not assert `Intl.supportedValuesOf("timeZone")` against client zone strings (`Europe/Kyiv` vs canonical `Europe/Kiev`); validate with `DateTimeFormat` (F7, O1, §4)
3. F11 clue-drafting cost: thinking tokens billed as output on Opus 5; 4.7+ tokenizer yields ~30 % more tokens — https://platform.claude.com/docs/en/about-claude/pricing
4. §7 sketch: handle `stop_reason: "refusal"` separately from schema failures; `fallbacks` parameter noted (bundled `claude-api` skill)
5. F6/R4: cron invocations that throw or time out are lost with no retry and no alert by default; added a "cron actually ran" check to the 06:00 alert job (crontap.com, runhooks.app)
6. F8 nits: `puzzletide` README wording, `cwg` publish date, Crossword-Layout-Generator last-push date
7. F9 XwordInfo row re-sourced to https://www.xwordinfo.com/WordList (253,276 entries, Angel account, one-time $50); georgeho.org citation removed as unsupporting
8. F5: 100-bound-parameter cap limits a parameterised multi-row `INSERT` to 4 puzzles (23 params each); the ~50-row figure applies only to literal-SQL seed files
9. Summary/§5: import is atomic per puzzle (50 `DB.batch` calls), not across the whole batch
10. §2/§6: D1 enforces foreign keys by default, so the seed script uses `INSERT ... ON CONFLICT DO UPDATE` instead of `INSERT OR REPLACE` (which would delete the parent `puzzles` row under `puzzle_secrets` / `daily_drops`)
