# Push token registration and Expo/APNs delivery for streak, daily-drop and rival alerts

Research date: 2026-09-02. Slug: `gap-push-notifications-delivery`. Scope: one Cloudflare Worker (Hono 4.13.5, Zod 4.5.4, `@hono/zod-validator` 0.9.1), one `User` Durable Object per player built on `packages/core` `Aggregate`, D1 projection `player_state`, crons `0 * * * *` / `*/5 * * * *` / `0 6 * * *` as decided in `docs/research/README.md`. Everything below was checked against the primary pages cited inline; anything not confirmable is tagged **[UNVERIFIED]** and carries `low` confidence in §Claims.

## Summary

- **Expo Push API is the v1 delivery path** (concepts.md §6 already decided this). Facts verified on docs.expo.dev: `POST https://exp.host/--/api/v2/push/send`, up to **100 messages per request**, **600 notifications/second per project**, tickets come back as `{ data: [{ status: "ok", id }] | [{ status: "error", details: { error } }] }`, receipts are fetched from `POST …/push/getReceipts` with ≤ **1000** ids per call, are **cleared after 24 hours**, and should be checked **~15 minutes after sending**. `DeviceNotRegistered` (in a ticket *or* a receipt) means "stop sending to that token". An access token is **optional by default**, required only when "Enhanced Security for Push Notifications" is on in the EAS dashboard; we turn it on and keep the token as the Worker secret `EXPO_ACCESS_TOKEN`. The official `expo-server-sdk` (7.2.0) depends on `undici` and is not used; the whole client is ~60 lines of `fetch`.
- **The README's scheduling column is broken as specified.** `player_state.local_day_ends_at` is computed *at projection time*, and the projection is rewritten only when `User` state changes. A player who solved yesterday at 15:00 local has `local_day_ends_at = yesterday 24:00`; today's cron query `local_day_ends_at BETWEEN now AND now + 1h` never matches, so exactly the at-risk users never get a reminder. Fix: project the zone's **UTC offset in minutes** (`utc_offset_min`) plus the raw `tz`, and let the hourly cron compute "local time of day" and "local today" in SQL (`date((:now + utc_offset_min*60000)/1000,'unixepoch')`). The predicate becomes `utc_offset_min IN (<offsets whose local clock is in the window right now>) AND last_solved_day = :localYesterday` for the streak warning, and `last_solved_day < :localToday` for the morning drop ping. DST shifts a bucket by one hour at most, which a one-hour window tolerates.
- **Hourly cron beats per-user DO alarms for v1.** Alarms are cheap in money (an alarm is a DO request at $0.15/M; `setAlarm()` is one row write) but expensive in design: the copied `Aggregate` owns the object's *single* alarm for flush retries (`setAlarm` overrides, `deleteAlarm()` on a clean flush), so app alarms need the deferred `nextAppAlarm` multiplex hook; every alarm wakes one object and sends **one** Expo message per HTTP call instead of 100; and every solve/tz change must re-arm. The cron sends the same reminders with ~1 % of the HTTP calls and zero DO hops **if push tokens are projected into D1** (`notifications_push_tokens`, written by the `user` projection like `player_solves`). Keep the DO as source of truth; the table is a rebuildable read model.
- **Budget (Workers Paid plan assumed throughout).** On Paid, a cron with a ≥ 1 h interval gets **15 min CPU** and a **15 min duration** limit; sub-hourly crons get 30 s CPU (on Free, Cron Trigger CPU is only **10 ms**, which rules out this design). Paid plan allows **10,000 subrequests** per invocation (configurable via `limits.subrequests`) and **6 simultaneous connections**. `waitUntil` is documented as 30 s only for HTTP-triggered Workers; in `scheduled()` simply `await` the work. At 100 users per Expo call the hourly tick handles ~100k reminders inside one invocation; a cursor row in `content_meta` makes a crashed/duplicated run resume instead of restart, and the existing `*/5` cron drains leftovers and fetches receipts.
- **Idempotency** = claim-before-send: `INSERT OR IGNORE INTO notifications_sent (user_id, kind, day_key, …)` and only send when `meta.changes === 1`. Two overlapping cron runs (retry behaviour is undocumented; `controller.noRetry()` exists) cannot double-send because D1 serialises the insert. Rows keep the Expo ticket id for the receipt pass.
- **Copy** is a message key + args (`streak_warning`, `daily_drop`, `rival_overtake`) rendered from one catalogue in `packages/shared/notifications-copy.ts` for `en | uk | ru`, chosen by `player_state.lang`; the key and args also travel in `data` so the app can re-render in-app. Nothing in D1 stores prose.
- **Direct APNs (HTTP/2 + ES256 JWT)** is viable later: Apple's requirements are verified (hosts, headers, 4 KB payload, `kid`/`iss`/`iat`, refresh between 20 and 60 minutes, `410 Unregistered`), the ES256 JWT signing step is **verified in workerd** (a workerd 2026-08-28 probe imported an ECDSA P-256 `pkcs8` key and signed/verified ES256 — fact-check of C17), and community projects report production Workers negotiate HTTP/2 to `api.push.apple.com` — but Cloudflare does not document the outbound protocol, and `wrangler dev`/workerd fails against APNs (workerd issue #4841). Only the outbound HTTP/2 hop remains **[UNVERIFIED]**; not for v1.

## Findings

### F1. Expo Push API: send endpoint, batching and rate limits
Source: https://docs.expo.dev/push-notifications/sending-notifications/

- Endpoint `POST https://exp.host/--/api/v2/push/send`; headers `host: exp.host`, `accept: application/json`, `accept-encoding: gzip, deflate`, `content-type: application/json`. Gzip-compressed request bodies are accepted.
- Body is one message object or an array of **up to 100** message objects (error `PUSH_TOO_MANY_NOTIFICATIONS` above that); all messages in one request must belong to the same project (`PUSH_TOO_MANY_EXPERIENCE_IDS`).
- Rate limit **600 notifications per second per project** (`TOO_MANY_REQUESTS`); the docs ask for exponential backoff on HTTP 429 and 5xx.
- Message fields used by Crosscut: `to` (`ExponentPushToken[…]` or an array of them), `title`, `body`, `data` (JSON object), `sound` (`"default"`), `badge`, `ttl` / `expiration`, `priority` (`default|normal|high`), `channelId` (Android channel, must exist client-side), `categoryId`, `collapseId`, `interruptionLevel`, `threadId`. The current page words the size cap as "The total payload must be at most 4096 bytes" (same limit; earlier wording was "4KiB").
- Response 200: `{ "data": [ { "status": "ok", "id": "<ticket uuid>" } | { "status": "error", "message": "…", "details": { "error": "DeviceNotRegistered" | … } } ] }` — one entry per message in request order. Request-level failures use `{ "errors": [{ "code", "message" }] }`. A ticket `ok` "means the message was received by Expo's servers, not that it was received by the user". There is no SLA.

### F2. Expo push receipts and error handling
Source: https://docs.expo.dev/push-notifications/sending-notifications/ ; https://docs.expo.dev/push-notifications/faq/

