# Metrics for Crosscut as an ad-supported game

**TL;DR:** 52 metrics across six families cover an ad-supported Crosscut; 10 can be produced from the backend as designed today and 5 more in part (`player_solves`, the User DO ledger, `plan_tier`, `leaderboard_week`), while 24 have a home in the console because they sit beside a console decision — the rest belong in AdMob or product analytics.
**Confidence:** High on metric definitions and formulas (AdMob, Firebase, Google Play and Unity primary docs); medium on benchmark levels (public benchmarks are median-of-all-genres, rarely word/puzzle-specific); low on any eCPM effect size for consent state, which no primary source states.
**Peter must do:** approve the 13-metric first-version list below, decide whether rewarded grants use AdMob server-side verification (this is what makes grant failure measurable at all), and confirm that ad-free plan share is measured off `plan.tier` rather than a store report.

## How these metrics are written

Every row follows the console guidelines: a metric sits beside the decision it changes, always carries a scope and a time window, states a direction or threshold where a source supports one, and stays a reconcilable count or rate rather than a composite score. Trends are only meaningful against a comparable prior period — for Crosscut that means day-of-week matched, because a daily-drop game has a hard weekly rhythm.

"Home" is where the metric should be read:

- **AdMob** — mediation dashboard and the AdMob reporting API. Campaigns, targeting and revenue reporting stay there by design.
- **Analytics** — Firebase Analytics or GameAnalytics, fed by client events.
- **Console** — the Crosscut admin console, and only when the number sits directly next to a console control (a placement toggle, a cap, a reward rule, an Operations signal).

"Today" says whether the backend as described in `docs/ARCHITECTURE.md` can already produce the number: `player_solves` fact rows, the in-DO ledger, `player_state` (`plan_tier`, `tokens`, `stars`, `streak_count`), and `leaderboard_week`.

## Ad monetisation

AdMob's own funnel is requests → matched requests → impressions, and its glossary gives the formulas: match rate is `matched requests / requests`, show rate is `impressions / matched requests`, and eCPM is `estimated earnings / impressions × 1000`.

| Metric | Definition / formula | Decision it changes | Scope · window | Direction | Home | Today |
|---|---|---|---|---|---|---|
| Impressions per DAU | Ad impressions ÷ daily active users, split by format | Whether to raise or lower a frequency cap | Per placement · per platform · 7 days vs prior 7 | Raise only while ARPDAU rises and D7 holds | AdMob + Analytics | No — needs DAU and an ad impression event |
| Ad ARPDAU | Ad revenue ÷ DAU on the same day | Whether an ads change paid for itself | Per platform · per country group · 7-day rolling | Up, read together with retention | AdMob | No |
| IAP ARPDAU | Star-pack and token-pack revenue ÷ DAU | Whether ads are cannibalising purchases | Per platform · 7-day rolling | Up | Analytics | Partly — ledger has purchases, DAU missing |
| Blended ARPDAU | (Ad + IAP revenue) ÷ DAU | The only honest headline for a hybrid app | Per platform · 28 days | Up | Analytics | No |
| eCPM by format and platform | Earnings ÷ impressions × 1000 | Which formats deserve inventory | Per format · per platform · per country group · 7 days | Compare to own prior period, never to a public figure | AdMob | No |
| Match rate | Matched requests ÷ requests | Whether to add or re-order an ad source | Per placement · per platform · 7 days | Investigate sustained drops | AdMob | No |
| Show rate | Impressions ÷ matched requests | Whether the app is discarding filled ads (load timing, navigation races) | Per placement · 7 days | A low show rate with a high match rate is an app bug, not a demand problem | AdMob + Console | No |
| Fill / match rate beside the placement toggle | Same number, surfaced next to the enable control | Whether pausing a placement is warranted | Per placement · 7 days · with prior period | Show the floor next to the value | Console | No |
| Opportunity-to-impression rate | Impressions ÷ ad opportunities the app decided to fill | Whether placement rules or caps, not demand, are the constraint | Per placement · 7 days | Splits "we never asked" from "we asked and got nothing" | Analytics | No — needs an `ad_opportunity` event |
| Rewarded engagement rate | Rewarded views started ÷ rewarded offers shown | Whether the reward is worth the ad to players | Per placement · per offer copy · 7 days | Up; a falling rate means the reward is priced wrong | Analytics | No |
| Rewarded completion rate | Rewarded events (reward granted) ÷ rewarded views started | Whether creatives or the network are failing mid-view | Per placement · per platform · 7 days | Down is a load or network problem | AdMob | No |
| Delivered interstitial frequency vs cap | Actual interstitials per player-day, as a distribution against the configured cap | Whether the cap is real or decorative | Per placement · per platform · 7 days | Report P50 and P90, not a mean | Console | No |
| Ad-free conversion | Players moving from `lite` to a paid `plan.tier` ÷ eligible players | Whether the ad load is pushing people to pay or away | Per platform · 28-day cohort | Up, but never at the cost of D7 | Analytics + Console | Partly — `plan_tier` transitions exist, denominators do not |

