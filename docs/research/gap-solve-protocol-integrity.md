# Server-tracked solve session, solution-leak closure and leaderboard anti-cheat

Research date: 2026-09-02. Slug: `gap-solve-protocol-integrity`. Scope: the solving routes of the Crosscut Worker (Hono 4.13.5 + Zod 4.5.4, one `User` SQLite Durable Object per player, D1 for facts), the `session` shape in `UserState`, and the leaderboard fairness model. Inputs read: `docs/research/README.md` (§Request lifecycle, §API surface), `durable-objects-d1-domain.md` (R3 anti-cheat basics, R10, R12), `domain-spec-extraction.md` (F5 solving rules, "Server-authoritative solving"), `identity-auth-v1.md` (F13 App Attest, rate limits), `testing-and-dx.md` (F1–F4 vitest-plugin), the handoff README (§12 Play, "Solving" interaction rules), `scratchpad/prototype-logic.js` (`tryLock`, `lockAndSweep`, `input`, `hintLetter`, `hintFifty`, `hintWord`, `spendTokens`), and `packages/core/src/aggregate.ts` (`commit`, `#persist`, `#flushAfterCommit`).

Anything not confirmed against a current primary source is marked **UNVERIFIED** in the text and carries confidence `low` in the Claims table.

## Summary