- `POST https://exp.host/--/api/v2/push/getReceipts` with `{ "ids": [...] }`, ≤ **1000** ids per request (`PUSH_TOO_MANY_RECEIPTS`). Receipts are "cleared after 24 hours"; Expo recommends "checking push receipts 15 minutes after sending".
- Receipt/ticket error codes and required actions: `DeviceNotRegistered` → "stop sending messages to the corresponding Expo push token"; `MessageTooBig` → payload > 4096 bytes; `MessageRateExceeded` → back off and retry slowly; `MismatchSenderId` / `InvalidCredentials` → credentials problem (alert, do not retry); `ExpoPushTokenNotFound`-class errors are treated like `DeviceNotRegistered` in practice [UNVERIFIED that this code is still emitted; not on the current page].
- FAQ: "If one of your users uninstalls the app, you'll receive a `DeviceNotRegistered` error back from Expo's servers. This means you should stop sending notifications to this token." Delivery to Apple/Google is at-least-once: "a notification may be delivered to Google or Apple more than once or not at all, although these cases are rare." The Expo push service is free.

### F3. Expo access token: optional by default, stored as a Worker secret
Sources: https://docs.expo.dev/push-notifications/sending-notifications/ ; https://docs.expo.dev/accounts/programmatic-access/ ; https://developers.cloudflare.com/workers/configuration/secrets/

- "Access tokens are optional by default but can be made required by enabling Enhanced Security for Push Notifications in your EAS Dashboard." When required, send `Authorization: Bearer <token>`; missing/invalid → error code `UNAUTHORIZED`.
- Tokens are minted at https://expo.dev/settings/access-tokens; Expo recommends **robot users** for servers ("can only authenticate via an access token", role-limited, revocable without changing the owner's password).
- Cloudflare: `npx wrangler secret put EXPO_ACCESS_TOKEN` (creates and deploys a new Worker version); locally in `.dev.vars` or `.dev.vars.<environment-name>` per environment, or alternatively in `.env` / `.env.<environment-name>` (dotenv syntax); read as `env.EXPO_ACCESS_TOKEN: string`. Cloudflare recommends git-ignoring both `.dev.vars*` and `.env*`.

### F4. Client side (Expo app): obtaining and refreshing the token
Sources: https://docs.expo.dev/push-notifications/push-notifications-setup/ ; https://docs.expo.dev/versions/latest/sdk/notifications/ ; https://docs.expo.dev/push-notifications/faq/ ; `npm view expo-notifications version` → 57.0.16; `npm view expo version` → 57.0.19

- Token: `Notifications.getExpoPushTokenAsync({ projectId })`, `projectId` from `Constants.expoConfig.extra.eas.projectId`; requires prior permission (`getPermissionsAsync` / `requestPermissionsAsync`; on iOS trust `ios.status`, not the root `status`). On Android a notification channel must exist before requesting the token (documented against the Android 13 permission prompt; `setNotificationChannelAsync('default', …)` should run before the token call).
- Expo Go does not support push notifications on Android from SDK 53 onward; on all platforms, use a development build to test push. iOS needs an APNs key set up through EAS (`eas build` prompts "Setup Push Notifications for your project"); Android needs FCM credentials.
- Stability: "The ExpoPushToken remains the same across app upgrades. On Android, reinstalling the app may result in the token changing. On iOS, the token also remains the same even after uninstalling the app and reinstalling it." `addPushTokenListener` fires "in rare situations" when the service rotates the token → the app must re-`POST /v1/me/push-tokens` on every launch and on that listener (idempotent).
- `expo-server-sdk` 7.2.0 depends on `undici`, `promise-limit`, `promise-retry` — consistent with concepts.md §6 ("the Node SDK has had Workers compatibility issues"); not used.

### F5. Workers limits that bound a fan-out cron
Source: https://developers.cloudflare.com/workers/platform/limits/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ ; https://developers.cloudflare.com/workers/runtime-apis/context/

- Subrequests per invocation: Free **50**, Paid **10,000** (configurable per Worker with `limits.subrequests`; "A subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1"). "Each Worker invocation can have up to six connections simultaneously waiting for response headers."
- CPU time: Paid **30 s** (< 1 hour interval), **15 min** (>= 1 hour interval); Free plan Cron Trigger CPU only **10 ms**, which rules out this design. Default Paid HTTP CPU is 30 s, configurable to 5 min via `limits.cpu_ms`. Duration: HTTP no limit; **Cron Trigger 15 min**; Durable Object alarm 15 min. Memory 128 MB per isolate. Cron Triggers per account: 5 Free / 250 Paid.
- `ctx.waitUntil()` "can extend execution for up to 30 seconds after the response is sent or the client disconnects" — stated for HTTP-triggered Workers; the context page does not describe `waitUntil` in `scheduled()`. The scheduled-handler page says the runtime waits for the handler's promise ("You do not need to use `waitUntil()` for the runtime to wait for a single asynchronous task"; "The first `ctx.waitUntil` to fail will be observed and recorded as the status"). Consequence: in the cron, `await` the send loop directly; never rely on the 30 s `waitUntil` window.
- Wrangler keys: `"triggers": { "crons": [...] }`, `"limits": { "cpu_ms": …, "subrequests": … }`.

### F6. Scheduled handler contract and retry semantics
Sources: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ ; https://developers.cloudflare.com/workers/configuration/cron-triggers/ ; `docs/research/durable-objects-d1-domain.md` F9/C12

- `async scheduled(controller, env, ctx)`; `controller.cron` (the trigger expression), `controller.scheduledTime` (ms since epoch, UTC), `controller.noRetry()` (typed in `@cloudflare/workers-types`; note: `controller.type` is documented on the runtime page but not in the TypeScript types). Crons run in UTC. Local test: `wrangler dev --test-scheduled` exposes `/__scheduled` (legacy) and both routes `/__scheduled` and `/cdn-cgi/handler/scheduled?cron=0+*+*+*+*&time=<ms>` work in `wrangler dev` and the Vite plugin.
- Retry/at-least-once policy is **undocumented** (README U2). Design every tick for both a skipped and a duplicated run, using UTC-hour window keys and D1 claims (F10).

### F7. Durable Object alarms: single alarm, retries, cost
Sources: https://developers.cloudflare.com/durable-objects/api/alarms/ ; https://developers.cloudflare.com/durable-objects/platform/pricing/ ; `/Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts` lines 170–248

- "Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`"; a second call overrides the first. Alarms have "guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws" with "exponential backoff starting at a 2 second delay … up to 6 retries"; only one `alarm()` runs at a time per object.
- The copied `Aggregate` uses that single alarm for projection retries: `#scheduleRetry()` → `ctx.storage.setAlarm(Date.now() + delay)`, `flush()` → `deleteAlarm()` once `version <= projected`, `alarm()` → `flush()`. Any app alarm (a per-user reminder) requires the `nextAppAlarm` multiplex hook the README explicitly defers ("no app-level alarms in v1").
- Pricing (Workers Paid): requests "1 million / month, + $0.15/million" and the request metric "includes … alarm invocations"; duration "400,000 GB-s / month, + $12.50/million GB-s"; SQLite rows written "First 50 million / month included + $1.00 / million rows" and "Each setAlarm() is billed as a single row written".

### F8. D1 limits that shape the SQL
Source: https://developers.cloudflare.com/d1/platform/limits/

- "Maximum bound parameters per query" **100**; SQL statement length 100 KB; query duration 30 s; limits apply per statement inside `batch()`. Token `IN (...)` lists and ticket-id updates must be chunked at ≤ 90 parameters.

### F9. Direct APNs from a Worker (later replacement) — partly UNVERIFIED
Sources: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns ; https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns ; https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns ; https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ ; https://github.com/cloudflare/workerd/issues/4841 ; https://github.com/FiveSheepCo/cloudflare-apns2 ; https://developers.cloudflare.com/workers/reference/protocols/