AdMob's own guidance on eCPM movement is that it depends on market and platform, on blocked categories, and on price floors, and that a lower eCPM with higher impressions can still mean higher earnings — so eCPM alone never justifies a change.

## User value

| Metric | Definition / formula | Decision it changes | Scope · window | Direction | Home | Today |
|---|---|---|---|---|---|---|
| Ad-free plan share | Players with `plan.tier ≠ lite` ÷ all active players | Whether ad revenue or plan revenue is the real business | Per platform · monthly | Watch the mix, not the level | Console (Economy) + Analytics | Yes — `player_state.plan_tier` |
| D7 revenue per install | Total revenue from an install cohort by day 7 ÷ installs | Whether a UA channel or an ads change pays back | Per install cohort · per channel · fixed 7-day horizon | Up | Analytics | No |
| D30 revenue per install | Same, 30-day horizon | The only LTV proxy worth reporting before there is a year of data | Per install cohort · fixed 30-day horizon | Up | Analytics | No |
| Paying share | Players with any purchase ÷ active players | Whether the star pack is priced and placed correctly | Per platform · 28 days | Up | Analytics | Partly — `economy_purchases` exists |
| Revenue mix | Ad revenue ÷ total revenue | Guards against optimising ads into an IAP hole | Per platform · monthly | Report both halves, never a single index | Analytics | No |

Unity defines ARPDAU as revenue from IAPs, ads or both on a day divided by unique active users that day, and notes that it removes user-base fluctuation from the reading. Keep ad ARPDAU and IAP ARPDAU as separate lines and show the blend beside them; a single blended number hides the trade Crosscut is actually making.

## Engagement and retention

| Metric | Definition / formula | Decision it changes | Scope · window | Direction | Home | Today |
|---|---|---|---|---|---|---|
| DAU | Unique players with a session that day | The denominator under every rate here | Per platform · daily, compared day-of-week | — | Analytics | No — needs `session_start` |
| DAU/MAU | DAU ÷ MAU | Whether the daily-drop habit is forming | Global · monthly | Up | Analytics | No |
| D1 retention | Cohort players returning on day 1 ÷ cohort installs | Whether the first-session ad grace is set correctly | Per install cohort · per platform | Never trade D1 for interstitial revenue | Analytics | No |
| D7 retention | Same, day 7 | Whether the drop cadence keeps people | Per install cohort · per platform | Up | Analytics | No |
| D30 retention | Same, day 30 | Whether streaks and collections do long-term work | Per install cohort · per platform | Up | Analytics | No |
| Sessions per DAU | Sessions ÷ DAU | How many interstitial opportunities exist per player-day | Per platform · 7 days | Read before setting a cap | Analytics | No |
| Session length | Median and P90 foreground time per session | Whether an ad break fits the natural gap | Per platform · 7 days | Report percentiles, not the mean | Analytics | No |
| Streak distribution | Count of players by current streak bucket (0, 1–3, 4–7, 8–30, 31+) | Whether a streak-restore support action or a reminder is warranted | Global · weekly snapshot | Watch the 1–3 bucket for leakage | Console (Overview) | Yes — `player_state.streak_count` |
| Drop completion rate | Players who finished at least one game in a drop ÷ players who opened that drop | Whether a specific drop was too hard, or scheduled badly | Per drop · per language · per kind | Show it beside the published drop | Console (Drop desk) | Partly — numerator from `player_solves`, denominator needs a `drop_opened` event |
| Solve rate | Solves finished ÷ solves started | Whether a crossword is losing people mid-grid | Per game · lifetime and first 7 days | Below a language-level floor, review the game | Console (Library) | Partly — `solve.started` exists as an event but no fact row |
| Hint usage per solve | Mean and P90 `hints_used` on finished solves | Whether hint prices and the rewarded hint offer are balanced | Per game kind · per difficulty · 7 days | Rising P90 means the crossword set drifted harder | Console (Library) + Analytics | Yes — `player_solves.hints_used` |
| Median solve time vs par | `time_ms` median ÷ `parSec` | Difficulty labelling on the drop desk | Per crossword · lifetime | Flag crosswords far from par | Console (Library) | Yes — `player_solves.time_ms` |
| Leaderboard participation | Board-eligible solvers ÷ solvers, per week | Whether anti-cheat exclusions are over-firing | Per week · per language | A falling rate needs an integrity review, not a metric change | Console (Leaderboards) | Yes — `player_solves.board_eligible`, `leaderboard_week` |