- **The README v1 solving API leaks the solution in one call.** `POST /solves/:id/words` is declared stateless and takes the *client's* `locked: number[]`, then returns `fixedLetters` for every locked word "recomputed from the secret". A client that claims all ten questions locked receives the whole grid. `POST /solves/:id/check` is a per-cell oracle with no enforceable "only while autocheck is on" rule (≈325 expected / 650 worst-case calls for a 5×5 at `RL_USER` 120/min ≈ 3–6 minutes). `POST /hints/letter` returns `{ noop: true }` without charging when the client-supplied `filled` already matches, which is a free per-word oracle. Because nothing per-word is recorded server-side, `finishSolve` cannot tell a progressive solve from a dumped grid, and R3 (d) "the no-hint bonus cannot be forged" is only true inside one account.
- **Decision: `words` becomes a `User` DO command (`submitWord`), not a stateless route with an HMAC "locked proof".** An HMAC proof closes the harvest leak but gives none of the other properties the leaderboard needs: wrong-guess counters, a `check` budget, per-lock timestamps, a server-owned `hintsUsed`, and an idempotent finish. The delta is one DO RPC per typed word (5 for the three word-square minis thanks to the sweep, up to 10 for `cross1`) plus one per wrong guess: ≈ +12 DO requests per DAU-day ⇒ **+$0.18/month at 3k DAU and +$2.70/month at 50k DAU** at Cloudflare's $0.15 per million DO requests (1M included). Latency is one RPC round-trip to an object that Cloudflare places "in a data center close to where the initial `get()` request is made" (the player's own bootstrap), which the prototype's 500 ms "advance to next clue" delay already hides. Exact RTT numbers are not published — **UNVERIFIED**, budget 10–40 ms in-region.
- **One required change to `packages/core`**: a `projectionFingerprint(state)` hook so that commits that only touch `session` do not flush to D1. Without it, ~12 extra `player_state` upserts per DAU-day (≈3 D1 rows each) add ≈54M D1 rows/month at 50k DAU, blowing through D1's 50M included rows (+$1.00/million ⇒ ≈ +$37/month) for data no D1 reader needs (`/me/continue` reads the DO snapshot).
- **Session state machine in the `User` DO** (`running → paused → running → finished`, replaced only by `startSolve`): server-owned `locked` + `locks[]` timestamps, per-question wrong-guess counters (budget 20/question, 100/solve), `checks` counter and ticket count, `hintLog`, `pendingFifty`, `autocheck`, `pausedMs/pauseCount`, and `lastResult` cached by `solveId` so a retried finishing `words` call or `POST /finish` returns the identical `SolveResult` (fixes the "idempotent yet `session = null` ⇒ 409" contradiction). The finishing word completes rewards **in the same commit** (`submitWord` with all questions locked ⇒ `finishSolve` logic inline): one DO hop instead of the README's snapshot + finish.
- **Oracles get budgets that cost more than an honest solve**: `check` is accepted only with a DO-issued HMAC-SHA-256 *autocheck ticket* (WebCrypto `crypto.subtle.sign/verify`, 10-minute TTL, renewable at most 6 times per solve through the DO), only for the cells of one question per call, and at 30 calls/minute per solve via a `RL_CHECK` `ratelimits` binding (`simple.period` must be 10 or 60). Harvesting a 5×5 through `check` then takes ≥ 11 minutes inside a session whose elapsed time is recorded, i.e. it is worthless for that account and only feeds a Sybil chain. Wrong-guess exhaustion is shown as "Out of tries for this clue — reveal a letter (🪙 40), solve it (🪙 100), or let the crossing answers fill it in."
- **Fairness model**: plausibility floor `minPlausibleMs = max(12 s, 400 ms × fillableCells)` (S1, existing), a typed-lock speed floor (S2: two or more consecutive correct submits faster than 80 ms × word length), audit flags (S3 zero mistakes and `elapsed < 2 × minPlausible`; S4 `checks > 6 × fillableCells`), `boardEligible = firstSolve && !suspicious && pauseCount === 0 && (veteran || attested)` where *veteran* = ≥ 3 eligible solves on ≥ 2 earlier local days, and three suspicious finishes in 30 days shadow-exclude the account from boards. Suspicious solves keep stars and the completion but earn 0 tokens and never enter `topToday`/weekly boards (existing R3 policy, now enforceable).
- **Attestation is designed in but not switched on in v1.** iOS App Attest (attest once at bootstrap, assert on board-entering finishes; server checks the `x5c` chain against Apple's App Attest Root CA, the `nonce` = SHA-256(authData ‖ SHA-256(challenge)), key id, `rpIdHash`, `counter`, `aaguid`) and Android Play Integrity (standard request, `requestHash` = SHA-256(solveId), verdicts `MEETS_DEVICE_INTEGRITY` + `PLAY_RECOGNIZED`, decoded through `playintegrity.googleapis.com` under a default quota of 10,000 requests/day) become mandatory for `topToday` once a trigger fires (§Recommendation 4). Attestation is *lazy*: only finishes that would enter the top 10 of an unattested install are asked for it, which keeps the Play Integrity quota trivial. **No npm package is documented as Workers-compatible for App Attest**; `node-app-attest` 1.0.1 and `appattest-checker-node` 1.0.3 are Node-oriented (`cbor` v9/v10 + `pkijs`/`@peculiar/x509`); the Workers-native candidate stack is `@levischuck/tiny-cbor` 0.3.6 (dependency-free) + `@peculiar/x509` 2.0.0 (WebCrypto-based) + WebCrypto ECDSA verify, which needs a one-day spike in workerd — **UNVERIFIED**.
- **Review mode** gets its own route: `GET /puzzles/:id/solution` returns the grid letters and answers **only when `completions[puzzleId]` exists in the DO snapshot** (403 `NOT_COMPLETED` otherwise). `GET /solves/:id` keeps returning the finished session (status `finished`, all letters, cached `result`) until `startSolve` replaces it, then 404 `SOLVE_GONE`. This replaces the README's "Review mode returns the grid letters via `/solves/:id`", which cannot work after `session = null`.
- Every solving route gets a reconciled Zod 4 request/response schema (`z.strictObject` for bodies so a client that still sends `locked`/`filled` gets 400), and a workerd test list (with `@cloudflare/vitest-plugin` 1.1.3) whose first test claims all words locked and asserts no letter outside the submitted question is returned.

## Findings

### F1. The README v1 contract leaks the solution (local sources)
`docs/research/README.md` §API surface, row `POST /solves/:solveId/words`: body `{ questionIndex, word, locked: number[] }`, response `{ correct, locked, newlyLocked, fixedLetters, … }`, note "**stateless**: `normalizeWord(lang, word) === answer`, then `sweep()` over the client's locked set; no DO hop". Row `GET /solves/:solveId`: "`fixedLetters` = letters of locked words recomputed from the secret". Row `POST /solves/:solveId/check`: "stateless; only while autocheck is on". Row `/hints/letter`: body `{ questionIndex, filled: string[] }`, "`{ noop:true }` (no charge if word already correct)". Row `/finish`: "409 `NO_ACTIVE_SESSION`; idempotent per `sessionId`", while §Request lifecycle step 3 sets `session = null` in the finish commit. Row `/puzzles/:id`: "`Review` mode after completion returns the grid letters via `/solves/:id`". `durable-objects-d1-domain.md` R3: "(d) Hints are server-issued, so a 'no-hint' bonus cannot be forged" and "Deliberately *not* attempted: keystroke telemetry, device attestation"; `suspicious = elapsedMs < minPlausibleMs(puzzle) // e.g. 400 ms per fillable cell, min 12 s`. `identity-auth-v1.md` threat table: "Bulk scripted play | later: App Attest assertion required for leaderboard submission; v1: none" and the `RL_BOOT` note that IP keys are "not recommended" and "per-location counters mean a distributed minting attack is barely slowed".

### F2. Prototype solving semantics that the server must reproduce (local source)
`scratchpad/prototype-logic.js`: `tryLock` (L143–162) locks when the typed word equals `q.ans`, calls `lockAndSweep` (L113–125: any unlocked question whose cells are all fixed by locked questions locks, repeated to a fixpoint), then advances after 500 ms or finishes after 750 ms; a wrong word only sets `error: true`. `input` (L164–175) clears non-fixed cells of the active word on the next keypress after an error. `hintLetter` (L535–546) finds the first cell where `filled !== q.ans[i]`, returns without charging if none (`emptyI < 0`), else `spendTokens(40)` and fills it; `hintWord` fills the whole word for 100; `hintFifty` charges 20 and shows `[ans, decoy]` in random order; `spendTokens` sets `usedHints: true`; `hintCheck` toggles `autocheck` free (render-time compare `p.sol[r][c] !== letter`, L380). `finish` (L127–140): `earned = floor(secLeft/5)`, stars `10 + (usedHints ? 0 : 2)`. Handoff README §Interactions "Solving": "A complete word auto-checks: correct → … the word locks, any word whose cells are now all fixed locks too (recursive sweep), and after ~0.5s focus advances".

### F3. Durable Objects pricing (source: https://developers.cloudflare.com/durable-objects/platform/pricing/)
Workers Paid: requests "$0.15/million" beyond "1 million / month" included, counting "HTTP requests, RPC sessions, WebSocket messages, and alarm invocations" — each "RPC method call" is "a single billed request". Duration "$12.50/million GB-s" beyond 400,000 GB-s included. SQLite storage: rows read "$0.001 / million rows" beyond 25 billion included; rows written "$1.00 / million rows" beyond 50 million included; stored data $0.20/GB-month beyond 5 GB. Free plan: 100,000 requests/day, 13,000 GB-s/day, SQLite backend only.

### F4. D1 and Workers pricing (sources: https://developers.cloudflare.com/d1/platform/pricing/ , https://developers.cloudflare.com/workers/platform/pricing/)
D1 Paid: rows read "First 25 billion / month included + $0.001 / million rows"; rows written "First 50 million / month included + $1.00 / million rows"; storage 5 GB included + $0.75/GB-month. Workers Paid: "10 million included per month +$0.30 per additional million" requests; "30 million CPU milliseconds included per month +$0.02 per additional million". These are the numbers behind the cost delta in §Recommendation 2.

### F5. Durable Object placement and limits (sources: https://developers.cloudflare.com/durable-objects/reference/data-location/ , https://developers.cloudflare.com/durable-objects/platform/limits/ , https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
"By default, a Durable Object is instantiated in a data center close to where the initial `get()` request is made." "Durable Objects do not currently change locations after they are created." `locationHint` is "a best effort and not a guarantee". Limits: "An individual Object has a soft limit of 1,000 requests per second"; SQLite storage 10 GB per object; SQL statement ≤ 100 KB, ≤ 100 bound parameters; 30 s CPU per request by default. Durable Objects "are single-threaded and cooperatively multi-tasked". Neither page states a request latency figure — the RTT used in this document is an estimate (**UNVERIFIED**).

### F6. Input gates serialize a Durable Object's requests (source: https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/ and https://developers.cloudflare.com/durable-objects/api/state/)
Input gate: "While a storage operation is executing, no events shall be delivered to a Durable Object except for storage completion events. Any other events will be deferred until such a time as the object is no longer executing JavaScript code and is no longer waiting for any storage operations." Output gate: "When a storage write operation is in progress, any new outgoing network messages will be held back until the write has completed." Consequence for Crosscut: `submitWord`, `spendForHint` and the inline finish are serialized per user; concurrent requests from two devices on the same account cannot double-lock, double-spend, or double-finish.

### F7. Workers RPC semantics (source: https://developers.cloudflare.com/workers/runtime-apis/rpc/)
Public methods on Durable Objects "can be called by other workers on the same Cloudflare account that declare a binding to it"; "Nearly all types that are Structured Cloneable can be used as a parameter or return value"; "Whether or not the method you are calling was declared asynchronous on the server side, it will behave as such on the client side"; promise pipelining lets several calls travel "in a single round trip" when the first `await` is omitted. For Crosscut this means the route can pass a plain `topology` object (cells per question, no letters) and a boolean verdict into the DO with no serialization ceremony.

### F8. Web Crypto in Workers (source: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
HMAC is listed with `sign()` and `verify()` support; SHA-256/384/512 digests; ECDSA supports `sign`, `verify`, `generateKey`, `importKey`; `crypto.subtle.importKey()` "Transform a key from some external, portable format into a `CryptoKey`"; `verify()` resolves "a Boolean value indicating if the signature given as a parameter matches"; `crypto.subtle.timingSafeEqual(a, b)` is documented as "a non-standard extension to the Web Crypto API" to "Compare two buffers in a way that is resistant to timing attacks". The autocheck ticket (§Recommendation 3) and the rejected HMAC "locked proof" both use only these primitives. The page's table does not spell out which hash pairs with HMAC; `{ name: "HMAC", hash: "SHA-256" }` is the standard WebCrypto shape and is treated as verified by the algorithm table plus the digest row.

### F9. Rate Limiting binding (source: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ ; local: `wrangler-config.md` §13)
Config `ratelimits: [{ name, namespace_id, simple: { limit, period } }]`, `period` "Must be either 10 or 60" seconds; `limit({ key })` returns `{ success }`. The docs describe it as "permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system" and "local to the Cloudflare location that your Worker runs in". `wrangler-config.md` verified miniflare simulates it locally (third call in a 2/10 s limit returns `success: false`). So `RL_CHECK` is a per-colo oracle throttle, not an accounting cap — the per-solve cap lives in the DO (`checkTickets`).

### F10. Apple App Attest server validation (source: https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server ; content read through Apple's documentation JSON endpoint https://developer.apple.com/tutorials/data/documentation/devicecheck/validating-apps-that-connect-to-your-server.json)
Attestation steps (quoted): verify the `x5c` chain against Apple's App Attest root; `clientDataHash` = SHA-256 of the one-time challenge, appended to `authData`, hashed again to form `nonce`, which must match the `credCert` extension OID `1.2.840.113635.100.8.2`; "Create the SHA256 hash of the public key in `credCert` with X9.62 uncompressed point format, and verify that it matches the key identifier from your app."; "Compute the SHA256 hash of your app's App ID, and verify that it's the same as the authenticator data's `RP ID` hash."; "Verify that the authenticator data's `counter` field equals `0`."; `aaguid` is `appattestdevelop` or `appattest` + seven `0x00`; "Verify that the authenticator data's `credentialId` field is the same as the key identifier."; verify `apple_validation_category_01` and `apple_bundle_version_01` in the `extensions` CBOR dictionary. Assertion steps: `clientDataHash` = SHA-256(clientData); "Concatenate `authenticatorData` and `clientDataHash`, and apply a SHA256 hash over the result to form `nonce`."; verify the signature with the stored public key; check `RP ID`; "Verify that the authenticator data's `counter` value is greater than the value from the previous assertion, or greater than `0` on the first assertion."; verify the embedded challenge. Storage: "Store the verified public key from `credCert` on your server and associate it with the user for the specific device… Store `counter`"; "Be prepared to store multiple (key, receipt) pairs for each user"; "make sure that the public key doesn't already have an association with another user."

### F11. Apple App Attest client-side constraints (source: https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity via https://developer.apple.com/tutorials/data/documentation/devicecheck/establishing-your-app-s-integrity.json)
"Not all devices can use the App Attest service… You check for availability by reading the `isSupported` property."; "If the method, which accesses a remote Apple server, returns the `serverUnavailable` error, try attestation again later with the same key. For any other error, discard the key identifier and create a new key"; the challenge "should be at least 16 bytes in length"; "There's no restriction on the number of assertions that you can make with a key. Nevertheless, you typically reserve assertions for requests made at sensitive moments". Design consequence: attest once per install (key id persisted by the app), assert only on board-entering finishes.

### F12. Google Play Integrity verdicts and quota (sources: https://developer.android.com/google/play/integrity/verdicts , https://developer.android.com/google/play/integrity/overview)
Verdict JSON has `requestDetails { requestPackageName, requestHash | nonce, timestampMillis }` (verify first: package name, hash, freshness window), `appIntegrity.appRecognitionVerdict` ∈ `PLAY_RECOGNIZED | UNRECOGNIZED_VERSION | UNEVALUATED`, `deviceIntegrity.deviceRecognitionVerdict` containing `MEETS_DEVICE_INTEGRITY` (optionally `MEETS_BASIC_INTEGRITY`, `MEETS_STRONG_INTEGRITY`, `MEETS_VIRTUAL_INTEGRITY`), `accountDetails.appLicensingVerdict` ∈ `LICENSED | UNLICENSED | UNEVALUATED`, optional `environmentDetails`. Tokens are decrypted server-side via `POST https://playintegrity.googleapis.com/v1/…:decodeIntegrityToken` with service-account credentials. Standard requests use `requestHash` and take "A few hundred milliseconds"; classic requests use `nonce` and take "A few seconds". Quota: "By default, your app can make up to 10,000 total requests per day across all installs." Minimum Android 6.0 (API 23).

### F13. npm libraries for CBOR / X.509 / App Attest (source: `npm view`, 2026-09-02)
| package | version | dependencies / notes | Workers fit |
|---|---|---|---|
| `@levischuck/tiny-cbor` | 0.3.6 | no dependencies; decodes to `Map`/arrays/`Uint8Array`; no indefinite-length items, no half floats | good candidate; whether Apple's attestation CBOR uses only definite lengths is **UNVERIFIED** |
| `cbor2` | 2.3.0 | `@cto.af/wtf8`; "Web-first. Usable in Node and Deno."; engines node ≥ 20 | plausible, **UNVERIFIED** in workerd |
| `cbor-x` | 1.6.6 | runs in browsers/Deno per README; optional native addon | plausible, **UNVERIFIED** |
| `cbor` (node-cbor) | 10.0.12 | `nofilter`; Node Buffer/stream API, node ≥ 20 | Node-oriented; likely needs `nodejs_compat`, **UNVERIFIED** |
| `@peculiar/x509` | 2.0.0 | `@peculiar/asn1-*`, `pvtsutils`, `tslib`, `tsyringe`; "providers need to be compatible with the WebCrypto API"; browser build shipped | best X.509 candidate; chain building in workerd **UNVERIFIED** (needs a spike) |
| `pkijs` | 3.4.0 | `asn1js`, `@noble/hashes`, `pvtsutils`; WebCrypto engine | alternative, **UNVERIFIED** |
| `node-app-attest` | 1.0.1 | `asn1js ^3.0.7`, `cbor ^10.0.11`, `pkijs ^3.3.3`; ESM, `verifyAttestation`/`verifyAssertion` | Node-first (node-cbor); **UNVERIFIED** on Workers |
| `appattest-checker-node` | 1.0.3 | `@peculiar/x509 ^1.9.6`, `cbor ^9`, `@types/node`, `json-stable-stringify` | Node-first; **UNVERIFIED** on Workers |
| `@noble/curves` | 2.4.0 | pure JS ECC | fallback if WebCrypto ECDSA import of the attested key is awkward |
Conclusion: there is no npm package that documents Workers/workerd support for App Attest end-to-end; the composition `tiny-cbor` + `@peculiar/x509` + WebCrypto is the cheapest path and must be spiked before attestation is switched on.

### F14. Test tooling (local: `testing-and-dx.md` F1–F4; npm)
`@cloudflare/vitest-plugin` 1.1.3 (deps `wrangler 4.128.0`, `miniflare 5.20260831.0-alpha`; peers `vitest ^4.1.0`) replaces `@cloudflare/vitest-pool-workers` 0.22.0 with an unchanged `cloudflareTest()` API; `cloudflare:test` exports `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`, `applyD1Migrations`; the Worker is invoked with `import { env, exports } from "cloudflare:workers"` and `exports.default.fetch()`; fake timers (`vi.useFakeTimers()`, `vi.setSystemTime()`) are visible inside a Durable Object instance (probe verified in that document) but Crosscut injects `now` into every command anyway. The 1.1.2 fix for tests that repeatedly recreate Durable Objects matters here because every solving test creates a fresh `User` object.

### F15. `packages/core` `Aggregate` flush behaviour (local: `/Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts`)
`commit(mutate)` → `#persist(next)` compares `JSON.stringify(next)` with the current state and returns without a version bump when equal; otherwise `UPDATE aggregate SET version = ?, state = ?` and `version + 1`; then `#flushAfterCommit()` calls `flush()` (awaited when `flushMode === "await"`, `ctx.waitUntil` otherwise) whenever `version > projected`. There is no way today to bump the version without projecting — hence the `projectionFingerprint` hook in §Recommendation 2.

## Recommendation for Crosscut

### 1. Threat model

Costs are computed under the README limits: `RL_USER` 120 requests / 60 s per user (per colo, permissive), `RL_BOOT` 10 / 60 s per IP (per colo), `RL_SPEND` 20 / 60 s. "Today" = README v1 contract; "After" = this specification. `fillableCells` = 25 for the 5×5 minis; for `cross1` (9×9) use the puzzle's own count (`grid` cells that are not `#`).

| id | attack | today (README v1) | after this spec | residual risk / cost to attacker |
|---|---|---|---|---|
| T1 | **Solution harvest via `locked`/`fixedLetters`**: send `{ questionIndex: 0, word: "AAAAA", locked: [0..9] }` | 1 request, 0 tokens, whole grid returned | `locked` is not accepted (strict body ⇒ 400); `fixedLetters` are derived only from `session.locked` in the DO; a wrong guess returns `fixedLetters: []` | closed |
| T2 | **Per-cell `check` oracle**: try letters cell by cell | ≤ 26 tries/cell; 5×5 expected ≈ 325 calls (uniform) / ≈ 190 with frequency ordering, worst 650 ⇒ 1.6–5.4 min at 120/min; autocheck rule unenforceable | needs a DO-issued autocheck ticket (10 min TTL, ≤ 6 tickets/solve ⇒ ≤ 60 min), one question per call (≤ word length cells), `RL_CHECK` 30/60 s per solve; ticket issuance recorded (`autocheckUsed`, `checkTickets`) | harvest of a 5×5 takes ≥ 6.3 min (190 calls) and ≥ 11 min (325 calls) inside a session whose `elapsedMs` is recorded ⇒ that account's time is worthless; only useful as the first hop of T4. Escape hatch: make `check` a DO command with a hard per-solve cap (≈ +$22/month at 50k DAU, see §2) |
| T3 | **Per-word `words` oracle**: dictionary attack per clue | unlimited; ~6,000 five-letter English words ⇒ ≤ 50 min/word at 120/min (a clue usually narrows to ≈ 10 candidates) | wrong-guess budget 20/question, 100/solve; each guess logged with a timestamp; exhausted ⇒ 422 `GUESS_BUDGET`, hints still available | crosswords are guessable by design; the budget only needs to stop scripted enumeration. Cost: ≤ 20 guesses/word, then 40–100 tokens per word |
| T4 | **Harvest then replay with a fast clock** (harvest on device A, dump on device B) | no per-word state ⇒ a dumped grid finishes with whatever `elapsed` the server measured since `startSolve`; `minPlausibleMs` is the only defence | *same account*: the harvest session **is** the solve (locks and `elapsedMs` recorded); `startSolve` again ⇒ `replay: true` ⇒ 0 tokens, 0 stars, `boardEligible: false`. *Second account* (Sybil): the dump must pass S1/S2 and the veteran-or-attested gate | residual = a *paced* dump from an aged or attested second account. Cost: one honest slow solve (≥ 3 min) + an account with ≥ 3 eligible solves on ≥ 2 days or a real attested device, per puzzle. Detection: S3 audit flag + top-N review cron |
| T5 | **Second device keeps the no-hint bonus** (hints on A, finish on B) | `hintsUsed` lives in the DO session already, but `finish` trusted a client `grid` and nothing else | both devices share the single `session` in the `User` DO; `hintsUsed` is set by `spendForHint` in the same object ⇒ the +2 stars cannot be forged inside an account | cross-account variant = T4 with a 2-star payoff; not worth defending beyond T4 |
| T6 | **Sybil device minting for leaderboards** | `RL_BOOT` 10/min/IP/colo ⇒ 14,400 accounts/day/IP, no attestation; every account can play the daily once and post a paced T4 time into `topToday` | `topToday` requires `boardEligible` (veteran-or-attested); weekly board sums stars per user so extra accounts do not help one identity; nightly cron clusters new accounts by `cf-connecting-ip`/ASN and marks clusters `boardShadow` | cost after: 3 days of play per sybil account **or** one attested physical device per account (App Attest keys are per app install on a real device; Play Integrity `MEETS_DEVICE_INTEGRITY` excludes emulators/rooted devices) |
| T7 | **Client clock / time forgery** (`secLeft`, timestamps, pausing) | timing already server-side (R3 b), but `pause` semantics were an open question | no client-supplied time anywhere; `now` injected by the route; `elapsedMs = now − startedAt − pausedMs`; commands while `paused` ⇒ 409 `PAUSED`; `pauseCount`/`pausedMs` recorded; `boardEligible` requires `pauseCount === 0` | pause-and-think is legal but off the board (product decision, see Open questions) |
| T8 | **Hint routes as free oracles** (`hints/letter` `noop`, `fifty/pick`) | `hints/letter { filled }` returns `noop` without charge when the word is right ⇒ free per-word oracle; `pick` trusts the client `locked` | `hints/letter` takes the client's letters for the question; if they equal the answer the word is **locked and counted as a guess** (no charge, no reveal); otherwise 40 tokens are charged and the first wrong-or-empty cell is revealed; `fifty` stores `pendingFifty` in the DO and `pick` must name one of the two stored options (wrong pick = wrong guess) | closed; the hint still costs tokens, guesses still count |
| T9 | **Finish retry loses the result** | `finish` sets `session = null`, so a retried finish gets 409 and the client never sees its `SolveResult` | `lastResult` cached in the finished session; retried finishing `words` and `POST /finish` return the identical `SolveResult` until the session is replaced | closed |

### 2. Session state machine in the `User` DO and the `words` decision

**Decision: `POST /solves/:id/words` becomes the `User.submitWord` command.** Rejected alternative: keep the route stateless and add an HMAC "locked proof" (`HMAC-SHA-256(solveId ‖ lockedBitmap ‖ issuedAt)` issued by the server on every correct answer and required on the next call). The proof does close T1 — `fixedLetters` would only be derived from server-signed locks — and costs one `crypto.subtle.verify` per call. But it cannot count wrong guesses (T3), cannot enforce the `check` budget (T2), records no per-word timestamps (T4 detection), leaves `hintsUsed` and `finish` on separate DO hops anyway (hints already pay a DO hop for `spendForHint`), and needs the finishing `words` call to make a *second* trip to the DO to grant rewards. The DO command gives all of these in the same hop that the finishing word already needs.

**Cost delta (F3, F4, R12 model).** Extra DO requests per solve: typed words (5 for the word-square minis because the sweep locks the down words, up to 10 for `cross1`) + wrong guesses (assume 3) + autocheck ticket renewals (≤ 1 typical) ≈ 12; R12 already budgets 12 DO requests per DAU-day, so the per-user budget becomes ≈ 24. Assuming one solve per DAU-day:

| | 3k DAU | 50k DAU |
|---|---|---|
| extra DO requests/month | 1.08 M (total ≈ 2.2 M; 1.2 M billable) | 18 M (total ≈ 36 M; 35 M billable) |
| extra DO request cost at $0.15/M | **≈ +$0.18** | **≈ +$2.70** |
| extra DO duration (12 × 10 ms × 128 MB) | negligible, within 400k GB-s | ≈ 2.3k GB-s, within included |
| extra DO SQLite rows written (1 `UPDATE aggregate` per commit) | 1.08 M (within 50 M) | 18 M (within 50 M) |
| extra D1 rows **if every lock flushed the projection** (≈ 3 rows/upsert) | 3.2 M (within 50 M) | **54 M ⇒ ≈ +$37/month** and over the included 50 M together with R12's 33 M |

Hence the one required base-class change: **`Aggregate.projectionFingerprint(state)`**. `commit` computes `JSON.stringify(projectionFingerprint(prev))` and `…(next)`; when equal it persists the new version, marks `projected = version` in the same `UPDATE`, and skips `flush()`. `User.projectionFingerprint` returns the state without `session` (and without the in-session counters). Every D1 reader of `player_state`/`player_solves` is unaffected because none of them reads the session (`/me/continue` reads the DO snapshot per README). The finishing commit changes `completions`/`wallet`/`streak`, so it still flushes. Add a core test: three `submitWord` commits ⇒ `snapshot().projected === true` and the D1 `player_state.version` unchanged; the finishing commit ⇒ version advances and `player_solves` row exists.

**Latency.** One RPC to the user's own object, which Cloudflare places near the first `get()` (the bootstrap `POST /devices`, so the player's home region; F5). Cloudflare publishes no RTT figure — **UNVERIFIED**; plan for 10–40 ms in-region plus the SQLite `UPDATE` (no D1 write on the path thanks to the fingerprint). The prototype waits 500 ms before advancing to the next clue and 750 ms before Solved, so the client can keep the flow: render the word as "checking" (no colour change) until the response, then flash `success` or `error`; the advance timer starts on the response. Do not lock optimistically — the server verdict is the only source of truth.

