# Tracking retention in Crosscut

**TL;DR:** Retention for a daily-drop word game is a *day-rule* problem before it is a metric problem — Crosscut already keys "today" to the player's IANA zone, so every cohort, curve and churn definition here must use `dayKey(now, tz)` and nothing else, or the numbers will disagree with the streak the player can see.
**Confidence:** High on definitions (Amplitude, Mixpanel, GA4, App Store Connect and Play Console state theirs explicitly, and they differ); high on the comparable-product mechanics; medium on the published comparable numbers (Duolingo's are first-party and dated, LinkedIn's are a quoted executive, NYT's could not be verified at all).
**Peter must do:** fix the four definitions in "Definitions to fix first" before any event ships, approve adding `created_at` and `first_solved_day` to `player_state` (server-side cohorts are impossible without them), and approve the five console placements.

This document extends `docs/research/ad-app-metrics.md`, which already defines DAU, D1/D7/D30, sessions, streak distribution and the 13-metric first-version event list. Nothing there is repeated; this is the retention-specific layer — day rules, curve set, instrumentation, comparables, console placement.

## Definitions to fix first

Four choices have to be made before an event is written, because each one changes every later number and none can be changed retroactively.

| Question | Options | Recommendation for Crosscut | Why |
|---|---|---|---|
| What counts as "active" | App open · game started (`solve_started`) · Daily game finished | Two ladders, reported side by side: **active = app open** (the denominator for ads and sessions) and **engaged = at least one solve that day** (the denominator for streaks, cohorts and churn) | The streak, the leaderboard and `player_solves` all key off a finished solve. A retention curve built on app opens and a streak built on solves will diverge, and support will be asked to explain the gap |
| Calendar day or rolling 24h | Calendar day in a fixed zone · calendar day in the player's zone · rolling 24h from first use | **Calendar day in the player's IANA zone**, i.e. `dayKey(ms, tz)` exactly as `applyStreak` uses it | The streak is already defined this way (`ARCHITECTURE.md` §Streak algorithm); a second day rule for analytics guarantees two answers to "did I play yesterday" |
| Which retention shape | Classic N-day · unbounded · bracket | **Classic N-day** for D1/D7/D30 reported externally, **unbounded** for the churn read, **bracket** (D0, D1–3, D4–7, D8–30) for the weekly review | The three are different questions and Amplitude names all three; publishing one and reasoning with another is the most common way a retention argument goes wrong |
| Cohort by what | `first_open` · first solve · onboarding complete | **Cohort by first solve day** as the primary, `first_open` day kept as a secondary for store-report reconciliation | A player who installs and never finishes a game has no streak, no `player_solves` row and no day rule; Apple already excludes never-opened installs from both sides of its ratio |

The three retention shapes, in their vendors' own words:

| Shape | Definition | Source |
|---|---|---|
| N-day (classic) | "The percentage of users that came back to trigger your return event **on a specific day** after triggering your starting event" | Amplitude, retention analysis |
| Unbounded | "How many of your users triggered your return event **on a specific day or after** they triggered your starting event" | Amplitude, retention analysis |
| Bracket | "Create custom brackets for your Return On retention instead of using predefined units of time" | Amplitude, retention analysis |
| Rolling vs calendar interval | Rolling "considers time intervals based on the user's time of birth"; calendar "considers time intervals based on 'calendar' time" | Mixpanel, retention report |

The platforms Peter will be asked about in a board deck use classic N-day on an exact day, in their own zone, not the player's:

| Report | Definition | Note |
|---|---|---|
| App Store Connect, app retention | "the percentage of active devices that installed the app on the selected day and opened the app a certain number of days later" | "Users who install your app but never open it do not qualify, and are not counted in the numerator or the denominator" |
| Play Console, game statistics | "Calculations are based on the number of players who come back on an exact number of days after installing your game" | Day-1 = "returned to the game exactly one day after they first played" |
| GA4 cohort exploration | Daily granularity is "from midnight to midnight in the property timezone"; weekly is "Sunday to Saturday included, not on a rolling 7 days" | Property timezone, not player timezone — this is the drift source below |
| Firebase cohorts | "User activity by cohort shows whether users you acquire on one date return at a greater rate than users you acquire on another date" | Cohort membership is acquisition-date only |

**Why cohorts must use the same day rule as the streak.** `player_state.local_day_ends_at` and `player_solves.day_key` are both player-local. A GA4 cohort is property-local. A player in `Europe/Kyiv` who solves at 23:30 local is on day *N* for their streak and, at UTC property time, on day *N* too — but the same solve at 01:30 Kyiv is day *N* for the streak and day *N−1* in a UTC-keyed report. Over a 30-day curve that misplaces a few percent of every cohort, always in the same direction, and it is invisible unless you look for it. The rule: **console and server-side retention use `day_key`; client analytics is treated as a directional cross-check, never as the reconciled number.**

## The retention curve set

| Curve | Definition | Day rule | Reads as |
|---|---|---|---|
| D1 / D7 / D30 classic | Share of a first-solve cohort with a solve on exactly day N | `day_key` | The headline, day-of-week matched to the cohort's own weekday |
| Weekly cohort curve | Share of a first-solve week cohort with ≥1 solve in each later week | ISO `week_key` (already on `player_solves`) | The honest long-run shape; daily curves are too noisy per language |
| Resurrection rate | Players with a solve this week, no solve last week, and a first solve older than one week ÷ all players active this week | `week_key` | Amplitude's "resurrected"; the payoff line for reminders and re-engagement |
| Streak-survival curve | Share of players who reached a streak of 1 who are still on an unbroken streak at day N | `last_solved_day` vs `day_key` | The single most Crosscut-specific curve; see the survivorship pitfall |
| Daily game completion | Players finishing ≥1 of the day's pair ÷ players who opened the day's Daily game | `day_key` | Leading indicator: it moves days before D7 does |
| Time to second session | Median hours from first solve to second app open | Rolling hours, deliberately | The only place a rolling window is right — it is a latency, not a calendar fact |
| Notification-driven return | Sessions opened from a push ÷ reminders sent, and the share that end in a solve | `day_key` of the reminder | Pairs with the reminder cron's dedupe row |
| Churn | No solve for 14 consecutive local days; "deep churn" at 30 | `day_key` | Choose one and never change it; it is the denominator of resurrection |

Two notes. Daily game completion is a leading indicator because it is measurable on the day, while D7 for the same cohort arrives a week later — a bad Daily game shows up in completion immediately and in D7 much later. And the streak-survival curve should be plotted from a *starting* cohort (everyone who reached streak = 1 in a given week), never from today's streak distribution.

## In-app instrumentation

Firebase already gives `first_open`, `session_start` and `user_engagement` without code (see `ad-app-metrics.md`). These are the retention-specific additions, in `snake_case`, reusing `drop_opened`, `solve_started` and `solve_finished` from that document rather than renaming them.

| Event | When | Properties |
|---|---|---|
| `app_open_attributed` | First foreground of a local day | `open_source` (`push` · `organic` · `deeplink` · `store`), `reminder_day_key`, `hours_since_last_solve`, `streak_count` |
| `drop_opened` | Daily game module enters view on the feed | `day_key`, `lang`, `crossword_id`, `daily_five_id`, `both_done` |
| `solve_started` / `solve_finished` | Existing | add `kind` (`crossword` · `daily_five`), `lang`, `day_key`, `is_daily_challenge` |
| `streak_extended` | On a finish that advances the streak | `streak_count`, `previous_count`, `kind`, `lang` |
| `streak_broken` | First read after `lastSolvedDay` falls out of {today, yesterday} | `previous_count`, `days_missed` |
| `streak_at_risk_card_shown` / `_tapped` | Feed card render and tap | `streak_count`, `hours_left_local` |
| `notification_prompt_shown` / `notification_permission_result` | Pre-prompt and the one system ask | `surface` (`onboarding` · `post_solve`), `result` (`enabled` · `declined` · `skipped`) |
| `reminder_delivered` / `reminder_opened` | Push receipt and tap (v2, when delivery exists) | `reminder_day_key`, `template_id`, `hours_before_local_midnight` |
| `wheel_spun` | Spin resolves | `prize`, `day_key`, `is_first_action_of_day` |

**User properties** (set once, updated on change): `player_tz`, `lang`, `level`, `plan_tier`, `notif_status`, `first_solve_day`, `streak_bucket` (`0` · `1-3` · `4-7` · `8-30` · `31+`), `longest_streak_bucket`. Keep `streak_bucket` as a bucket, not a number — a numeric user property re-segments every cohort every day and makes historical charts unreadable.

**Tying a return to its trigger.** Set one session-scoped property, `return_trigger`, on the first event of a local day, resolved in this order: `push` if the app was launched from a notification; `streak_at_risk_card` if the first solve of the day started from that card's CTA; `wheel` if the first action was a spin; else `organic`. One trigger per player-day, decided once, so a day cannot be credited twice.

**Server-side versus client.** The console and any number Peter defends should be computed server-side from `player_solves` and `player_state`, because those carry `day_key`, `week_key` and the player's zone. Client analytics is for the funnel steps the server cannot see (prompt shown, card shown, ad opportunity). Two examples:

```sql
-- D7 classic, cohorted by first solve day, entirely in player-local days
WITH firsts AS (
  SELECT user_id, MIN(day_key) AS cohort_day FROM player_solves GROUP BY user_id
)
SELECT f.cohort_day,
       COUNT(DISTINCT f.user_id) AS cohort_size,
       COUNT(DISTINCT CASE WHEN s.day_key = date(f.cohort_day, '+7 day')
                           THEN s.user_id END) AS d7
FROM firsts f LEFT JOIN player_solves s ON s.user_id = f.user_id
GROUP BY f.cohort_day;

-- Weekly resurrection: solved this ISO week, silent last week, not new
SELECT COUNT(DISTINCT s.user_id)
FROM player_solves s
WHERE s.week_key = :this_week
  AND NOT EXISTS (SELECT 1 FROM player_solves p
                  WHERE p.user_id = s.user_id AND p.week_key = :last_week)
  AND EXISTS (SELECT 1 FROM player_solves q
              WHERE q.user_id = s.user_id AND q.week_key < :last_week);
```

Three schema gaps block this today, all small:

| Gap | Consequence | Fix |
|---|---|---|
| `player_state` has no `created_at` | No `first_open` cohort server-side; `UserState.createdAt` exists in the DO but is not projected | Add `created_at` to the projection |
| `player_state` has no `first_solved_day` | Every cohort query needs a `MIN(day_key)` scan of `player_solves` | Add `first_solved_day`, written once by `applyStreak` |
| `player_solves` carries no `lang` or `kind` | Per-language and per-game cohorts need a join to `content_puzzles` on every read | Denormalise `lang` and `kind` onto the fact row |

## What comparable products do and publish

| Product | Streak and reminder mechanic | Published number | Known or inferred |
|---|---|---|---|
| Duolingo | Daily streak; Streak Freeze (up to two equipped); Streak Wager; Weekend Amulet | Learners reaching a 7-day streak are "3.6 times more likely to complete their course"; streak-extend animations improved new-learner retention "+1.7%"; doubling available Streak Freezes from one to two raised daily active learners "+0.38%"; over 6 million people on a 7+ day streak (2022-01-31) | **Known** — first-party blog, dated |
| Duolingo | Streak Wager and Weekend Amulet experiments | Streak Wager gave "statistically significant increases in Day-1, Day-7 and Day-14 user retention, with Day-7 retention showing the greatest improvement at +14%"; Weekend Amulet users were "4% more likely to come back a week later and 5% less likely to lose their streak" (2017-05-10) | **Known** — first-party, but an old and small feature set |
| Duolingo | Practice-reminder push optimisation via a bandit algorithm | Deployment "achieved a 0.5% increase in daily active users (DAUs) and a 2% improvement in new user retention" over a strong baseline (KDD 2020, Yancey and Settles) | **Known** — peer-reviewed; note the *baseline* was already an optimised reminder system |
| LinkedIn Games | One play per day per game; daily streak shown on completion; streak freezes added later | "84% of players return the next day after first playing, while 80% come back within a week" — Nicholas Pezarro, LinkedIn senior PM of games, as reported 2025-12-22 | **Inferred discipline** — an executive quote with no stated denominator, day rule or cohort; treat as a shape, not a target |
| Snapchat | Streak on daily reciprocal exchange, hourglass warning before expiry, in-app Streak Restore, one free restore per month for Snapchat+ | None published on retention | **Known** mechanic, **no** published number. The useful lesson is structural: the warning, the restore and the paid restore are three separate products around one streak |
| NYT Games (Wordle, crossword) | One game per day, streak and stats panel, shareable result grid, archive for subscribers | Widely repeated figures (billions of plays per year, ~10 million daily players) could **not** be verified — NYT's own domains are not reachable from this research run, and the NYT 2024 fourth-quarter press release filed with the SEC mentions games only in a product list, with no play, engagement or retention figure | **Inferred / unverified** — do not quote a Wordle number in a Crosscut deck |
| Puzzmo | Daily set of games, subscription, explicitly resists engagement dark patterns | Zach Gage: "if a game is fun for 10 hours, it'll be good enough for Puzzmo. Because that's a lot of hours stretched out once a day over a year" (2023-11-09) | **Known** quote; no retention data published |

What transfers to Crosscut, and what does not:

- **Transfers.** A streak-protection affordance is the highest-leverage retention feature any of these has published a number for, and Duolingo's own results say the *option to take a break* increased return rates rather than lowering them. Crosscut has the support-side half (S3 restore streak) and none of the player-side half.
- **Transfers.** Reminder content is worth optimising, but the Duolingo lift was 0.5% DAU *against an already-tuned baseline* — the first reminder is worth far more than the tenth variant of it.
- **Does not transfer.** LinkedIn's 84% is a next-day return among people who chose to start a game inside an app they already open daily. Crosscut's D1 denominator is a fresh install.
- **Does not transfer.** Duolingo's "3.6× more likely" is correlational: reaching a 7-day streak is itself evidence of a committed learner. Crosscut's streak-survival curve will show the same shape and must not be read as causal.

**Resurrection at scale, first-party.** Duolingo's Q2 2026 shareholder letter reports a one-time "Streak Revival" event in June 2026: eligible learners could restore their longest-ever streak by opting in and completing three lessons; 15.4 million learners revived a streak, including nearly 8 million who had no active streak when the event began. The same letter defines a "current user DAU" as one also active in the previous seven days and reports that share at 84%. Both are usable precedents for Crosscut: a time-boxed streak revival as a win-back campaign, and a seven-day "current user" share as the leading retention indicator. The 2022 Duolingo habit post also reports that doubling the number of Streak Freezes raised daily active learners by 0.38%, which is the cleanest published evidence that streak protection helps retention rather than diluting it.

## Where each number lives

Per the console guidelines, a number belongs in the console only when it sits next to the control that changes it; everything else is product analytics. Five placements:

| # | Console location | Number, with scope and window | Decision it changes |
|---|---|---|---|
| 1 | Players → Support actions, beside **S3 Restore streak** | Streak restores granted · global · 28 days, split by operator, with the share of restored players who solved again within 7 days | Whether restores are working as a support action or being used as a substitute for a player-facing streak protection |
| 2 | Daily game → Day inspector, beside the **published day** | Daily game completion · that day · per language · shown against the same weekday in the prior 4 weeks | Whether that day's crossword or Wordle was mis-scheduled or too hard, and whether to publish a correction |
| 3 | Operations → Notifications card, beside the **reminder rule** | Notification opt-in share (`prefs.notifications` = enabled ÷ all onboarded) · per platform · 28 days, next to reminders written and deduped by the hourly cron | Whether to move the pre-prompt, and whether the reminder rule fires for a population large enough to matter |
| 4 | Ads → Placement rule editor, beside the **first-session grace** control | Read-only D1 and D7 for first-solve cohorts before and after the rule's effective time, day-of-week matched · per platform | Whether to keep or revert an ad-rule change — the guardrail the guidelines demand next to a high-impact control |
| 5 | Players → Player record header | Days since last solve, current streak, longest streak, `last_solved_day` and the player's local day boundary | Whether this player is at risk, already churned, or in a timezone that explains their complaint — before any support action is taken |

Everything else — the curve set, weekly cohorts, resurrection, time to second session — lives in product analytics. It has no console control to sit beside, and putting it in the console turns the console into the generic dashboard the guidelines forbid.

## Pitfalls

**Survivorship in streak metrics.** "Average current streak" rises whenever short streaks break, because breaking removes the low numbers from the population. The streak-survival curve must be cohorted on the day the streak *started*, and reported as "of players who reached streak 1 in week W, x% are still unbroken at day N". Report the distribution buckets from `ad-app-metrics.md` alongside it, never a mean.

**Timezone drift double-counting a day.** Two failure modes. `setTimezone` is allowed once per local day and never lowers `lastSolvedDay`, so a player moving west can produce two solves with the same `day_key` and a player moving east can skip a `day_key` entirely — the streak is protected but a naive `COUNT(DISTINCT day_key)` is not. And any client-analytics cohort is bucketed in the property timezone, which will not agree with `day_key`. Reconcile only server-side, and treat `player_state.tz` changes as a known small distortion rather than trying to correct them.

**Counting a resurrected player as new.** A returning player keeps their user id and their `player_solves` history, so their return is a resurrection, not an install. The only way it becomes a fake install is a reinstall producing a new `install_id` — with `first_solve_day` on `player_state`, a returning player is always identifiable. Report new and resurrected separately, as Amplitude's lifecycle chart does; a combined "active" line hides which one is moving.

**Reading D1 during an ads or grace-period change.** `ad-app-metrics.md` already makes this point for the ad side; the retention side of it is that D1 measures the second day, which the 24-hour first-session grace makes the first ad day. Never change the grace and the cap on the same date, and never read a D1 delta over fewer than two matched weekday cycles.

**Weekday seasonality.** A daily-drop game has a hard weekly rhythm — a Sunday cohort's D1 lands on Monday. Every cohort comparison must be weekday-matched, and weekly cohorts should be preferred wherever the daily curve is not specifically needed.

**Small-cohort noise per language.** Ukrainian and Russian cohorts will be small enough that a single-day D7 swings on a handful of players. Set a minimum cohort size (a working floor of 200 first-solvers) below which the console shows the count rather than a rate, and roll small languages to weekly cohorts. This is the same discipline the guidelines already require for scope and window labels.

**One more.** Do not compare Crosscut's D1 to a public benchmark without matching the day rule and the denominator: Apple excludes never-opened installs, Play counts an exact day from first play, GA4 buckets in the property timezone, and Crosscut cohorts on first solve. Four different numbers, all correctly called "D1".

## Do this first

| # | Item | Event or query it needs |
|---|---|---|
| 1 | Fix the four definitions in the table above and write them into the console glossary | None — a decision |
| 2 | Add `created_at` and `first_solved_day` to the `player_state` projection | `applyStreak` writes `first_solved_day` on the first solve; `createdAt` already exists on `UserState` |
| 3 | Denormalise `lang` and `kind` onto `player_solves` | Projection `extra()` already writes the fact row; add two columns |
| 4 | Ship the D1/D7/D30 classic query cohorted on `first_solved_day` | The SQL above, against `player_solves` |
| 5 | Ship the weekly cohort and resurrection queries | `player_solves.week_key`, already present |
| 6 | Ship the streak-survival curve | `player_solves.day_key` plus `player_state.streak`, `last_solved_day` |
| 7 | Instrument `drop_opened` and finish `solve_started` / `solve_finished` with `kind`, `lang`, `is_daily_challenge` | Client events; denominator for Daily game completion |
| 8 | Instrument `streak_extended`, `streak_broken`, `streak_at_risk_card_shown`, `streak_at_risk_card_tapped` | Client events off the existing feed card |
| 9 | Instrument `notification_prompt_shown` and `notification_permission_result` at the pre-prompt | Client events; the numerator and denominator of placement 3 |
| 10 | Set the `return_trigger` session property and `app_open_attributed` | Client; resolve once per local day in the documented order |
| 11 | Set the user properties, `streak_bucket` as a bucket | Client, on session start and after any finish |
| 12 | Build console placements 1, 2 and 5 (restore volume, Daily game completion, player-record risk state) | Items 2, 4 and 7; placements 3 and 4 wait for notifications and ad rules to exist |

Items 1–6 are server-side and unblock the console. Items 7–11 are the client work. Item 12 is the only console build in the first pass.

## Sources

| Source | URL | What it supports | Date |
|---|---|---|---|
| Amplitude — interpret your retention analysis | https://amplitude.com/docs/analytics/charts/retention-analysis/retention-analysis-interpret | N-day, unbounded and bracket retention definitions | Accessed 2026-09-09 |
| Amplitude — interpret your Lifecycle chart | https://amplitude.com/docs/analytics/charts/lifecycle/lifecycle-interpret | New, current, resurrected and dormant user definitions | Accessed 2026-09-09 |
| Mixpanel — Retention report | https://docs.mixpanel.com/docs/reports/retention | Birth and return events; rolling vs calendar interval definitions | Accessed 2026-09-09 |
| GA4 — Cohort exploration | https://support.google.com/analytics/answer/9670133?hl=en | Cohort inclusion, return criteria; daily = midnight to midnight in the property timezone; weekly is Sunday–Saturday, not rolling | Accessed 2026-09-09 |
| Firebase — Cohorts | https://support.google.com/firebase/answer/6317510?hl=en | Cohort membership by acquisition date | Accessed 2026-09-09 |
| App Store Connect Analytics — App retention | https://developer.apple.com/help/app-store-connect-analytics/engagement/app-retention/ | Retention definition; installs that never open are excluded from numerator and denominator | Accessed 2026-09-09 |
| Play Console — Google Play game services statistics | https://support.google.com/googleplay/android-developer/answer/3423625 | Retention counted on an exact number of days after first play | Accessed 2026-09-09 |
| Duolingo blog — the streak and habit research | https://blog.duolingo.com/how-duolingo-streak-builds-habit/ | 3.6× course completion at a 7-day streak; +1.7% new-learner retention from streak animations; +0.38% daily active learners from two Streak Freezes; 6M on 7+ day streaks | 2022-01-31 |
| Duolingo — Q2 2026 shareholder letter (SEC 8-K exhibit 99.2, August 5, 2026) | https://www.sec.gov/Archives/edgar/data/1562088/000162828026053299/q2fy26duolingo6-30x26share.htm | Streak Revival: 15.4M streaks revived, ~8M from dormant users; current-user DAU definition and 84% share |
| Duolingo blog — how streaks keep learners committed | https://blog.duolingo.com/how-streaks-keep-duolingo-learners-committed-to-their-language-goals/ | Streak Wager D1/D7/D14 lift, +14% at D7; Weekend Amulet 4% / 5% | 2017-05-10 |
| Yancey and Settles — a sleeping, recovering bandit algorithm for optimizing recurring notifications | https://www.kdd.org/kdd2020/accepted-papers/view/a-sleeping-recovering-bandit-algorithm-for-optimizing-recurring-notificatio | +0.5% DAU and +2% new-user retention from reminder optimisation over a strong baseline | KDD 2020 |
| Snapchat Support — how do Streaks work and when do they expire | https://help.snapchat.com/hc/en-us/articles/7012394193684-How-do-Streaks-work-and-when-do-they-expire | Daily reciprocal rule, hourglass expiry warning | Accessed 2026-09-09 |
| Snapchat Support — I lost my Streak, how do I restore it | https://help.snapchat.com/hc/en-us/articles/7012318024852-I-lost-my-Streak-How-do-I-restore-it | In-app Streak Restore, limited window after expiry | Accessed 2026-09-09 |
| Net Influencer — LinkedIn bets on games | https://www.netinfluencer.com/linkedin-bets-on-games-to-build-professional-connections-daily-habits/ | 84% next-day and 80% one-week return, attributed to Nicholas Pezarro, LinkedIn senior PM of games — secondary, no denominator stated | 2025-12-22 |
| Game Developer — Zach Gage on newspaper games | https://www.gamedeveloper.com/design/puzzmo-co-creator-zach-gage-on-building-newspaper-games-that-can-last-forever | Daily-format design rationale | 2023-11-09 |
| The New York Times Company — fourth-quarter and full-year 2024 results (SEC 8-K) | https://www.sec.gov/Archives/edgar/data/71691/000007169125000021/pressrelease12312024.htm | Games named only in a product list; no play, engagement or retention figure disclosed | 2025-02-05 |

**Could not verify:** every widely circulated Wordle and NYT Games engagement figure (annual plays, daily players, "games subscribers retain best"). NYT-owned domains were unreachable from this run and the company's own 2024 results release discloses no games metric, so none of those numbers appear above as fact. Also dropped: a frequently repeated claim that Streak Freeze "reduced churn 21%", which traces only to secondary marketing write-ups with no primary Duolingo source.