Public retention benchmarks are the wrong yardstick for a daily-drop word game and should be used only to sanity-check magnitude. GameAnalytics' 2026 cycle reports global mobile medians of roughly 22% D1, 4% D7 and under 1% D30 across 16,000+ games in 2025, with a median 3.8–3.9 sessions and about 12 minutes of playtime per day, and explicitly says genre cuts were not included that cycle. Its 2025 cycle, covering 11,600 games across 9 regions on iOS and Android for calendar 2024, gave puzzle medians in the range 19.7–20.7% D1, 4.3–4.8% D7 and 1.1–1.3% D28. Neither cut is word-game-specific, and neither is a target.

## Content and economy

The wallet is authoritative in the User DO and every movement is a ledger entry, so this family is the one Crosscut can measure best today — with one gap: there is no rewarded-grant reason in the ledger because ads do not exist server-side yet.

| Metric | Definition / formula | Decision it changes | Scope · window | Direction | Home | Today |
|---|---|---|---|---|---|---|
| Token sources by reason | Tokens credited per ledger reason (solve, no-hint bonus, wheel, collection, purchase, rewarded grant, support grant) | Whether a source is flooding the economy | Global · 7 days · reconcilable to the ledger | Sources and sinks shown side by side | Console (Economy) | Yes for existing reasons; rewarded grant is new |
| Token sinks by reason | Tokens debited per reason (hints today) | Whether hint prices hold | Global · 7 days | — | Console (Economy) | Yes |
| Net token supply | Sources − sinks, plus the aggregate balance | Whether to change a rewarded grant amount or a hint price | Global · 7 days and 28 days | Sustained positive net means the rewarded grant is too generous | Console (Economy) | Yes for existing reasons |
| Median token balance | P50 and P90 of `player_state.tokens` | Whether players ever feel scarcity — the thing that makes a rewarded ad worth watching | Global · weekly snapshot | A rising P50 kills rewarded demand | Console (Economy) | Yes |
| Rewarded grant failure rate | Grants attempted but not credited ÷ grants attempted | Whether to pause the rewarded placement | Per placement · 7 days · beside the rewarded rule | The prototype's 1% alert floor is a product choice, not a vendor figure | Console (Ads, with an Operations signal) | No — needs the grant endpoint |
| Grants refused by cap | Reward requests refused because the daily cap was reached | Whether the cap is binding, and on how many people | Per placement · 7 days · count and distinct players | Report the player count, not just the event count | Console (Ads) | No |
| Hint purchases | Token packs bought, and hints bought with tokens | Whether the rewarded hint is substituting for paid hints | Per platform · 28 days | Watch alongside rewarded engagement | Console (Economy) | Yes |
| Share of hints funded by ads | Hints whose tokens came from a rewarded grant ÷ all hints | The core hybrid trade-off in one number | Global · 28 days | Needs the grant reason on the ledger entry | Analytics | No |