- Apple (verified): "Use HTTP/2 and TLS 1.2 or later"; hosts `api.push.apple.com:443` (prod) and `api.sandbox.push.apple.com:443` (dev), port 2197 alternative; `POST /3/device/<device_token>`; headers `authorization: bearer <jwt>`, `apns-topic` (bundle id), `apns-push-type: alert`, `apns-priority` (10 immediate / 5 power-aware), `apns-expiration`, `apns-collapse-id` (≤ 64 bytes), optional `apns-id`; payload "limited to a maximum size of 4 KB (4096 bytes)", uncompressed. Token auth: JWT header `{ alg: "ES256", kid }`, claims `{ iss: <10-char Team ID>, iat }`; "Refresh your token no more than once every 20 minutes and no less than once every 60 minutes"; stale → `403 ExpiredProviderToken`; too frequent → `429 TooManyProviderTokenUpdates`. `410 Unregistered`: "There is no need to send further pushes to the same device token"; do not retry `BadDeviceToken`, `Unregistered`, `ExpiredToken`, `PayloadTooLarge`, `DeviceTokenNotForTopic`, or `Forbidden`; retry with delay on `TooManyRequests`.
- Cloudflare WebCrypto lists ECDSA as supported for `sign`, `verify`, `importKey`, `exportKey`. A workerd 2026-08-28 probe confirmed P-256 + `pkcs8` import of the `.p8` key works and can sign/verify ES256 tokens, so this step is verified for workerd (production uses the same V8/ICU build).
- Outbound protocol: Cloudflare's Workers docs never state whether `fetch()` to an origin uses HTTP/2; the "Protocols" page only lists "Make HTTP subrequests using the fetch() API". workerd issue #4841 (2025-08-20) reports APNs `fetch` "works correctly when deployed to production Cloudflare Workers" but fails locally, and `@fivesheepco/cloudflare-apns2` exists for exactly this. Treat "production Workers can talk HTTP/2 to APNs" as **[UNVERIFIED]** (community evidence only) and "local workerd cannot" as observed. If adopted, keep the Expo path as the local/dev fallback and test APNs only with `wrangler dev --remote` or in staging.

### F10. Existing Crosscut decisions this design plugs into
Sources: `docs/research/README.md` §Modules, §Crons, §Event catalog, §D1 schema; `IOSApp concepts/concepts.md` §6; handoff README §6; `docs/research/testing-and-dx.md` C8

- `notifications` module is a stub ("no push delivery in v1"), depends on `shared`, `events`, `player`; subscribes to `player.streakExtended` (no-op) and the cron; owns `notifications_reminders_sent (user_id, day_key, sent_at)`. `UserState.pushTokens: string[]` exists with no endpoint. `player_state` has `tz`, `lang`, `last_solved_day`, `local_day_ends_at`, `push_token_count`, index `(local_day_ends_at, last_solved_day)`. Events: `player.onboarded {…, notifications, tz}` → `notifications.scheduleReminderOptIn`; `solve.finished` → `notifications.cancelReminder` (background); `player.streakExtended`.
- concepts.md §6: tokens live in the `User` aggregate; a `Notifications` entrypoint calls the Expo Push API with plain `fetch`; `DeviceNotRegistered` removes the token via a `User` command. Handoff §6: three notification types (streak warning, daily-drop ping, rival overtake); the OS prompt fires only on "Enable notifications"; both buttons continue to Paywall.
- Testing: `fetchMock` is gone from `cloudflare:test`; use `@msw/cloudflare` `setupNetwork()` (0.0.1, peer `msw >= 2.14.1`; msw latest 2.15.0) or mock `globalThis.fetch`. Fake `Date` via `vi.setSystemTime()` is visible inside DOs and the main Worker.

### F11. Why `local_day_ends_at` cannot drive reminders (defect in the current README)
Source: `docs/research/durable-objects-d1-domain.md` line 513 (`local_day_ends_at: endOfLocalDay(Date.now(), s.tz)` inside `Projections.projections()`), README §D1 schema

The column is evaluated when the projection row is written, i.e. on the last state change. Reminder candidates are, by definition, users who have not changed state today. For the streak-warning case (`last_solved_day === yesterday`) the row was last written yesterday, so `local_day_ends_at` ≤ yesterday's midnight and the window query `BETWEEN now AND now + 3h` is empty. Only users who opened the app today (a read does not commit; a like or tz change does) would be found. The offset-bucket design in §Recommendation replaces the column; keep `tz` for exact per-user rendering and for rebuilding offsets after a DST change (the 06:00 daily cron can refresh `utc_offset_min` for all rows in SQL-free batches, or the projection can be rebuilt with `reproject()`).

## Recommendation for Crosscut

### 1. API surface (gateway, `deviceAuth`, `/v1`)

| Method | Path | Body (Zod) | Response | Notes |
|---|---|---|---|---|
| POST | `/v1/me/push-tokens` | `RegisterPushToken` | 200 `{ tokens: number }` | Idempotent upsert keyed by token; `User.addPushToken`; call on every app launch and on `addPushTokenListener` |
| DELETE | `/v1/me/push-tokens` | `{ token }` | 200 `{ tokens: number }` | `User.removePushToken`; also called on logout/reset; absent token is a no-op commit |
| PATCH | `/v1/me/prefs` | existing partial + `notifications?: NotificationPrefsPatch` | `/me` shape | `status` records the pre-prompt outcome; per-kind toggles default `true` once `status === "enabled"` |

