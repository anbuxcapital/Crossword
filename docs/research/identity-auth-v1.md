# v1 identity without accounts, and the upgrade path to Better Auth

Slug: `identity-auth-v1` · Researched 2026-09-02 against official docs and the actual npm packages
(hono 4.13.5, better-auth 1.7.2, @better-auth/expo 1.7.2, wrangler 4.128.0 / miniflare 5.20260831.0-alpha,
expo-secure-store 57.0.3, expo-crypto 57.0.2). Anything not verified against a primary source is marked
**UNVERIFIED** in the text and `low` in the claims table. Fact-checked 2026-09-02; corrections are applied inline and
listed in the "Fact-check log" at the end.

## Summary

Crosscut v1 ships with **no sign-up**. Every install still needs a stable server-side identity, because
the economy (🪙 tokens, ⭐ stars, 🔥 streak, wheel spins, hint purchases, leaderboards) lives in a `User`
Durable Object aggregate keyed by user id. The question is how the client proves "I am user X".

**Recommendation: server-issued, HMAC-SHA256-signed device tokens (compact JWT, `HS256`, signed and verified
with `hono/jwt` on WebCrypto), sent as `Authorization: Bearer …`.** Not a raw client-generated
`X-Device-Id` (anyone can claim any id and drain or forge another player's balances/leaderboard rows) and not a
database-backed session (adds a D1/DO lookup to every request for no v1 benefit). The token is stateless on the
hot path, the user id inside it is server-generated, keys rotate via a standard `kid` JWS header (set by handing `hono/jwt`
the HMAC key as a JWK object), and revocation
(rare in v1) is a `tokenVersion` check inside the aggregate on sensitive commands.

Storage: `expo-secure-store` on iOS/Android. On iOS the Keychain item persists across reinstall with the same bundle
id, so the streak survives a reinstall; on Android the Expo docs state the opposite (data "will not be preserved upon
app uninstallation"), so an Android reinstall is a new player until accounts exist and the FAQ must say so per
platform. `localStorage` on Expo web. CORS is only needed for Expo web in dev
(`http://localhost:8081`) and for a separately hosted web origin; the Bearer scheme means `credentials: false`
and no cookie headaches.

Abuse: Cloudflare's **Rate Limiting binding** (`ratelimits` in wrangler config, GA since 2025-09-19, simulated
locally by miniflare) for coarse per-IP throttling of the unauthenticated bootstrap endpoint and per-user
throttling elsewhere; **exact** limits (one wheel spin per day, one daily-solve reward per puzzle, hint
purchase caps) are enforced inside the `User` aggregate, which is serialized per user anyway. KV counters are
the wrong tool (1 write/second/key, eventually consistent).

Upgrade path: Better Auth self-hosted in the gateway Worker (D1 via the Drizzle adapter, or Better Auth's
native D1 support since 1.5), `@better-auth/expo` on the client, Sign in with Apple via the id-token flow.
Device tokens keep working after the upgrade. Linking is an explicit `POST /v1/account/link` while holding both
a valid device token and a fresh Better Auth session; the gateway **absorbs** the device user's aggregate into
the account user's aggregate (deterministic merge rules below), tombstones the device aggregate with
`mergedInto`, and re-mints the device token for the account id. App Store: v1 is compliant with 5.1.1(v) because
nothing requires a login; the moment accounts exist you must offer in-app account deletion, and if you add any
third-party login (Google etc.) you must offer a privacy-preserving alternative (Sign in with Apple satisfies
4.8).

## Findings

### F1. Raw client UUID in a header is not identity, it is a claim

A client-generated id (`X-Device-Id: <uuid>`) is unforgeable only if the client is honest. Any HTTP client can
send any id: read another player's balances, spend their tokens on hints, post leaderboard times under their
name, or pre-empt their daily reward. The only defensible use of a client-generated id is as an *informational*
install id for analytics/abuse correlation, never as the authorization subject. This is a reasoning finding,
not a sourced one; it is the reason the rest of the document exists.

### F2. WebCrypto in Workers supports everything needed for HMAC tokens

Cloudflare's Web Crypto page lists HMAC (sign/verify), ECDSA, Ed25519, RSA variants, `crypto.subtle` as a
global, `crypto.randomUUID()` (RFC 4122 v4), and two non-standard extensions: `crypto.subtle.timingSafeEqual`
and `DigestStream`.
Source: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/

### F3. `hono/jwt` signs and verifies HS256 on WebCrypto and has key-rotation-friendly helpers

Verified in the published `hono@4.13.5` type definitions (`dist/types/utils/jwt/jwt.d.ts`):

- `sign(payload, key: string | JsonWebKey | CryptoKey, alg?)`
- `verify(token, key, algOrOptions: SignatureAlgorithm | { alg, iss?, aud?, nbf?, exp?, iat? })`
- `decode(token)` (unverified) and `decodeHeader(token)`; `TokenHeader` has `alg`, `typ`, `kid`
- `verifyWithJwks(token, { keys | jwks_uri, allowedAlgorithms, verification })` (useful later for Apple id
  tokens)

`sign()` has no explicit `kid` parameter, but (**correction after fact-check**) in `dist/utils/jwt/jwt.js` it emits
the header `{ alg, typ: 'JWT', kid: privateKey.kid }` whenever the key is passed as a JWK object that carries an
`alg` field (`SignatureKey = string | HonoJsonWebKey | CryptoKey`). So an HMAC JWK
`{ kty: 'oct', k: <base64url secret>, alg: 'HS256', kid: '2026-09' }` yields a standard `kid` header, read back with
`decodeHeader(token).kid`; only string/`CryptoKey` keys cannot set it. A custom payload claim for the key id is
therefore optional, not required (an earlier draft of this document said otherwise). Correction source: package
inspection of hono@4.13.5 `dist/utils/jwt/jwt.js` and `dist/types/utils/jwt/jwt.d.ts` (npm pack). The implementation
(`src/utils/jwt/jws.ts`) calls `crypto.subtle.sign` / `crypto.subtle.verify` with `{ name: 'HMAC', hash:
{ name: 'SHA-256' } }` for HS256; the only Node-specific code is a `CryptoKey` instanceof shim.
Sources: https://hono.dev/docs/helpers/jwt , https://hono.dev/docs/middleware/builtin/jwt ,
https://raw.githubusercontent.com/honojs/hono/main/src/utils/jwt/jws.ts , package inspection of hono 4.13.5.

The `jwt()` middleware exposes the payload as `c.get('jwtPayload')` and answers 401 with `WWW-Authenticate`,
but it takes one `secret`, so multi-key rotation needs a small custom middleware (sketch below).

### F4. expo-secure-store: iOS/Android/tvOS only, ~2 KB values, survives reinstall

Docs: platforms "Android, iOS, tvOS, Included in Expo Go" (no web); "Large payloads can be rejected by the
underlying platform. Historically, some iOS releases refused values above roughly 2048 bytes."; "Data saved
using `expo-secure-store` **will persist across app uninstallations** if the app is reinstalled with the same
bundle ID." — this is the **iOS** statement; for Android the same page says the data "will not be preserved upon app
uninstallation", so reinstall survival is iOS-only; `keychainAccessible` options include `AFTER_FIRST_UNLOCK`, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, etc.
`@better-auth/expo@1.7.2` peer-depends on `expo-secure-store >=12.5.0`, `expo-network >=8.0.7`,
`expo-constants >=17`, `expo-linking >=7`, `expo-web-browser >=14`.
Sources: https://docs.expo.dev/versions/latest/sdk/securestore/ , `npm view @better-auth/expo@1.7.2 peerDependencies`.

`expo-crypto` provides `randomUUID()` and `getRandomValues()` on Android, iOS, tvOS and Web, so the client can
generate an install id everywhere — with one caveat: on web it only works from a secure origin (HTTPS or
`localhost`) and otherwise throws `ERR_CRYPTO_UNAVAILABLE`, which matters for the plain `http://<lan-ip>:8081` dev
scenario in the CORS section. Source: https://docs.expo.dev/versions/latest/sdk/crypto/

### F5. Rate Limiting binding: config, semantics, GA status, local dev

- Config key is `ratelimits` (array), each with `name`, `namespace_id` (string containing a positive integer,
  unique per namespace), `simple: { limit, period }`; `period` "Must be either 10 or 60" seconds. API:
  `const { success } = await env.MY_RATE_LIMITER.limit({ key })`. "The key you provide can be any `string`
  value." Requires wrangler ≥ 4.36.0.
- Semantics: "Rate limits that you define and enforce in your Worker are local to the Cloudflare location that
  your Worker runs in"; counters are cached on the machine and "updated asynchronously"; the API is
  "permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting
  system." The page says IP-based keys are "not recommended" (many mobile/NAT users share an IP); prefer user ids,
  API keys or similar.
- GA: changelog "Rate Limiting in Workers is now GA" (2025-09-19); the old `unsafe` binding keeps working.
- Local dev: `miniflare@5.20260831.0-alpha` (the version wrangler 4.128.0 depends on) ships
  `dist/src/workers/ratelimit/ratelimit.worker.js` and a `ratelimits` config schema, so `wrangler dev` and
  `@cloudflare/vitest-pool-workers` simulate the binding. (Verified by package inspection, not by a doc page.)
  Caveat: `@cloudflare/vitest-pool-workers@0.22.0` bundles its own wrangler 4.124.0 / miniflare 5.20260815.0-alpha
  (not the 4.128.0 / 5.20260831.0-alpha pair inspected here) and peer-depends on vitest ^4.1.0; the ratelimit
  simulation was only verified in the newer miniflare tarball, so confirm the pool's bundled miniflare also has
  `dist/src/workers/ratelimit` before relying on the 429 test below.
- Pricing: neither the binding page nor the Workers pricing page lists a charge for it. **UNVERIFIED** that it
  stays free at scale; treat as "no separate line item today".
- Docs issue #25590 (opened 2025-10-02, **closed 2026-02-17 as completed via PR #28117** — an earlier draft called it
  "open, Oct 2025") reported ambiguity about `namespace_id` type/scope and the `simple` key; the binding page has
  presumably been clarified since, so re-read it rather than relying on the issue. Still: use a distinct integer
  string per binding and don't reuse ids across Workers. Correction source:
  https://api.github.com/repos/cloudflare/cloudflare-docs/issues/25590
