# Handoff: Crosscut — crossword app with an Instagram-like feed

## Overview
Crosscut is a daily-crossword mobile app whose home surface is a scrolling social-style
feed instead of a puzzle list. The design covers the whole first-run and daily loop:
onboarding funnel → feed → puzzle detail → playable grid → solved/reward → collections
browse → profile → wallet → paywall. It layers a light game economy (🪙 tokens, ⭐ stars,
🔥 streak) and casino-flavoured reward moments (fortune wheel, three randomised win
animations) on top of real crossword gameplay.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing
intended look and behaviour, not production code to copy directly. The task is to
**recreate these designs in the target codebase's existing environment** using its
established patterns and libraries.

The target codebase in this project is the Expo app at `apps/app` (Expo Router,
React Native, TanStack Query, `src/theme.ts` palette tokens). The prototype's screens map
onto that router structure: `app/index.tsx` (feed), `app/play/[id].tsx` (play),
`src/components/Grid.tsx`, `src/components/QuestionBanner.tsx`. Puzzle data already exists
as JSON in `workers/gateway/src/puzzles/{en,ru,uk}/` and the prototype uses the real
`en-mini-1`, `en-mini-2`, `en-mini-3` and `cross-en-1` payloads — no new data format is
needed.

Note the existing `src/theme.ts` is the older "Night Gold" palette. This design replaces it
with the palette in **Design Tokens** below; update the theme file rather than hard-coding
values per screen.

## Fidelity
**High-fidelity.** Final colours, typography, spacing, radii, shadows, copy and interaction
behaviour. Recreate pixel-accurately using the codebase's own component patterns. Frame is
390 × 844 (iPhone 14/15 logical size); all values below are in logical px = React Native
density-independent units.

## Design Tokens

### Colour
| Token | Hex | Use |
|---|---|---|
| `ink` | `#16130B` | Text, all borders, hard shadows, dark card covers |
| `ink-tile` | `#2b2618` | Unrevealed letter tile on ink cover |
| `paper` | `#EFE9DB` | Screen background; light text on ink |
| `card` | `#F6F1E4` | Card / chip / key surfaces |
| `tray` | `#E4DECF` | Keyboard tray background |
| `accent` | `#C93081` | Primary accent (magenta) — CTAs, active word, progress |
| `accent-tint` | `#EEDCE6` | Active-word cell fill |
| `error` | `#E5484D` | Wrong-answer text |
| `error-tint` | `#EBD9D8` | Wrong-answer cell fill |
| `success` | `#2FA34F` | Locked/solved cell, completed check |
| `gold` | `#DFA94C` | Streak, stars, wheel, secondary reward accents |
| `desk` | `#E2DDD1` | Canvas behind the device frame (prototype only) |

Palette is deliberately dimmed from pure white/hot pink to reduce eye strain in long
sessions — do not substitute `#fff` or `#E02D8D`.

Rule: a card with an ink (`#16130B`) surface casts an **accent-coloured** hard shadow
(`5px 5px 0 #C93081`); all other cards cast `5px 5px 0 #16130B`.

### Typography
Single family: **Chivo** (Google Fonts, weights 400–900). Sizes/weights actually used:

| Role | Spec |
|---|---|
| Wordmark | 900 26 / -0.5 letter-spacing |
| Screen title | 800 26–28 / 1.15–1.2 |
| Solved headline | 900 34 / -0.5 |
| Card clue (cover) | 800 20 / 1.25 |
| Section header | 800 12, uppercase, 1.5 letter-spacing, `ink` @ 50% |
| Kicker (on cover) | 800 10, uppercase, 2 letter-spacing |
| Card title / author | 800 13 |
| Body | 400 14–15 / 1.5 |
| Meta / caption | 500–600 11–12 |
| Letter tile (feed cover) | 900 26 |
| Letter tile (5×5 play) | 900 26 · (9×9 play) 900 16 |
| Keyboard key | 800 15 |
| Numeric stat | 900 24–28 |

### Geometry
- Radii: pill `999`, card `20`, inner card `14–16`, tile (feed) `10`, tile (5×5) `10`,
  tile (9×9) `7`, key `8`, badge `6`.
- Borders: `2px solid #16130B` almost everywhere; `1.5px` for hairline dividers;
  `3px` for the active-cell ring and `2px dashed` for missed/empty states.
- Shadows: hard offsets only — `5px 5px 0` (cards), `4px 4px 0` (buttons, collection
  cards), `3px 3px 0` (small tiles). No blur anywhere.