AdMob's rewarded policy requires that the reward is only served after an affirmative opt-in, that the required action and the reward are disclosed before each presentation, and that the publisher delivers the promised reward on completion — which makes grant failure a compliance matter, not only an economy one. Google's server-side verification callback carries `reward_amount`, `reward_item`, `transaction_id`, `user_id` and a signature, and is the mechanism that lets a Crosscut ledger entry be reconciled against an AdMob reward event at all. Its recommended pattern is to grant client-side for responsiveness and validate against the verified callback.

## Consent and privacy

| Metric | Definition / formula | Decision it changes | Scope · window | Direction | Home | Today |
|---|---|---|---|---|---|---|
| ATT prompt shown rate | Prompts shown ÷ eligible iOS installs | Whether the pre-prompt and its timing work at all | iOS · per install cohort | Should approach 100% of eligible installs | Analytics | No |
| ATT authorisation rate | Installs returning authorized ÷ prompts shown | Where in onboarding to place the prompt | iOS · per install cohort · per country group | Measure your own; public figures vary by genre and region | Analytics + Console (player record) | No |
| Consent-gathered rate (UMP) | Sessions where the UMP SDK reports it can request ads ÷ sessions in scope | Whether the consent form is failing in a region | EEA / UK / Switzerland · per country · 7 days | A sharp drop is a form or SDK problem | Analytics + Console (Ads) | No |
| Personalised impression share | Personalised impressions ÷ all impressions | Whether the consent flow, not demand, is depressing revenue | Per platform · per country group · 7 days | Report next to eCPM for the same slice | AdMob | No |
| eCPM by consent state | eCPM split by personalised and non-personalised impressions | Whether it is worth investing in the consent flow | Per platform · per country group · 28 days | Measure your own delta; no primary source states one | AdMob | No |
| Consent visibility in the player record | The consent and ATT state a support agent can see for one player | Answering "why do I see ads" support tickets | One player · current state | Read-only, never editable from the console | Console (Players → Devices & ads) | No |

Google's UMP SDK exposes `canRequestAds` and `privacyOptionsRequirementStatus`, and its geography scope for testing is the EEA, the UK and Switzerland — so consent rate must be scoped by country, never reported globally. Google describes non-personalised ads as based on contextual information and coarse geo-targeting rather than past behaviour, and says consent is required where legally required including the UK, Switzerland and certain EEA countries; it makes no claim about the revenue difference, so treat any figure you have seen quoted for that gap as unverified until you measure your own.

## Health and guardrails

| Metric | Definition / formula | Decision it changes | Scope · window | Direction | Home | Today |
|---|---|---|---|---|---|---|
| User-perceived crash rate | Daily users with at least one user-perceived crash ÷ daily users | Whether to roll back an ads SDK change | Per platform · per app version · daily | Google Play treats 1.09% of daily users across all device models as bad behaviour | Play Console / App Store Connect | No |
| User-perceived ANR rate | Daily active users with at least one user-perceived ANR ÷ DAU | Same, for main-thread stalls that ad SDKs cause | Android · per app version · daily | Play's bad-behaviour threshold is 0.47% overall and 8% for a single device model | Play Console | No |
| Ad load latency | P50 and P95 time from request to fill, per format | Whether to preload earlier or drop a slow ad source | Per placement · per platform · 7 days | P95 is the one that breaks the solve flow | Analytics | No |
| Ad show failure rate | Show attempts that error ÷ show attempts | Whether an SDK integration is broken in production | Per placement · per app version · daily | Any sustained non-zero rate is a bug | Analytics + Console (Operations) | No |
| Players hitting the rewarded cap | Distinct players reaching the daily cap ÷ DAU | Whether the cap is set where anyone notices | Per placement · 7 days | Show beside the cap control with the cap value | Console (Ads) | No |
| Retention delta after an ads change | D1 and D7 for cohorts before and after an effective time, day-of-week matched | Whether to keep or revert the change | Per install cohort · per platform · fixed horizons | Requires a holdout to be causal | Analytics | No |
| Ad rule change audit coverage | Ad-rule mutations with an operator, reason and effective time ÷ all ad-rule mutations | Whether the console's safeguards are actually working | Global · 28 days | Must be 100% | Console (Access → Audit) | No |