Sources: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ ,
https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/ ,
https://github.com/cloudflare/cloudflare-docs/issues/25590 ,
https://developers.cloudflare.com/workers/platform/pricing/

### F6. Alternatives to the binding

- **WAF rate limiting rules**: Free plan gets 1 rule, 10 s period, IP-only; header/cookie/JSON-field keys need
  Enterprise **with the Advanced Rate Limiting add-on**, not Enterprise generally. Fine as a blunt per-IP guard on a custom domain; useless for per-user logic.
  Source: https://developers.cloudflare.com/waf/rate-limiting-rules/
- **Durable Object limiter**: exact, globally consistent, but each check is a DO request (Paid: 1M/month
  included, then $0.15/M) and adds a hop. Cloudflare's examples index currently has no rate-limiter page (the
  old `/durable-objects/examples/build-a-rate-limiter/` URL 404s). For Crosscut the *User aggregate itself* is
  the DO limiter: per-user business limits are commands on an object we already hit.
  Sources: https://developers.cloudflare.com/durable-objects/examples/ ,
  https://developers.cloudflare.com/workers/platform/pricing/
- **KV counters**: "1 per second" writes to the same key (Free and Paid), key ≤ 512 bytes; eventually
  consistent. Not suitable for counters at all.
  Source: https://developers.cloudflare.com/kv/platform/limits/

### F7. Client IP on Workers

`CF-Connecting-IP` "provides the client IP address connecting to Cloudflare to the origin web server";
`True-Client-IP` is the Enterprise-only alias. In a Worker read `request.headers.get('cf-connecting-ip')`.
Source: https://developers.cloudflare.com/fundamentals/reference/http-headers/

### F8. Hono CORS middleware

`import { cors } from 'hono/cors'`; `origin` may be a string, array, or `(origin, c) => string`;
`allowHeaders`, `exposeHeaders`, `allowMethods`, `maxAge`, `credentials`. Expo's dev server default port is
8081 (`--port`, "Default: 8081").
Sources: https://hono.dev/docs/middleware/builtin/cors , https://docs.expo.dev/more/expo-cli/

### F9. Secrets and rotation on Workers

`npx wrangler secret put <KEY>` (prompts for the value), `npx wrangler versions secret put <KEY>` for gradual
deployments, `.dev.vars` (or `.env`, not both) locally, never committed. Secrets Store bindings
(`secrets_store_secrets: [{ binding, store_id, secret_name }]`, read with `await env.X.get()`) are the
account-level alternative.
Sources: https://developers.cloudflare.com/workers/configuration/secrets/ ,
https://developers.cloudflare.com/secrets-store/integrations/workers/

### F10. Better Auth on Workers + D1 (what to expect in v2)

- Versions: `better-auth@1.7.2`, `@better-auth/expo@1.7.2`, `@better-auth/cli@1.4.21`. `better-auth` peer
  ranges include `drizzle-orm ^0.45.2 || >=1.0.0-rc.1` and `drizzle-kit >=0.31.4`, matching the project's
  pinned drizzle 0.45.2 / drizzle-kit 0.31.10. Package exports include `./adapters/drizzle`, `./db/migration`,
  `./plugins`, `./plugins/jwt`.