- Screen padding: 18px horizontal for feed/browse/profile, 26px for funnel screens.
- Card gap: 18px vertical. Grid gap: 12px.
- Min hit target 44px (keyboard keys are 44 tall; nav circles 36 + padding).

## Screens / Views

### 1. Welcome
Purpose: first impression, entry to funnel.
Layout: 26px padding, content vertically centred, actions pinned bottom.
- Word-square logo: two rows of 56×56 tiles, 7px gap, radius 12, spelling CROSS / CUT.
  Row 1 all `ink` with `paper` letters except index 2 (`accent`, white letter). Row 2 three
  `card` tiles with 2px ink border, then a 44px `accent` period.
- Headline 800 30/1.15: "A crossword a day,\ndressed like a feed."
- Body 400 15/1.5 @60%: "Scroll puzzles like posts. Solve one clue at a time. Keep the
  streak alive."
- Primary pill button: `accent` fill, 2px ink border, `4px 4px 0` ink shadow, 16px vertical
  padding, 800 16 white label "Get started". Active state translates 2px and halves shadow.
- Text link "Skip all" 600 13 @50% → jumps straight to Feed.

### 2–4. Quiz: Level / Topics / Language
Purpose: personalise difficulty, themes, puzzle language.
Layout: 3-segment progress bar at top (5px tall, 6px gap, filled segments `accent`,
unfilled ink @15%), title, subtitle, options, spacer, Continue + Skip all.
- **Level** (single select): three 16px-padded rows, radius 16, 2px ink border. Selected =
  `accent-tint` fill + `4px 4px 0 accent` shadow + `accent` 44×44 initial tile + filled
  radio. Options: `N` First timer / "Gentle Minis, generous hints"; `C` Casual solver /
  "Minis on weekdays, a grid on weekends"; `S` Word shark / "Straight to the tricky stuff".
- **Topics** (multi select): wrapping pill chips, 10px gap, 10/18 padding, 700 14.
  Unselected `card` on ink border; selected ink fill with `paper` label. Options: Travel,
  Movies, Food, Science, Music, Sport, Art, Words. Defaults: Travel + Words.
- **Language** (single select): same row pattern as Level, 44×44 code tile.
  `EN` English / "365 puzzles a year"; `УК` Українська / "Куратор — київська редакція";
  `РУ` Русский / "Ежедневные мини". Subtitle: "Puzzles are written per language, never
  translated. Your streak counts across all of them."

### 5. Plan Ready
72×72 `accent` check tile (radius 16, ink border, 4px shadow) with a 0.5s pop-in; headline
"Your plan is ready."; summary card (`card`, radius 20, 5px shadow) with three
label/value rows (Level, Topics, Language) split by 1.5px ink @10% rules; closing body copy.
CTA "Show my feed".

### 6. Notifications pre-prompt
Three explanation rows (`card`, radius 14, ink border, emoji + 600 13/1.35 copy) covering
streak warning, daily-drop ping, rival overtake. Below them a **simulated iOS permission
sheet** on ink @6% fill, radius 16, with Don't Allow / Allow chips — labelled as the
one-time system ask that only fires on Enable. Buttons: "Enable notifications" (primary),
"Not now" (text link). Both continue to Paywall.