**`solveId` carries the puzzle id.** `solveId = "<puzzleId>~<22-char base32 random>"` (validated by regex). The route can then load `content.withSecret(puzzleId)` and compute the verdict **before** the single DO call — no snapshot read. The DO never receives letters: it gets `{ correct: boolean, topology }` where `topology = { questionCount, cells: number[][][] }` (cells per question, no answers, cached per puzzle id in the route's isolate).

**Session shape (replaces the README's `session` in `UserState`):**

```ts
export type SolveStatus = "running" | "paused" | "finished";
export interface SolveSession {
  id: string;                    // "<puzzleId>~<random>"
  puzzleId: string;
  size: 5 | 9;
  parSec: number;                // 300 | 600, copied at start
  fillableCells: number;         // for the plausibility floor and check caps
  questionCount: number;
  replay: boolean;               // puzzleId ∈ completions at start
  status: SolveStatus;
  startedAt: number;             // server clock
  pausedMs: number; pausedSince: number | null; pauseCount: number;
  locked: number[];              // server-owned; sorted question indexes
  locks: { q: number; at: number; typed: boolean; swept: number[] }[];   // timing telemetry, one per typed lock
  guesses: { total: number; wrongTotal: number; wrongByQ: Record<string, number>; lastAt: number | null };
  hintsUsed: number;             // paid hints only (fifty, letter, word)
  hintLog: { q: number; kind: "fifty" | "letter" | "word"; cost: number; at: number }[];
  pendingFifty: { q: number; options: [string, string]; at: number } | null;   // server-issued options; consumed by pick
  autocheck: boolean; autocheckUsed: boolean; checkTickets: number; lastTicketAt: number | null;
  finishedAt: number | null;
  lastResult: SolveResult | null;   // cached; returned on every retry until the session is replaced
}
```

Budget constants (`packages/shared/solving/limits.ts`): `WRONG_PER_QUESTION = 20`, `WRONG_PER_SOLVE = 100`, `CHECK_TICKET_TTL_MS = 600_000`, `CHECK_TICKETS_PER_SOLVE = 6`, `RL_CHECK = 30 / 60 s`, `MIN_PLAUSIBLE_MS = max(12_000, 400 × fillableCells)`, `TYPING_FLOOR_MS_PER_CHAR = 80`, `SESSION_ABANDON_MS = 24 h` (a running session older than this may be replaced without a prompt; it still finishes normally if resumed, with 0 tokens because it is over par).

**Transitions and guards (all take `now` from the route):**

| command | precondition | effect |
|---|---|---|
| `startSolve({ puzzleId, restart, now, meta })` | no session, or session `finished`, or a different puzzle, or `restart: true`; a running session for the *same* puzzle is returned unchanged | new `SolveSession` (status `running`, `replay = puzzleId ∈ completions`); the previous finished session is discarded (Review uses `/puzzles/:id/solution`) |
| `submitWord({ solveId, questionIndex, correct, now, topology })` | session id matches; status `running` (paused ⇒ `PAUSED`; finished ⇒ return `lastResult` if `questionIndex ∈ locked`, else `FINISHED`); `questionIndex ∉ locked` (else no-op returning current state); `wrongByQ[q] < 20 && wrongTotal < 100` (else `GUESS_BUDGET`) | wrong: counters++ (state changes ⇒ version bump, no flush). Correct: `locked += q`, `sweep(topology)`, push `locks` entry, `guesses.total++`; if `locked.length === questionCount` ⇒ **inline finish** (below) |
| `spendForHint({ solveId, q, kind, now })` | `running`; `q ∉ locked`; `tokens ≥ cost` (else `INSUFFICIENT_TOKENS` ⇒ 402) | debit, `hintsUsed++`, `hintLog` push; for `fifty` the route then stores `pendingFifty` via `setPendingFifty` in the same RPC pipeline (or the command accepts `options` computed by the route beforehand — preferred: the route computes options first, then one command `spendForHint({ …, pendingOptions })`) |
| `revealLetter`, `revealWord` | are **route-level compositions**: `spendForHint` then `submitWord(correct: true)` for `word`; for `letter` the route returns the letter and, if the client's letters plus the revealed one complete the answer, also calls `submitWord(correct: true)` | the hint's `at` and the lock's `at` are both recorded |
| `setAutocheck({ solveId, on, now })` | `running` | `autocheck = on`; when turning on: `autocheckUsed = true`, `checkTickets++` (≤ 6 else `CHECK_BUDGET`), `lastTicketAt = now`; returns the fields the route signs into the ticket |
| `renewCheckTicket({ solveId, now })` | `running && autocheck` | same counter rules; called by the client when the ticket expires |
| `pauseSolve` / `resumeSolve` | `running` / `paused` | `pausedSince = now` / `pausedMs += now − pausedSince`, `pauseCount++` on pause |
| `finishSolve` (public command kept for `POST /finish`) | session `finished` and id matches ⇒ return `lastResult`; `running` with all locked cannot happen (finish is inline); otherwise `NO_ACTIVE_SESSION`/`NOT_COMPLETE` | no state change |

**Inline finish (inside the `submitWord` commit, same rules as README §Request lifecycle step 3):** `elapsedMs = now − startedAt − pausedMs`; `secLeft = max(0, floor((parSec × 1000 − elapsedMs)/1000))`; `suspicious = S1 || S2` (§4); `tokens = replay || suspicious ? 0 : floor(secLeft/5)`; `stars = replay ? 0 : 10 + (hintsUsed === 0 ? 2 : 0)`; `completions[puzzleId] = { day, solvedAt, timeMs, hintsUsed, tokens, stars, suspicious, boardEligible, telemetry }` (first solve only); `applyStreak`; `stats`; `ledgerSeq++`; `session.status = "finished"`, `finishedAt`, `lastResult = SolveResult` (with `balances`, `streak`, `firstSolve`, `boardStatus`). The route then dispatches `solve.finished` exactly as the README describes (collections critical, `PuzzleStats.recordSolve` critical **only if `boardEligible`**, notifications background) and returns `{ correct: true, …, finished: true, result }`. Retries: the same `words` call again finds `questionIndex ∈ locked` and `status === "finished"` ⇒ returns `lastResult` without re-dispatching; the reconcile route (`POST /me/reconcile`) heals a lost fan-out from `completions` as before.

**What `words` returns.** `fixedLetters` are computed by the route from the secret **only for `newlyLocked` questions** (typed + swept) — never for the whole `locked` set; a wrong guess returns `[]`. `GET /solves/:id` returns letters for every cell covered by `session.locked` (server-owned), which is the resume/Review payload.

### 3. Oracle budgets and what the client shows

- **Wrong guesses**: 20 per question, 100 per solve. Response carries `guessesLeft: { question, solve }` so the banner can show "3 tries left" from 5 downwards. On `GUESS_BUDGET` the banner reads "Out of tries for this clue — reveal a letter (🪙 40), solve it (🪙 100), or let the crossing answers fill it in"; the keyboard stays enabled for other questions; the hint sheet opens on tap. Crossing locks still sweep the question.
- **`check`** (autocheck): accepted only with `ticket` = `base64url(payload) + "." + base64url(HMAC-SHA-256(payload))`, `payload = "chk:" + solveId + ":" + issuedAt + ":" + n` signed with `CHECK_TICKET_KEY` (a Worker secret; rotate with `kid` like the device-token ring). Verify: signature (`crypto.subtle.verify`, constant-time), `solveId` equals the path param, `now − issuedAt < 10 min`. Body `{ questionIndex, letters }` where `letters` is the client's entries for that question's cells (`.` for empty, length = word length); the response is `{ wrongCells: [r, c][] }` restricted to that question. Throttle `RL_CHECK.limit({ key: "chk:" + solveId })` (30/60 s) before touching the secret. When the ticket is expired the client calls `POST /solves/:id/autocheck { on: true }` again (DO renews, counts); after the 6th ticket the DO returns `CHECK_BUDGET` and the client turns the autocheck toggle off with "Autocheck is taking a break — it comes back on your next puzzle". While autocheck is off, `check` returns 403 `AUTOCHECK_OFF`.
- **Hints**: unchanged prices; `RL_SPEND` 20/60 s stays; `fifty` options are stored server-side; `letter` accepts the client's letters (bounded to word length) and never returns more than one cell; `word` locks through `submitWord(correct: true)` so it is recorded as a lock with `typed: false`? No — record hint locks as `typed: true, hinted: true`? Keep it simple: `locks[].source: "typed" | "hint" | "sweep"`; hint locks are excluded from the S2 speed check.
- **Rate limits summary**: `RL_USER` 120/60 s (all routes), `RL_SPEND` 20/60 s (hints, purchases, spins), new `RL_CHECK` 30/60 s keyed by `solveId`. Add to `wrangler.jsonc`: `{ "name": "RL_CHECK", "namespace_id": "1004", "simple": { "limit": 30, "period": 60 } }`.

### 4. Fairness model for leaderboards

**Per-solve telemetry recorded server-side** (`session.locks[]`, `guesses`, `checkTickets`, `hintLog`, `pauseCount`, `pausedMs`) and copied at finish into `completions[puzzleId].telemetry = { typed, swept, wrong, checks: checkTickets, hints, pauses, minGapMs, firstLockMs }` and into new `player_solves` columns (`typed_words, wrong_guesses, check_tickets, pause_count, min_gap_ms, first_lock_ms, board_eligible, flags`). Keep the full `locks[]` in the DO completion record only (≤ 10 entries × ~30 bytes).

**Rules evaluated in the finishing commit:**

| rule | condition | effect |
|---|---|---|
| S1 plausibility floor | `elapsedMs < max(12_000, 400 × fillableCells)` (5×5: 12 s; a 9×9 with 65 fillable cells: 26 s) | `suspicious` |
| S2 typing floor | ≥ 2 typed locks (source `typed`) whose gap from the previous lock (or from `startedAt` for the first) is `< 80 ms × wordLength` | `suspicious` |
| S3 too clean | `wrongTotal === 0 && checkTickets === 0 && hintsUsed === 0 && elapsedMs < 2 × minPlausibleMs` | `flags += "clean_fast"` (audit only, stays on the board) |
| S4 oracle use | `checkTickets ≥ 4` or (from the stateless route) `RL_CHECK` refusals observed ≥ 3 in the solve (counted by the route via a cheap `noteCheckThrottle` command, at most once per minute) | `flags += "check_heavy"`; `boardEligible = false` |
| replay | `puzzleId ∈ completions` at start | not eligible, 0 tokens, 0 stars |
| pauses | `pauseCount > 0` | not eligible (time still shown to the user as "unranked") |
| veteran-or-attested | `eligibleSolvesOnDistinctDays ≥ 3 on ≥ 2 earlier local days` **or** `installs[current].attested` | required for `topToday`; weekly board unaffected |

**Exclusion policy.** `suspicious` ⇒ `tokens = 0`, stars granted, completion recorded, `boardEligible = false`, `SolveResult.boardStatus = "unranked"` (copy: "Time not ranked"). Three suspicious finishes within 30 days ⇒ `boardShadow = true` on the account (all future finishes `boardEligible = false` until an admin clears it; no user-facing message — shadow exclusion). A nightly cron (`0 6 * * *`, reuse the existing health cron) audits `flags != ''` rows in the top 10 of each puzzle of the last 7 days plus new-account clusters by `cf-connecting-ip`/ASN and can set `boardShadow` via an admin route. `PuzzleStats.recordSolve` is only called for `boardEligible` solves, so `topToday` never has to be rewritten; the weekly cron already excludes `suspicious = 1` and additionally excludes `board_shadow` users by joining `player_state`.

**When attestation becomes mandatory for `topToday`.** Ship the columns (`installs[].attested`, `attest_keys` table) and the lazy flow in M5 but keep `ATTEST_REQUIRED = false`. Flip it when any trigger fires: (a) > 5 % of `topToday` rows over 7 days come from accounts younger than 2 days despite the veteran rule, (b) a confirmed harvest ring (S3/S4 audit hits sharing IP/ASN), or (c) a public leaderboard feature (weekly top 100 with display names) launches. When `ATTEST_REQUIRED` is on, `boardEligible` additionally requires `attested`, and the veteran rule is dropped.

**Lazy attestation flow** (keeps App Attest assertions and Play Integrity requests to a handful per puzzle-day): the finishing commit computes `wouldEnterTop = rows.length < 10 || timeMs < rows[9].timeMs` from the `PuzzleStats` snapshot passed in by the route (one extra DO read on the finishing request only). If `wouldEnterTop && !attested && ATTEST_REQUIRED` ⇒ `boardStatus = "attestation_required"`, the row is *not* recorded yet; the client obtains an assertion (`DCAppAttestService.generateAssertion(keyId, SHA-256(clientData))`, `clientData = solveId + ":" + serverChallenge`) or a Play Integrity standard token (`requestHash = SHA-256(solveId + ":" + serverChallenge)`), posts `POST /solves/:id/attest`, the Worker verifies (F10/F12) and then calls `PuzzleStats.recordSolve`. Challenges are single-use 32-byte values stored in the session (`attestChallenge`). Android quota: 10,000 verdicts/day by default (F12) versus ≤ ~30 board-entering finishes per puzzle-day ⇒ no quota risk. iOS: attest once per install at bootstrap (`POST /devices { attestation, keyId, challenge }` after `GET /devices/challenge`); store `{ userId, installId, keyId, publicKeySpki, counter, env }` in D1 `attest_keys`; reject a key already bound to another user (Apple's replay note, F10). Web installs are never attested and never board-eligible.

**Library decision for attestation (F13).** Do not depend on `node-app-attest`/`appattest-checker-node` (Node Buffer/stream CBOR, `@types/node`). Spike (≤ 1 day, before M5): `@levischuck/tiny-cbor` to decode the attestation `{ fmt, attStmt: { x5c, receipt }, authData }`, `@peculiar/x509` `X509Certificate`/`X509ChainBuilder` with the Apple App Attest Root CA PEM embedded as a constant, WebCrypto `crypto.subtle.digest("SHA-256")` for `clientDataHash`/`nonce`/key id, ASN.1 lookup of extension OID `1.2.840.113635.100.8.2` (via `@peculiar/asn1-schema`), and `crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, nonce)` for assertions with the stored P-256 SPKI. Whether `@peculiar/x509` 2.0.0 bundles cleanly for workerd (its `tsyringe` dependency historically wants `reflect-metadata`) is **UNVERIFIED**; if it fails, fall back to `pkijs` 3.4.0 with `setEngine("workers", crypto, crypto.subtle)` (also **UNVERIFIED**), and if both fail, verify assertions only in the Worker (pure WebCrypto) and perform the one-time attestation check in a small Node job behind an admin route — the only case where the one-Worker rule would bend. Play Integrity needs a service-account JWT (RS256 via WebCrypto `RSASSA-PKCS1-v1_5`, listed in the Workers algorithm table, **medium** confidence) exchanged for an OAuth token and one `fetch` to `decodeIntegrityToken`.

### 5. Review-mode contract after completion

- `GET /puzzles/:id/solution` (device auth, `RL_USER`) → **200** `{ puzzleId, grid: string[] /* letters, "#" blocks */, questions: [{ index, dir, num, clue, answer, cells }], completion: { solvedAt, timeMs, hintsUsed, tokens, stars, boardEligible, boardStatus } }` only when `completions[puzzleId]` exists in the caller's `User` snapshot (strongly consistent, one DO read); otherwise **403** `NOT_COMPLETED`. `Cache-Control: private, no-store` (the body contains answers; do not let an intermediary or the device cache keep it after `DELETE /me`). The route reads `content.withSecret(id)` — the same cache as `words`.
- `GET /solves/:solveId` → `SolveView`; for a finished session `status: "finished"`, `locked` = all questions, `fixedLetters` = every fillable cell, `result: SolveResult` (the cached `lastResult`), `secLeft` frozen. After `startSolve` replaced the session → **404** `SOLVE_GONE { puzzleId }`; the client then uses `/puzzles/:id/solution` (its `me.done` flag from `/puzzles/:id` already tells it which to call).
- `GET /puzzles/:id` note becomes: "never includes answers; after completion the client calls `GET /puzzles/:id/solution` for Review; `me.inProgressSolveId` points at a running/paused session only".
- `Play again` = `POST /puzzles/:id/solves { restart: true }` ⇒ `replay: true` session; the client may show the solution afterwards but the replay earns nothing and is not board-eligible, so the leak of one's own completed puzzle is harmless.

### 6. Reconciled routes (replace the README solving table)

| method | path | auth / limit | body (Zod) | response (Zod) | notes |
|---|---|---|---|---|---|
| POST | `/puzzles/:id/solves` | device | `StartBody` `{ restart?: boolean }` | `SolveView` | `User.startSolve`; emits `solve.started` |
| GET | `/solves/:solveId` | device | — | `SolveView` | 404 `SOLVE_GONE` after replacement |
| POST | `/solves/:solveId/words` | device (`RL_USER`) | `WordBody` `{ questionIndex, word }` (strict) | `WordResult` | one DO hop; finishing word returns `result` |
| POST | `/solves/:solveId/hints/fifty` | device (`RL_SPEND`) | `QuestionBody` | `FiftyResult` `{ options: [a,b], balances }` | 402 `INSUFFICIENT_TOKENS`; options stored in DO |
| POST | `/solves/:solveId/hints/fifty/pick` | device | `PickBody` `{ questionIndex, word }` | `WordResult` | word must be one of `pendingFifty.options`, else 422 `NOT_AN_OPTION`; counts as a guess |
| POST | `/solves/:solveId/hints/letter` | device (`RL_SPEND`) | `LetterBody` `{ questionIndex, letters?: string }` | `LetterResult` `{ cell: [r,c], letter, word: WordResult \| null, balances }` | `letters` bounded to word length; if it equals the answer ⇒ lock without charge (`word` set, `cell` null) |
| POST | `/solves/:solveId/hints/word` | device (`RL_SPEND`) | `QuestionBody` | `WordResult` | `spendForHint(100)` then `submitWord(correct: true, source: "hint")` |
| POST | `/solves/:solveId/autocheck` | device | `AutocheckBody` `{ on: boolean }` | `AutocheckResult` `{ autocheck, ticket: string \| null, expiresAt: number \| null, ticketsLeft }` | DO command; 422 `CHECK_BUDGET` after 6 tickets |
| POST | `/solves/:solveId/check` | device (`RL_CHECK` per solve) | `CheckBody` `{ questionIndex, letters, ticket }` | `CheckResult` `{ wrongCells: [r,c][] }` | stateless; 403 `AUTOCHECK_OFF` / `BAD_TICKET`; 429 on throttle |
| POST | `/solves/:solveId/pause`, `/resume` | device | — | `{ secLeft, running, pauseCount }` | commands while paused ⇒ 409 `PAUSED` |
| POST | `/solves/:solveId/finish` | device | — (no body; `grid` removed) | `SolveResult` | returns the cached result; 409 `NOT_COMPLETE` while locks remain; 404 `SOLVE_GONE` |
| POST | `/solves/:solveId/attest` | device | `AttestBody` (discriminated on `platform`) | `{ boardStatus }` | only when `result.boardStatus === "attestation_required"` |
| GET | `/puzzles/:id/solution` | device | — | `SolutionView` | 403 `NOT_COMPLETED` |
| — | `/solves/:solveId/progress` | — | — | — | **removed** (locks are server-owned; `/me/continue` reads `session.locked.length`) |

`UserState` changes: `session: SolveSession | null` as in §2; `installs: { id, platform, attested: boolean, keyId?: string }[]`; `boardShadow: boolean`; `completions[*].boardEligible`, `.telemetry`, `.flags`. D1 `player_solves` gains the telemetry columns listed in §4 and `board_eligible INTEGER NOT NULL DEFAULT 0`; index `(puzzle_id, board_eligible, time_ms)` replaces `(puzzle_id, suspicious, time_ms)`. New table `attest_keys (key_id TEXT PRIMARY KEY, user_id, install_id, platform, public_key_spki BLOB, counter INTEGER, env TEXT, created_at)`.

### 7. Tests that prove the leak is closed (workerd, `@cloudflare/vitest-plugin` 1.1.3)

All HTTP tests go through `exports.default.fetch(new Request(...), env, ctx)` with a device token minted by the test helper; DO-level tests use `runInDurableObject(stub, (instance) => …)`. `now` is injected via a test header honoured only under `TEST_FLAGS` (or fake timers, F14).

| # | test | assertion |
|---|---|---|
| 1 | `words` with `{ questionIndex: 0, word: "BEACH", locked: [0,1,2,3,4,5,6,7,8,9] }` | 400 (strict body). Then without `locked`: `fixedLetters` has exactly 5 entries, all in row 0; no letter from rows 1–4 |
| 2 | `words` wrong guess `{ questionIndex: 1, word: "WRONG" }` | `correct: false`, `fixedLetters: []`, `locked` unchanged, `guessesLeft.question === 19`; DO `version` bumped, `snapshot().projected === true`, D1 `player_state.version` unchanged |
| 3 | fresh `GET /solves/:id` | `fixedLetters: []`, `locked: []`; after locking question 0, letters for row 0 only |
| 4 | word-square sweep | lock across 0–4 on `en-mini-1` ⇒ 5th call returns `newlyLocked` containing all five down questions, `finished: true`, `result.tokensEarned === floor(secLeft/5)` |
| 5 | `hints/letter` with `letters === answer` | 200, `word.correct === true`, `cell === null`, tokens unchanged, `hintsUsed === 0` |
| 6 | `hints/letter` with a wrong letter | tokens −40, exactly one `cell`, `hintsUsed === 1`; `finish` later gives `noHintBonus: false` |
| 7 | guess budget | 20 wrong guesses on one question ⇒ 21st returns 422 `GUESS_BUDGET`; `hints/word` still works and locks |
| 8 | `check` gates | without autocheck ⇒ 403 `AUTOCHECK_OFF`; with a ticket signed for another `solveId` ⇒ 403 `BAD_TICKET`; with a tampered signature ⇒ 403; `letters` longer than the word ⇒ 400; 31st call within 60 s ⇒ 429 (miniflare simulates `ratelimits`) |
| 9 | `check` scope | body for question 0 with all five letters wrong ⇒ `wrongCells` ⊆ cells of question 0 and length 5; never returns letters |
| 10 | autocheck budget | 6 `autocheck { on: true }` toggles ⇒ 7th returns 422 `CHECK_BUDGET`; `check` with the last valid ticket still works until expiry |
| 11 | finish idempotency | the finishing `words` call twice ⇒ identical `result` (deep equal), balances unchanged, `PuzzleStats.solved === 1`; `POST /finish` ⇒ same `result`; `GET /solves/:id` ⇒ `status: "finished"` with 25 `fixedLetters` |
| 12 | S1 | with injected `now`, lock all words 2 s after start ⇒ `suspicious: true`, `tokensEarned: 0`, `starsEarned: 12`, `boardStatus: "unranked"`, `PuzzleStats.topToday.rows` empty |
| 13 | S2 | five typed locks 300 ms apart for 5-letter words (< 400 ms floor) ⇒ `suspicious: true`; the same with 2 s gaps ⇒ eligible |
| 14 | pause | `pause` then `words` ⇒ 409 `PAUSED`; `resume` after 60 s injected ⇒ `secLeft` unchanged by the pause; final `pauseCount === 1` ⇒ `boardEligible: false` |
| 15 | replay | finish, `startSolve { restart: true }`, finish again ⇒ `firstSolve: false`, 0 tokens, 0 stars, `completions` unchanged, `topToday` unchanged |
| 16 | Review | `GET /puzzles/:id/solution` before completion ⇒ 403; after ⇒ full `grid` letters and answers; another user ⇒ 403; after `startSolve` on another puzzle `GET /solves/:oldId` ⇒ 404 `SOLVE_GONE` |
| 17 | veteran gate | a brand-new account's eligible finish does not enter `topToday` (`boardStatus: "not_ranked_new_account"`); after 3 eligible solves on 2 injected days it does |
| 18 | core fingerprint | `packages/core`: subclass with `projectionFingerprint` excluding a field ⇒ commit changing only that field bumps `version`, leaves the D1 row untouched, `projected === true`; `flush(true)` still rebuilds |
| 19 | secret never serialised | property test over all seeded puzzles: for every route response body, `JSON.stringify(body)` contains no answer string except the letters of `newlyLocked`/`locked` cells (helper `assertNoAnswerLeak(body, secret, allowedCells)`) |

## Code sketches

Illustrative only; names follow the README module layout (`solving/http.ts`, `player/internal/user.do.ts`, `packages/shared`).

### Zod 4 schemas (`packages/shared/solving/schemas.ts`)

```ts
import { z } from "zod";

export const PuzzleId = z.string().regex(/^(en|uk|ru)-(mini|cross)-[1-9]\d*$/).brand<"PuzzleId">();
export const SolveId = z.string().regex(/^(en|uk|ru)-(mini|cross)-[1-9]\d*~[0-9a-hjkmnp-tv-z]{22}$/).brand<"SolveId">();
const Q = z.int().min(0).max(199);
const Letters = z.string().regex(/^[A-ZА-ЯЁЇІЄҐ.]{1,15}$/u);   // "." = empty cell; bounded to a word

export const StartBody     = z.strictObject({ restart: z.boolean().optional() });
export const WordBody      = z.strictObject({ questionIndex: Q, word: z.string().min(1).max(15).toUpperCase() }); // no `locked`
export const QuestionBody  = z.strictObject({ questionIndex: Q });
export const PickBody      = z.strictObject({ questionIndex: Q, word: z.string().min(1).max(15).toUpperCase() });
export const LetterBody    = z.strictObject({ questionIndex: Q, letters: Letters.optional() });                  // no `filled`
export const AutocheckBody = z.strictObject({ on: z.boolean() });
export const CheckBody     = z.strictObject({ questionIndex: Q, letters: Letters, ticket: z.string().max(200) });
export const AttestBody    = z.discriminatedUnion("platform", [
  z.strictObject({ platform: z.literal("ios"), keyId: z.string().max(64), assertion: z.base64url().max(4096) }),
  z.strictObject({ platform: z.literal("android"), token: z.string().max(8192) }),
]);

export const Cell = z.tuple([z.int().min(0), z.int().min(0)]);
export const FixedLetter = z.object({ r: z.int().min(0), c: z.int().min(0), ch: z.string().length(1) });
export const Question = z.object({ index: Q, dir: z.enum(["ACROSS", "DOWN"]), num: z.int().min(1), clue: z.string(), length: z.int().min(1), cells: z.array(Cell) }); // no `answer`
export const Balances = z.object({ tokens: z.int().min(0), stars: z.int().min(0) });
export const BoardStatus = z.enum(["ranked", "unranked", "not_ranked_new_account", "attestation_required", "replay"]);

export const SolveResult = z.object({
  solveTimeSec: z.int().min(0), secLeft: z.int().min(0), underPar: z.boolean(),
  tokensEarned: z.int().min(0), starsEarned: z.int().min(0), noHintBonus: z.boolean(), firstSolve: z.boolean(),
  suspicious: z.boolean(), boardStatus: BoardStatus, balances: Balances,
  streak: z.object({ count: z.int().min(0), extendedToday: z.boolean(), week: z.array(z.object({ dayKey: z.iso.date(), state: z.enum(["today", "solved", "missed", "future"]) })).length(7) }),
  claimedCollections: z.array(z.object({ id: z.string(), reward: z.int().min(0) })),
  nextPuzzleId: PuzzleId.nullable(), celebration: z.enum(["coins", "reels", "marquee"]),
});
export const WordResult = z.object({
  correct: z.boolean(), locked: z.array(Q), newlyLocked: z.array(Q),
  fixedLetters: z.array(FixedLetter),                 // ONLY cells of newlyLocked; [] on a wrong guess
  nextQuestionIndex: Q.nullable(),
  guessesLeft: z.object({ question: z.int().min(0), solve: z.int().min(0) }),
  finished: z.boolean(), result: SolveResult.optional(),
});
export const SolveView = z.object({
  solveId: SolveId, puzzleId: PuzzleId, size: z.union([z.literal(5), z.literal(9)]), parSec: z.int(),
  grid: z.array(z.string().regex(/^[.#]+$/)), questions: z.array(Question),
  locked: z.array(Q), fixedLetters: z.array(FixedLetter),   // derived from session.locked in the DO
  secLeft: z.int().min(0), running: z.boolean(), status: z.enum(["running", "paused", "finished"]),
  usedHints: z.boolean(), autocheck: z.boolean(), checkTicket: z.string().nullable(), checkTicketExpiresAt: z.int().nullable(),
  pendingFifty: z.object({ questionIndex: Q, options: z.tuple([z.string(), z.string()]) }).nullable(),
  guessesLeft: z.object({ perQuestion: z.record(z.string(), z.int().min(0)), solve: z.int().min(0) }),
  balances: Balances, replay: z.boolean(), result: SolveResult.nullable(),
});
export const SolutionView = z.object({
  puzzleId: PuzzleId, grid: z.array(z.string()),
  questions: z.array(Question.extend({ answer: z.string() })),
  completion: z.object({ solvedAt: z.int(), timeMs: z.int(), hintsUsed: z.int(), tokens: z.int(), stars: z.int(), boardEligible: z.boolean(), boardStatus: BoardStatus }),
});
```

### `User.submitWord` (inside the aggregate; no letters ever enter the DO)

```ts
type Topology = { questionCount: number; cells: [number, number][][] };   // cached per puzzle in the route
interface SubmitInput { solveId: string; questionIndex: number; correct: boolean; source: "typed" | "hint"; now: number;
                        topology: Topology; minPlausibleMs: number; wouldEnterTop: boolean; attestRequired: boolean }

submitWord(input: SubmitInput) {
  let out = { correct: input.correct, newlyLocked: [] as number[], finished: false };
  const snap = await this.commit((s) => {
    const ses = s.session;
    if (!ses || ses.id !== input.solveId) throw new DomainError("NO_ACTIVE_SESSION");
    if (ses.status === "paused") throw new DomainError("PAUSED");
    if (ses.locked.includes(input.questionIndex)) {           // retry of a lock (or of the finishing word)
      out = { correct: true, newlyLocked: [], finished: ses.status === "finished" };
      return s;                                                 // equal state ⇒ no version bump
    }
    if (ses.status === "finished") throw new DomainError("FINISHED");
    const key = String(input.questionIndex);
    if (!input.correct) {
      if ((ses.guesses.wrongByQ[key] ?? 0) >= WRONG_PER_QUESTION || ses.guesses.wrongTotal >= WRONG_PER_SOLVE)
        throw new DomainError("GUESS_BUDGET");
      ses.guesses.total++; ses.guesses.wrongTotal++; ses.guesses.wrongByQ[key] = (ses.guesses.wrongByQ[key] ?? 0) + 1;
      ses.guesses.lastAt = input.now;
      return s;                                                 // version bump, but projectionFingerprint unchanged ⇒ no D1 flush
    }
    const locked = new Set(ses.locked); locked.add(input.questionIndex);
    const swept = sweep(input.topology, locked);              // pure; cells only
    ses.locked = [...locked].sort((a, b) => a - b);
    ses.locks.push({ q: input.questionIndex, at: input.now, typed: input.source === "typed", swept });
    ses.guesses.total++;
    out = { correct: true, newlyLocked: [input.questionIndex, ...swept], finished: false };
    if (ses.locked.length === input.topology.questionCount) {
      out.finished = true;
      finishInline(s, ses, input);                              // rewards, completion, streak, lastResult — same commit
    }
    return s;
  });
  return { ...out, snapshot: snap };
}

protected override projectionFingerprint(s: UserState) { const { session, ...rest } = s; return rest; }
```

### Route: `POST /solves/:solveId/words` (`solving/http.ts`)

```ts
app.post("/solves/:solveId/words", v("param", z.object({ solveId: SolveId })), v("json", WordBody), async (c) => {
  const { solveId } = c.req.valid("param"); const { questionIndex, word } = c.req.valid("json");
  const { userId } = c.get("auth"); const m = c.get("modules");
  const puzzleId = solveId.slice(0, solveId.indexOf("~"));
  const secret = await m.content.withSecret(puzzleId);                 // isolate cache; never returned
  const q = secret.questions[questionIndex]; if (!q) throw new HTTPException(400, { message: "BAD_QUESTION" });
  const correct = normalizeWord(secret.lang, word) === q.answer;
  const r = await m.player.submitWord({ solveId, questionIndex, correct, source: "typed", now: Date.now(),
    topology: secret.topology, minPlausibleMs: secret.minPlausibleMs, wouldEnterTop: false, attestRequired: c.env.ATTEST_REQUIRED === "1" });
  const fixedLetters = r.newlyLocked.flatMap((qi) => secret.questions[qi].cells.map(([rr, cc], i) => ({ r: rr, c: cc, ch: secret.questions[qi].answer[i] })));
  if (r.finished && r.snapshot.state.session?.lastResult && !r.retried) await m.events.dispatch(solveFinishedFrom(r.snapshot, secret), c.executionCtx);
  return c.json(WordResult.parse({ correct, locked: r.snapshot.state.session!.locked, newlyLocked: r.newlyLocked, fixedLetters,
    nextQuestionIndex: nextUnlocked(r.snapshot.state.session!.locked, questionIndex, secret.topology.questionCount),
    guessesLeft: guessesLeft(r.snapshot.state.session!, questionIndex), finished: r.finished,
    result: r.finished ? r.snapshot.state.session!.lastResult! : undefined }));
});
```

### Autocheck ticket with WebCrypto HMAC (`solving/internal/check-ticket.ts`)

```ts
const enc = new TextEncoder();
let keyPromise: Promise<CryptoKey> | undefined;
const key = (secret: string) => (keyPromise ??= crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));

export async function issueTicket(secret: string, solveId: string, issuedAt: number, n: number) {
  const payload = `chk:${solveId}:${issuedAt}:${n}`;
  const sig = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(payload));
  return `${b64url(enc.encode(payload))}.${b64url(new Uint8Array(sig))}`;
}
export async function verifyTicket(secret: string, ticket: string, solveId: string, now: number): Promise<boolean> {
  const [p, s] = ticket.split("."); if (!p || !s) return false;
  const payload = new TextDecoder().decode(unb64url(p));
  const [tag, sid, issuedAt] = payload.split(":");
  if (tag !== "chk" || sid !== solveId || now - Number(issuedAt) > CHECK_TICKET_TTL_MS) return false;
  return crypto.subtle.verify("HMAC", await key(secret), unb64url(s), enc.encode(payload));   // constant-time per WebCrypto
}

// route: POST /solves/:solveId/check
app.post("/solves/:solveId/check", v("param", …), v("json", CheckBody), async (c) => {
  const { solveId } = c.req.valid("param"); const { questionIndex, letters, ticket } = c.req.valid("json");
  if (!(await verifyTicket(c.env.CHECK_TICKET_KEY, ticket, solveId, Date.now()))) throw new HTTPException(403, { message: "BAD_TICKET" });
  if (!(await c.env.RL_CHECK.limit({ key: `chk:${solveId}` })).success) throw new HTTPException(429, { message: "CHECK_THROTTLED" });
  const secret = await c.get("modules").content.withSecret(solveId.slice(0, solveId.indexOf("~")));
  const q = secret.questions[questionIndex]; if (!q || letters.length !== q.answer.length) throw new HTTPException(400, { message: "BAD_CELLS" });
  const wrongCells = q.cells.filter((_, i) => letters[i] !== "." && letters[i] !== q.answer[i]);
  return c.json({ wrongCells });                                      // positions only, never letters
});
```

### Rejected alternative, for the record: stateless `words` with an HMAC locked proof

```ts
// proof = b64url(HMAC(`lock:${solveId}:${bitmap}:${issuedAt}`)); client echoes { questionIndex, word, bitmap, proof }
// server: verify proof → locked = bitsToSet(bitmap) → check word → sweep → new bitmap → new proof
// Closes T1 only. No wrong-guess counter, no check budget, no lock timestamps, no idempotent finish, still two hops on the finishing word.
```

### `Aggregate.projectionFingerprint` hook (`packages/core/src/aggregate.ts`, diff sketch)

```ts
/** Override to exclude hot fields from projection. Default: whole state. */
protected projectionFingerprint(state: State): unknown { return state; }

protected async commit(mutate: (state: State) => State): Promise<Snapshot<State>> {
  this.#requireInit();
  const prev = this.#state as State;
  const next = mutate(structuredClone(prev));
  const changed = this.#persist(next);
  if (changed && JSON.stringify(this.projectionFingerprint(prev)) === JSON.stringify(this.projectionFingerprint(this.#state as State))) {
    this.#projected = this.#version;                                   // nothing a D1 reader can see changed
    this.sql.exec("UPDATE aggregate SET projected = ? WHERE key = 1", this.#version);
  } else {
    await this.#flushAfterCommit();
  }
  return this.snapshot();
}
```

### iOS assertion verification skeleton (Workers-native, to be spiked)

```ts
import { decodeCBOR } from "@levischuck/tiny-cbor";
export async function verifyAssertion(a: { assertion: Uint8Array; clientData: Uint8Array; spki: Uint8Array; counter: number; appIdHash: Uint8Array }) {
  const m = decodeCBOR(a.assertion) as Map<string, unknown>;             // { signature, authenticatorData }
  const authData = m.get("authenticatorData") as Uint8Array, sig = m.get("signature") as Uint8Array;
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", a.clientData));
  const nonce = await crypto.subtle.digest("SHA-256", concat(authData, clientDataHash));   // F10 step 2
  const key = await crypto.subtle.importKey("spki", a.spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(sig), nonce);   // App Attest signatures are DER; WebCrypto wants raw r||s
  const rpIdHash = authData.slice(0, 32), counter = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  return ok && timingSafeEqual(rpIdHash, a.appIdHash) && counter > a.counter ? { counter } : null;
}
```

### Test: the leak is closed (`workers/gateway/test/solving.leak.test.ts`)

```ts
import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { bootstrap, start, secretFor } from "./helpers";

describe("solution never leaves the Worker", () => {
  it("rejects client-supplied locks and returns letters only for the submitted word", async () => {
    const { token } = await bootstrap(env);
    const { solveId } = await start(env, token, "en-mini-1");
    const forged = await exports.default.fetch(new Request(`https://x/v1/solves/${solveId}/words`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ questionIndex: 0, word: "BEACH", locked: [0,1,2,3,4,5,6,7,8,9] }) }), env);
    expect(forged.status).toBe(400);                                                   // strict body
    const res = await exports.default.fetch(new Request(`https://x/v1/solves/${solveId}/words`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ questionIndex: 0, word: "BEACH" }) }), env);
    const body = await res.json() as { fixedLetters: { r: number; c: number; ch: string }[]; locked: number[] };
    expect(body.locked).toEqual([0]);
    expect(body.fixedLetters).toHaveLength(5);
    expect(body.fixedLetters.every((f) => f.r === 0)).toBe(true);
    const secret = secretFor("en-mini-1");
    for (const row of secret.sol.slice(1)) expect(JSON.stringify(body)).not.toContain(row);   // rows 1–4 never appear
  });
});
```

## Claims

| id | claim | source | confidence |
|---|---|---|---|
| C1 | README v1 `POST /solves/:id/words` is stateless, takes the client's `locked: number[]` and returns `fixedLetters` for every locked word recomputed from the secret, so one call with all questions locked returns the whole solution | `docs/research/README.md` §API surface rows `/solves/:solveId/words`, `/solves/:solveId` | high |
| C2 | README v1 `/finish` is "idempotent per `sessionId`" but the finish commit sets `session = null`, and `/puzzles/:id` says Review returns letters "via `/solves/:id`" — mutually inconsistent | `docs/research/README.md` §Request lifecycle step 3, §API rows `/finish`, `/puzzles/:id` | high |
| C3 | Prototype: a word locks when equal to the answer, the sweep locks any question whose cells are all fixed, `hintLetter` returns without charging when no cell is wrong, `spendTokens` sets `usedHints`, autocheck is free and compares against `sol` at render time | `scratchpad/prototype-logic.js` L111–125, L143–162, L193–196, L380, L535–555 | high |
| C4 | Durable Objects Paid pricing: $0.15 per million requests beyond 1M included; each RPC method call is one billed request; SQLite rows written $1.00/million beyond 50M; duration $12.50 per million GB-s beyond 400k | https://developers.cloudflare.com/durable-objects/platform/pricing/ | high |
| C5 | D1 Paid: 50M rows written/month included, then $1.00 per million; 25B rows read included | https://developers.cloudflare.com/d1/platform/pricing/ | high |
| C6 | Workers Paid: 10M requests included, $0.30 per additional million; 30M CPU-ms included | https://developers.cloudflare.com/workers/platform/pricing/ | high |
| C7 | A Durable Object is created "in a data center close to where the initial `get()` request is made" and does "not currently change locations after they are created"; `locationHint` is best effort | https://developers.cloudflare.com/durable-objects/reference/data-location/ | high |
| C8 | Soft limit of 1,000 requests/second per object; DOs are single-threaded; input gates defer other events while a storage operation runs, output gates hold outgoing messages until writes complete | https://developers.cloudflare.com/durable-objects/platform/limits/ , https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/ , https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/ | high |
| C9 | No official Durable Object RPC round-trip latency figure exists on the limits/data-location pages; the 10–40 ms in-region estimate is an assumption | https://developers.cloudflare.com/durable-objects/platform/limits/ , https://developers.cloudflare.com/durable-objects/reference/data-location/ | low (UNVERIFIED) |
| C10 | Workers RPC accepts structured-cloneable arguments/returns, every call behaves asynchronously, and promise pipelining can batch dependent calls into one round trip | https://developers.cloudflare.com/workers/runtime-apis/rpc/ | high |
| C11 | Workers Web Crypto supports HMAC `sign`/`verify`, ECDSA `verify`/`importKey`, SHA-256 `digest`, and the non-standard `crypto.subtle.timingSafeEqual` | https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ | high |
| C12 | Rate Limiting binding: `simple.period` must be 10 or 60 s, `limit({ key })` returns `{ success }`, limits are per Cloudflare location and "permissive, eventually consistent" | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ | high |
| C13 | App Attest attestation validation requires: `x5c` chain to Apple's App Attest root, `nonce` = SHA-256(authData ‖ SHA-256(challenge)) in extension OID 1.2.840.113635.100.8.2, key id = SHA-256 of the uncompressed public key, `rpIdHash` = SHA-256(App ID), `counter == 0`, `aaguid` ∈ {appattestdevelop, appattest}, `credentialId` = key id, and the `extensions` CBOR values; assertion validation requires `nonce` = SHA-256(authenticatorData ‖ clientDataHash), signature by the stored key, `rpIdHash`, and a strictly increasing `counter` | https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server (read via developer.apple.com/tutorials/data/…json) | high |
| C14 | App Attest: check `isSupported`; retry `attestKey` only on `serverUnavailable`; challenge ≥ 16 bytes; assertions are unlimited but should be reserved for sensitive moments | https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity | high |
| C15 | Play Integrity: verdict fields `requestDetails.requestHash/nonce/timestampMillis`, `appIntegrity.appRecognitionVerdict = PLAY_RECOGNIZED`, `deviceIntegrity.deviceRecognitionVerdict ∋ MEETS_DEVICE_INTEGRITY`; tokens decoded via `playintegrity.googleapis.com/v1/…:decodeIntegrityToken`; default quota 10,000 requests/day; standard requests ≈ hundreds of ms, classic ≈ seconds | https://developer.android.com/google/play/integrity/verdicts , https://developer.android.com/google/play/integrity/overview | high |
| C16 | npm (2026-09-02): `@levischuck/tiny-cbor` 0.3.6 (no deps), `cbor2` 2.3.0, `cbor-x` 1.6.6, `@peculiar/x509` 2.0.0 (WebCrypto-provider based), `pkijs` 3.4.0, `node-app-attest` 1.0.1 (deps `cbor ^10`, `pkijs`, `asn1js`), `appattest-checker-node` 1.0.3 (deps `@peculiar/x509 ^1.9.6`, `cbor ^9`, `@types/node`) | `npm view <pkg> version dependencies` | high |
| C17 | None of the App Attest npm packages documents Workers/workerd support; `tiny-cbor` + `@peculiar/x509` + WebCrypto is a plausible Workers-native composition but is unproven inside workerd | `npm view … readme` (no Workers mention); no spike run | low (UNVERIFIED) |
| C18 | Workers WebCrypto lists RSASSA-PKCS1-v1_5 (needed to sign a Google service-account JWT) | https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ (algorithm table; not re-quoted in this pass) | medium |
| C19 | `@cloudflare/vitest-plugin` 1.1.3 bundles wrangler 4.128.0 / miniflare 5.20260831.0-alpha, peers `vitest ^4.1.0`; `cloudflare:test` provides `runInDurableObject`, `runDurableObjectAlarm`; tests call `exports.default.fetch()` from `cloudflare:workers` | `npm view @cloudflare/vitest-plugin@1.1.3`; `docs/research/testing-and-dx.md` F1–F4 (https://developers.cloudflare.com/workers/testing/vitest-integration/) | high |
| C20 | `packages/core` `Aggregate.commit` bumps `version` on any JSON change and then flushes to D1 whenever `version > projected`; there is no hook to skip projection for hot fields | `/Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts` (`commit`, `#persist`, `#flushAfterCommit`) | high |
| C21 | Harvest cost through the README `check` route: ≈ 325 expected calls (uniform letters) / ≈ 190 with frequency ordering / 650 worst case for 25 cells ⇒ 1.6–5.4 min at 120 calls/min | arithmetic over `RL_USER` 120/60 s (`docs/research/README.md` §Stack decisions) | high |
| C22 | Cost delta of `words` as a DO command: ≈ +12 DO requests per DAU-day ⇒ ≈ +$0.18/month at 3k DAU and ≈ +$2.70/month at 50k DAU; flushing the projection on each lock would add ≈ 54M D1 rows/month at 50k DAU (≈ +$37/month) | C4, C5, `durable-objects-d1-domain.md` R12 assumptions | medium |
| C23 | miniflare simulates the `ratelimits` binding locally (third call in a 2/10 s limit returns `success: false`), so the `RL_CHECK` 429 test can run in workerd | `docs/research/wrangler-config.md` §13 (verified there) | medium |
| C24 | Apple's App Attest Root CA PEM is published by Apple and must be embedded as a constant; exact download URL not re-verified in this pass | Apple certificate authority page (URL UNVERIFIED) | low (UNVERIFIED) |