## First version: instrument these before launch

Thirteen metrics, and the events each needs. Everything else in this document can wait for the first ads iteration.

| # | Metric | Events or fields needed |
|---|---|---|
| 1 | DAU and sessions per DAU | `session_start` (automatic in Firebase Analytics) |
| 2 | D1 / D7 / D30 retention | `first_open` + `session_start` (both automatic) |
| 3 | Session length | `user_engagement` (automatic) |
| 4 | Drop completion rate | new `drop_opened` client event; solves already in `player_solves` |
| 5 | Solve rate | new `solve_started` / `solve_finished` fact rows keyed by `solveId` |
| 6 | Hint usage per solve | `player_solves.hints_used` — available today |
| 7 | Streak distribution | `player_state.streak_count` — available today |
| 8 | Impressions per DAU, by format | `ad_impression` (automatic from AdMob via the Firebase link) |
| 9 | Ad ARPDAU and eCPM by format | `ad_impression` with impression-level revenue; AdMob reporting |
| 10 | Rewarded engagement and completion rate | new `ad_offer_shown`, `ad_view_started`, `ad_reward_granted` events |
| 11 | Rewarded grant failure rate | server grant endpoint + AdMob SSV callback; new ledger reason `rewarded_grant` |
| 12 | Token sources vs sinks, net supply | ledger reasons — available today once `rewarded_grant` is added |
| 13 | ATT authorisation rate and UMP consent-gathered rate | new `att_prompt_shown` / `att_result` events; UMP `canRequestAds` on session start |

Firebase logs `ad_impression` automatically when an AdMob app is linked, and logs `session_start`, `user_engagement` and `first_open` without any code — so items 1, 2, 3 and 8 are close to free. The revenue value on `ad_impression` needs the impression-level revenue data path, which mediation SDKs expose as a per-impression revenue callback.

## Pitfalls specific to Crosscut

**Rewarded ads inflate token supply.** A rewarded grant is a mint with no cost. `finishSolve` already pays `floor(secLeft/5)` tokens plus star bonuses, and the wheel mints more; adding a +25 grant with a cap of 3 is up to 75 tokens a day against a hint price of 20–100. Watch net token supply and the P50 balance together: once the median player is never short, the rewarded placement stops being watched and the whole hybrid loop dies quietly while impressions-per-DAU still looks fine.

**Interstitials after the first session hurt D1.** The prototype's first-session grace is the right instinct, but its 24-hour window makes the second day the first ad day — exactly the day D1 measures. Change the grace and the cap on different dates so the two effects are separable, and read D1 on day-of-week matched cohorts. AdMob's own advice is to start with low frequency caps and raise them carefully so that ads do not adversely affect retention.

**ATT denial lowers eCPM, and the fix is not more prompting.** Public opt-in figures (gaming around 37% in Adjust panel data reported in 2023) are directional at best and vary hugely by genre and country. Measure your own authorisation rate per country group and read it beside eCPM for the same slice. Re-prompting is not available, so prompt placement is a one-shot decision worth testing before launch, not after.

**Mediation A/B without a holdout proves nothing.** Ad revenue is seasonal, weekday-shaped and demand-shaped. Comparing this week to last week after a waterfall change measures the ad market, not the change. Any ads change worth reporting needs a randomised holdout carried for a full week or more, with retention read on the same split.

**Fill rate is not a revenue proxy.** The archive banner in the prototype shows 64% fill; that number alone says nothing about whether enabling it earns anything or costs retention. AdMob separates match rate from show rate from eCPM precisely because a filled request that is never shown, or shown at a low price, is not revenue. Put fill rate beside the placement toggle as a health signal with its floor, and put revenue questions in AdMob.