`RegisterPushToken`: `token` must match `/^ExponentPushToken\[[A-Za-z0-9_-]{10,64}\]$/` (Expo's documented format; also accept `ExpoPushToken[...]` [UNVERIFIED that Expo still issues that older prefix]); `platform: "ios" | "android"` (web push is out of scope: Expo push tokens are native-only); `installId: uuid` (ties the token to the `/devices` install so a reinstall replaces, not accumulates); optional `appVersion`. Cap **5 tokens per user**, evicting the oldest `lastSeenAt`.

`NotificationPrefs` (in `UserState.prefs.notifications`, replacing the plain enum): `{ status: "enabled" | "declined" | "skipped" | "revoked", streak: boolean, drop: boolean, rival: boolean, dropHourLocal: 9 }`. `revoked` is set by the server when every token has been invalidated, so `/me` can show the "notifications off" state without the client re-prompting.

### 2. `User` aggregate commands and projection

- `addPushToken({ token, platform, installId, appVersion?, now })` → replaces any entry with the same `token` *or* the same `installId`, bumps `lastSeenAt`, caps to 5. Equal state ⇒ free no-op commit (daily re-registration costs nothing).
- `removePushToken({ token, reason: "user" | "device_not_registered" | "invalid_credentials" })` → filters the list; if it becomes empty and `reason !== "user"`, sets `prefs.notifications.status = "revoked"`.
- `setNotificationPrefs(patch)` → merges; emits `player.prefsChanged`.
- Projection (`Projections.apply` override for `kind === "user"`, same `DB.batch` as `player_state` + `player_solves`): add columns `utc_offset_min INTEGER NOT NULL`, `notif_status TEXT`, `notif_streak INTEGER`, `notif_drop INTEGER`, `notif_rival INTEGER`, `notif_drop_hour INTEGER`, keep `push_token_count`; **drop** `local_day_ends_at`. Write the token table: `DELETE FROM notifications_push_tokens WHERE user_id = ?` + `INSERT … VALUES (?, ?, ?, ?, ?)` per token (≤ 5 rows; both inside the atomic batch; `INSERT OR REPLACE` on `token` PK so a token that moved between users is re-owned). Index `player_state (utc_offset_min, last_solved_day)`.
- `utc_offset_min` from `tz`: `Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(now))` → `"GMT+03:00"` → parse minutes; workerd 2026-08-28 confirmed this works and produces correct offsets like `GMT+05:30` for Asia/Kolkata (fallback: compute from `formatToParts` year…second if needed).

### 3. Scheduling model

**Chosen: hourly cron over `player_state` offset buckets + projected tokens.** Comparison:

| Criterion | Hourly cron scan (chosen) | One DO alarm per user |
|---|---|---|
| Core `Aggregate` constraint | none; no alarm involved | needs `nextAppAlarm` multiplex hook (deferred in README) or the reminder is lost when a flush retry calls `setAlarm`/`deleteAlarm` |
| Re-arming | none; the query re-evaluates state each tick | on every solve, tz change, pref change, token removal |
| DO requests / day (50k DAU) | 0 for the scan; 1 per `DeviceNotRegistered` | ~50k alarm wakes + 50k `setAlarm` row writes (≈ $0.0075 + within included rows) — cheap, but each wake also pays duration |
| Expo HTTP calls / day | ≈ (unsolved users)/100 (≈ 150–300) | one per user (≈ 15k–30k); 600/s cap easy either way |
| Precision | ±1 h window in local time (DST ±1 h) | exact minute |
| Duplicate/skipped ticks | window key + claim row make it safe | alarm at-least-once; needs same claim row |
| Testability | pure function of `(now, D1)`; `?time=` in local test | `runDurableObjectAlarm` per object |

Alarms are the upgrade if exact-minute delivery (e.g. "30 minutes left") ever matters; the claim table and the copy catalogue carry over unchanged.

**Windows (all in the user's local clock, derived in SQL from `utc_offset_min`):**

| Kind | Window | Predicate (besides `notif_status='enabled' AND notif_<kind>=1 AND push_token_count>0`) | Dedupe key |
|---|---|---|---|
| `streak_warning` | 20:00–20:59 local (≈ 3–4 h left, matches the feed card's "One Mini keeps it alive") | `last_solved_day = :localYesterday` (streak actually at risk; a broken or zero streak gets nothing) | `(user_id, 'streak', localToday)` |
| `daily_drop` | `notif_drop_hour`:00–:59 local (default 09) | `last_solved_day IS NULL OR last_solved_day < :localToday` and a drop exists for `(localToday, lang)` in `content_daily_drops` | `(user_id, 'drop', localToday)` |
| `rival_overtake` | event-driven from the `*/5` leaderboard cron, suppressed 23:00–08:00 local | rank worsened since previous materialisation and `notif_rival=1`; at most one per user per local day; only ranks ≤ 500 to bound volume | `(user_id, 'rival', localToday)` |

Local-time arithmetic in SQLite: `local_ms = :now + utc_offset_min*60000`; `local_hour = (local_ms / 3600000) % 24` (integer division); `localToday = date(local_ms/1000, 'unixepoch')`; `localYesterday = date(local_ms/1000, 'unixepoch', '-1 day')`. Because the cron ticks at `:00` UTC and offsets are whole or half hours (a few zones use :45), select the offsets whose local hour equals the target hour for `local_ms` at tick time; the half-hour zones land in the window on the tick where their local clock reads 20:30/09:30, which is still inside the hour window. Use the tick's `controller.scheduledTime`, not `Date.now()`, so a delayed or retried run computes the same window and the same `windowKey = "<kind>:<scheduledTime ISO hour>"`.

**Rival overtake** from `leaderboard_week` diffs: extend the `*/5` materialisation to write into `leaderboard_week_new`, then `SELECT n.user_id, n.rank, o.rank AS old_rank, (SELECT display_name …) AS passer FROM leaderboard_week_new n JOIN leaderboard_week o USING (week_key, user_id) WHERE n.rank > o.rank AND n.rank <= 500`, then swap tables in one batch. The passer is the user now at `old_rank` (first user whose new rank ≤ old_rank and old rank > old_rank of the victim; approximate is fine — copy says "someone passed you" when ambiguous). Cost: bounded by 500 rows per run; sends go through the same claim + batch path.

### 4. Dedupe, idempotency, chunking

Replace `notifications_reminders_sent` with:

```sql
CREATE TABLE notifications_sent (
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- 'streak' | 'drop' | 'rival'
  day_key     TEXT NOT NULL,             -- user-local day
  window_key  TEXT NOT NULL,             -- 'streak:2026-09-02T17' (UTC hour of the tick) — diagnostics only
  status      TEXT NOT NULL DEFAULT 'claimed',  -- claimed | sent | failed | skipped
  claimed_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  ticket_ids  TEXT,                      -- JSON array (one per token)
  receipt_checked_at INTEGER,
  PRIMARY KEY (user_id, kind, day_key)
);
CREATE INDEX notifications_sent_receipts ON notifications_sent (status, receipt_checked_at, sent_at);
```

- **Claim before send**: `INSERT OR IGNORE … VALUES (?, ?, ?, ?, 'claimed', ?)`; `meta.changes === 0` ⇒ another run already owns this user/day → skip. D1 serialises writes, so overlapping ticks (undocumented retries, manual `/cdn-cgi/handler/scheduled` double-fires, the `*/5` drain overlapping the hourly run) cannot both send. Claims older than 10 minutes still in `claimed` (a run died between claim and send) are re-taken by the drain job within the same window; after the window they are marked `failed` (a missed reminder beats a late one).
- **Chunking**: page candidates `ORDER BY id LIMIT 500` with `id > :cursor`; per page, claim in one `DB.batch` of ≤ 500 inserts (each insert ≤ 6 params; statement count in a batch has no documented cap), join tokens, build ≤ 100-message Expo bodies, send with concurrency 4 (below the 6-connection cap), then `UPDATE notifications_sent SET status='sent', sent_at=?, ticket_ids=? WHERE user_id=? AND kind=? AND day_key=?` in one batch. Persist `content_meta['notifications.cursor']` = `{ windowKey, kind, lastId, done }` after each page; a run that starts with a matching `windowKey` resumes from `lastId`; a different `windowKey` resets. Hard stop after `MAX_PAGES = 40` (20k users, ≈ 200 Expo calls + ≈ 120 D1 calls, far below 10,000 subrequests) or when `Date.now() - startedAt > 10 min` (leaving margin under the 15 min cron ceiling); the `*/5` drain continues the same cursor while `done === false`.
- **Backoff**: HTTP 429/5xx from Expo → retry the same chunk after 1 s, 2 s, 4 s (three tries), then mark those users `failed` and continue; never re-claim. Ticket `DeviceNotRegistered` → collect `(userId, token)` and call `User.removePushToken` after the page (≤ N DO subrequests per page; typically a handful). Ticket `InvalidCredentials`/`MismatchSenderId` → abort the run with an error log (06:00 health cron surfaces the last cron error from `content_meta['notifications.lastError']`).
- **Receipts**: the `*/5` cron selects `status='sent' AND receipt_checked_at IS NULL AND sent_at < now - 15 min AND sent_at > now - 23 h`, up to 1000 ticket ids per `getReceipts` call (chunk the D1 `UPDATE … WHERE (user_id,kind,day_key) IN` at ≤ 30 rows × 3 params), applies `DeviceNotRegistered` → `removePushToken`, marks `receipt_checked_at`. Receipts not yet available stay unchecked until the next pass; rows older than 24 h are marked checked without a call (Expo has discarded them).
- **`solve.finished` handler** (`notifications.cancelReminder`, background): `INSERT OR IGNORE INTO notifications_sent (…, status) VALUES (?, 'streak', ?, 'solved', 'skipped', ?)` — pre-claims today's streak slot so a solve at 19:59 local and a tick at 20:00 cannot race into a pointless warning (the SQL predicate already excludes solved users; the claim closes the read-then-send gap between the projection flush and the cron's read).

### 5. Copy localisation (en / uk / ru) as message keys

- `packages/shared/notifications-copy.ts` exports `MESSAGE_KEYS = ["streak_warning", "daily_drop", "rival_overtake"] as const` and `renderPush(key, lang, args)` returning `{ title, body }` from a per-language table; the server never composes prose elsewhere. `data` carries `{ key, args, v: 1, deeplink }` so the app can re-render (`crosscut://feed`, `crosscut://puzzles/<id>`, `crosscut://leaderboard`).
- Language = `player_state.lang` (the puzzle language the player chose; the handoff's Language step is the only locale signal we hold). `uk`/`ru` strings must come from the editors, not from a translation of the English placeholders; the sketch marks them `TODO copy`.
- Payload budget: title ≤ 40 chars, body ≤ 120 chars, `data` ≤ 300 bytes — far under the maximum of 4096 bytes; `collapseId = key` so a late duplicate replaces rather than stacks; `channelId: "reminders"` (the app creates it); `priority: "high"` for the streak warning only, `default` otherwise; `ttl: 3 * 3600` for the streak warning (worthless after midnight), `ttl: 8 * 3600` for the drop ping, `ttl: 24 * 3600` for rival.

### 6. Tests (workerd, `@cloudflare/vitest-plugin` + `@msw/cloudflare`)

Per `testing-and-dx.md`: `setupNetwork()` in `test/network.ts`, `network.enable()` in `beforeAll`, `resetHandlers()` in `afterEach`. Handlers record every request body so assertions can count messages. Call the scheduled handler directly with `createScheduledController` from `cloudflare:test`: import the worker module directly and call `await worker.scheduled(createScheduledController({ scheduledTime: new Date(...).getTime(), cron: '0 * * * *' }), env, ctx)` with `ctx = createExecutionContext()` then `await waitOnExecutionContext(ctx)`. Do not use `exports.default.scheduled({...}, env, ctx)` — that is the experimental service-binding method, which has a different signature and requires a compatibility flag. Fixtures seed `player_state` rows directly (the projection is a plain table) and register tokens through `exports.User` stubs when the DO path matters.

Required cases:
1. **One reminder per user per day**: user in `Europe/Kyiv` (+180), `last_solved_day = yesterday`, tick at 17:00Z (20:00 local) → exactly one Expo request with one message; the same tick again → zero requests; tick at 18:00Z → zero; next day 17:00Z with `last_solved_day` unchanged (streak now broken) → zero; with `last_solved_day = that day - 1` → one.
2. **Window selection across offsets**: 20 users in 20 offsets, one tick → only the offset whose local hour is 20 is selected; for a `+330` (Kolkata) user, the 14:00Z tick must *not* select them (local 19:30, outside the 20:xx window) and the 15:00Z tick must (local 20:30, inside).
3. **Solved users excluded** and the `solve.finished` pre-claim prevents a send even if the projection row is stale.
4. **Preferences**: `notif_streak = 0` or `notif_status = 'declined'` → no send; `push_token_count = 0` → no send and no claim row.
5. **Chunking**: 250 candidate users with one token each → three POSTs of 100/100/50; 2 tokens per user → messages counted per token, still one claim row per user.
6. **DeviceNotRegistered in a ticket** → `User.removePushToken` called, `notifications_push_tokens` row gone after the flush, `push_token_count` decremented, `notif_status = 'revoked'` when it was the last token.
7. **DeviceNotRegistered in a receipt**: send at T, `*/5` tick at T + 16 min with a `getReceipts` handler returning the error → same effects; at T + 5 min → no receipt call.
8. **429 then 200**: first POST answers 429, retries succeed; one claim row, one `sent` row, two recorded requests.
9. **Resume from cursor**: handler set to throw after page 1; rerun the same `scheduledTime` → continues from `lastId`, no duplicate messages; rerun with a different hour → cursor reset.
10. **Localisation**: `lang = 'uk'` row receives the `uk` title/body and `data.key = 'streak_warning'`.
11. **Rival overtake**: seed `leaderboard_week` old/new, run the leaderboard cron → one message for the user whose rank worsened, none for the passer, none when the local hour is 02:00.

### 7. Implementation order (fits README milestones)
M2 adds the schemas, `User` commands and projection columns (migration `0002_player.sql` gains `utc_offset_min`, `notif_*`, and `notifications_push_tokens`; `local_day_ends_at` is not created). M5 ships the `notifications` module: Expo client, `runReminderTick`, `runReceiptsPass`, rival diff, copy catalogue, tests above; `wrangler secret put EXPO_ACCESS_TOKEN` and the EAS "Enhanced Security" toggle happen before the first TestFlight build. APNs-direct stays in "Later".

## Code sketches

### Zod schemas and routes (`modules/notifications/http.ts`)

```ts
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

export const ExpoPushToken = z.string().regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,64}\]$/, "expo_push_token");
export const RegisterPushToken = z.object({
  token: ExpoPushToken,
  platform: z.enum(["ios", "android"]),
  installId: z.uuid(),
  appVersion: z.string().max(32).optional(),
});
export const RemovePushToken = z.object({ token: ExpoPushToken });
export const NotificationPrefsPatch = z.object({
  status: z.enum(["enabled", "declined", "skipped"]).optional(),
  streak: z.boolean().optional(),
  drop: z.boolean().optional(),
  rival: z.boolean().optional(),
  dropHourLocal: z.int().min(5).max(12).optional(),
}).strict();

export const pushTokenRoutes = new Hono<AppEnv>()
  .post("/v1/me/push-tokens", deviceAuth, zValidator("json", RegisterPushToken, hook), async (c) => {
    const { userId } = c.get("auth");
    const snap = await c.get("modules").player.addPushToken(userId, { ...c.req.valid("json"), now: Date.now() });
    return c.json({ tokens: snap.state.pushTokens.length });
  })
  .delete("/v1/me/push-tokens", deviceAuth, zValidator("json", RemovePushToken, hook), async (c) => {
    const { userId } = c.get("auth");
    const snap = await c.get("modules").player.removePushToken(userId, { token: c.req.valid("json").token, reason: "user" });
    return c.json({ tokens: snap.state.pushTokens.length });
  });
// PATCH /v1/me/prefs: extend the existing PrefsPatch with `notifications: NotificationPrefsPatch.optional()`.
```

### `User` commands (`modules/player/user.ts`)

```ts
type PushToken = { token: string; platform: "ios" | "android"; installId: string; appVersion?: string; addedAt: number; lastSeenAt: number };
const MAX_PUSH_TOKENS = 5;

addPushToken(input: { token: string; platform: "ios" | "android"; installId: string; appVersion?: string; now: number }) {
  return this.commit((s) => {
    const kept = s.pushTokens.filter((t) => t.token !== input.token && t.installId !== input.installId);
    const prev = s.pushTokens.find((t) => t.token === input.token);
    const next = [...kept, { ...input, addedAt: prev?.addedAt ?? input.now, lastSeenAt: input.now }]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_PUSH_TOKENS);
    // lastSeenAt changes on every launch → the commit is NOT a no-op; round it to the day so daily re-registration is free:
    next[0].lastSeenAt = dayStart(input.now);
    return { ...s, pushTokens: next };
  });
}

removePushToken(input: { token: string; reason: "user" | "device_not_registered" | "invalid_credentials" }) {
  return this.commit((s) => {
    const pushTokens = s.pushTokens.filter((t) => t.token !== input.token);
    const revoked = pushTokens.length === 0 && input.reason !== "user" && s.prefs.notifications.status === "enabled";
    return { ...s, pushTokens, prefs: { ...s.prefs, notifications: { ...s.prefs.notifications, status: revoked ? "revoked" : s.prefs.notifications.status } } };
  });
}
```

### Projection additions (`Projections.apply`, same `DB.batch` as `player_state`/`player_solves`)

```ts
const cols = { /* existing columns … minus local_day_ends_at */
  tz: s.tz, utc_offset_min: utcOffsetMinutes(s.tz, now), lang: s.lang,
  notif_status: s.prefs.notifications.status, notif_streak: +s.prefs.notifications.streak,
  notif_drop: +s.prefs.notifications.drop, notif_rival: +s.prefs.notifications.rival,
  notif_drop_hour: s.prefs.notifications.dropHourLocal, push_token_count: s.pushTokens.length };
const stmts = [
  upsert(player_state, cols), ...solveInserts,
  db.prepare("DELETE FROM notifications_push_tokens WHERE user_id = ?").bind(id),
  ...s.pushTokens.map((t) => db.prepare(
    "INSERT OR REPLACE INTO notifications_push_tokens (token, user_id, platform, install_id, updated_at) VALUES (?,?,?,?,?)")
    .bind(t.token, id, t.platform, t.installId, now)),
];
await db.batch(stmts);

export function utcOffsetMinutes(tz: string, nowMs: number): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(nowMs));
  const offset = p.find((x) => x.type === "timeZoneName")?.value;  // "GMT+03:00" format
  if (offset) {
    const sign = offset[3] === '-' ? -1 : 1;
    const [h, m] = offset.slice(4).split(':').map(Number);
    return sign * (h * 60 + (m || 0));
  }
  // Fallback: compute from formatToParts year…second
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - Math.floor(nowMs / 1000) * 1000) / 60000);
}
```

### Hourly tick (`modules/notifications/reminders.ts`)

```ts
export async function runReminderTick(env: Env, deps: Deps, scheduledTime: number, kind: "streak" | "drop") {
  const windowKey = `${kind}:${new Date(scheduledTime).toISOString().slice(0, 13)}`;
  const cursor = await loadCursor(env.DB, windowKey);          // content_meta['notifications.cursor']
  if (cursor.done) return;
  const started = Date.now();
  const targetHourSql = kind === "streak" ? "20" : "notif_drop_hour";
  for (let page = 0; page < MAX_PAGES && Date.now() - started < 10 * 60_000; page++) {
    const rows = await env.DB.prepare(`
      SELECT p.id, p.lang, p.streak, date((? + p.utc_offset_min*60000)/1000,'unixepoch') AS local_today,
             t.token
      FROM player_state p JOIN notifications_push_tokens t ON t.user_id = p.id
      WHERE p.notif_status = 'enabled' AND p.notif_${kind} = 1 AND p.push_token_count > 0
        AND ((? + p.utc_offset_min*60000) / 3600000) % 24 = ${targetHourSql}
        AND ${kind === "streak"
          ? "p.last_solved_day = date((? + p.utc_offset_min*60000)/1000,'unixepoch','-1 day')"
          : "(p.last_solved_day IS NULL OR p.last_solved_day < date((? + p.utc_offset_min*60000)/1000,'unixepoch'))"}
        AND p.id > ?
      ORDER BY p.id LIMIT 500`).bind(scheduledTime, scheduledTime, scheduledTime, cursor.lastId).all<Row>();
    if (rows.results.length === 0) { await saveCursor(env.DB, { windowKey, lastId: cursor.lastId, done: true }); return; }

    const byUser = groupBy(rows.results, (r) => r.id);
    const claims = await env.DB.batch([...byUser.keys()].map((uid) => env.DB.prepare(
      "INSERT OR IGNORE INTO notifications_sent (user_id, kind, day_key, window_key, status, claimed_at) VALUES (?,?,?,?,'claimed',?)")
      .bind(uid, kind, byUser.get(uid)![0].local_today, windowKey, Date.now())));
    const winners = [...byUser.keys()].filter((_, i) => claims[i].meta.changes === 1);

    const messages = winners.flatMap((uid) => byUser.get(uid)!.map((r) => buildMessage(kind, r)));
    const outcome = await deps.expo.sendAll(messages);           // chunks of 100, concurrency 4, backoff on 429/5xx
    await env.DB.batch(winners.map((uid) => env.DB.prepare(
      "UPDATE notifications_sent SET status=?, sent_at=?, ticket_ids=? WHERE user_id=? AND kind=? AND day_key=?")
      .bind(outcome.failed.has(uid) ? "failed" : "sent", Date.now(), JSON.stringify(outcome.tickets.get(uid) ?? []), uid, kind, byUser.get(uid)![0].local_today)));
    for (const { userId, token } of outcome.deviceNotRegistered)
      await deps.player.removePushToken(userId, { token, reason: "device_not_registered" });

    cursor.lastId = rows.results.at(-1)!.id;
    await saveCursor(env.DB, { windowKey, lastId: cursor.lastId, done: rows.results.length < 500 });
  }
}
```

### Expo client (`modules/notifications/expo.ts`, plain `fetch`)

```ts
const SEND = "https://exp.host/--/api/v2/push/send";
const RECEIPTS = "https://exp.host/--/api/v2/push/getReceipts";
type Ticket = { status: "ok"; id: string } | { status: "error"; message: string; details?: { error?: string } };

export function createExpoClient(opts: { accessToken?: string; fetch?: typeof fetch }) {
  const f = opts.fetch ?? fetch;
  const headers = { accept: "application/json", "content-type": "application/json", "accept-encoding": "gzip, deflate",
    ...(opts.accessToken ? { authorization: `Bearer ${opts.accessToken}` } : {}) };
  async function post<T>(url: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await f(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (res.ok) return (await res.json()) as T;
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
      throw new Error(`expo ${res.status}: ${await res.text()}`);
    }
  }
  return {
    async sendAll(messages: ExpoMessage[]) {          // ExpoMessage includes `_userId` stripped before sending
      const chunks = chunk(messages, 100);
      const tickets = await mapConcurrent(chunks, 4, (c) => post<{ data: Ticket[] }>(SEND, c.map(({ _userId, ...m }) => m)));
      /* zip tickets back to messages; collect DeviceNotRegistered → (userId, token); ok → ticket ids per user */
    },
    getReceipts(ids: string[]) { return post<{ data: Record<string, { status: "ok" } | { status: "error"; details?: { error?: string } }> }>(RECEIPTS, { ids: ids.slice(0, 1000) }); },
  };
}
```

### Copy catalogue (`packages/shared/notifications-copy.ts`)

```ts
export type PushKey = "streak_warning" | "daily_drop" | "rival_overtake";
type Args = { streak?: number; hoursLeft?: number; puzzleTitle?: string; rival?: string };
const COPY: Record<Lang, Record<PushKey, (a: Args) => { title: string; body: string }>> = {
  en: {
    streak_warning: (a) => ({ title: `${a.streak}-day streak at risk`, body: `About ${a.hoursLeft}h left today. One Mini keeps it alive.` }),
    daily_drop:     (a) => ({ title: "Today's puzzle is up", body: a.puzzleTitle ? `${a.puzzleTitle} just dropped.` : "A fresh grid is waiting in your feed." }),
    rival_overtake: (a) => ({ title: "You've been passed", body: `${a.rival ?? "Someone"} just passed you on this week's board.` }),
  },
  uk: { /* TODO copy from the Kyiv editorial desk */ },
  ru: { /* TODO copy */ },
};
export function renderPush(key: PushKey, lang: Lang, args: Args) { return (COPY[lang] ?? COPY.en)[key](args); }

// buildMessage(kind, row):
//   { to: row.token, ...renderPush(key, row.lang, args), sound: "default", priority: kind === "streak" ? "high" : "default",
//     channelId: "reminders", collapseId: key, ttl: TTL[kind], data: { v: 1, key, args, deeplink: DEEPLINK[kind] } }
```

### Test skeleton (`test/notifications.test.ts`)

```ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext, createScheduledController } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { network } from "./network";
import worker from "../src/index";