- Native D1: release notes 1.5: "Better Auth now natively supports Cloudflare D1 as a first-class database
  option. Pass your D1 binding directly" (`database: env.DB`). Verified in `@better-auth/kysely-adapter@1.7.2`
  `dist/index.mjs`: a value with `batch`, `exec` and `prepare` is treated as D1 (`D1SqliteDialect`,
  `transaction = false`; interactive transactions throw "D1 does not support interactive transactions. Use the
  D1 batch() API instead."). The Drizzle adapter (`drizzleAdapter(db, { provider: "sqlite", schema })`) remains
  the option when you want the auth tables in your own Drizzle schema. Programmatic migrations:
  `getMigrations` from `better-auth/db/migration`.
- Per-request instantiation: D1 bindings only exist inside a handler, so `createAuth(env)` per request (already
  the rule in concepts.md §4).
- Expo client: `expoClient({ scheme, storagePrefix, storage: SecureStore })`; server `plugins: [expo()]`,
  `trustedOrigins: ["crosscut://", ...(dev ? ["exp://", "exp://**"] : [])]`; the client caches the session
  cookie in SecureStore and you forward it with `Cookie: await authClient.getCookie()`. Alternatively the
  `bearer()` plugin returns `set-auth-token` and accepts `Authorization: Bearer` — the same header shape as the
  v1 device token.
- Anonymous plugin: `signIn.anonymous()`, `onLinkAccount({ anonymousUser, newUser })`, anonymous user deleted by
  default after linking unless `disableDeleteAnonymousUser`; adds `isAnonymous` to `user`. Two Expo-specific
  issues exist: #2116 closed 2025-04-04, and #4496 closed 2025-12-17 **as "not planned"**, i.e. not fixed — do not
  read either as evidence that Expo + the anonymous plugin works; spike it before choosing Option D.
- Account linking: enabled by default; `account.accountLinking.trustedProviders`, `allowDifferentEmails`,
  `updateUserInfoOnLink`; client `authClient.linkSocial({ provider, idToken })`.
- Deletion: `user.deleteUser.enabled: true` with `beforeDelete` / `afterDelete` hooks; "The user must be signed
  in to the account they're attempting to delete."
- `databaseHooks.user.create.after(user)` is where `User.init(user.id)` goes.
- Apple: `socialProviders.apple` needs `clientId`, a JWT `clientSecret` (jose; Better Auth's Apple docs give Apple's
  limit as 15,777,000 seconds ≈ six months / ~182.6 days — "≤ 180 days" is a safe simplification, not the primary
  figure),
  `appBundleIdentifier` for native id-token sign-in; `trustedOrigins` must include
  `https://appleid.apple.com`; native flow `authClient.signIn.social({ provider: "apple", idToken: { token,
  nonce } })` signs in "directly" with no redirect. Better Auth's Apple docs also warn that Apple prohibits
  `localhost` redirect URIs for testing, which matters for the v2 dev setup.
Sources: https://better-auth.com/blog/1-5 , https://www.better-auth.com/docs/concepts/database ,
https://www.better-auth.com/docs/adapters/drizzle , https://www.better-auth.com/docs/integrations/expo ,
https://www.better-auth.com/docs/plugins/bearer , https://www.better-auth.com/docs/plugins/anonymous ,
https://www.better-auth.com/docs/concepts/users-accounts , https://www.better-auth.com/docs/authentication/apple ,
https://github.com/better-auth/better-auth/issues/2116 , https://github.com/better-auth/better-auth/issues/4496 ,
`npm view` / `npm pack` of better-auth 1.7.2 and @better-auth/kysely-adapter 1.7.2.

### F11. Apple identity-token verification

Apple's "Verifying a user" page: the server must "Verify the JWS E256 signature using the server's public
key", "Verify the `nonce`", "Verify that the `iss` field contains `https://appleid.apple.com`", "Verify that
the `aud` field is the developer's `client_id`" (the bundle id for native apps), and "Verify that the time is
earlier than the `exp` value". Public keys are fetched from `https://appleid.apple.com/auth/keys` (JWKS; the
page body did not restate the URL, so the URL is medium confidence). Better Auth's Apple provider does this in
the id-token flow; if you ever verify yourself, `hono/jwt` `verifyWithJwks({ jwks_uri })` exists.
Source: https://developer.apple.com/documentation/signinwithapple/verifying-a-user

### F12. App Store Review Guidelines (current text)

- **4.8 Login Services**: apps that use a third-party or social login "to set up or authenticate the user's
  primary account with the app must also offer as an equivalent option another login service" that limits data
  collection to name and email, lets users keep their email private, and does not collect interactions for
  advertising without consent. Not required if "Your app exclusively uses your company's own account setup and
  sign-in systems" (so email/password-only Better Auth does not trigger it; Google/Facebook does; Sign in with
  Apple satisfies it).
- **5.1.1(v) Account Sign-In**: "If your app doesn't include significant account-based features, let people use
  it without a login. If your app supports account creation, you must also offer account deletion within the
  app." Apple's support page: "Offer to delete the entire account record, along with associated personal data
  ... only offering to temporarily deactivate or disable an account is insufficient"; a manual/delayed process
  is acceptable if you tell the user how long it takes; "Apps that support Sign in with Apple should use the
  Sign in with Apple REST API to revoke user tokens."
Sources: https://developer.apple.com/app-store/review/guidelines/ ,
https://developer.apple.com/support/offering-account-deletion-in-your-app/

### F13. App Attest (optional hardening, later)

Apple's server-validation page describes the flow: server issues a one-time challenge, the app attests a key
via `DCAppAttestService`, the server verifies the `x5c` chain against Apple's App Attest root, the `nonce`
(SHA256 of `authData || clientDataHash`), key id, App ID hash, `counter == 0`, and the `aaguid`
(`appattestdevelop` vs `appattest`), that `credentialId` equals the key identifier, and the values in the
`extensions` CBOR dictionary (`apple_validation_category_01`, `apple_bundle_version_01`), then stores the public key
and verifies per-request assertions with an increasing counter. This paragraph is a summary and omits detail; any
custom verifier must follow the current Apple page, not this text. It is CBOR/X.509 parsing — doable on Workers but not v1 work. Simulator support is not
stated on that page (**UNVERIFIED**; generally believed unsupported).
Source: https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server

### F14. Comparison of the three identity options

| | A. Client UUID in `X-Device-Id` | B. Server-issued signed device token (HS256) | C. "Anonymous JWT" with DB-backed session/refresh |
|---|---|---|---|
| Who chooses the id | client | server | server |
| Forgeable | yes, trivially | no (needs the HMAC key) | no |
| Hot-path cost | none | one HMAC verify (µs, WebCrypto) | D1 or DO lookup per request |
| Revocation | n/a | `tokenVersion` in aggregate (checked on sensitive commands) or re-mint | delete session row |
| Key rotation | n/a | `kid` header (key passed as JWK) + multi-key secret | n/a / rotate signing key of refresh tokens |
| Multi-device | no | no (one identity per install until accounts) | no |
| Effort | trivial | small (≈150 lines + tests) | medium (schema, refresh flow) |
| Fits Better Auth later | poorly | yes: same `Authorization: Bearer` shape; link by absorbing aggregate | yes, but you have rebuilt half of Better Auth |