## Open questions

1. **Pauses and the board.** This document makes any pause board-ineligible (`pauseCount === 0`). Alternative: allow ≤ 1 pause of ≤ 60 s. Product call; the telemetry supports either.
2. **Veteran rule threshold.** ≥ 3 eligible solves on ≥ 2 earlier local days keeps first-day players off `topToday`. Is a softer "≥ 1 earlier day" acceptable, or should new accounts be shown their rank privately (`me.rank`) but not listed?
3. **Wrong-guess budget size.** 20 per question / 100 per solve is generous for humans and fatal for enumeration; confirm with playtests that stuck beginners do not hit it before buying a hint.
4. **`check` per-solve cap.** The ticket scheme caps autocheck *time* (6 × 10 min), not calls; if oracle abuse shows up in S4 flags, promote `check` to a DO command (≈ +$22/month at 50k DAU at 100 calls/solve) or lower `RL_CHECK` to 20/60 s.
5. **`projectionFingerprint` in `packages/core`.** Approve the base-class change (and its test) before M2; the alternative is a separate DO SQLite `session` table written outside the versioned state, which loses the single-commit finish.
6. **DO RTT budget.** Measure `words` p50/p95 from a device in EU and NA against a deployed preview before finalising the client's "checking" animation (C9 is unverified).
7. **Attestation spike.** Run the one-day workerd spike for `@levischuck/tiny-cbor` + `@peculiar/x509` (chain build to the Apple root, extension OID lookup, DER→raw ECDSA conversion) and for `pkijs` as fallback; decide the Node-job fallback only if both fail.
8. **Which puzzles count for "veteran"?** Solves in any language count today; decide whether replays or suspicious solves ever count (this document: no).
9. **Display of unranked results.** Copy for `boardStatus` values (`unranked`, `not_ranked_new_account`, `attestation_required`) on the Solved screen is not in the handoff; the design needs a line under the time.
10. **Cron audit tooling.** The nightly audit needs an admin route to set/clear `boardShadow` and to list `flags`; not in the README API table yet.
11. **Session abandonment.** `SESSION_ABANDON_MS = 24 h` is a guess; a paused session older than that could instead be auto-finished as over-par (0 tokens) so `/me/continue` does not show week-old puzzles.
12. **Web platform.** Web installs are never board-eligible under the attestation rule; confirm the web client is out of scope for leaderboards (README lists `platform: web` in `/devices`).