**No composite health scores.** An "ads health" index that blends fill, latency and grant failures cannot be reconciled by an operator and cannot be drilled into. Show the three numbers with their thresholds. The same applies to a "player value score" in the player record: support agents need the ledger, the plan tier and the streak, not an index.

**Two more traps.** Reporting a mean where the distribution matters — delivered interstitial frequency, session length and hint usage all need P50 and P90, because the cap only binds the tail. And treating a solve count as DAU: `player_solves` counts finishers, so using it as a denominator makes every rate look better than it is on days when a drop is hard.

## Sources

| Source | URL | What it supports |
|---|---|---|
| AdMob reports glossary | https://support.google.com/admob/table/9462111?hl=en | Definitions and formulas for requests, matched requests, match rate, show rate, impressions, eCPM, CTR, rewarded events and rewarded users |
| AdMob — understanding eCPM fluctuation | https://support.google.com/admob/answer/15337570?hl=en | eCPM formula; market, category blocking and price-floor causes; lower eCPM with higher impressions can still raise earnings |
| AdMob — set frequency caps | https://support.google.com/admob/answer/6244508?hl=en | Caps limit impressions per user per period, at app and ad-unit level, apply to Google and third-party demand, take up to 24 hours to apply, and can be slightly exceeded |
| AdMob — policies for ad units that offer rewards | https://support.google.com/admob/answer/7313578?hl=en | Affirmative opt-in, disclosure before each presentation, publisher must deliver the reward on completion |
| AdMob — server-side verification | https://developers.google.com/admob/android/ssv | SSV callback parameters (`reward_amount`, `reward_item`, `transaction_id`, `user_id`, `signature`); grant client-side, validate server-side |
| AdMob — monetize a mobile game with ads | https://admob.google.com/home/resources/monetize-mobile-game-with-ads/ | Frequency capping for interstitials; start low and increase carefully to avoid harming retention; interstitials at natural transition points |
| Google UMP SDK quick start (iOS) | https://developers.google.com/admob/ump/ios/quick-start | `canRequestAds`, `privacyOptionsRequirementStatus`, EEA / UK / Switzerland geography scope |
| Google — personalised and non-personalised ads | https://support.google.com/admob/answer/7676680?hl=en | NPA definition (contextual and coarse geo), consent required where legally required; no revenue-difference claim |
| Firebase — measure ad revenue | https://firebase.google.com/docs/analytics/measure-ad-revenue | `ad_impression` logged automatically for linked AdMob apps; manual logging with value and currency for other mediation |
| Google Analytics — automatically collected events | https://support.google.com/analytics/answer/9234069?hl=en | `session_start`, `user_engagement`, `first_open`, `ad_impression`, `ad_click`, `in_app_purchase` definitions and triggers |
| GameAnalytics — 2026 mobile and PC gaming benchmarks | https://www.gameanalytics.com/reports/2026-mobile-pc-gaming-benchmarks | Global mobile medians for D1 / D7 / D30, sessions per day and playtime; 16,000+ games, 9 regions, calendar 2025; no genre cuts this cycle |
| GameAnalytics — 2025 mobile gaming benchmarks | https://www.gameanalytics.com/reports/2025-mobile-gaming-benchmarks | Puzzle-genre median D1 / D7 / D28 for calendar 2024; 11,600 games, 9 regions, iOS and Android |
| Unity — what is ARPDAU | https://unity.com/blog/what-is-arpdau | ARPDAU definition and formula; applies to ad revenue, IAP revenue or both |
| Google Play — Android vitals core vitals | https://support.google.com/googleplay/android-developer/answer/9844486?hl=en | User-perceived ANR and crash rate definitions; 0.47% and 1.09% overall bad-behaviour thresholds, 8% per device model |
| PocketGamer.biz on Adjust ATT data | https://www.pocketgamer.biz/news/81883/att-opt-in-rates-for-gaming-climb-to-37-as-users-grow-more-data-savvy/ | Gaming ATT opt-in around 37% in Adjust panel data as reported in 2023 — secondary, directional only |