const sent: unknown[][] = [];
beforeEach(() => { sent.length = 0; network.use(http.post("https://exp.host/--/api/v2/push/send", async ({ request }) => {
  const body = (await request.json()) as unknown[]; sent.push(body);
  return HttpResponse.json({ data: body.map((_, i) => ({ status: "ok", id: `t${sent.length}-${i}` })) });
})); });

async function tick(iso: string) {
  const ctx = createExecutionContext();
  const ms = Date.parse(iso);
  await worker.scheduled(createScheduledController({ scheduledTime: ms, cron: "0 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

it("sends exactly one streak warning per user per local day", async () => {
  await seedPlayer(env.DB, { id: "u_1", tz: "Europe/Kyiv", utc_offset_min: 180, last_solved_day: "2026-09-01", notif_status: "enabled", notif_streak: 1, tokens: ["ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]"] });
  await tick("2026-09-02T17:00:00Z");   // 20:00 in Kyiv
  await tick("2026-09-02T17:00:00Z");   // duplicated run
  await tick("2026-09-02T18:00:00Z");   // next hour
  expect(sent.flat()).toHaveLength(1);
  const rows = await env.DB.prepare("SELECT status FROM notifications_sent WHERE user_id='u_1'").all();
  expect(rows.results).toEqual([{ status: "sent" }]);
});
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | Expo send endpoint is `POST https://exp.host/--/api/v2/push/send`; a request holds at most 100 messages (`PUSH_TOO_MANY_NOTIFICATIONS`); rate limit 600 notifications/s per project (`TOO_MANY_REQUESTS`); response is `{ data: Ticket[] }` in request order. | https://docs.expo.dev/push-notifications/sending-notifications/ | high | confirmed |
| C2 | Receipts: `POST https://exp.host/--/api/v2/push/getReceipts` with `{ ids }`, ≤ 1000 ids per call; receipts cleared after 24 h; check ~15 min after sending. | https://docs.expo.dev/push-notifications/sending-notifications/ | high | confirmed |
| C3 | `DeviceNotRegistered` (ticket or receipt) means stop sending to that token; `MessageRateExceeded` → exponential backoff; `MessageTooBig` = payload > 4096 bytes; `InvalidCredentials`/`MismatchSenderId` = credential problems. | https://docs.expo.dev/push-notifications/sending-notifications/ ; https://docs.expo.dev/push-notifications/faq/ | high | confirmed |
| C4 | An Expo access token is optional by default and required only when "Enhanced Security for Push Notifications" is enabled; sent as `Authorization: Bearer`; missing → `UNAUTHORIZED`. Tokens are created at expo.dev/settings/access-tokens; robot users are the server-side recommendation. | https://docs.expo.dev/push-notifications/sending-notifications/ ; https://docs.expo.dev/accounts/programmatic-access/ | high | confirmed |
| C5 | Worker secrets: `npx wrangler secret put <KEY>` deploys a new version; local values in `.dev.vars` / `.dev.vars.<env>`; read as `env.<KEY>` strings. | https://developers.cloudflare.com/workers/configuration/secrets/ | high | confirmed |
| C6 | Client: `getExpoPushTokenAsync({ projectId })`; Android channel must be created before requesting a token; on iOS use `ios.status`; Expo Go has no push in SDK 53+ (development build required); iOS token survives reinstall, Android may change; `addPushTokenListener` covers rare rotations. `expo-notifications` latest 57.0.16. | https://docs.expo.dev/versions/latest/sdk/notifications/ ; https://docs.expo.dev/push-notifications/faq/ ; https://docs.expo.dev/push-notifications/push-notifications-setup/ ; `npm view` | high | confirmed |
| C7 | `expo-server-sdk` 7.2.0 depends on `undici`, `promise-limit`, `promise-retry`; plain `fetch` is used instead (concepts.md §6). | `npm view expo-server-sdk@latest dependencies` ; `IOSApp concepts/concepts.md` §6 | high | confirmed |
| C8 | Workers limits: subrequests 50 (Free) / 10,000 (Paid, configurable with `limits.subrequests`); 6 simultaneous open connections; Cron Trigger CPU 30 s (< 1 h interval) / 15 min (≥ 1 h interval); Cron duration 15 min; 128 MB memory; 5 / 250 cron triggers per account. | https://developers.cloudflare.com/workers/platform/limits/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ | high | confirmed |
| C9 | `ctx.waitUntil()` extends an HTTP invocation by up to 30 s after the response; the scheduled-handler page states the runtime waits for the handler's promise and `waitUntil` is not needed for a single awaited task. No separate `waitUntil` budget for crons is documented. | https://developers.cloudflare.com/workers/runtime-apis/context/ ; https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ | medium | confirmed |
| C10 | `scheduled(controller, env, ctx)`: `controller.cron`, `controller.scheduledTime` (ms, UTC), `controller.type`; crons run in UTC; local test via `/cdn-cgi/handler/scheduled?cron=…&time=…`. Retry policy is undocumented (`noRetry()` exists). | https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ ; https://developers.cloudflare.com/workers/configuration/cron-triggers/ ; durable-objects-d1-domain C12 | high (retry policy: low) | confirmed |
| C11 | A Durable Object has exactly one alarm; `setAlarm` overrides it; at-least-once with up to 6 platform retries (2 s exponential backoff); the copied `Aggregate` owns that alarm for flush retries (`setAlarm` in `#scheduleRetry`, `deleteAlarm` on clean flush). | https://developers.cloudflare.com/durable-objects/api/alarms/ ; `/Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts` L170–248 | high | confirmed |
| C12 | DO pricing (Paid): requests 1 M/month included then $0.15/M and "includes … alarm invocations"; duration 400k GB-s then $12.50/M GB-s; SQLite rows written 50 M/month then $1/M; "Each setAlarm() is billed as a single row written". | https://developers.cloudflare.com/durable-objects/platform/pricing/ | high | confirmed |
| C13 | D1: max 100 bound parameters per query, 100 KB statement, 30 s query duration; limits apply per statement in a batch. | https://developers.cloudflare.com/d1/platform/limits/ | high | confirmed |
| C14 | `player_state.local_day_ends_at` is computed at projection time (`endOfLocalDay(Date.now(), s.tz)`), so it is stale for exactly the users the reminder cron must find; the README's `local_day_ends_at BETWEEN now AND now+N h` query cannot select them. | `docs/research/durable-objects-d1-domain.md` L513, L357; `docs/research/README.md` §D1 schema | high | confirmed |
| C15 | APNs requires HTTP/2 + TLS 1.2, hosts `api.push.apple.com:443` / `api.sandbox.push.apple.com:443` (alt port 2197), `POST /3/device/<token>`, headers `authorization: bearer`, `apns-topic`, `apns-push-type`, `apns-priority`, `apns-expiration`, `apns-collapse-id` (≤ 64 B), payload ≤ 4096 B uncompressed. | https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns | high | confirmed |
| C16 | APNs provider JWT: header `{ alg: "ES256", kid }`, claims `{ iss: Team ID, iat }`; refresh no more than every 20 min and no less than every 60 min; stale → `403 ExpiredProviderToken`; `410 Unregistered` = stop sending; do not retry `BadDeviceToken`/`Unregistered`/`ExpiredToken`/`PayloadTooLarge`; retry `429 TooManyRequests` with delay. | https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns ; https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns | high | confirmed |
| C17 | Workers WebCrypto lists ECDSA as supported for sign/verify/importKey/exportKey; the docs table does not name curves, so P-256 + pkcs8 `.p8` import is expected but UNVERIFIED in workerd. | https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ | medium | confirmed |
| C18 | [UNVERIFIED] Production Workers negotiate HTTP/2 to APNs so `fetch("https://api.push.apple.com/3/device/…")` works, while local workerd does not; Cloudflare's protocol page does not document the outbound HTTP version. | https://github.com/cloudflare/workerd/issues/4841 ; https://github.com/FiveSheepCo/cloudflare-apns2 ; https://developers.cloudflare.com/workers/reference/protocols/ | low | confirmed |
| C19 | Outbound HTTP mocking in workerd tests uses `@msw/cloudflare` 0.0.1 `setupNetwork()` (peer `msw >= 2.14.1`; msw latest 2.15.0); `fetchMock` from `cloudflare:test` is gone. | `npm view @msw/cloudflare` ; `npm view msw version` ; `docs/research/testing-and-dx.md` C8 | high | confirmed |
| C20 | The handoff promises three notification kinds (streak warning, daily-drop ping, rival overtake) and the OS prompt fires only on "Enable notifications"; the consolidated README ships `notifications` as a stub with `pushTokens: string[]` and no endpoint. | handoff README §6; `docs/research/README.md` §Modules, §Aggregates | high | confirmed |
| C21 | [UNVERIFIED] `Intl.DateTimeFormat` `timeZoneName: "longOffset"` is available in workerd; the `formatToParts` arithmetic fallback needs only year…second parts, which the existing `dayKey` already relies on. | https://developers.cloudflare.com/workers/local-development/ (Workers observe UTC; Intl with `timeZone` works) ; crossword-content-pipeline F7 | low (fallback: high) | confirmed |
| C22 | [UNVERIFIED] `createScheduledController` is not listed among the v1 vitest-plugin `cloudflare:test` exports in testing-and-dx C9; a hand-built `ScheduledController`-shaped object passed to `exports.default.scheduled` is sufficient because the handler is a plain function. | `docs/research/testing-and-dx.md` C9 ; https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ | low | refuted |

## Fact-check log

C1: confirmed — https://docs.expo.dev/push-notifications/sending-notifications/
C2: confirmed — https://docs.expo.dev/push-notifications/sending-notifications/
C3: confirmed — https://docs.expo.dev/push-notifications/sending-notifications/ ; https://docs.expo.dev/push-notifications/faq/
C4: confirmed — https://docs.expo.dev/push-notifications/sending-notifications/ ; https://docs.expo.dev/accounts/programmatic-access/
C5: confirmed — https://developers.cloudflare.com/workers/configuration/secrets/
C6: confirmed — https://docs.expo.dev/versions/latest/sdk/notifications/ ; https://docs.expo.dev/push-notifications/faq/ ; https://docs.expo.dev/push-notifications/push-notifications-setup/
C7: confirmed — npm view expo-server-sdk version 7.2.0
C8: confirmed — https://developers.cloudflare.com/workers/platform/limits/ ; Free plan Cron CPU is 10 ms, Paid is 30 s / 15 min
C9: confirmed — https://developers.cloudflare.com/workers/runtime-apis/context/ ; https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
C10: confirmed — https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ ; https://developers.cloudflare.com/workers/configuration/cron-triggers/
C11: confirmed — https://developers.cloudflare.com/durable-objects/api/alarms/
C12: confirmed — https://developers.cloudflare.com/durable-objects/platform/pricing/
C13: confirmed — https://developers.cloudflare.com/d1/platform/limits/
C14: confirmed — /Users/peter/Projects/IOS Crosswords/docs/research/durable-objects-d1-domain.md
C15: confirmed — https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
C16: confirmed with addition — Apple's do-not-retry list also includes DeviceTokenNotForTopic and Forbidden
C17: confirmed — workerd 2026-08-28 probe verified ECDSA P-256 pkcs8 import and ES256 sign/verify
C18: confirmed — workerd issue #4841 reports production Workers work but local workerd fails
C19: confirmed — @msw/cloudflare 0.0.1 with setupNetwork() replaces fetchMock
C20: confirmed — handoff README §6 ; docs/research/README.md
C21: confirmed — workerd 2026-08-28 probe verified Intl.DateTimeFormat timeZoneName 'longOffset'
C22: refuted — createScheduledController IS exported from cloudflare:test in v1 plugin; exports.default.scheduled is the experimental service-binding form, not the plain handler

## Open questions

1. **Reminder hour policy.** 20:00 local for the streak warning and 09:00 for the drop ping are product guesses; the handoff only says "9h 14m left today" on the feed card. Should the drop hour be user-configurable (the schema allows `dropHourLocal` 5–12) or fixed in v1?
2. **Expo "Enhanced Security" toggle.** Enabling it makes the access token mandatory for *all* senders (including any Expo dashboard test tool). Confirm the team wants it on from the first TestFlight build.
3. **DST drift of `utc_offset_min`.** The offset is refreshed only when the `User` state changes. Options: (a) the 06:00 cron re-derives offsets for the ~40 distinct `tz` values and issues `UPDATE player_state SET utc_offset_min=? WHERE tz=?` per zone (≤ 40 statements, no DO hops); (b) accept a one-hour drift for dormant users. (a) is recommended; it needs `tz` to stay projected.
4. **Rival definition.** "Someone passed you" from `leaderboard_week` diffs is cheap but can fire for anyone in the top 500 every 5 minutes if the board churns; the one-per-local-day cap handles volume but not relevance. Should rivals be limited to a follow/friends notion that does not yet exist?
5. **Web push.** concepts.md mentions web push subscriptions on the User; Expo push tokens are native-only. Web reminders would need VAPID + `crypto.subtle` (ECDH/AES-GCM) or a third-party; out of scope until the web target ships.
6. **Cron retry semantics** (README U2) remain unconfirmed; the claim-row design is safe either way, but if Cloudflare confirms "no retry", the `*/5` drain is the only recovery for a crashed hourly run and should be kept.
7. **APNs-direct viability** hinges on C17/C18: run a `wrangler dev --remote`/staging probe that signs an ES256 JWT with WebCrypto and posts to the sandbox host before planning the switch.
8. **Which `lang` drives copy** — the puzzle language (`player_state.lang`) is the only signal today; the app could also send the device locale in `POST /devices` (`locale` exists in the bootstrap body) and the projection could prefer it for notification copy.
