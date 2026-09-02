# Crosscut domain spec — extracted from the design handoff and the prototype logic

Slug: `domain-spec-extraction` · Date: 2026-09-02 · Method: local-file extraction only (no web research was needed for this topic; every claim cites a local file and line range).

Sources read completely:

- `README` = `/Users/peter/Projects/IOS Crosswords/Crosswords app with feed/design_handoff_crosscut_feed/README.md` (326 lines; fact-check `wc -l` 2026-09-02 — an earlier draft said 327)
- `PROTO` = `/private/tmp/claude-501/-Users-peter-Projects-IOS-Crosswords/9d054732-b7c8-4939-80a1-8eb9aba21fda/scratchpad/prototype-logic.js` (570 lines per `wc -l` on 2026-09-02 — an earlier draft said 571; all line references below were re-checked and hold, the `Component extends DCLogic` class extracted from `Crosscut Prototype.dc.html`)
- `CONCEPTS` = `/Users/peter/Projects/IOS Crosswords/IOSApp concepts/concepts.md`, `CORE` = `/Users/peter/Projects/IOS Crosswords/IOSApp concepts/core-package.md`, and `/Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts` (the base class the implementation copies in)
- Verification script: `/private/tmp/claude-501/-Users-peter-Projects-IOS-Crosswords/9d054732-b7c8-4939-80a1-8eb9aba21fda/scratchpad/verify.mjs` (re-ran the prototype's `questions()` / `lockAndSweep()` against all four puzzles)

## Summary

The prototype is a single React component whose state object is the whole product: economy (tokens, stars, streak), onboarding preferences, per-card likes/saves, play state for one puzzle at a time, wheel instances, and feed pagination counters. The data model underneath is small and consistent:

- **Puzzle** = `{ id, title, author, size (5|9), par (300|600), diff, cover presentation, themeWord + reveal[], grid[] ('#' block / '.' cell), sol[] (solution rows), across[], down[] }` with each clue as a 5-tuple `[num, clue, answer, row, col]`. Every puzzle in the prototype has exactly 10 clues (5 across + 5 down). The 5×5 minis are perfect word squares (down words == across words), which is why their down clues repeat the across clue text verbatim.
- **Solving** is word-at-a-time: a word is "locked" when typed completely and equal to the answer; any word whose cells are all covered by locked words is auto-locked (recursive sweep); the puzzle is finished when all 10 questions are locked. The server can verify all of this from `sol` + the clue tuples alone.
- **Economy**: `tokens = floor(secLeft / 5)` at finish; `stars = 10 + (usedHints ? 0 : 2)`; hint costs 50/50 = 20, reveal letter = 40, solve word = 100, autocheck free (and it does not flag `usedHints`); wheel prizes `[50, 10, 0, 25, 5, 15]`, uniform random, one spin per wheel instance; token packs 120/$0.99, 550/$3.99, 1,400/$8.99; plans lite/free, month/$3.99, year/$23.99; collection rewards 60–250 tokens; the streak shown is `baseStreak + (todaySolved ? 1 : 0)` and *any* puzzle solve sets `todaySolved`.
- **Feed** is a deterministic composition: daily post, streak-at-risk card (only while today is unsolved), Weekend Grid, wheel, Studio Mini, then up to 10 appended batches of `{wheel | mystery} + 2 archive posts`.
- A lot of what is on screen is **fake/hard-coded**: like counts (`likes + (idx*37) % 400`), live counters (`8412 + bump`), stories (fixed MON/SUN/SAT/FRI-missed/THU/WED), top solvers, ticker lines, profile stats (`42 + completed`, best time `1:47`, achievements `12 / 30`), the streak strip (Fri always missed), the "Continue solving" default (Weekend Grid 4/10), and `colProgress()` which only counts the first three slots and never `mini3`. The referenced repo puzzle JSON (`workers/gateway/src/puzzles/{en,ru,uk}/`) does **not** exist on this machine, so the four inline puzzles are the only content we have.

This document turns that into an implementation-ready spec: entities and fields, constants and formulas, the exact solving rules, the state map, per-screen data needs, a REST endpoint list, and a domain-event catalog delivered as direct in-process calls.

## Findings

### F1. Source inventory and what is missing

- The README says puzzle data "already exists as JSON in `workers/gateway/src/puzzles/{en,ru,uk}/`" and that the prototype uses "the real `en-mini-1`, `en-mini-2`, `en-mini-3` and `cross-en-1` payloads" (README L17-23). Neither `/Users/peter/Projects/IOSApp/workers/` nor any `*.json` puzzle file exists under `/Users/peter/Projects/IOS Crosswords` or `/Users/peter/Projects/IOSApp` (checked with `ls`/`find`). The prototype's inline `PUZZLES` map (PROTO L20-53) is therefore the only ground truth for the data format. The ids differ (`mini1` vs `en-mini-1`): treat the prototype ids as aliases and adopt the `<lang>-<kind>-<n>` naming for real content. Note (fact-check, README L22): the README's own ids are *not* consistent with one scheme — it mixes `en-mini-1` (`<lang>-<kind>-<n>`) with `cross-en-1` (`<kind>-<lang>-<n>`); `<lang>-<kind>-<n>` is this document's proposal, not something the README already uses, so `cross-en-1` would become `en-cross-1` (or `en-crossword-1`) under it.
- `support.js` (1,911 lines) is the `DCLogic` prototype runtime; it contains no puzzle data.
- README §"Files" (L318-323) says the retention ideas in Feed Explorations turns 4–5 (streak freeze, missions, rewarded double, etc.) are **not** in the prototype and are backlog. They are excluded from this spec.

### F2. Puzzle content format (PROTO L20-53, L75-80)

```
grid:   string[size]      each char: '#' = block, '.' = open cell        (L26, L33)
sol:    string[size]      same shape; '#' for blocks, uppercase letter otherwise (L26, L34)
across: Clue[]            Clue = [num:number, clue:string, answer:string, row:number, col:number]
down:   Clue[]            same tuple; cells run downward from (row, col)
```

`questions(p)` (L75-80) flattens across then down into a `Question[]` in that order; each question gets `dir`, `num`, `clue`, `ans` and `cells = answer.split('').map((_, i) => [row, col + i])` (across) or `[row + i, col]` (down). **Question index = position in that flattened list**, and the whole play state (`solvedQs`, `qIndex`) is keyed by that index, not by clue number. The "QUESTION n OF 10" banner shows `qIndex + 1` (L363).

Verified with `verify.mjs`:

| puzzle | size | open cells | questions | blocks consistent | answers match `sol` | all open cells covered by ≥1 clue | word square | numbering standard |
|---|---|---|---|---|---|---|---|---|
| mini1 | 5 | 25 | 10 | yes | yes | yes | yes | yes |
| cross1 | 9 | 31 | 10 | yes | yes | yes | no | yes |
| mini2 | 5 | 25 | 10 | yes | yes | yes | yes | yes |
| mini3 | 5 | 25 | 10 | yes | yes | yes | yes | yes |

Notes:

- Clue numbering follows the standard crossword rule (a cell gets the next number if it starts an across or a down word). The `num` field is therefore derivable, but keep it in the data — the client shows "7-Across" (L297).
- Every prototype puzzle has exactly 10 questions and the UI hard-codes "of 10 clues" / `pzClueCount: 10` / "QUESTION n OF 10" (README L215; PROTO L297, L517). The server must send `questionCount` so the client stops hard-coding it.
- `cross1` (9×9) has 31 open cells; some cells belong to only one word (e.g. `C` at (4,0) is only in 6-Across). That matters for the sweep rule below.

### F3. Entities and fields

#### Puzzle (content, authored)

| field | type | source | notes |
|---|---|---|---|
| `id` | string | L21 | `mini1`, `cross1`, `mini2`, `mini3` |
| `title` | string | L21 | "Monday Mini", "Weekend Grid", "Studio Mini", "Agent Mini" |
| `author` | string | L21 | setter display name; "Crosscut Daily", "Weekend Desk", "Théa V." |
| `avatar`, `avatarBg`, `avatarFg` | string | L21 | initial letter + colours — belongs to a **Setter** entity |
| `meta` | string | L22 | "Mini · 5×5 · ~2 min" — derivable from `kind`, `size`, `par` |
| `size` | 5 \| 9 | L22 | grid is square |
| `par` | 300 \| 600 | L22, L81-85 | seconds; 9×9 = 2× mini |
| `diff` | "EASY" \| "MEDIUM" \| "TRICKY" | L22, L30, L46 | badge text |
| `diffColor` | hex | L22 | ink for EASY/MEDIUM, accent for TRICKY |
| `coverBg`, `kickerColor`, `clueColor`, `subColor`, `ctaBg`, `ctaFg` | hex | L23-24 | all derivable from one enum `coverTheme: "ink" \| "accent" \| "card"` (see mkTiles L272-283) |
| `kicker` | string | L23 | "MONDAY MINI · SEP 1", "CROSSWORD 1 · 10 CLUES", "THEMED · ART & LETTERS", "THEMED · SPY STUFF"; archive cards override with "FROM THE ARCHIVE · AUG n" (L325) |
| `themeWord` | string | L24 | word shown as cover tiles; equals one of the answers (`BEACH`=1A, `GRID`=3D, `EASEL`=7A, `AGENT`=7A) |
| `reveal` | number[] | L24 | indices of themeWord letters shown on the cover; the accent tile is `reveal[floor(reveal.length/2)]` (L278) |
| `likes` | number | L24 | seed like count (fake, see F14) |
| `solvedCount` | string | L24 | display string, e.g. "8,412 solved today" (fake) |
| `grid`, `sol`, `across`, `down` | see F2 | L25-28 | |
| `coverClueIndex` (derived) | number | L296-297 | the across clue shown on the cover: index 2 for mini2 (7-Across), else 0 |
| `lang` (missing) | "en" \| "uk" \| "ru" | README L116-118 | not in the prototype; required by the language quiz |
| `kind` (missing) | "mini" \| "crossword" | L22, L30 | implied by `meta` |
| `publishedAt` / `dailyDate` (missing) | | L23, L284 | needed for "2m ago", "SEP 1", archive months |

The server must **never** send `sol` or the `answer` element of clue tuples to a client that has not finished the puzzle (see Recommendation). The client needs `grid`, clue `[num, clue, len, row, col, dir]`, `size`, `par`, `questionCount`.

#### Question (derived, per puzzle)

`{ index, dir: "ACROSS" | "DOWN", num, clue, length, cells: [row, col][] }` — plus `answer` server-side only. Progress bar has one segment per question (L368).

#### Setter (implied)

`{ id, name, avatarInitial, avatarBg, avatarFg }` — appears on puzzle cards (L292) and as a collection shelf ("Setters": Théa V., Weekend Desk, L462). Not modelled separately in the prototype.

#### User

| field | source | notes |
|---|---|---|
| `id` / `displayName` | README L201 | "Player-7F3A" — display name derived from id suffix |
| `since` | README L201 | "Solving since Aug 2026" |
| `tokens` | L5 (269) | wallet |
| `stars` | L5 (1284) | earned only, never spent/bought (README L242-243) |
| `baseStreak` | L5 (6) | streak before today; shown streak = `baseStreak + (todaySolved ? 1 : 0)` (L234) |
| `todaySolved` | L5 | set true by *any* finish (L138) |
| `completedIds[]` | L9 | puzzle ids solved at least once (order = completion order, used for Profile "Completed" tiles L346) |
| `level`, `topicsSel[]`, `lang`, `plan` | L6-7 | onboarding prefs; defaults `casual`, `["Travel","Words"]`, `en`, `year` |
| `likes{}`, `saves{}` | L8 | keyed `puzzleId#feedIndex` (README L297) — per *card instance* in the prototype; per puzzle in the real model |
| `wheels{}` | L15 | per wheel key: `{ rot, spinning, done, prize }` |
| `luckyClaims{}`, `searchExtra` | L15 | dead state (never read for anything visible) |
| `curPz` | L10 | currently viewed puzzle (client nav only) |

#### Solve (one per user × puzzle attempt)

| field | source | notes |
|---|---|---|
| `playPz` (puzzleId) | L12 | |
| `filled[][]` | L12, L105 | `'#'` for blocks, `''` empty, else one uppercase letter |
| `solvedQs[]` | L12 | question indexes locked (typed or swept) |
| `qIndex` | L12 | active question |
| `secLeft` | L12, L105 | starts at `par`, ticks down only while on Play, never below 0 (L92) |
| `error` | L13 | last typed word was wrong |
| `usedHints` | L13 | set by any *paid* hint (L195), never by autocheck |
| `autocheck` | L13 | free toggle |
| `fiftyOpts` | L14 | pending 50/50 candidates `[a, b]` |
| `justLocked[]` | L14 | UI flash keys, transient |
| result: `tokensEarned`, `noHint`, `solveTime` | L17, L139 | `solveTime = par - secLeft` (capped at par) |
| `celebType`, `celebSeed` | L17 | client-only randomness |

Resume rule (L104-106): re-opening Play for the same `playPz` keeps the whole solve state (timer included) unless the puzzle is in `completedIds`, in which case a fresh solve starts. "Play again" on a completed puzzle therefore starts over (L518).

#### Collection (manifest, L55-68)

`{ key, name, emoji, shelf: "theme" | "size" | "setter" | "archive", bg, fg, blurb, pz: puzzleId[], reward: number, locked?: boolean }`

| key | name | shelf | members (prototype) | reward | locked |
|---|---|---|---|---|---|
| travel | Travel 🌍 | theme | 8 (repeats) | 120 | |
| art | Art & Letters 🎨 | theme | 6 | 90 | |
| spy | Spy Stuff 🕵️ | theme | 5 | 80 | |
| food | Food 🍜 | theme | 7 | 100 | **yes** — "Finish Travel to unlock" |
| minis | Two-minute Minis ⚡ | size | 10 | 150 | |
| grids | Weekend Grids 🧩 | size | 4 (cross1 ×4) | 200 | |
| thea | Théa V. ✍️ | setter | 4 | 60 | |
| desk | Weekend Desk 🗞️ | setter | 3 | 60 | |
| aug / july / june / may | August…May 2026 📅 | archive | 10 / 6 / 5 / 4 | 250 each | |

Shelves and headers (L459-464): "By theme · 4 collections", "By size · 2 collections", "Setters · 2 setters", "Archive · by month". The lock rule is a hard-coded string (L454) and `open()` is a no-op while locked (L456); reward line copy: "Finish all for the {name} badge + 🪙 {reward}" (README L195-196). The prototype never grants a collection reward.

#### Feed item (union, L285-326)

- `puzzle_post`: `{ puzzleId, feedIndex, kicker, ago, clue, clueMeta, tiles, done, liked, saved, likeCount, solvedCountLabel, ctaLabel: "Solve" | "Review" }`
- `streak_save`: `{ title: "{streak}-day streak at risk", sub: "9h 14m left today. One Mini keeps it alive.", puzzleId: "mini1" }` — only while `!todaySolved` (L310)
- `wheel`: `{ wheelKey, canSpin, doneSpin, resultShort: "✓ +{prize} 🪙" | "✓ spun" }` (L311-320)
- `mystery`: `{ }` → opens a random puzzle from `ORDER` (L324)
- Stories row: 6 fixed items `[MON Today, ✓ Sun, ✓ Sat, FRI Missed, ✓ Thu, ✓ Wed]`; today's label becomes ✓ when solved (L262-270)
- Ticker: 6 lines (L439) — solve line, streak line, live solver count, like line, leaderboard pass, archive teaser; rotates every 3 s (L96)

#### Wheel instance (L183-192, L311-320)

`{ key: "wheel#base" | "wheel#<batch>", prize: 50|10|0|25|5|15|null, done, spinning, rot }` — keys created on demand; one spin per key.

#### TokenPack (L434-437): `{ amount: 120|550|1400, price: "$0.99"|"$3.99"|"$8.99", badge: null|"Popular"|"Best value" }`; `buy()` adds tokens immediately (mock).

#### Plan (L254-259): `lite` ("Lite — with ads", "Free forever", Free), `month` ("No ads for a month", "Billed monthly", $3.99), `year` ("No ads for a year", "$2.00 / month", $23.99, badge "2 months free"); default `year`; CTA derived from selection.

#### Onboarding prefs (L238-253)

- `level`: `newbie` (N, "First timer", "Gentle Minis, generous hints"), `casual` (C, "Casual solver", "Minis on weekdays, a grid on weekends"), `shark` (S, "Word shark", "Straight to the tricky stuff"); default `casual`.
- `topicsSel`: subset of `[Travel, Movies, Food, Science, Music, Sport, Art, Words]`; default `[Travel, Words]`; empty renders "Surprise me" (L478).
- `lang`: `en` / `uk` / `ru`; default `en`. README L118: "Puzzles are written per language, never translated. Your streak counts across all of them."
- `notifications`: enable / not now (README L126-131) — not stored in prototype state.
- "Skip all" from any funnel step keeps the defaults (README L102, L253-254).

### F4. Constants and formulas

| constant | value | source |
|---|---|---|
| Par, 5×5 | 300 s | PROTO L22, L83; README L265 |
| Par, 9×9 | 600 s (`size > 5 ? base*2 : base`) | PROTO L84; README L265 |
| Timer | 1 Hz countdown, only while `screen === "play"`, floor 0 | PROTO L88-94 |
| Timer urgency | pill turns accent under 60 s | PROTO L367; README L266 |
| Tokens on solve | `floor(secLeft / 5)` | PROTO L129; README L266 |
| Stars on solve | `10 + (usedHints ? 0 : 2)` | PROTO L137; README L267 |
| "under par" / "over par" | `secLeft > 0` / `secLeft === 0` | PROTO L557 |
| Solve time | `par - secLeft` | PROTO L139 |
| Hint 50/50 | 20 tokens | PROTO L530; README L228 |
| Hint reveal letter | 40 tokens | PROTO L542; README L229 |
| Hint solve word | 100 tokens | PROTO L549; README L229 |
| Autocheck | free; does not set `usedHints` | PROTO L555, L380 |
| Insufficient tokens | route to Wallet, hint not applied | PROTO L194 |
| DECOYS (50/50 pool by length) | 3: AXE, ORB · 4: DUSK, MOSS, PINE, CLAM · 5: PLAZA, CORAL, MOUNT, TREND, SPARE · else "BLANK" | PROTO L73, L531 |
| Wheel prizes (segment order) | `[50, 10, 0, 25, 5, 15]`, uniform pick, label "✕" for 0 | PROTO L185, L477 |
| Wheel rotation | `1800 + (360 - i*60) + jitter(-16..16)`, credit after 3.4 s | PROTO L189-191; README L272-274 |
| Wheel result copy | "You won 🪙 n!" / "So close — try tomorrow" | PROTO L508 |
| Token packs | 120/$0.99 · 550/$3.99 "Popular" · 1,400/$8.99 "Best value" | PROTO L434; README L243-244 |
| Plans | lite free · month $3.99 · year $23.99 ("$2.00 / month", "2 months free") | PROTO L254; README L136-139 |
| Collection rewards | 60–250 tokens (table in F3) | PROTO L56-67 |
| Feed pagination | batch appended when within 500 px of bottom, max 10 batches | PROTO L511 |
| Browse pagination | same, max 8 batches (legacy search grid) | PROTO L512 |
| Ticker / live drift | every 3 s: `tickerIdx++`, `bump += rand(0..3)` | PROTO L96 |
| Live counters | daily card: `(8412 + bump)` solved · `(297 + bump*3)` solving now | PROTO L303 |
| Like count | `p.likes + (idx*37) % 400 + (liked ? 1 : 0)` | PROTO L302 |
| Next puzzle order | `ORDER = [mini1, cross1, mini2, mini3]`, wraps | PROTO L54, L561-565 |
| Streak shown | `baseStreak + (todaySolved ? 1 : 0)` | PROTO L234 |
| Profile stats | solved `42 + completedIds.length`, best `1:47`, this week `5 + todaySolved` | PROTO L513 |
| Balances at start | tokens 269, stars 1284, streak 6 | PROTO L5 |
| Play grid geometry | 5×5: 54 px cells / 6 gap · 9×9: 33 px / 4 gap | PROTO L362; README L219 |

### F5. Solving rules (the part the server must be able to verify)

All from PROTO L100-182 and README L259-263.

1. **Start** (`openPlay`, L100-109): `filled = grid.map(row → '#' stays '#', else '')`, `solvedQs = []`, `qIndex = 0`, `secLeft = par`, flags reset. Reused if the same puzzle is re-opened and not completed.
2. **Fixed cell** (`isFixed`, L111): a cell is fixed iff it belongs to at least one locked question.
3. **Typing** (`input`, L164-175): ignored if the active question is locked. If `error` is set, first clear every *non-fixed* cell of the active word. Then put the letter in the first cell of the active word that is empty (fixed cells are already filled, so they are skipped — "skipping cells already locked by a crossing answer", README L259-260). If no empty cell, ignore. Then `tryLock`.
4. **tryLock** (L143-162): only when every cell of the word is non-empty. Compare the joined letters with `ans`:
   - equal → `solvedQs += qi`, then **sweep**; set `justLocked` for the flash; if `solvedQs.length >= questions.length` → finish after 750 ms; else after 500 ms advance to the first unlocked question with index `> qi`, wrapping to the first unlocked overall.
   - not equal → `error = true` (banner shake, error cell styling). Nothing is cleared until the next keypress.
5. **Sweep** (`lockAndSweep`, L113-125): repeat until no change — any unlocked question whose cells are *all* fixed becomes locked. Consequence verified by `verify.mjs`: in a 5×5 word square, locking the 5 across words locks all 5 down words (typed words to finish = 5); in `cross1` locking all across words sweeps nothing (every down word has a cell in no across word), so up to 10 words must be typed. A swept word is never checked letter-by-letter — correctness follows from the crossing words being correct.
6. **Backspace** (L176-182): clears the *last* non-fixed, non-empty cell of the active word and clears `error`.
7. **Cell tap** (L389-394): candidates = unlocked questions containing the cell; cycle to the next one after the current `qIndex` (wraps). Locked-only cells do nothing.
8. **Prev/Next** (L521-522): `qIndex ± 1 mod n` including locked questions; clears `error`.
9. **Finish** (`finish`, L127-141): stop timer; `earned = floor(secLeft/5)`; `tokens += earned`; `stars += 10 + (usedHints ? 0 : 2)`; `todaySolved = true`; append to `completedIds` if absent; `solveTime = par - secLeft`. **Replays earn again** in the prototype (no first-solve check).
10. **Letters** are the uppercase QWERTY set `A–Z` only (L399-402); no digits, no diacritics — an issue for `uk`/`ru` puzzles (see F14).

Server verification needs: `grid`, `sol`, the clue tuples, the ordered question list, the solve's `solvedQs`, and the submitted word per question. Verification is deterministic — no client-side randomness affects correctness.

### F6. Hints (PROTO L527-555; README L227-230)

| hint | cost | behaviour |
|---|---|---|
| 50/50 (`hintFifty`) | 20 | If a 50/50 is already showing, ignore. Debit first (`spendTokens`, sets `usedHints`). Pick one decoy of the same length from `DECOYS` (excluding the answer), present `[answer, decoy]` in random order. Picking the answer fills all cells and calls `tryLock` (locks, sweeps, may finish); picking the decoy just closes the sheet. Tokens are spent either way. |
| Reveal one letter (`hintLetter`) | 40 | If in error state, clear non-fixed cells first (locally). Find the first cell index `i` where `filled[cell] !== ans[i]` (empty *or* wrong). If none, do nothing (no charge). Debit, write `ans[i]` into that cell, `tryLock`. A revealed letter is *not* fixed until its word locks (it can be backspaced). |
| Solve this word (`hintWord`) | 100 | Debit, write the whole answer, `tryLock`. |
| Autocheck (`hintCheck`) | free | Toggle; while on, any typed non-fixed letter that differs from `sol[r][c]` renders in error colour (L380). Does not set `usedHints`, does not touch the star bonus. |

Footnote copy: "Hints pause your no-hint ⭐ bonus for this puzzle" (README L230). Insufficient balance → navigate to Wallet with the sheet closed, no debit (L194).

### F7. Timer, tokens, stars, streak

- The countdown only runs on the Play screen; leaving to the Puzzle page and coming back **resumes** with the same `secLeft` (L92, L104-106). Nothing tracks wall-clock time, so a player can pause indefinitely. At 0 the timer stops and the solve can still be completed for 0 tokens ("over par").
- `solveTime = par - secLeft` never exceeds par, so a 12-minute solve shows as "5:00 · over par" (L139, L557). The leaderboard ("Top solvers today", README L209-210) needs real elapsed time.
- Stars: +10 per solve, +2 when `usedHints` is false. The Solved screen lists "⭐ Solve +10", "⭐ No hints used +2" (conditional), "🪙 Time bonus — {secLeft}s left ÷ 5" (README L235-236; PROTO L559).
- Streak: only `baseStreak`, `todaySolved` exist. Any finish (including archive puzzles and replays) flips `todaySolved`. Stories and the 7-day strip are static (L262-270, L423-432). The streak-at-risk card text "9h 14m left today" is a literal (L310); the real value is time until the user's local midnight.

### F8. Fortune wheel

- One card at feed position 4 (`wheel#base`) plus one per even pagination batch (`wheel#0`, `wheel#2`, …) (L321-323). Each key spins once; the prize is credited to `tokens` 3.4 s after the spin starts (L191). The "So close — try tomorrow" copy (L508) implies a daily cadence that the prototype does not enforce — a single feed session can offer six spins.
- Segment `i` is chosen uniformly (`floor(random()*6)`), so expected value = 17.5 tokens per spin.

### F9. Feed composition (exact, PROTO L309-326)

```
[0] puzzle_post mini1  feedIndex 0  ago "2m ago"   (the daily; live counters)
[1] streak_save                                     only if !todaySolved
[2] puzzle_post cross1 feedIndex 1  ago "28m ago"
[3] wheel      "wheel#base"
[4] puzzle_post mini2  feedIndex 2  ago "1h ago"
for b in 0 .. feedExtra-1 (feedExtra ≤ 10):
    b even → wheel "wheel#b"      b odd → mystery
    puzzle_post ORDER[(b+3)%4] feedIndex 2b+3 kicker "FROM THE ARCHIVE · AUG {30-b}"
    puzzle_post ORDER[(b+1)%4] feedIndex 2b+4 kicker "FROM THE ARCHIVE · AUG {29-b}"
```

- `AGO = ["2m ago","28m ago","1h ago","3h ago","yesterday","2d ago","3d ago","4d ago"]` indexed by `feedIndex % 8` (L284, L293).
- Cover: kicker, tiles from `themeWord`/`reveal`, the cover clue = `across[coverClueIndex][1]` in quotes, clue meta "{n}-Across of 10 clues", CTA "Solve ▸" or "Review ▸" when completed (L296-298).
- Action bar: like toggle (optimistic, count +1), save toggle (icon only), live meta (L302-306; README L168-170).
- Cover tile colour rules per `coverBg` (L277-281) — presentation, derive client-side from `coverTheme`.
- `mini3` never appears in the base feed; only via archive batches / mystery / collections.
- Puzzle page "Top solvers today" (wordwasp 0:58, klara.m 1:12, setter_dan 1:26) is literal HTML (README L209-210; confirmed by grep of the prototype HTML).

### F10. Collections, progress, lock rule

- `colProgress(c)` (L69-72): `done = pz.filter((id, i) => completed.includes(id) && i < 3 && id !== "mini3").length`, `pct = round(100*done/total)`. This is a demo hack: it prevents one solve from ticking every repeated slot and keeps `mini3` from completing collections. The row list applies the same rule and appends a numeric suffix to repeated titles from slot 4 on (L469-470).
- Real rule: a collection's members are distinct puzzle ids; `done = |members ∩ completedPuzzleIds|`; complete when `done === total`; completing grants `reward` tokens once and unlocks dependants.
- Lock rule: only `food` is locked, with the literal meta "Finish Travel to unlock" (L59, L454). Model it as data: `unlock: { kind: "collection_complete", collectionId: "travel" }`.
- Browse "Continue solving" (L442-447): if there is an in-progress solve with ≥1 locked word, show `title`, `solved/total`, pct; otherwise the literal fallback "Weekend Grid · 4 / 10 · 40%". Resume calls `openPlay(pid)`.
- Legacy: `searchChips`, `searchTiles`, `trending` (L328-343, L441) belong to the replaced keyword-search screen (README L181) and are not needed.

### F11. Puzzle page, Solved screen, Profile, Wallet

- Puzzle page (L514-519; README L207-210): cover, "Mini · 5×5 · ~2 min · by {author}", stat cards Difficulty / "Par · 🪙 per 5s left" (`m:ss`) / Clues (10), top solvers, CTA "Play" or "Play again".
- Solved (L557-566; README L233-238): headline, "{title} · m:ss · under|over par", earnings card, streak card "🔥 {streak}-day streak" + 7-day strip (literal Tue..Mon, Fri missed, Mon today), "Next puzzle ▸" → Puzzle page of `ORDER[(i+1)%4]`, "Back to feed".
- Profile (L345-350, L513; README L200-204): name, since, three balances, Solved / Best time / This week, language chips (switch `lang`), "Completed" = first 4 of `completedIds` (placeholder `mini1` when empty), rows Wallet / Achievements (12 / 30) / Remove ads.
- Wallet (L434-437; README L241-244): balances, explainer copy, packs, hint-cost reference (20 / 40 / 100).

### F12. Onboarding funnel and plans

Linear: welcome → quizLevel → quizTopics → quizLang → planReady → notifs → paywall → feed; "Skip all" jumps to feed from any step (README L253-256; PROTO L490-493). Plan Ready shows Level / Topics / Language summary (L497-498). Notifications pre-prompt outcome is not persisted. The paywall selection (`plan`) is stored but has no effect (ads are not modelled).

### F13. State map (README L290-306) → ownership

| README state | owner in the real system |
|---|---|
| `screen`, `prevScreen`, `openCol`, `wheelOpen`, `hintsOpen`, `justLocked`, `celebType`, `celebSeed`, `tickerIdx`, `bump`, `feedExtra` | client only |
| `tokens`, `stars`, `baseStreak`, `todaySolved`, `completedIds` | server: User aggregate (wallet + streak + completions) |
| `wheels{}` | server: User aggregate (spin ledger keyed by wheel id) |
| `level`, `topicsSel`, `lang`, `plan` | server: User aggregate (prefs, entitlement) |
| `likes{}`, `saves{}` | server: User aggregate (sets of puzzle ids) + per-puzzle counters |
| `playPz`, `filled`, `solvedQs`, `qIndex`, `secLeft`, `error`, `usedHints`, `autocheck`, `fiftyOpts` | server: Solve aggregate (authoritative), mirrored optimistically on the client; `error`/`qIndex` can stay client-side |
| `tokensEarned`, `noHint`, `solveTime` | server: Solve result |
| `luckyClaims`, `searchExtra`, `curPz` | drop |

README L304-306 lists the data needs verbatim: "puzzle by id (grid, solution, across/down clues), a daily-drop id, per-puzzle social counts, the user's streak/balances/completions, and a collections manifest (name, emoji, shelf, member puzzle ids, reward, lock rule)". The only correction: the *solution* must not be served to the client pre-solve.

### F14. Inconsistencies, fakes and unknowns

1. **Minis reuse across clues as down clues** (L27-28, L43-44, L51-52). Verified: the three minis are symmetric word squares, so the down *words* really are the across words; the repeated clue *text* is a content shortcut. Real minis will usually not be word squares; the format supports it either way. Do not special-case.
2. **`colProgress` hack** (L69-72) and the repeated member ids (L56-67) — prototype-only; replace with distinct member ids and a real count.
3. **Like counts are fake** (`likes + (idx*37) % 400`, L302); **live counters are fake** (`8412 + bump`, L303, L439, L441); **stories are fixed** (L262-270); **streak strip fixed** (L423-432); **profile stats fixed** (L513); **top solvers literal** (README L209-210); **Continue-solving fallback literal** (L442); **streak-at-risk time literal** (L310); **kicker "SEP 1" literal** (L23).
4. **Replays re-earn tokens and stars** (L137-138) and any solve flips `todaySolved` (L138) — needs a policy decision (see Open questions).
5. **Timer has no wall-clock** (L88-94); solve time capped at par (L139) — leaderboard impossible without server time.
6. **Wheel cadence** — "try tomorrow" copy vs. up to six spins per session (L321-323).
7. **50/50 charges even when the decoy is picked** and `DECOYS` is a tiny static pool (L73, L531) — real decoys must come from the puzzle's language word list of matching length and must not equal any other answer in the grid.
8. **Keyboard is Latin A–Z** (L399-402) although `uk`/`ru` puzzles exist (README L116-118) — the grid/sol format must permit Cyrillic; the keyboard layout is per language.
9. **`hintLetter` has a dead `idx` computation** (L539) — harmless, ignore.
10. **Cover shows "five 52px letter tiles"** (README L166) but `cross1.themeWord = "GRID"` is 4 letters (L32) — tile count = themeWord length.
11. **"MONDAY MINI · SEP 1"** — 1 Sep 2026 is a Tuesday; kicker must be generated from the daily date.
12. **`likes{}`/`saves{}` keyed by card instance** (`puzzleId#feedIndex`, L287) so the same puzzle can be liked twice in one feed — real model is per puzzle.
13. **Puzzle JSON directory referenced by the README does not exist locally** (F1).
14. The `plan` selection, notification choice, and "Restore purchases" have no behaviour in the prototype.
15. **Par is computed two ways** (fact-check, PROTO L81-85 vs L355): Play uses `parFor()` (L81-85, doubles the base for 9×9 → 600 s for cross1), while the Puzzle page shows `props.parSeconds ?? pz.par` (L355). With the `parSeconds` design tweak set, the Puzzle page shows the *undoubled* par for cross1 while the Play timer starts from the doubled value. The server must own a single `parSec` per puzzle (C3) and every screen must read it from there.

## Recommendation for Crosscut

### Module boundaries (modular monolith, direct calls)

| module | owns | storage |
|---|---|---|
| `identity` | user creation, display name, onboarding prefs, entitlement (plan) | `User` aggregate (DO) → `user_state` projection |
| `content` | puzzles, setters, collections manifest, daily schedule per language | static JSON bundled in the Worker (v1) + D1 `puzzle`, `collection` tables for querying; solutions never leave the Worker |
| `solving` | Solve lifecycle: start, submit word, hints, autocheck, pause/resume, finish; the only module that reads `sol` — note that in the sketch below the route handler loads `PuzzleContent` (including `sol`/answers) and passes it over RPC into the `Solve` DO on every `submitWord`, so "solutions never leave the Worker" means the Worker *script* (Worker + its DOs), not the gateway module alone; the DO also recomputes `questions()` per commit (cache per puzzle id in the DO if it shows up in profiles) | `Solve` aggregate (DO, id `${userId}:${puzzleId}`) with `flushMode: "background"` → `solve_state` projection (leaderboard + continue-solving read model). **Deviation from CONCEPTS §13**, which records "Flush timing: `await` (read-your-writes)" with `background` as the rejected alternative: choosing `background` here is a deliberate hot-path exception and means `GET /me/continue` and D1 leaderboard reads can lag the last word submit; if that lag is unacceptable, keep `await` and accept the extra D1 write per word |
| `wallet` | tokens & stars balances, grants/debits with reason + idempotency key, packs (mocked purchase) | slice of `User` aggregate state + `wallet_ledger` D1 table (append-only, for audit) |
| `streak` | day keys, `todaySolvedDay`, streak count, 7-day history, time-left-today | slice of `User` aggregate |
| `progress` | completions, collection progress, unlocks, rewards | slice of `User` aggregate |
| `wheel` | wheel instances per user per day, spins | slice of `User` aggregate |
| `social` | likes/saves per user, like/solved/solving-now counters per puzzle | per-user sets in `User`; counters in a `PuzzleStats` aggregate per puzzle → `puzzle_stats` projection |
| `feed` | composes feed pages from projections; stories, ticker, streak-at-risk | read-only over D1 + `User` snapshot |
| `leaderboard` | top solvers per puzzle per day, "passed you" | D1 query over `solve_state` |
| `billing` | plans, token packs, receipts (mocked in v1) | calls `wallet` / `identity` |

Keeping wallet/streak/progress/wheel inside one `User` DO keeps every economy mutation serialized per user (no double-spend, no double-grant) at the cost of one object per user — cheap and consistent with CONCEPTS §3. `Solve` is separate because it is the hot path (one commit per submitted word) and must not contend with the user's other commands.

Cross-module orchestration lives in stateless service functions (or `WorkerEntrypoint`s) called by the Hono routes — per CONCEPTS §3, "no object ever calls another object's commands as a side effect of its own commit". Events are typed payloads passed to consumer functions in-process (see (c)).

### Server-authoritative solving

- Client receives clues without answers plus `questionCount`; it can render everything except correctness.
- `POST /solves/{id}/words` returns `correct`, the new `lockedQuestions` (typed + swept), and the letters of all cells of newly locked words (so the client can show swept words). Latency is one DO round-trip for a non-finishing word; the *finishing* submit is two sequential DO round-trips, because the route also calls `User.applySolved` synchronously (see (c)) before responding with the `SolveResult`.
- **Hints are not atomic across objects** (fact-check): a hint debits tokens in the `User` DO (`wallet.spend`) and then mutates the `Solve` DO — two separate commits with no transaction, and CONCEPTS §3 forbids cross-object side effects inside a commit. A failure between them charges without delivering (or, if ordered the other way, delivers without charging). The gateway route must own this: debit first with an idempotency key derived from `(solveId, questionIndex, kind)`, then apply the hint with the same key so a retry after a partial failure completes rather than double-applies, and on a hard failure of the second step issue a compensating `wallet.refund` with the same key. The idempotency-key note in (c) covers retries only, not this partial-failure case.
- Autocheck: `POST /solves/{id}/check` with the client's current `filled` returns `wrongCells`. Call it on each keypress while autocheck is on (debounced client-side) — simplest and leak-free. Alternative (UNVERIFIED trade-off, not required for v1): send per-cell salted digests so the client checks locally; note a 26-letter alphabet makes digests brute-forceable, so this is obfuscation only.
- Time: server records `startedAt`, keeps `elapsedMs` accumulated across `pause`/`resume` (exit to Puzzle page = pause), and computes `secLeft = max(0, par - floor(elapsed/1000))` at finish. Do not trust a client-supplied `secLeft`. A solve left active is capped at par by wall clock.
- Rewards are granted **once per (user, puzzle)** on first finish; replays return `firstSolve: false` and grant nothing (recommended policy; see Open questions).
- Day boundary for streaks uses the user's IANA time zone captured at onboarding (and updatable), storing `dayKey = YYYY-MM-DD` in that zone.

### (a) Screen → data needs

| screen | reads | writes |
|---|---|---|
| Welcome / Quiz Level / Topics / Language / Plan Ready / Notifs / Paywall | option lists (static), current prefs | `POST /me/onboarding` (once, or per step) ; `POST /billing/plan` |
| Feed | `GET /me` (balances, streak, todaySolved, dayEndsAt), `GET /feed?cursor` (items, stories, ticker, streakAtRisk) | like/save toggles, wheel spin |
| Browse | `GET /collections` (shelves, progress, locks), `GET /me/continue` | — |
| Collection detail | `GET /collections/{id}` (members with done flags, reward, progress) | — |
| Profile | `GET /me/profile` (stats, completed tiles, achievements), `GET /me` | `PATCH /me/prefs` (lang) |
| Puzzle page | `GET /puzzles/{id}` (cover, meta, par, difficulty, questionCount, myStatus), `GET /puzzles/{id}/leaderboard?period=today` | `POST /puzzles/{id}/solves` (Play) |
| Play | `GET /solves/{id}` (grid, clues w/o answers, filled, locked, secLeft, autocheck, balance) | words, hints, check, pause/resume |
| Solved | response of the finishing word submit (result: tokensEarned, stars, noHint, solveTime, underPar, streak, weekStrip, nextPuzzleId) | — |
| Wallet | `GET /wallet` (balances, packs, hint costs, recent ledger) | `POST /wallet/purchases` (mock) |
| Wheel modal | wheel state from feed item | `POST /wheel/{wheelId}/spin` |

### (b) Proposed REST endpoints (Hono + Zod; auth context `{ userId }` injected once)

All responses `application/json`; errors `{ error: { code, message } }`; `DomainError` → 422, `NotInitializedError` → 404, insufficient tokens → 402 `{ code: "INSUFFICIENT_TOKENS", balance, cost }`.

**Identity / onboarding**

- `GET /me` → `{ id, displayName, since, lang, level, topics[], plan, notifications, tz, balances: { tokens, stars }, streak: { count, todaySolved, dayEndsAt }, completedCount }`
- `POST /me/onboarding` body `{ level: "newbie"|"casual"|"shark", topics: string[], lang: "en"|"uk"|"ru", plan: "lite"|"month"|"year", notifications: "enabled"|"declined"|"skipped", tz: string, skippedAt?: "welcome"|"level"|"topics"|"language"|"planReady"|"notifs"|"paywall" }` → `GET /me` shape. Idempotent (re-submission overwrites).
- `PATCH /me/prefs` body partial of the same → `GET /me` shape.

**Feed**

- `GET /feed?cursor=<opaque>&lang=en` → `{ items: FeedItem[], nextCursor: string|null, stories: Story[7], ticker: string[], streakAtRisk: { streak, dayEndsAt, puzzleId }|null, balances }`.
  `FeedItem = { type: "puzzle_post", puzzleId, feedIndex, kicker, publishedAt, cover: { theme, themeWordLength, revealed: [{i, ch}], clue, clueMeta }, title, author: Setter, kind, size, parSec, diff, done, liked, saved, likeCount, solvedCount, solvingNow, cta } | { type: "streak_save", ... } | { type: "wheel", wheelId, canSpin, prize|null } | { type: "mystery", puzzleId }`.
  First page = today's daily(s) for `lang` + streak card + the base composition; subsequent pages = archive posts newest-first interleaved with wheel/mystery cards; `nextCursor = null` after 10 pages or when the archive is exhausted. `Story = { dayKey, weekday, state: "today"|"solved"|"missed"|"future" }`.
- `GET /daily?lang=en` → `{ dayKey, puzzleIds: string[] }`

**Puzzles**

- `GET /puzzles/{id}` → `{ id, lang, kind, size, parSec, diff, title, author: Setter, cover, kicker, questionCount, publishedAt, stats: { likeCount, solvedCount, solvingNow }, me: { done, liked, saved, bestTimeSec|null, inProgressSolveId|null } }`
- `GET /puzzles/{id}/leaderboard?period=today&limit=3` → `{ rows: [{ rank, userId, displayName, solveTimeSec, finishedAt }], me: { rank|null, solveTimeSec|null } }`
- `GET /puzzles/{id}/next` → `{ nextPuzzleId }` (order mini1 → cross1 → mini2 → mini3 in v1; later: next daily/collection member)
- `POST /puzzles/{id}/like` body `{ liked: boolean }` → `{ liked, likeCount }` (idempotent)
- `POST /puzzles/{id}/save` body `{ saved: boolean }` → `{ saved }`
- `GET /me/saved` → `{ puzzleIds }`

**Solving**

- `POST /puzzles/{id}/solves` → `SolveView` (creates or returns the in-progress solve; `Play again` on a completed puzzle sends `{ restart: true }`).
  `SolveView = { solveId, puzzleId, size, parSec, grid: string[], questions: [{ index, dir, num, clue, length, cells }], filled: string[][], locked: number[], fixedLetters: [{ r, c, ch }], qIndex, secLeft, running, usedHints, autocheck, pendingFifty: string[]|null, balances, status: "active"|"finished" }`
- `GET /solves/{solveId}` → `SolveView`
- `POST /solves/{solveId}/words` body `{ questionIndex, word }` → `{ correct, locked: number[], newlyLocked: number[], fixedLetters, nextQuestionIndex, finished, result?: SolveResult }`
  `SolveResult = { solveTimeSec, secLeft, underPar, tokensEarned, starsEarned, noHintBonus, firstSolve, balances, streak: { count, extendedToday, week: [{ dayKey, state }] }, nextPuzzleId, celebration: "coins"|"reels"|"marquee" }`
- `POST /solves/{solveId}/hints/fifty` body `{ questionIndex }` → `{ options: [string, string], balances }` (402 if broke)
- `POST /solves/{solveId}/hints/fifty/pick` body `{ questionIndex, word }` → same shape as `/words` (server knows which option was the answer)
- `POST /solves/{solveId}/hints/letter` body `{ questionIndex, filled?: string[][] }` → `{ cell: [r, c], letter, ...wordsResponse }` — `filled` lets the server pick "first wrong-or-empty cell" the way the prototype does; without it the server uses its own last-known grid. `{ noop: true }` when the word is already correct (no charge).
- `POST /solves/{solveId}/hints/word` body `{ questionIndex }` → `wordsResponse`
- `POST /solves/{solveId}/autocheck` body `{ on: boolean }` → `{ autocheck }`
- `POST /solves/{solveId}/check` body `{ cells: [{ r, c, ch }] }` → `{ wrongCells: [r, c][] }` (only while autocheck is on)
- `POST /solves/{solveId}/pause` / `POST /solves/{solveId}/resume` → `{ secLeft, running }`
- `GET /me/continue` → `{ solveId, puzzleId, title, locked, total, pct }|null`

**Wallet / billing**

- `GET /wallet` → `{ balances, packs: [{ id, tokens, priceCents, currency, badge }], hintCosts: { fifty: 20, letter: 40, word: 100 }, ledger: [{ at, delta, kind: "tokens"|"stars", reason, ref }] }`
- `POST /wallet/purchases` body `{ packId, idempotencyKey, receipt?: string }` → `{ balances, ledgerEntry }` (v1: mocked, no receipt validation; the idempotency key is the client's purchase id)
- `POST /billing/plan` body `{ plan, idempotencyKey }` → `{ plan, adsRemoved, expiresAt|null }` (mock)

**Wheel**

- `GET /wheel` → `{ wheels: [{ wheelId, canSpin, prize|null }] }` (v1 rule: ids `${dayKey}:base` and `${dayKey}:${batch}` mirror the prototype; see Open questions for cadence)
- `POST /wheel/{wheelId}/spin` body `{ idempotencyKey }` → `{ prizeIndex, prize, prizes: [50,10,0,25,5,15], balances }` — server credits immediately; the client animates 3.4 s then shows the balance.

**Collections / profile / leaderboard**

- `GET /collections?lang=en` → `{ shelves: [{ key, title, countLabel, items: [{ id, name, emoji, theme, blurb, total, done, pct, locked, lockLabel, reward }] }] }`
- `GET /collections/{id}` → `{ ...item, members: [{ n, puzzleId, title, meta, diff, done }] }`
- `GET /me/profile` → `{ displayName, since, balances, streak, solvedTotal, bestTimeSec|null, weekCount, achievements: { done, total }, completed: [{ puzzleId, title, themeInitial }], langs }`

### (c) Domain event catalog (direct in-process calls)

`emit(event)` walks a static registry: sync consumers are awaited inside the request (their result may be part of the response), deferred consumers run via `ctx.waitUntil` and are allowed to outlive the response. Two caveats (Cloudflare docs, developers.cloudflare.com/workers/runtime-apis/context/): (1) `waitUntil` work gets at most 30 seconds after the invocation ends, so deferred consumers must be short and must not chain long retries; (2) calling `fn(e, ctx)` inside the `emit` sketch starts the consumer *synchronously* up to its first `await` — it does not strictly "run after the response is sent" — so a deferred consumer must not do heavy synchronous work before its first await or it delays the response. There is no queue: a deferred consumer that throws is logged and lost, so anything money-related is **sync**. Every consumer must be idempotent on `event.id` (`${name}:${aggregateId}:${version}`) because a retried HTTP request re-runs the pipeline.

| event | payload | producer | consumers (mode) |
|---|---|---|---|
| `user.onboarded` | `{ userId, level, topics, lang, plan, notifications, tz }` | identity | streak (set tz, sync); feed (seed personalization, sync); notifications (schedule streak warning, deferred) |
| `prefs.changed` | `{ userId, lang? , topics? }` | identity | feed (deferred) |
| `solve.started` | `{ userId, puzzleId, solveId, startedAt }` | solving | social (`solvingNow++`, deferred) |
| `solve.paused` / `solve.resumed` | `{ solveId, elapsedMs }` | solving | social (`solvingNow--/++`, deferred) |
| `word.locked` | `{ solveId, questionIndex, swept: number[] }` | solving | analytics only (deferred) |
| `hint.used` | `{ userId, solveId, puzzleId, kind: "fifty"\|"letter"\|"word", cost, ledgerRef }` | solving (after `wallet.spend` succeeded) | analytics (deferred) |
| `tokens.spent` | `{ userId, amount, reason, ref, balance }` | wallet | ledger (sync) |
| `puzzle.solved` | `{ userId, puzzleId, solveId, lang, solveTimeSec, secLeft, usedHints, firstSolve, finishedAt, dayKey }` | solving | wallet.grant time bonus (sync, first solve only); stars.grant (sync, first solve only); streak.extend (sync); progress.markCompleted → collections (sync, may emit `collection.completed`); leaderboard.record (deferred); social (`solvedCount++`, `solvingNow--`, deferred); notifications (cancel today's streak warning, deferred) |
| `tokens.granted` | `{ userId, amount, reason: "time_bonus"\|"wheel"\|"pack"\|"collection", ref, balance }` | wallet | ledger (sync) |
| `stars.granted` | `{ userId, amount, reason, ref, balance }` | wallet | ledger (sync) |
| `streak.extended` | `{ userId, count, dayKey }` | streak | ticker/feed (deferred); notifications (deferred) |
| `streak.broken` | `{ userId, previousCount, dayKey }` | streak (lazily on first read of a new day — **not** by a `User` alarm, see note below) | notifications (deferred) |
| `collection.completed` | `{ userId, collectionId, reward }` | progress | wallet.grant (sync); progress.unlockDependants (sync, emits `collection.unlocked`); achievements (deferred) |
| `collection.unlocked` | `{ userId, collectionId }` | progress | feed (deferred) |
| `wheel.spun` | `{ userId, wheelId, prizeIndex, prize }` | wheel | wallet.grant (sync, may be 0) |
| `like.toggled` | `{ userId, puzzleId, liked }` | social | PuzzleStats counter (sync — the response needs the new count); ticker (deferred) |
| `save.toggled` | `{ userId, puzzleId, saved }` | social | — |
| `pack.purchased` | `{ userId, packId, tokens, priceCents, mocked: true, idempotencyKey }` | billing | wallet.grant (sync) |
| `plan.changed` | `{ userId, plan, adsRemoved, expiresAt }` | billing | identity.setEntitlement (sync) |
| `notifications.permission` | `{ userId, granted }` | identity | notifications (deferred) |

Ordering inside `puzzle.solved`: wallet → stars → streak → progress (may cascade to wallet again for a collection reward) → then deferred consumers. Because all four sync consumers mutate the same `User` DO, expose one `User.applySolved(event)` command that performs them atomically in a single commit and returns `{ tokensEarned, starsEarned, streak, completedCollections[] }`; the module functions then emit the derived events from that result. That keeps "one command = one version bump" and makes a replayed `puzzle.solved` a no-op (`solveId` recorded in state).

**Alarm collision (fact-check).** The `Aggregate` base class already owns the Durable Object's only alarm for projection-flush retries: `aggregate.ts` L186-188 `alarm()` calls `flush()`, L248 `setAlarm(...)` schedules the backoff, and L170 `deleteAlarm()` clears it once projected. Per Cloudflare (developers.cloudflare.com/durable-objects/api/alarms/) a DO has exactly one alarm and `setAlarm` overrides any pending one. So a `User` subclass that sets its own alarm for day rollover / streak break (or the subscription-expiry alarm CONCEPTS §5 places on `User`) would cancel a pending flush retry, or have its own alarm deleted by the next successful flush. Options: (a) add a multiplexed scheduler to the base class (state field `timers: { [name]: dueAt }`, base `alarm()` fires every due timer and re-arms to the earliest remaining one, flush retry becomes one named timer); or (b) avoid alarms for day rollover entirely — evaluate `streak.broken` lazily on the first command/read of a new `dayKey` (as the producer column now says) and drive streak-warning pushes from a Cron Trigger that scans `user_state` in D1. This document recommends (b) for v1 and (a) when subscription expiry needs it.

## Code sketches

Pure domain functions (port of PROTO L75-80, L111-125, L143-162), shared by the `Solve` aggregate and tests:

```ts
// packages/shared/src/crossword.ts
export type ClueTuple = [num: number, clue: string, answer: string, row: number, col: number];
export interface PuzzleContent { id: string; size: number; par: number; grid: string[]; sol: string[]; across: ClueTuple[]; down: ClueTuple[] }
export interface Question { index: number; dir: "ACROSS" | "DOWN"; num: number; clue: string; answer: string; cells: [number, number][] }

export function questions(p: PuzzleContent): Question[] {
  const mk = (dir: Question["dir"]) => (c: ClueTuple): Omit<Question, "index"> => ({
    dir, num: c[0], clue: c[1], answer: c[2],
    cells: [...c[2]].map((_, i) => (dir === "ACROSS" ? [c[3], c[4] + i] : [c[3] + i, c[4]])),
  });
  return [...p.across.map(mk("ACROSS")), ...p.down.map(mk("DOWN"))].map((q, index) => ({ ...q, index }));
}

export const isFixed = (qs: Question[], locked: Set<number>, r: number, c: number) =>
  qs.some((q) => locked.has(q.index) && q.cells.some(([qr, qc]) => qr === r && qc === c));

/** Lock any question whose cells are all covered by locked questions; repeat to a fixpoint. */
export function sweep(qs: Question[], locked: Set<number>): number[] {
  const swept: number[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const q of qs) {
      if (locked.has(q.index)) continue;
      if (q.cells.every(([r, c]) => isFixed(qs, locked, r, c))) { locked.add(q.index); swept.push(q.index); changed = true; }
    }
  }
  return swept;
}

export const timeBonus = (secLeft: number) => Math.floor(secLeft / 5);
export const starsFor = (usedHints: boolean) => 10 + (usedHints ? 0 : 2);
export const HINT_COST = { fifty: 20, letter: 40, word: 100 } as const;
export const WHEEL_PRIZES = [50, 10, 0, 25, 5, 15] as const;
```

Zod for the wire format (answers stripped):

```ts
import { z } from "zod";
// Answer alphabet: uppercase letters of en/uk/ru. NOTE (fact-check, zod 4.5.4): the earlier regex /^[A-ZА-ЯЇІЄҐ]+$/u
// rejected Ё (U+0401 — the А–Я range is U+0410–U+042F) so any Russian answer containing Ё failed
// (`safeParse([1,'clue','ЁЖ',0,0]).success === false`), and it rejected the Ukrainian apostrophe used inside words.
// Ё is now included; the apostrophe is a content decision (see Open questions 8) — add `'` / `’` to the class if kept.
export const ANSWER_RE = /^[A-ZА-ЯЁЇІЄҐ]+$/u;             // alternative: /^\p{Lu}+$/u (any uppercase letter, all scripts)
export const ClueTupleSchema = z.tuple([z.number().int().min(1), z.string().min(1), z.string().regex(ANSWER_RE), z.number().int().min(0), z.number().int().min(0)]);
export const PuzzleContentSchema = z.object({
  id: z.string(), lang: z.enum(["en", "uk", "ru"]), kind: z.enum(["mini", "crossword"]),
  size: z.union([z.literal(5), z.literal(9)]), par: z.union([z.literal(300), z.literal(600)]),
  grid: z.array(z.string().regex(/^[.#]+$/)), sol: z.array(z.string()),
  across: z.array(ClueTupleSchema), down: z.array(ClueTupleSchema),
}).refine((p) => p.grid.length === p.size && p.grid.every((r) => r.length === p.size), "grid must be size×size");

export const SubmitWordSchema = z.object({ questionIndex: z.number().int().min(0), word: z.string().min(1).max(15).toUpperCase() });
```

`Solve` aggregate command (on top of `packages/core` `Aggregate`):

```ts
export interface SolveState {
  userId: string; puzzleId: string; status: "active" | "finished";
  filled: string[][]; locked: number[]; usedHints: boolean; autocheck: boolean;
  startedAt: number; elapsedMs: number; runningSince: number | null; pendingFifty: string[] | null;
  result: null | { solveTimeSec: number; secLeft: number; tokensEarned: number; starsEarned: number };
}

export class Solve extends Aggregate<SolveState, Env> {
  readonly kind = "solve";
  protected flushMode: FlushMode = "background";           // hot path; leaderboard reads are eventually consistent.
                                                            // Deliberate deviation from CONCEPTS §13 ("await, read-your-writes") — see module table.
  protected initial(id: string): SolveState { /* id = `${userId}:${puzzleId}`; filled from grid */ }

  submitWord(content: PuzzleContent, questionIndex: number, word: string) {
    return this.commit((s) => {
      if (s.status !== "active") throw new DomainError("solve finished");
      const qs = questions(content), q = qs[questionIndex];
      if (!q) throw new DomainError("bad question");
      const locked = new Set(s.locked);
      if (locked.has(q.index)) return s;                     // no-op commit
      // Wrong guess: return `s` UNCHANGED. (Fact-check: an earlier sketch returned `{ ...s, lastError: q.index }`,
      // which does not type-check — `lastError` is not a SolveState field — and, because the returned state differed,
      // bumped `version` and triggered a projection flush on every wrong guess (aggregate.ts L221-234 treats only an
      // equal JSON snapshot as a no-op), defeating the hot-path intent.) The error is signalled to the caller via the
      // command's return value; the route maps it to `{ correct: false }` without a DomainError so the HTTP status stays 200.
      if (word !== q.answer) { return s; }                   // no-op commit, no version bump, no flush
      q.cells.forEach(([r, c], i) => { s.filled[r][c] = q.answer[i]; });
      locked.add(q.index); sweep(qs, locked);
      s.locked = [...locked];
      if (s.locked.length === qs.length) {
        const elapsed = s.elapsedMs + (s.runningSince ? Date.now() - s.runningSince : 0);
        const secLeft = Math.max(0, content.par - Math.floor(elapsed / 1000));
        s.status = "finished"; s.runningSince = null; s.elapsedMs = elapsed;
        s.result = { solveTimeSec: Math.floor(elapsed / 1000), secLeft, tokensEarned: timeBonus(secLeft), starsEarned: starsFor(s.usedHints) };
      }
      return s;
    });
  }
}
```

Direct-call event dispatch (no queue):

```ts
type Handlers = { [K in keyof Events]?: { sync?: Array<(e: Events[K], ctx: Ctx) => Promise<void>>; deferred?: Array<(e: Events[K], ctx: Ctx) => Promise<void>> } };
export async function emit<K extends keyof Events>(name: K, e: Events[K], ctx: Ctx) {
  const h = registry[name] ?? {};
  for (const fn of h.sync ?? []) await fn(e, ctx);                       // awaited; failures fail the request
  for (const fn of h.deferred ?? []) ctx.executionCtx.waitUntil(fn(e, ctx).catch((err) => console.error(name, err)));
}
// route: finishing word → emit("puzzle.solved", {...}) → sync: user.applySolved(); deferred: leaderboard, social, notifications
```

Note on `submitWord`'s return value: `commit` returns the new state, so the route derives `correct` by comparing `locked` before/after (or the command returns `{ state, correct }` via a thin wrapper). Either way a wrong guess must not produce a state change.

### Stack versions (checked 2026-09-02; this document pins nothing — CORE says "wrangler 4.127")

| package | latest | notes |
|---|---|---|
| `zod` | 4.5.4 | `.toUpperCase()`, `z.tuple([...])`, and `.refine(fn, "message")` shorthand used above all verified working on 4.5.4 |
| `hono` | 4.13.5 | |
| `@hono/zod-validator` | 0.9.1 | peers: `zod ^3.25.0 || ^4.0.0`, `hono >=4.11.2` |
| `wrangler` | 4.128.0 | |
| `@cloudflare/vitest-pool-workers` | 0.22.0 | peer `vitest ^4.1.0` |

`enable_ctx_exports` is default-on from compatibility date 2025-11-17, so listing it explicitly next to `compatibility_date = "2026-08-27"` is redundant but harmless.

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | Puzzle content is `grid`/`sol` string rows with `'#'` blocks and `'.'` cells, and clue tuples `[num, clue, answer, row, col]` in `across[]`/`down[]`; across cells run `[row, col+i]`, down `[row+i, col]`. | PROTO L25-28, L33-36, L75-80 | high | confirmed |
| C2 | All four prototype puzzles have exactly 10 questions (5 across + 5 down); the UI hard-codes "of 10 clues" and `pzClueCount: 10`. | PROTO L27-28, L297, L517; verify.mjs output | high | confirmed |
| C3 | Par is 300 s for 5×5 and 600 s for 9×9 (`size > 5 ? base*2 : base`). | PROTO L22, L30, L81-85; README L265 | high | confirmed |
| C4 | Tokens earned on finish = `floor(secLeft/5)`; stars = `10 + (usedHints ? 0 : 2)`. | PROTO L129, L137; README L266-267 | high | confirmed |
| C5 | Hint costs: 50/50 = 20, reveal letter = 40, solve word = 100; autocheck is free and does not set `usedHints`; insufficient tokens routes to Wallet without charging. | PROTO L193-196, L530, L542, L549, L555; README L228-230 | high | confirmed |
| C6 | Wheel prizes are `[50, 10, 0, 25, 5, 15]`, segment chosen uniformly, one spin per wheel key, credited 3.4 s after spin start. | PROTO L183-192; README L272-274 | high | confirmed |
| C7 | A word locks when fully typed and equal to the answer; then any question whose cells are all covered by locked questions locks recursively (sweep); finish when all questions are locked. | PROTO L111-125, L143-162; README L259-263 | high | confirmed |
| C8 | The three minis are perfect word squares (down words equal across words), so their down clues duplicate the across clue text; cross1 is not, and no word is swept when only its across words are locked. | verify.mjs output over PROTO L26-28, L33-36, L42-44, L50-52 | high | confirmed |
| C9 | Feed composition is: daily mini1, streak-save (if today unsolved), cross1, wheel#base, mini2, then up to 10 batches of `{wheel (even b) | mystery (odd b)} + 2 archive posts` triggered within 500 px of the bottom. | PROTO L309-326, L511 | high | confirmed |
| C10 | Token packs are 120/$0.99, 550/$3.99 "Popular", 1,400/$8.99 "Best value"; plans are lite/free, month/$3.99, year/$23.99 with default `year`; purchase in the prototype adds tokens immediately. | PROTO L254-259, L434-437; README L136-139, L243-244 | high | confirmed |
| C11 | Collection progress uses the hack `completed && i < 3 && id !== "mini3"`; only `food` is locked with the literal "Finish Travel to unlock"; rewards range 60–250 and are never granted by the prototype. | PROTO L55-72, L454-456 | high | confirmed |
| C12 | Like counts, live counters, stories, streak strip, profile stats, top solvers, "Continue solving" fallback and "9h 14m left" are fake or literal. | PROTO L262-270, L302-303, L310, L423-432, L442, L513; README L209-210 | high | confirmed |
| C13 | The shown streak is `baseStreak + (todaySolved ? 1 : 0)` and any finish (any puzzle, including replays) sets `todaySolved` and re-grants tokens/stars. | PROTO L127-141, L234 | high | confirmed |
| C14 | The timer counts only on the Play screen with no wall clock; solve time is capped at par (`par - secLeft`). | PROTO L88-94, L139, L557 | high | confirmed |
| C15 | The puzzle JSON directory the README cites (`workers/gateway/src/puzzles/{en,ru,uk}/`) does not exist locally; the inline `PUZZLES` map is the only content available. | README L20-23; `ls`/`find` on both project roots | high | confirmed |
| C16 | Onboarding options: level newbie/casual/shark (default casual), topics 8 chips (default Travel+Words), language en/uk/ru (default en); "Skip all" keeps defaults. | PROTO L6-7, L238-253; README L104-118 | high | confirmed |
| C17 | Architecture constraint: no aggregate calls another aggregate's commands as a side effect of its commit; cross-entity workflows are orchestrated from Worker code by direct calls, no queue/pub-sub. | CONCEPTS §2 "One backend, no events", §3 "Cross-entity workflows"; task brief | high | confirmed |
| C18 | Per-word server verification and once-only rewards are design recommendations, not prototype behaviour. | this document §Recommendation | medium | confirmed |

## Open questions

1. **Reward policy on replays.** Prototype re-grants tokens/stars on every finish (C13). Recommended: first solve only; leaderboard records best time per user per puzzle. Needs product sign-off.
2. **What extends the streak?** Prototype: any finish. README copy ("One Mini keeps it alive", "streak counts across all of them") suggests any puzzle in any language counts. Confirm whether archive/replay solves count.
3. **Wheel cadence.** "Try tomorrow" vs. up to six spins per feed session. Proposal: one `base` wheel per user per day plus at most N (e.g. 2) archive-batch wheels per day; needs a decision.
4. **Time zone source** for `dayKey` and "time left today": device tz sent at onboarding and refreshed on app start, or a fixed zone per language?
5. **Solution exposure.** The design assumes client-side checking; the server-authoritative variant adds one round-trip per word. Accept latency, or ship salted digests (obfuscation only)? Also: should completed puzzles return the full solution for "Review"?
6. **Timer semantics when the app is backgrounded** — pause automatically (client sends `/pause` on background) or keep counting?
7. **50/50 decoys** — source of same-length decoy words per language (needs a word list; the prototype's `DECOYS` pool is five words).
8. **Cyrillic puzzles** — letter set, keyboard layout, and `sol` encoding for `uk`/`ru`; the prototype keyboard is Latin only.
9. **Daily drop schedule** — one puzzle per day per language, or a mini on weekdays and a 9×9 on weekends as the "casual" copy implies? Does `level` change which daily a user sees?
10. **Social counts** — real counters from day one (per-puzzle `PuzzleStats`) or seeded/fuzzed values as in the prototype? "solving now" requires pause/resume events to be reliable.
11. **Achievements (12 / 30)** and **badges** for completed collections are named but undefined.
12. **Billing** — v1 mocks purchases; when RevenueCat/Stripe arrive, the `pack.purchased`/`plan.changed` producers move to webhook routes (CONCEPTS §5). Who validates receipts in v1 (nobody)?
13. **Content ids** — adopt `en-mini-1` style ids from the missing repo JSON, or keep `mini1`? The real JSON files must be located or regenerated. Note the README itself mixes `en-mini-1` and `cross-en-1` (README L22), so a single scheme is a decision to make, not one to inherit.

## Fact-check log

Fact-check run 2026-09-02 against the local sources (README, PROTO, CONCEPTS, CORE, `aggregate.ts`), `wc -l`, a zod 4.5.4 run, npm registry versions, and Cloudflare docs. No claim was refuted and none was unverifiable; all 18 are confirmed. The extra findings below were applied inline (search for "fact-check").

| id | verdict | source |
|---|---|---|
| C1 | confirmed | PROTO L25-28, L33-36, L75-80 |
| C2 | confirmed | PROTO L27-28, L297, L517; verify.mjs |
| C3 | confirmed | PROTO L22, L30, L81-85; README L265 |
| C4 | confirmed | PROTO L129, L137; README L266-267 |
| C5 | confirmed | PROTO L193-196, L530, L542, L549, L555; README L228-230 |
| C6 | confirmed | PROTO L183-192; README L272-274 |
| C7 | confirmed | PROTO L111-125, L143-162; README L259-263 |
| C8 | confirmed | verify.mjs over PROTO L26-28, L33-36, L42-44, L50-52 |
| C9 | confirmed | PROTO L309-326, L511 |
| C10 | confirmed | PROTO L254-259, L434-437; README L136-139, L243-244 |
| C11 | confirmed | PROTO L55-72, L454-456 |
| C12 | confirmed | PROTO L262-270, L302-303, L310, L423-432, L442, L513; README L209-210 |
| C13 | confirmed | PROTO L127-141, L234 |
| C14 | confirmed | PROTO L88-94, L139, L557 |
| C15 | confirmed | README L20-23; `ls`/`find` on both project roots |
| C16 | confirmed | PROTO L6-7, L238-253; README L104-118 |
| C17 | confirmed | CONCEPTS §2, §3 |
| C18 | confirmed | this document §Recommendation |

Extra findings applied:

1. DO alarm collision between `Aggregate` flush retries (`aggregate.ts` L170, L186-188, L248) and any `User` streak/subscription alarm — Cloudflare alarms docs (one alarm per DO, `setAlarm` overrides). Fixed in (c): producer column and new "Alarm collision" note.
2. `ClueTupleSchema` regex excluded Ё (U+0401) and the Ukrainian apostrophe — verified with zod 4.5.4. Fixed in the Zod sketch (`ANSWER_RE`).
3. `Solve.submitWord` returned `{ ...s, lastError }` (not a `SolveState` field; caused a version bump + flush per wrong guess, `aggregate.ts` L221-234). Fixed to return `s` unchanged.
4. Hints span two DOs (`User` debit, then `Solve` mutate) with no transaction; CONCEPTS §3. Added compensation/idempotency guidance under "Server-authoritative solving".
5. Sketch ships `PuzzleContent` incl. `sol` into the `Solve` DO per call and recomputes `questions()` per commit. Clarified in the module table.
6. `ctx.waitUntil` 30-second limit and synchronous-until-first-await behaviour (Cloudflare context docs). Clarified in (c).
7. Par computed by `parFor()` (PROTO L81-85) in Play but `props.parSeconds ?? pz.par` (L355) on the Puzzle page. Added as F14 item 15.
8. `flushMode: "background"` deviates from CONCEPTS §13 ("await, read-your-writes"). Acknowledged in the module table and the code comment.
9. Content-id scheme: README L22 mixes `en-mini-1` and `cross-en-1`. Noted in F1 and Open question 13.
10. Finishing-word latency is two DO round-trips (`Solve` + `User.applySolved`), not one. Fixed under "Server-authoritative solving".
11. Line counts: README 326 (was 327), prototype-logic.js 570 (was 571); line references verified. Fixed in the source list.
12. Stack versions as of 2026-09-02 (zod 4.5.4, hono 4.13.5, wrangler 4.128.0, @cloudflare/vitest-pool-workers 0.22.0, @hono/zod-validator 0.9.1; `enable_ctx_exports` default-on since 2025-11-17). Added as "Stack versions" subsection.