### 7. Paywall
Kicker "REMOVE ADS" in `accent`; headline "Just you and\nthe grid."; subtitle "Lite is free
forever. Paid plans only remove ads."
Three selectable plan rows (same select pattern as Level, plus right-aligned price 800 16
and a radio): Lite — with ads / Free forever / **Free**; No ads for a month / Billed
monthly / **$3.99**; No ads for a year / $2.00 per month / **$23.99** with an `accent`
"2 MONTHS FREE" badge (800 9 uppercase, radius 5). Default selection: year.
CTA label is derived from selection ("Continue with Lite — free" / "Remove ads — $3.99 /
month" / "Remove ads — $23.99 / year"). Footnote "Cancel anytime · Restore purchases".

### 8. Feed (home)
Purpose: the daily loop — see today's drop, solve, keep the streak.
Layout, top to bottom:
1. **Header** (flex, 18px padding): wordmark "Crosscut" + `accent` period; three pill
   balance chips (`card`, 2px ink border, 800 12): `🔥 {streak}`, `🪙 {tokens}`,
   `⭐ {stars}`. Token and star chips open Wallet.
2. **Stories row** — horizontal scroll, 14px gap. Each item = 58px circle + 600 10 caption.
   Today: 3px `accent` ring, `card` fill, "MON" label, caption "Today"; becomes an ink-filled
   ✓ once solved. Solved past days: ink fill, `paper` ✓. Missed: 2px dashed ink @35%, muted
   label, caption "Missed". Six items (Mon…Wed).
3. **Live ticker** — pill (`card`, 2px ink border), 8px `success` dot blinking on a 1.2s
   step loop, 600 11 single-line ellipsised text. Rotates every 3s through six lines
   (fast solve, long streak, live solver count, a like, a leaderboard pass, archive teaser).
4. **Streak-at-risk card** (only while today is unsolved) — ink surface, `accent` shadow,
   flickering 🔥 (1.6s scale+rotate loop), title "{streak}-day streak at risk", sub
   "9h 14m left today. One Mini keeps it alive.", full-width `accent` CTA "Solve today's Mini".
5. **Puzzle post cards** — the core unit:
   - Header strip: 34px circular avatar, author 800 13, meta 500 11 @55%
     ("Mini · 5×5 · 2m ago"), optional 26px `success` ✓ when solved, difficulty badge
     (2px border in the puzzle's difficulty colour, 800 10 uppercase).
   - **Full-bleed cover** (tap → Puzzle page): background per puzzle (`ink`, `accent`, or
     `card`), 26/20 padding, 16px gap. Contains kicker, a row of five 52px letter tiles
     (revealed letters solid, one accent-coloured, unrevealed as muted `?`), the clue in
     800 20/1.25 quotes, then a footer row: clue meta + pill CTA "Solve ▸" / "Review ▸".
     Revealed tiles **flap** — a 4.6s infinite `rotateX(-78°→16°→0)` split-flap tick,
     staggered 0.4s per tile.
   - Action bar: heart (filled `accent` when liked) + count, bookmark + "Save", and
     right-aligned live meta ("8,412 solved · 297 solving now" — the count creeps every 3s).
6. **Fortune wheel card** — compact ink card, `accent` shadow: 🎰 icon rotating on a slow
   loop, "Fortune wheel" / "One free spin waiting", `accent` pill "Spin ▸" that opens the
   wheel modal (see Interactions).
7. **Mystery grid card** — ink cover, `gold` kicker "MYSTERY GRID", five `?` tiles (one
   gold), copy "No title. No difficulty. Dare you." and a gold "Reveal ▸" pill.
8. **Infinite scroll** — two shimmer skeleton blocks (110px and 60px, 1.4s sweep) sit at the
   bottom; nearing them appends another batch (archive posts + alternating wheel/mystery
   cards), up to 10 batches.

### 9. Browse (collections) — replaces a keyword-search screen
Purpose: find puzzles by theme, size, setter or month. **No horizontal scrolling anywhere.**
- Search affordance: pill field, "Search collections, setters…".
- "Continue solving" card: ink surface, gold kicker, title, 5px `accent` progress bar,
  right-side clue fraction, `accent` chevron. Resumes the in-progress puzzle.
- Four shelves, each = section header (800 16 title + 600 11 @50% count) then a **2-column
  grid**, 12px gap:
  - By theme: Travel 🌍, Art & Letters 🎨, Spy Stuff 🕵️, Food 🍜 (locked).
  - By size: Two-minute Minis ⚡, Weekend Grids 🧩.
  - Setters: Théa V. ✍️, Weekend Desk 🗞️.
  - Archive: August–May 2026 📅.
- Collection card: min-height 118, radius 18, 2px ink border, `4px 4px 0` shadow (accent
  when the card is ink), 26px emoji top-left, 🔒 top-right when locked, name 800 15/1.15,
  meta 600 10 @60% ("3 / 8 solved" or "Finish Travel to unlock"), 5px progress track.
- **Collection detail** (same tab, back chevron): hero card with 36px emoji, name 900 26,
  blurb, 7px progress bar + "3 / 8", and a reward line "Finish all for the {name} badge +
  🪙 {reward}". Below, a vertical list of puzzle rows — 40px numbered tile (`success` ✓ when
  done), title, meta ("Mini · 2 min · Crosscut Daily"), difficulty badge; solved rows at 55%
  opacity. Tapping a row opens the Puzzle page.

### 10. Profile ("You")
64px `accent` avatar + name "Player-7F3A" + "Solving since Aug 2026"; three balance pills;
three stat cards (Solved, Best time, and an ink card with gold "This week"); language chip
row (EN / УКР / РУС); "Completed" row of 76px tiles; three list rows — Wallet, Achievements
(12 / 30), Remove ads → Paywall.

### 11. Puzzle page
Close ✕ + token chip header. Cover card repeating the feed cover treatment (kicker, 48px
tiles, title, "Mini · 5×5 · ~2 min · by Crosscut Daily"). Three stat cards: Difficulty,
"Par · 🪙 per 5s left", Clues. "Top solvers today" card — three rows, rank 1 in `gold`
(wordwasp 0:58, klara.m 1:12, setter_dan 1:26). Primary CTA "Play" / "Play again".

### 12. Play
- Header: back ‹, timer pill (`card`; flips to `accent` fill with white text under 60s),
  token chip that opens the hint sheet.
- **Question banner** (`card`, radius 16): ← / "QUESTION n OF 10" / →, then a direction
  chip (ink pill, "ACROSS"/"DOWN") beside the clue in 800 15/1.25, then a 10-segment
  progress bar (5px, 4px gaps; solved segments `accent`). A wrong word shakes the banner
  (0.3s, ±6px).
- **Grid**, centred: 5×5 uses 54px cells / 6px gap; 9×9 uses 33px / 4px. Cell states:
  block = ink; empty = `card` with 2px ink @35% border; active word = `accent-tint` fill +
  2px `accent` border; next-to-type = 3px `accent` border; error = `error-tint` + `error`
  border and text; locked = ink fill with `paper` letter; just-locked = `success` fill with a
  0.35s pop. Tapping a cell cycles between the unsolved across/down words through it.
- **Keyboard**: QWERTY, 3 rows, 5px gaps, 44px tall keys, radius 8, `card` on 2px ink
  border, 800 15; row 3 is a `gold` "HINT" key (52 wide), Z–M, then an ink "⌫" (52 wide).
  Keys translate 2px down on press.
- **Hint sheet** (bottom sheet, rises 0.25s): title "Stuck?" + token chip; four rows —
  50/50 (🪙 20, shows two candidate answers as tappable cards), Reveal one letter (🪙 40),
  Solve this word (🪙 100), and a free ink row toggling autocheck. Footnote: "Hints pause
  your no-hint ⭐ bonus for this puzzle". Insufficient tokens routes to Wallet.

### 13. Solved
Celebration overlay (see Interactions) plus: "Solved!" 900 34 with `accent` "!", subline
"{title} · 2:31 · under par". Earnings card: ⭐ Solve +10, ⭐ No hints used +2 (only when
no hints), 🪙 "Time bonus — {n}s left ÷ 5" with the accent-coloured amount. Streak card
(ink): "🔥 {streak}-day streak" in gold plus a 7-day strip (gold circle for today, faint
✓ for past days, dashed for the missed Friday). Buttons: "Next puzzle ▸" (advances through
mini1 → cross1 → mini2 → mini3) and "Back to feed". Cards rise in at 0.3/0.45/0.6/0.7s.

### 14. Wallet
Two balance cards side by side (tokens on `card`, stars on ink with gold numeral).
Explainer: "Tokens: earned from time left against par (1 per 5s), spent on hints. Stars:
earned only by solving — they can never be bought or spent." Token packs: 120 / $0.99,
550 / $3.99 "Popular", 1,400 / $8.99 "Best value". Hint-cost reference list (20 / 40 / 100).

### 15. Tab bar
Three tabs, ink top border, `card` fill, 10px top / 20px bottom padding: Feed (house),
Browse (magnifier), You (person). Active tab full opacity, inactive 0.35. Hidden on Play,
Solved, Puzzle, Wallet and the whole funnel.

## Interactions & Behavior

**Navigation.** Single `screen` value drives everything; `prevScreen` powers back. Funnel is
linear (welcome → level → topics → language → planReady → notifs → paywall → feed) with
"Skip all" jumping to feed from any step. Tabs swap feed/browse/profile. Puzzle, Play,
Solved and Wallet are pushed over the tabs.

**Solving.** Typing fills the active word left-to-right, skipping cells already locked by a
crossing answer. A complete word auto-checks: correct → cells flash `success`, the word
locks, any word whose cells are now all fixed locks too (recursive sweep), and after ~0.5s
focus advances to the next unsolved clue; incorrect → error state until the next keypress,
which clears the non-fixed cells. Backspace clears the last editable letter. Completing all
clues waits 0.75s then routes to Solved.

**Timer.** Counts down from par (mini 5:00, 9×9 double) once per second while on Play, pill
turns `accent` under 60s. Tokens earned = `floor(secondsLeft / 5)`. Stars = 10 + 2 if no
hints were used.

**Fortune wheel.** The feed card is compact; tapping "Spin ▸" opens a centred modal
(scrim ink @45%): 200px wheel, 6-segment `conic-gradient` (paper / accent / paper / gold /
paper / dark), gold rim, ink hub, `accent` ▼ pointer. Spin sets a target rotation of
1800° + segment offset ±16° jitter with a 3.2s `cubic-bezier(.12,.65,.1,1)` transition;
after 3.4s tokens are credited and the result reads "You won 🪙 n!" or "So close — try
tomorrow" (prizes 50 / 10 / 0 / 25 / 5 / 15). Each wheel instance spins once.

**Win celebration.** On Solved one of three plays at random (overridable via the
`celebration` tweak): **coins** — 18 🪙 glyphs fall from above, 1.6–3s each, random x,
staggered, rotating 680°; **reels** — one slot reel per theme-word letter (56×64, hard
shadow) spins to land the real letter in `accent`, staggered 0.22s; **marquee** — 26 blinking
bulbs travel the frame perimeter (alternating gold/accent, 0.9s step blink) around a
"JACKPOT" wordmark that pops in.

**Ambient motion.** Feed cover letter tiles split-flap every 4.6s (0.4s stagger); the
streak 🔥 flickers on a 1.6s loop; the wheel 🎰 rotates slowly; ticker and live counters
update every 3s; skeleton blocks shimmer at 1.4s.

**Likes / saves.** Local optimistic toggle per card instance; the like count increments
immediately. Saves are icon-fill only in this design.

## State Management
Single component state (map onto TanStack Query + a small store in the app):

- Navigation: `screen`, `prevScreen`, `openCol` (collection detail), `wheelOpen`.
- Economy: `tokens` (269), `stars` (1284), `baseStreak` (6), `todaySolved`, `wheels{}`
  (per-wheel rotation/spinning/done/prize), `completedIds[]`.
- Funnel: `level`, `topicsSel[]`, `lang`, `plan`.
- Social: `likes{}`, `saves{}` keyed by `puzzleId#feedIndex`.
- Play: `playPz`, `filled[][]`, `solvedQs[]`, `qIndex`, `secLeft`, `error`, `usedHints`,
  `autocheck`, `hintsOpen`, `fiftyOpts`, `justLocked[]`.
- Solved: `celebType`, `celebSeed[]`, `tokensEarned`, `noHint`, `solveTime`.
- Feed: `feedExtra` (pagination batches), `tickerIdx`, `bump` (live-count drift),
  `luckyClaims{}`.

Data needs: puzzle by id (grid, solution, across/down clues), a daily-drop id, per-puzzle
social counts, the user's streak/balances/completions, and a collections manifest
(name, emoji, shelf, member puzzle ids, reward, lock rule).

## Assets
No bitmap assets. Everything is CSS/inline SVG: house / magnifier / person tab icons, heart,
bookmark, magnifier; emoji are system glyphs (🔥 🪙 ⭐ 🎰 🧊 🌍 🎨 🕵️ 🍜 ⚡ 🧩 ✍️ 🗞️ 📅).
Font: **Chivo** from Google Fonts — bundle it with the app rather than loading remotely.
Puzzle content comes from the existing repo JSON.

## Files
- `Crosscut Prototype.dc.html` — the full interactive prototype (all 15 screens, playable).
  Tweak props: `startScreen` (onboarding | feed), `celebration` (random | coins | reels |
  marquee), `parSeconds`.
- `Feed Explorations.dc.html` — the exploration gallery, newest turn first: turn 6 = ten
  single-axis variants of the chosen direction; turn 5 = ten retention-mechanic sketches;
  turn 4 = seven research-backed ideas (streak freeze, escalating week, missions strip, soft
  stop, rewarded double, paywall-after-win, first-week checklist); turn 3 = a dimmed noir
  theme; turn 2 = two crossword × casino theme blends; turn 1 = the three original feed
  directions. Ideas in turns 4–5 are **not** in the prototype — treat them as a backlog.

Open either file in a browser; both are self-contained apart from `support.js`, which sits
beside them in the project.