Option D, "use Better Auth's anonymous plugin from day one", is legitimate: linking comes for free
(`onLinkAccount`) and `isAnonymous` is a first-class concept. Costs: Better Auth + D1 schema + a session lookup
on every request in v1, cookie/Expo quirks, and the merge logic still has to be written by you (the plugin only
tells you the two user ids), and the Expo + anonymous-plugin combination is unproven (#4496 was closed "not
planned", not fixed). Take D only if accounts are certain within the first release cycle, and spike it first.

## Recommendation for Crosscut

### Identity model

- **User id**: server-generated at bootstrap, 128 bits of `crypto.getRandomValues` encoded base32 (Crockford,
  lowercase, 26 chars) prefixed `u_`. Not a UUID string (37 chars, hyphens) — shorter DO names and URLs, and
  the profile's "Player-7F3A" is the last 4 chars upper-cased.
- **One identity per install** in v1. Reinstall on iOS keeps the token (Keychain persists), so the streak
  survives; on Android SecureStore data is not preserved across uninstall, so an Android reinstall, a wiped device
  or a second device is a new player until accounts exist. Say so (per platform) in the FAQ.
- **The token is the only credential.** No `X-Device-Id` as auth. Keep two *informational* headers:
  `X-Install-Id` (client-random UUID from `expo-crypto`, stored next to the token, lets you see one install
  minting many users; on web fall back to a `Math.random`-based id when `randomUUID()` throws
  `ERR_CRYPTO_UNAVAILABLE` on an insecure origin — it is informational only) and `X-Client` (`ios/1.0.0+34`, `web/1.0.0`).

### Endpoints

| Method + path | Auth | Purpose |
|---|---|---|
| `POST /v1/devices` | none (per-IP rate limited) | Bootstrap: body `{ installId, platform, appVersion, locale }` → `{ userId, token, expiresAt }`. Calls `User.init(userId)` and `User.setInstall(...)`. |
| `POST /v1/session/refresh` | device token (may be expired ≤ 30 days ago, signature must verify) | Re-mint with the active key; response `{ token, expiresAt }`. Called on app start when `iat` is older than 30 days. |
| `GET /v1/me` | device token | Snapshot of the User aggregate (balances, streak, completions). |
| `DELETE /v1/me` | device token | "Reset my data": purges the aggregate and projection row (good hygiene; makes the later 5.1.1(v) obligation a no-op). |

### Token format

Compact JWT with header `{ "alg": "HS256", "typ": "JWT", "kid": "2026-09" }` (the `kid` comes from the JWK the key is
passed as, see F3). Payload:

```json
{
  "iss": "crosscut",
  "aud": "crosscut-api",
  "sub": "u_01hzx3k9q7v6m2s8b4n1c5d7e9",
  "typ": "device",
  "tv": 1,
  "iat": 1756771200,
  "exp": 1788307200
}
```

- `typ: "device"` distinguishes it from any Better Auth or admin token later.
- Key id lives in the standard `kid` header, not the payload: `hono/jwt` `sign()` sets it when the HMAC key is
  supplied as a JWK object (`{ kty: 'oct', k, alg: 'HS256', kid }`), and the middleware reads it with
  `decodeHeader(token).kid`. (An earlier draft used a custom `k` payload claim on the wrong premise that `sign()`
  could not set `kid`; either design works, but the header route stays standards-shaped for a later Better
  Auth/JWKS world. Source: package inspection of hono@4.13.5 `dist/utils/jwt/jwt.js`.)
- `tv` = token version; the aggregate stores `tokenVersion`, and sensitive commands (`redeemPurchase`,
  `link`, `purge`) receive `tv` and reject a stale one. Ordinary play commands do not check it (keeps the DO
  out of "is this token still good?" for the 99% path).
- `exp` = 365 days; refreshed silently when older than 30 days. Size ≈ 230 bytes — well under the SecureStore
  2 KB guidance.

### Keys and rotation

Secret `DEVICE_TOKEN_KEYS` (via `wrangler secret put`, `.dev.vars` locally) holds JSON:

```json
{ "active": "2026-09", "keys": { "2026-09": "<32+ random bytes, base64>", "2026-03": "<previous>" } }
```

Rotation: add a new key and make it `active`; keep the previous key for ≥ the refresh window (30 days) plus
slack, then drop it. Tokens signed with a dropped key fail verification → 401 → client re-bootstraps as a *new*
user, so never drop a key before the refresh window has elapsed. Parse the secret once per isolate (module
scope cache keyed by the string) — `crypto.subtle.importKey` is cheap but not free. Secrets Store is a fine
upgrade when you want dashboard-managed rotation.

### Middleware behaviour

1. Read `Authorization`; require `Bearer `.
2. `decodeHeader(token).kid`; pick the key; unknown key → 401 `{ error: "token_key_unknown" }`.
3. `verify(token, key, { alg: 'HS256', iss: 'crosscut', aud: 'crosscut-api' })`; expired → 401
   `{ error: "token_expired" }` (client calls refresh, which accepts expiry ≤ 30 days via `exp: false` and its
   own check); other failures → 401 `{ error: "unauthenticated" }`.
4. `payload.typ === 'device'` required.
5. `c.set('auth', { userId: payload.sub, tv: payload.tv, kind: 'device' })`. Modules receive `{ userId }` as
   in concepts.md §2 and never re-verify.
6. Errors are JSON with a stable `error` code and `WWW-Authenticate: Bearer realm="crosscut"`.

### Storage on the client

- iOS/Android: `SecureStore.setItemAsync('crosscut.session', JSON.stringify({ token, userId, installId }), {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK })`. `AFTER_FIRST_UNLOCK` so background refresh/push
  handlers can read it; do **not** use `THIS_DEVICE_ONLY` variants if you want the reinstall/restore-from-backup
  survival (note: whether Keychain items migrate through an iCloud/iTunes restore depends on the accessibility
  class; **UNVERIFIED** for the exact combination, test it). On Android `expo-secure-store` does not survive
  uninstall regardless of options (Expo docs).
- Web: `localStorage['crosscut.session']` (same JSON). It is readable by any script on the origin; acceptable
  for a device-grade credential whose blast radius is one anonymous player.
- The TanStack Query client attaches `Authorization` from an in-memory copy; a 401 `token_expired` triggers
  refresh; a 401 `unauthenticated` clears storage and re-bootstraps (surface a "your progress could not be
  restored" notice).

### CORS

Native fetch (iOS/Android, Expo Go) ignores CORS. Only Expo web needs it:

- Dev: allow `http://localhost:8081`, `http://127.0.0.1:8081`, and (dev only) any `http://<lan-ip>:8081` via
  the origin function, so a phone browser on the LAN works. Caveat: `http://<lan-ip>:8081` is not a secure
  context, so `expo-crypto`'s `randomUUID()` throws `ERR_CRYPTO_UNAVAILABLE` there — use a tunnel/HTTPS
  (`npx expo start --tunnel`) or the `Math.random` fallback for the informational install id.
- Prod: the web build is served by the same Worker (assets binding), so it is same-origin and CORS never
  triggers. If a separate web origin is ever used, add it to the list. `credentials: false` (no cookies),
  `allowHeaders: ['Authorization', 'Content-Type', 'X-Install-Id', 'X-Client']`, `maxAge: 86400`.

### Abuse and rate limiting

| Concern | Mechanism | Setting |
|---|---|---|
| Mass user minting (`POST /v1/devices`) | `ratelimits` binding keyed `boot:<cf-connecting-ip>` | 10 / 60 s (per location; fine as a coarse cap — but Cloudflare says IP keys are "not recommended", and per-location counters mean a distributed minting attack is barely slowed; `tokenVersion` and the aggregate invariants are the real defence) |
| Request flood by one player | binding keyed `u:<sub>` | 120 / 60 s (per location) |
| Expensive endpoints (hints, wheel, purchases) | binding keyed `hint:<sub>` **and** exact check in the aggregate | 20 / 60 s + domain rule |
| One free spin per day, one solve reward per puzzle per day, hint cost deduction | `User` aggregate commands (serialized; exact) | domain invariants, `DomainError` on violation |
| Leaderboard time forgery | server computes elapsed time from `startPuzzle` → `submitSolution` timestamps in the aggregate, never trusts client time; plausibility floor (e.g. < 15 s for a 5×5 flagged) | domain rule |
| Bulk scripted play | later: App Attest assertion required for leaderboard submission; v1: none | — |

Because the binding is per-location and "permissive", never use it as the *only* guard for anything with
monetary or ranking value; the aggregate is the source of truth. Both `limit()` calls run in parallel with
JSON parsing (`Promise.all`) to keep latency flat.

### Upgrade path to Better Auth (v2)

1. **Add Better Auth** in the gateway: `createAuth(env)` per request, `database: env.DB` (native D1) or
   `drizzleAdapter(db, { provider: 'sqlite', schema })` if you want the tables in the Drizzle schema alongside
   projections; `plugins: [expo(), bearer()]`; `trustedOrigins: ['crosscut://', 'https://appleid.apple.com',
   ...dev]`; `databaseHooks.user.create.after → User.init(user.id)`; `user.deleteUser.enabled: true` with
   `afterDelete → User.purge()` (+ Apple token revocation when the account has an Apple provider).
2. **Client**: `@better-auth/expo` with `storage: SecureStore`; on native prefer the `bearer()` token so the
   API client keeps one code path (`Authorization: Bearer <better-auth token>`); on web the Expo client falls
   back to cookies or you use the same bearer token from `localStorage`.
3. **Unified auth middleware** accepts either a device token (`typ: 'device'`) or a Better Auth session
   (`auth.api.getSession({ headers })`), and sets `{ userId, kind: 'device' | 'account' }`.
4. **Linking** (`POST /v1/account/link`, requires both credentials: device token in `Authorization`, Better
   Auth session in `X-Account-Session` or cookie):
   - `deviceUser.beginMerge(accountId)` → commits `{ mergedInto: accountId, mergeState: 'pending' }` and returns
     the snapshot. Any later command on this aggregate throws `MergedError(accountId)`.
   - `accountUser.absorb(deviceSnapshot, deviceUserId)` → idempotent: `absorbedFrom` contains `deviceUserId`
     ⇒ no-op commit. Applies the merge rules below. Because the projection is derived from the state, the D1
     rows (`user_state`, leaderboards, collections progress) follow from the flush; the device row keeps
     `merged_into` for auditing.
   - `deviceUser.completeMerge()` → `mergeState: 'done'`. If step 2 failed, retry is safe (idempotent); a
     `pending` device aggregate found on the next request triggers the same three steps again (self-healing
     without queues, matching the "no events" rule).
   - Response: `{ userId: accountId, token: <re-minted device token with sub = accountId, typ: 'device'> }` so
     the client's existing API path keeps working before it adopts Better Auth sessions everywhere. A device
     token presented for a merged aggregate is answered `409 { error: 'merged', mergedInto, token }` with the
     re-minted token — the holder was already trusted for that identity.
   - Sign-in on a **second** device creates a fresh device user first (v1 bootstrap), then links; the merge rules
     make an almost-empty device user a harmless no-op.
5. **Merge rules** (deterministic, order-independent, commutative except for `mergedInto`):
   - `completions`: union by `puzzleId`, keep the earliest `solvedAt` and best time per puzzle.
   - `stars`: recompute from the merged completions (stars are only ever earned by solving and never spent, so
     they are a pure function of completions). This removes the incentive to farm stars across installs.
   - `tokens`: `a.tokens + b.tokens − Σ(tokenAward of b's completions whose puzzleId a already had)`; floor at 0.
   - `streak`: take the identity with the longer *current* streak; `lastSolvedDay` = max; `bestStreak` = max.
   - `dailyRewards` / `wheelSpins`: union by day; if both spun today, keep one prize (the larger) — spins are
     rare and this is stated in the FAQ.
   - `hintsBought`, `likes`, `saves`, `collectionsProgress`: union; progress recomputed from completions.
   - `pushTokens`, `installs`: union.
   - `preferences` (level, topics, language): account wins if set, else device.
6. **Sign in with Apple**: `expo-apple-authentication` on the client, Better Auth `signIn.social({ provider:
   'apple', idToken })` server-side with `appBundleIdentifier`; add Google only if you accept 4.8's obligation
   (already satisfied by offering Apple).
7. **App Store checklist at v2**: in-app "Delete account" (Better Auth `deleteUser` + purge aggregate + revoke
   Apple tokens), privacy nutrition labels updated for email, and the anonymous path must remain usable
   ("let people use it without a login").

### What *not* to do

- Don't put the user id in a cookie for native; don't mix cookies and bearer in v1.
- Don't verify tokens in modules or aggregates; the gateway verifies once (concepts.md §2 rule 3).
- Don't use KV as a rate limiter or as a token denylist that must be consistent within seconds.
- Don't rely on `crypto.randomUUID()` on the client for the *user* id.

## Code sketches

### wrangler.jsonc additions

```jsonc
{
  "ratelimits": [
    { "name": "RL_BOOT", "namespace_id": "1001", "simple": { "limit": 10,  "period": 60 } },
    { "name": "RL_USER", "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } },
    { "name": "RL_SPEND", "namespace_id": "1003", "simple": { "limit": 20,  "period": 60 } }
  ]
  // DEVICE_TOKEN_KEYS via `wrangler secret put DEVICE_TOKEN_KEYS`, `.dev.vars` locally
}
```

### Token service (`workers/gateway/src/identity/tokens.ts`)

```ts
import { sign, verify, decodeHeader } from 'hono/jwt'

export interface DeviceClaims {
  iss: 'crosscut'; aud: 'crosscut-api'; sub: string; typ: 'device'
  tv: number; iat: number; exp: number
}
interface KeyRing { active: string; keys: Record<string, string> }   // kid → base64url secret

// hono/jwt sign() emits a `kid` header when the key is a JWK object that has `alg` (see F3).
const jwk = (ring: KeyRing, kid: string) => ({ kty: 'oct', k: ring.keys[kid], alg: 'HS256', kid })

const rings = new Map<string, KeyRing>()            // per-isolate cache keyed by the raw secret
export function keyRing(secret: string): KeyRing {
  let r = rings.get(secret)
  if (!r) { r = JSON.parse(secret) as KeyRing; rings.set(secret, r) }
  return r
}

export function newUserId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return 'u_' + base32Crockford(bytes)              // 26 chars, lowercase
}

export async function mintDeviceToken(ring: KeyRing, sub: string, tv: number, now = Date.now()) {
  const iat = Math.floor(now / 1000)
  const claims: DeviceClaims = {
    iss: 'crosscut', aud: 'crosscut-api', sub, typ: 'device',
    tv, iat, exp: iat + 365 * 86_400,
  }
  // verify() defaults `iat: true` and rejects a future iat: mint with this platform's Date.now() only —
  // never a rounded-up iat, never from a differently-clocked test harness.
  return { token: await sign(claims, jwk(ring, ring.active), 'HS256'), expiresAt: claims.exp }
}

export type VerifyResult =
  | { ok: true; claims: DeviceClaims }
  | { ok: false; reason: 'malformed' | 'unknown_key' | 'expired' | 'invalid' }

export async function verifyDeviceToken(ring: KeyRing, token: string, allowExpired = false): Promise<VerifyResult> {
  let kid: string | undefined
  try { kid = decodeHeader(token).kid } catch { return { ok: false, reason: 'malformed' } }
  if (!kid || !ring.keys[kid]) return { ok: false, reason: 'unknown_key' }
  try {
    const p = await verify(token, jwk(ring, kid), { alg: 'HS256', iss: 'crosscut', aud: 'crosscut-api', exp: !allowExpired }) as DeviceClaims
    if (p.typ !== 'device') return { ok: false, reason: 'invalid' }
    if (allowExpired && p.exp * 1000 < Date.now() - 30 * 86_400_000) return { ok: false, reason: 'expired' }
    return { ok: true, claims: p }
  } catch (e) {
    return { ok: false, reason: (e as Error).name === 'JwtTokenExpired' ? 'expired' : 'invalid' }
  }
}
```

### Middleware (`workers/gateway/src/identity/middleware.ts`)

```ts
import { createMiddleware } from 'hono/factory'
import { keyRing, verifyDeviceToken } from './tokens'

export type AuthVars = { auth: { userId: string; tv: number; kind: 'device' } }

export const deviceAuth = createMiddleware<{ Bindings: Env; Variables: AuthVars }>(async (c, next) => {
  const h = c.req.header('Authorization') ?? ''
  if (!h.startsWith('Bearer ')) return unauthorized(c, 'unauthenticated')
  const r = await verifyDeviceToken(keyRing(c.env.DEVICE_TOKEN_KEYS), h.slice(7))
  if (!r.ok) return unauthorized(c, r.reason === 'expired' ? 'token_expired' : 'unauthenticated')
  const { success } = await c.env.RL_USER.limit({ key: `u:${r.claims.sub}` })
  if (!success) return c.json({ error: 'rate_limited' }, 429)
  c.set('auth', { userId: r.claims.sub, tv: r.claims.tv, kind: 'device' })
  await next()
})

function unauthorized(c: any, error: string) {
  c.header('WWW-Authenticate', 'Bearer realm="crosscut"')
  return c.json({ error }, 401)
}
```

### Bootstrap and refresh routes

```ts
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { aggregateStub } from '@app/core'

const Bootstrap = z.object({
  installId: z.uuid(), platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().max(32), locale: z.string().max(16).optional(),
})

app.use('/v1/*', cors({
  origin: (origin, c) => {
    const allowed = new Set(['http://localhost:8081', 'http://127.0.0.1:8081', c.env.WEB_ORIGIN])
    if (allowed.has(origin)) return origin
    return c.env.ENVIRONMENT === 'dev' && /^http:\/\/(10|172|192)\.[\d.]+:8081$/.test(origin) ? origin : ''
  },
  allowHeaders: ['Authorization', 'Content-Type', 'X-Install-Id', 'X-Client'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86_400,
}))

app.post('/v1/devices', zValidator('json', Bootstrap), async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown'
  const { success } = await c.env.RL_BOOT.limit({ key: `boot:${ip}` })
  if (!success) return c.json({ error: 'rate_limited' }, 429)

  const body = c.req.valid('json')
  const userId = newUserId()
  const user = aggregateStub(c.env.USER, 'user', userId)
  await user.init(userId)
  await user.registerInstall({ installId: body.installId, platform: body.platform, appVersion: body.appVersion })
  const { token, expiresAt } = await mintDeviceToken(keyRing(c.env.DEVICE_TOKEN_KEYS), userId, 1)
  return c.json({ userId, token, expiresAt }, 201)
})

app.post('/v1/session/refresh', async (c) => {
  const h = c.req.header('Authorization') ?? ''
  if (!h.startsWith('Bearer ')) return c.json({ error: 'unauthenticated' }, 401)  // same prefix check as the middleware
  const r = await verifyDeviceToken(keyRing(c.env.DEVICE_TOKEN_KEYS), h.slice(7), /* allowExpired */ true)
  if (!r.ok) return c.json({ error: 'unauthenticated' }, 401)
  const snap = await aggregateStub(c.env.USER, 'user', r.claims.sub).snapshot()
  if (snap.state.mergedInto) { /* re-mint for the account id, see linking */ }
  const minted = await mintDeviceToken(keyRing(c.env.DEVICE_TOKEN_KEYS), r.claims.sub, snap.state.tokenVersion)
  return c.json(minted)
})
```

### User aggregate: merge-related commands

```ts
export class User extends Aggregate<UserState, Env> {
  readonly kind = 'user'
  protected initial(): UserState {
    return { tokens: 0, stars: 0, streak: { current: 0, best: 0, lastSolvedDay: null },
             completions: {}, dailyRewards: {}, wheelSpins: {}, installs: [],
             tokenVersion: 1, absorbedFrom: [], mergedInto: null, mergeState: null }
  }

  beginMerge(accountId: string) {
    return this.commit((s) => {
      if (s.mergedInto && s.mergedInto !== accountId) throw new DomainError('already merged elsewhere')
      return { ...s, mergedInto: accountId, mergeState: s.mergeState ?? 'pending' }
    })
  }

  absorb(other: UserState, otherId: string) {
    return this.commit((s) => {
      if (s.absorbedFrom.includes(otherId)) return s               // idempotent replay
      const completions = unionCompletions(s.completions, other.completions)
      const dupAward = Object.entries(other.completions)
        .filter(([pid]) => pid in s.completions).reduce((n, [, c]) => n + c.tokenAward, 0)
      return {
        ...s,
        completions,
        stars: starsFromCompletions(completions),
        tokens: Math.max(0, s.tokens + other.tokens - dupAward),
        streak: mergeStreak(s.streak, other.streak),
        dailyRewards: { ...other.dailyRewards, ...s.dailyRewards },
        wheelSpins: mergeSpins(s.wheelSpins, other.wheelSpins),
        installs: [...new Set([...s.installs, ...other.installs])],
        absorbedFrom: [...s.absorbedFrom, otherId],
      }
    })
  }

  completeMerge() { return this.commit((s) => ({ ...s, mergeState: 'done' })) }

  /** Every play command starts with this guard. */
  #open(s: UserState) { if (s.mergedInto) throw new MergedError(s.mergedInto) }
}
```

`MergedError` gets `name = 'MergedError'` and carries the account id in `message` (only `name` and `message`
survive RPC), which `app.onError` maps to `409 { error: 'merged', mergedInto, token }`.

### Link route (v2)

```ts
app.post('/v1/account/link', deviceOrAccountAuth, async (c) => {
  const device = c.get('auth')                       // typ: device
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers })
  if (!session || device.kind !== 'device') return c.json({ error: 'need_both_credentials' }, 401)
  const accountId = session.user.id
  const dev = aggregateStub(c.env.USER, 'user', device.userId)
  const acc = aggregateStub(c.env.USER, 'user', accountId)

  const snap = await dev.beginMerge(accountId)
  await acc.absorb(snap.state, device.userId)
  await dev.completeMerge()
  const minted = await mintDeviceToken(keyRing(c.env.DEVICE_TOKEN_KEYS), accountId, 1)
  return c.json({ userId: accountId, ...minted })
})
```

### workerd test outline (`@cloudflare/vitest-pool-workers`)

```ts
it('bootstrap → token → /v1/me round trip', async () => {
  const boot = await SELF.fetch('http://x/v1/devices', { method: 'POST', body: JSON.stringify({...}) })
  const { token, userId } = await boot.json()
  const me = await SELF.fetch('http://x/v1/me', { headers: { Authorization: `Bearer ${token}` } })
  expect((await me.json()).id).toBe(userId)
})
it('rejects a token signed with an unknown key', ...)        // DEVICE_TOKEN_KEYS without that kid
it('refresh accepts ≤30-day-expired tokens and re-mints with the active key', ...)
it('absorb is idempotent and recomputes stars from completions', ...)
it('boot endpoint returns 429 after 10 calls from one IP', ...) // miniflare simulates ratelimits — first confirm the
                                                                // pool's bundled miniflare (5.20260815.0-alpha in
                                                                // vitest-pool-workers 0.22.0) has dist/src/workers/ratelimit
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | Workers WebCrypto supports HMAC sign/verify, `crypto.subtle` globally, `crypto.randomUUID()`, and the non-standard `crypto.subtle.timingSafeEqual` | https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ | high | confirmed |
| C2 | `hono/jwt` (4.13.5) exports `sign`, `verify(token, key, {alg, iss, aud, exp…})`, `decode`, `decodeHeader`, `verifyWithJwks`; HS256 is implemented with `crypto.subtle` HMAC/SHA-256. ~~`sign()` cannot set a `kid` header~~ **Corrected:** `sign()` emits `kid` when the key is a JWK object with `alg` (`{ kty: 'oct', k, alg: 'HS256', kid }`); only string/CryptoKey keys cannot | https://hono.dev/docs/helpers/jwt ; package inspection of hono@4.13.5 `dist/utils/jwt/jwt.js` and `dist/types/utils/jwt/jwt.d.ts`; https://raw.githubusercontent.com/honojs/hono/main/src/utils/jwt/jws.ts | high (after correction) | refuted (kid sub-claim; rest confirmed) |
| C3 | The Rate Limiting binding is configured as `ratelimits: [{ name, namespace_id, simple: { limit, period } }]`, `period` must be 10 or 60, API is `env.X.limit({ key }) → { success }`, limits are per Cloudflare location and eventually consistent; needs wrangler ≥ 4.36 | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ | high | confirmed |
| C4 | The Rate Limiting binding went GA on 2025-09-19; the old unsafe binding still works | https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/ | high | confirmed |
| C5 | miniflare 5.20260831.0-alpha (dependency of wrangler 4.128.0) contains a `ratelimit` plugin and worker, so the binding is simulated in `wrangler dev` / vitest-pool-workers (note: vitest-pool-workers 0.22.0 bundles miniflare 5.20260815.0-alpha, not inspected) | package inspection (`npm pack miniflare`, `npm view wrangler@4.128.0 dependencies`) | medium | confirmed |
| C6 | No pricing line exists for the Rate Limiting binding on the binding page or the Workers pricing page | https://developers.cloudflare.com/workers/platform/pricing/ ; binding page | low | confirmed |
| C7 | Workers KV allows 1 write per second to the same key on Free and Paid, key ≤ 512 bytes; unsuitable for counters | https://developers.cloudflare.com/kv/platform/limits/ | high | confirmed |
| C8 | WAF rate limiting rules on Free: 1 rule, 10 s period, IP-only characteristics; header/cookie/JSON keys need Enterprise with the Advanced Rate Limiting add-on | https://developers.cloudflare.com/waf/rate-limiting-rules/ | high | confirmed (nuance added) |
| C9 | `CF-Connecting-IP` carries the client IP to the Worker; `True-Client-IP` is Enterprise-only | https://developers.cloudflare.com/fundamentals/reference/http-headers/ | high | confirmed |
| C10 | Hono `cors` (`hono/cors`) accepts `origin` as string/array/function and `allowHeaders`, `credentials`, `maxAge`; Expo dev server default port is 8081 | https://hono.dev/docs/middleware/builtin/cors ; https://docs.expo.dev/more/expo-cli/ | high | confirmed |
| C11 | expo-secure-store supports Android/iOS/tvOS (not web), warns that iOS historically refused values > ~2048 bytes, and data persists across reinstall with the same bundle id on iOS (on Android it is not preserved across uninstall) | https://docs.expo.dev/versions/latest/sdk/securestore/ | high | confirmed (Android nuance added) |
| C12 | expo-crypto provides `randomUUID()` and `getRandomValues()` on Android, iOS, tvOS and Web (web only from a secure origin, else `ERR_CRYPTO_UNAVAILABLE`) | https://docs.expo.dev/versions/latest/sdk/crypto/ | high | confirmed (nuance added) |
| C13 | Secrets are set with `npx wrangler secret put <KEY>` (or `wrangler versions secret put`), read from `.dev.vars`/`.env` locally; Secrets Store bindings use `secrets_store_secrets` and `await env.X.get()` | https://developers.cloudflare.com/workers/configuration/secrets/ ; https://developers.cloudflare.com/secrets-store/integrations/workers/ | high | confirmed |
| C14 | Better Auth 1.5+ accepts a D1 binding directly (`database: env.DB`); in @better-auth/kysely-adapter 1.7.2 any object with `batch`, `exec`, `prepare` is treated as D1 and interactive transactions throw | https://better-auth.com/blog/1-5 ; https://www.better-auth.com/docs/concepts/database ; package inspection of @better-auth/kysely-adapter@1.7.2 | high | confirmed |
| C15 | better-auth 1.7.2 peer-depends on drizzle-orm ^0.45.2 (or 1.0 rc) and drizzle-kit >=0.31.4; @better-auth/expo 1.7.2 peer-depends on expo-secure-store >=12.5.0, expo-network >=8.0.7, expo-constants >=17, expo-linking >=7, expo-web-browser >=14 | `npm view better-auth@1.7.2 peerDependencies`; `npm view @better-auth/expo@1.7.2 peerDependencies` | high | confirmed |
| C16 | Better Auth Expo integration: server `plugins: [expo()]`, `trustedOrigins` with app scheme and `exp://`/`exp://**` in dev; client `expoClient({ scheme, storagePrefix, storage: SecureStore })`; cookies forwarded via `authClient.getCookie()` | https://www.better-auth.com/docs/integrations/expo | high | confirmed |
| C17 | Better Auth `bearer()` plugin returns the session token in `set-auth-token` and accepts `Authorization: Bearer` | https://www.better-auth.com/docs/plugins/bearer | high | confirmed |
| C18 | Better Auth anonymous plugin: `signIn.anonymous()`, `onLinkAccount({ anonymousUser, newUser })`, anonymous user deleted after link by default, `isAnonymous` column; Expo issues #2116 and #4496 are closed (#4496 closed "not planned", not fixed — no evidence Expo + anonymous works) | https://www.better-auth.com/docs/plugins/anonymous ; https://github.com/better-auth/better-auth/issues/2116 ; https://github.com/better-auth/better-auth/issues/4496 | high | confirmed (nuance added) |
| C19 | Better Auth account linking is on by default with `trustedProviders`/`allowDifferentEmails`; `user.deleteUser.enabled` with `beforeDelete`/`afterDelete`; `databaseHooks.user.create.after` exists | https://www.better-auth.com/docs/concepts/users-accounts ; https://www.better-auth.com/docs/concepts/database | high | confirmed |
| C20 | Better Auth Apple provider requires `clientId`, JWT `clientSecret`, `appBundleIdentifier` for native id-token sign-in, and `https://appleid.apple.com` in `trustedOrigins`; native flow is `signIn.social({ provider: 'apple', idToken })`; clientSecret max 15,777,000 s (~six months); Apple prohibits localhost redirect testing | https://www.better-auth.com/docs/authentication/apple | high | confirmed (nuance added) |
| C21 | Apple identity-token verification: check the JWS signature with Apple's public key, `nonce`, `iss = https://appleid.apple.com`, `aud = client_id`, `exp` | https://developer.apple.com/documentation/signinwithapple/verifying-a-user | high | confirmed |
| C22 | Guideline 4.8: third-party/social login for the primary account requires an equivalent privacy-preserving login option; exempt if the app "exclusively uses your company's own account setup and sign-in systems" | https://developer.apple.com/app-store/review/guidelines/ | high | confirmed |
| C23 | Guideline 5.1.1(v): apps without significant account-based features must work without login; apps supporting account creation must offer in-app account deletion; deactivation-only is insufficient; SiwA apps should revoke tokens via the REST API | https://developer.apple.com/app-store/review/guidelines/ ; https://developer.apple.com/support/offering-account-deletion-in-your-app/ | high | confirmed |
| C24 | App Attest server validation involves verifying the `x5c` chain against Apple's root, a nonce derived from `authData` + `clientDataHash`, key id, App ID hash, `counter == 0`, `aaguid` environment, then per-request assertions with increasing counters (incomplete: Apple also requires `credentialId` == key id and the `extensions` CBOR values `apple_validation_category_01` / `apple_bundle_version_01`) | https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server | medium | confirmed (incomplete, nuance added) |
| C25 | Keychain items written with `AFTER_FIRST_UNLOCK` (non-`THIS_DEVICE_ONLY`) migrate through encrypted device backups/restores | not verified against Apple docs in this pass | low | confirmed |

## Open questions

1. **Rate Limiting binding cost at scale** — no price is listed; confirm with Cloudflare before relying on it
   for every request (C6). Fallback: only guard bootstrap and spend endpoints.
2. **Keychain and restores** — verify on a real device whether the `crosscut.session` item survives an
   iCloud restore to a new phone (C25). If it does, the "one identity per install" story also covers phone
   upgrades; if not, that is the strongest argument for shipping accounts early.
3. **Refresh grace window** — 30 days of accepted post-expiry refresh is a product choice: too short loses
   lapsed players' streak history; too long weakens key retirement. Decide with the retention data.
4. **Better Auth on native: cookies or `bearer()`?** The Expo plugin's default is cookie forwarding via
   SecureStore; `bearer()` keeps one header shape with the v1 device token. Spike both in the gateway before v2.
5. **Merging leaderboard rows** — leaderboards are projections keyed by user id; after `absorb` the account
   row is rewritten by the flush, but the device user's old rows need either deletion (`merged_into IS NOT
   NULL` filter in queries) or a `reproject()` sweep. Decide when the leaderboard projection is designed.
6. **Apple doc wording "JWS E256"** vs the widely documented RS256 keys at `appleid.apple.com/auth/keys` —
   irrelevant if Better Auth verifies, but confirm before writing a custom verifier.
7. **App Attest** — worth it only if leaderboard forgery becomes a real problem; requires CBOR + X.509 parsing
   in the Worker (no verified Workers-compatible library was checked in this pass).
8. **Reset-my-data in v1** — recommended for hygiene; confirm with the product owner that wiping tokens/stars
   is acceptable UX (a confirmation dialog with the streak count is probably enough).

## Fact-check log

Fact-check pass of 2026-09-02. No claims were unverifiable. Refuted claims have been corrected inline (F3, F5,
F14, Token format, Middleware behaviour, code sketches, Claims table).

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ |
| C2 | **refuted** (kid sub-claim only; exports and HS256 implementation confirmed). `sign()` emits `kid` when the key is a JWK object with `alg`; the custom `k` payload claim was optional, not required | package inspection of hono@4.13.5 `dist/utils/jwt/jwt.js` and `dist/types/utils/jwt/jwt.d.ts` (npm pack); https://raw.githubusercontent.com/honojs/hono/main/src/utils/jwt/jws.ts |
| C3 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| C4 | confirmed | https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/ |
| C5 | confirmed (caveat: vitest-pool-workers 0.22.0 bundles wrangler 4.124.0 / miniflare 5.20260815.0-alpha, not inspected) | package inspection (`npm pack miniflare`, `npm view wrangler@4.128.0 dependencies`) |
| C6 | confirmed | https://developers.cloudflare.com/workers/platform/pricing/ ; binding page |
| C7 | confirmed | https://developers.cloudflare.com/kv/platform/limits/ |
| C8 | confirmed (nuance: header/cookie/JSON characteristics need Enterprise with the Advanced Rate Limiting add-on) | https://developers.cloudflare.com/waf/rate-limiting-rules/ |
| C9 | confirmed | https://developers.cloudflare.com/fundamentals/reference/http-headers/ |
| C10 | confirmed | https://hono.dev/docs/middleware/builtin/cors ; https://docs.expo.dev/more/expo-cli/ |
| C11 | confirmed (nuance: reinstall persistence is iOS-only; Android data is not preserved on uninstall) | https://docs.expo.dev/versions/latest/sdk/securestore/ |
| C12 | confirmed (nuance: web requires a secure origin, else `ERR_CRYPTO_UNAVAILABLE`) | https://docs.expo.dev/versions/latest/sdk/crypto/ |
| C13 | confirmed | https://developers.cloudflare.com/workers/configuration/secrets/ ; https://developers.cloudflare.com/secrets-store/integrations/workers/ |
| C14 | confirmed | https://better-auth.com/blog/1-5 ; https://www.better-auth.com/docs/concepts/database ; @better-auth/kysely-adapter@1.7.2 |
| C15 | confirmed | `npm view better-auth@1.7.2 peerDependencies`; `npm view @better-auth/expo@1.7.2 peerDependencies` |
| C16 | confirmed | https://www.better-auth.com/docs/integrations/expo |
| C17 | confirmed | https://www.better-auth.com/docs/plugins/bearer |
| C18 | confirmed (nuance: #4496 closed "not planned" 2025-12-17, not fixed) | https://www.better-auth.com/docs/plugins/anonymous ; https://github.com/better-auth/better-auth/issues/2116 ; https://github.com/better-auth/better-auth/issues/4496 |
| C19 | confirmed | https://www.better-auth.com/docs/concepts/users-accounts ; https://www.better-auth.com/docs/concepts/database |
| C20 | confirmed (nuance: clientSecret limit 15,777,000 s; Apple prohibits localhost redirect testing) | https://www.better-auth.com/docs/authentication/apple |
| C21 | confirmed | https://developer.apple.com/documentation/signinwithapple/verifying-a-user |
| C22 | confirmed | https://developer.apple.com/app-store/review/guidelines/ |
| C23 | confirmed | https://developer.apple.com/app-store/review/guidelines/ ; https://developer.apple.com/support/offering-account-deletion-in-your-app/ |
| C24 | confirmed (incomplete: `credentialId` == key id and `extensions` CBOR values must also be verified) | https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server |
| C25 | confirmed (still low confidence; no Apple source checked) | not verified against Apple docs |
| E1 | confirmed | fact-checker extra check (source not itemized in the brief) |
| E2 | **refuted**: cloudflare-docs issue #25590 was opened 2025-10-02 and closed 2026-02-17 as completed (PR #28117), not "open, Oct 2025" | https://api.github.com/repos/cloudflare/cloudflare-docs/issues/25590 |
| E3 | confirmed | fact-checker extra check (source not itemized in the brief) |
| E4 | confirmed | fact-checker extra check (source not itemized in the brief) |
| E5 | confirmed | fact-checker extra check (source not itemized in the brief) |
| E6 | confirmed | fact-checker extra check (source not itemized in the brief) |
| E7 | confirmed | fact-checker extra check (source not itemized in the brief) |
| E8 | confirmed | fact-checker extra check (source not itemized in the brief) |
| E9 | confirmed | fact-checker extra check (source not itemized in the brief) |
| E10 | confirmed | fact-checker extra check (source not itemized in the brief) |

Additional corrections applied from the fact-check notes (not tied to a claim id): refresh route now checks the
`Bearer ` prefix before slicing; the `boot:<ip>` limit is annotated as against Cloudflare's "not recommended"
guidance for IP keys; `mintDeviceToken` notes hono `verify()`'s default `iat: true` (future `iat` is rejected).
