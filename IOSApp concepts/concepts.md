# Concepts

The common approach for every app built on this stack: one universal Expo app (iOS, Android, web)
in front of a Cloudflare Workers modular monolith, where stateful entities are Durable Objects
that project their current state into D1 tables.

This document is the "why" and the rules. `core-package.md` is the "how" for the code.

---

## 1. Product shape

```
┌─────────────────────────────┐        ┌──────────────────────────────────────────────┐
│  apps/app  (Expo Router)    │  HTTPS │  workers/gateway  (Hono)                     │
│  iOS · Android · web        │ ─────▶ │  auth once · validate · route                │
│  TanStack Query · NativeWind│        │      │ RPC by name                            │
└─────────────────────────────┘        │      ▼                                       │
                                       │  named WorkerEntrypoints  (stateless modules) │
                                       │  Durable Object aggregates (stateful entities)│
                                       │      │ flush snapshot                         │
                                       │      ▼                                       │
                                       │  Projections entrypoint ──▶ D1 (read model)   │
                                       └──────────────────────────────────────────────┘
```

- **One codebase, three platforms.** The Expo app targets web via React Native Web. Its static
  export is served from the gateway Worker's assets binding, so the entire product is one deploy.
- **One backend, no events.** Modules call each other by name over Workers RPC (service bindings
  or `ctx.exports` loopback). Nothing subscribes to anything; there is no queue or pub/sub.
- **One account.** Everything runs in your own Cloudflare account: Workers, Durable Objects, D1,
  KV, R2. Expo's EAS handles builds, store submission and OTA updates.

## 2. Backend topology

| Piece | Role | Stateful? |
|---|---|---|
| `gateway` Worker (Hono) | Public HTTPS surface. Verifies the session **once**, validates input with Zod, calls modules, serves the web build. | no |
| Named `WorkerEntrypoint` classes | Stateless modules: `Projections`, `Notifications`, `Billing`, … Callable only from Workers that bind to them. | no |
| `Aggregate` Durable Objects | One object per entity (`User`, `Match`, `Order`). Owns the entity's current state and serializes its commands. | yes |
| D1 | Read model (projection tables) + relational tables that must be queried across entities (auth, admin). | yes |
| KV / R2 | Cache & config / user uploads. | yes |

**RPC rules**

1. Bind to **named** entrypoints, never to `default` — the default export is what `workers.dev`
   exposes to the internet; named entrypoints are reachable only through bindings on your account.
2. Only structured-cloneable values cross an RPC boundary (plain objects, arrays, strings, numbers,
   Dates, streams). Class instances must extend `RpcTarget`. Errors arrive as `Error` with the same
   `name` and `message` — nothing else survives, so map on `err.name` in the gateway.
3. The gateway passes an authenticated context object (`{ userId }`) into modules and aggregates.
   Internal modules trust it; they never re-verify tokens.
4. Start as a single Worker with several named entrypoints (one `wrangler dev`, one deploy).
   Split a module into its own Worker only when you need independent deploys; the calling code
   does not change, only the binding.

## 3. Aggregates and projections (the core pattern)

An **aggregate** is a Durable Object that owns the *current state* of one entity as a plain JSON
value. It is the write model. A **projection** is a row in a D1 table derived from that state. It
is the read model, and also the registry of which aggregates exist.

**Invariants**

- State is a single snapshot. There is no event log (decided: current state only).
- Every commit bumps a monotonic `version`. The object remembers the highest version that
  reached D1 as `projected`. `version > projected` is the entire "outbox".
- A flush pushes `{kind, id, version, state}` to the `Projections` entrypoint, which performs an
  **idempotent, version-guarded upsert**: a row is only overwritten by a strictly newer version.
  Duplicates and out-of-order flushes are therefore harmless.
- A failed flush schedules an alarm and retries with exponential backoff. Alarms survive eviction;
  the constructor re-arms one if it wakes up with a pending flush.
- A commit that produces an equal state is a **no-op**: no version bump, no flush. Naturally
  idempotent commands (webhook replays, "add token" twice) cost nothing.
- **Register on create.** Durable Objects cannot be enumerated. The first flush after `init(id)`
  inserts the projection row, which is what makes the entity discoverable. Never create an
  aggregate without calling `init`, or you can never rebuild its projection.
- Projection tables are disposable. Add a column with a D1 migration, then call `reproject()` on
  each id from the registry to rebuild.

**Consistency model**

| Read | Where | Guarantee |
|---|---|---|
| One entity, must be exact | the aggregate (`snapshot()`) | strongly consistent |
| Result of my own command | returned by the command | strongly consistent — write it into TanStack Query's cache |
| Lists, search, admin, cross-entity | D1 projection tables | eventually consistent; milliseconds behind in `await` flush mode |

`flushMode: "await"` (default) makes a command resolve after D1 is updated, so a list read that
follows a command usually sees it. `"background"` returns as soon as the object's SQLite is written.

**What belongs in an aggregate vs. a plain table**

- Aggregate: anything owned by one entity and mutated by commands — entitlements, push tokens,
  preferences, room state, order lifecycle.
- Plain D1 table: anything queried across entities or owned by a library — the auth schema
  (Better Auth), audit logs, analytics-style tables.

**Cross-entity workflows** are orchestrated by calling several objects by name from a Worker
(or from Cloudflare Workflows when a multi-step process must survive failures midway). No object
ever calls another object's commands as a side effect of its own commit.

**Naming.** Object names are `${kind}:${id}` (`user:abc123`). Projection tables always have
`id TEXT PRIMARY KEY`, `version INTEGER`, `updated_at INTEGER`, plus read-model columns.

## 4. Auth

- **Better Auth**, self-hosted in the gateway Worker, schema in D1 via the Drizzle adapter.
  Instantiate per request (`createAuth(env)`) because D1 bindings only exist inside a handler.
- Clients: `@better-auth/expo` on iOS/Android (tokens in `expo-secure-store`), the web client on
  web. Same server, same sessions.
- Offering Google/social login on iOS obliges you to offer **Sign in with Apple** (Guideline 4.8).
  Verify Apple identity tokens against Apple's JWKS on the Worker.
- The `User` aggregate is keyed by the Better Auth user id and holds *product* state only. It is
  created (`init`) from Better Auth's user-created hook.

## 5. Payments and entitlements

- iOS: In-App Purchase via RevenueCat (`react-native-purchases`, development build required).
- Web: Stripe or RevenueCat web billing. Digital goods sold on web are outside Apple's rules, but
  check the current external-purchase rules before advertising web prices inside the iOS app.
- Both paths end in one place: a webhook route on the gateway calls
  `User.setEntitlement(...)`. Serialization inside the object gives webhook idempotency for free;
  a replayed or reordered event is a no-op commit.
- Subscription expiry checks are **alarms on the User object**, not a cron scanning a table.

## 6. Push notifications

- Device tokens live in the `User` aggregate (APNs/Expo tokens and, on web, push subscriptions).
- Sending goes through a `Notifications` entrypoint that calls the Expo Push API with plain
  `fetch` (the Node SDK has had Workers compatibility issues). Direct APNs (HTTP/2 + .p8 JWT) is the
  alternative if you want Expo out of the delivery path.
- `DeviceNotRegistered` receipts remove the token via a command on the User object.

## 7. Real-time (later)

- A room/match is an `Aggregate` subclass that also accepts WebSockets using the **Hibernation
  API**. Hibernating rooms cost nothing while idle; non-hibernated sockets bill wall-clock time.
- Room state stays in the object; the match list is a projection.
- PartyServer is an optional ergonomic layer on top of the same Durable Objects.

## 8. Web as a third platform

- Enable `web` in the Expo app; `expo export` produces a static bundle (`expo.web.output: static`)
  served by the gateway's assets binding. Server-rendered output can run on Workers via
  `expo-server`'s workerd adapter, but keep server logic in the Hono API, not in Expo server
  functions.
- Universal links (`app.yourdomain.com/…`) open the iOS app when installed, the web app otherwise.
- Platform differences are handled inside the app (`Platform.OS` branches): IAP vs Stripe, native
  push vs web push, Apple Sign In vs OAuth redirect.
- A content/marketing site with SEO needs is a separate Astro/TanStack Start app on Workers,
  sharing `packages/shared` — added only when needed.

## 9. Repository layout

```
apps/app/               Expo Router app (ios, android, web)
workers/gateway/        Hono API + assets + Better Auth; exports aggregates and entrypoints
workers/<module>/       optional: modules split into their own Workers later
packages/core/          Aggregate + Projections base classes (this pattern)
packages/shared/        Zod schemas, TypeScript types, Hono RPC client types
docs/                   app-specific decision records
```

pnpm workspaces + Turborepo; Metro needs `watchFolders`/`nodeModulesPaths` set to the repo root
and exactly one copy of `react`.

## 10. Local development

Everything runs on the Mac with no Cloudflare paid plan, no Apple Developer account and no deploy.

**Tooling: Wrangler, not the Vite plugin.** `create cloudflare` asks "Wrangler or Vite?" — the
choice only affects the local dev server and bundler; `wrangler.jsonc`, bindings and deployment
are identical. Cloudflare's rule is to pick by the build tool the project already uses. The front
end here is bundled by Expo/Metro, not Vite, and the Worker only serves the finished `dist/`, so
Vite would add a second toolchain for nothing. Wrangler also has `--remote` (develop against real
bindings) and is the deploy tool regardless. Switch to the Vite plugin only if a Vite-built web
app (TanStack Start, React Router) is later added to the same Worker; it reads the same
`wrangler.jsonc`, so nothing else changes.

**Backend.** `wrangler dev` runs the Worker in workerd with local Durable Objects, D1, KV and R2
(state persists under `.wrangler/state`; the Local Explorer, key `e`, inspects it). No login is
needed until the first `wrangler deploy`. `wrangler dev --ip 0.0.0.0` exposes it on the LAN for a
physical phone.

**App.** Three run modes, cheapest first:

| Mode | Command | Needs | Covers |
|---|---|---|---|
| Web in browser | `npx expo start --web` | nothing | everything pure JS |
| Expo Go on iPhone | `npx expo start`, scan QR | Expo Go app | pure JS; same Wi-Fi as the Mac; API URL = Mac's LAN IP |
| iOS Simulator | `npx expo run:ios` | Xcode | pure JS + most native modules |
| Development build | `eas build --profile development --platform ios` | free Expo account, free Apple ID for a device | IAP, push, Apple Sign In |

Stub the native-only features while playing (RevenueCat has a preview mode that mocks purchases
in Expo Go). Better Auth email/password works locally with no OAuth keys.

**Env.** The app reads `EXPO_PUBLIC_API_URL` (`http://localhost:8787` for browser/Simulator,
`http://<lan-ip>:8787` for a phone). Worker secrets go in `.dev.vars` locally, `wrangler secret
put` in production. Run `wrangler types` after any binding change.

**First loop from the scaffold:** `pnpm install` → `packages/core` tests pass → create
`workers/gateway` (Hello World, TypeScript, Wrangler, skip deploy; add Hono, `User`,
`Projections`) → create `apps/app` (TanStack Query, one screen calling `/me/…`) → add Better Auth
email/password. That is the full screen → gateway → aggregate → D1 projection loop on one machine.

## 11. Cost model (what actually costs money)

- Workers Paid ($5/month) covers a small app entirely. Per command you pay one Workers request,
  one Durable Object request, a few row writes, and ~20 ms of object duration.
- Durable Objects bill duration only while active or unable to hibernate. Idle objects are free.
- Things that make it expensive: non-hibernating WebSockets, timers inside objects
  (`setInterval`), a single hot global object, and staying on the Free plan after launch
  (Free plan operations fail once a daily limit is exceeded).
- Rough totals: ~$5/month at 3k DAU, ~$45/month at 50k DAU, plus $99/year for Apple.
- Vercel for the same backend: ≈4–5× the cost (per-seat fee, $2/M edge requests above 10M,
  provisioned-memory billing), and no equivalent of Durable Objects or Workers RPC.

## 12. Testing conventions

- `@cloudflare/vitest-pool-workers` runs tests inside `workerd`: real Durable Objects, real D1,
  real RPC. Use `runDurableObjectAlarm` for retries, `evictDurableObject` for reload paths,
  `runInDurableObject` to poke at instances directly.
- Assert command failures with `await expect(async () => { await stub.cmd(); }).rejects…` so the
  RPC rejection is handled exactly once (see the note in `packages/core/vitest.config.ts`).
- Every aggregate gets: a happy-path projection test, an idempotency test, and a failed-flush →
  alarm → recovered test.

## 13. Decision log

| Decision | Choice | Alternative considered |
|---|---|---|
| Mobile framework | Expo (universal, web enabled) | Capacitor; separate web app |
| Backend shape | Single Worker, named entrypoints, RPC by name | Multiple Workers + service bindings (still supported) |
| Stateful entities | Durable Object per entity (actor model) | D1-only relational model |
| History | Current state only (snapshot) | Per-object event log / event sourcing |
| Projection delivery | In-object watermark + alarm retry, version-guarded upsert | Queues, transactional outbox rows |
| Flush timing | `await` (read-your-writes) | `background` |
| System of record for auth | D1 (Better Auth, Drizzle) | Auth inside a Durable Object |
| Projections wiring | `ctx.exports` loopback in single-Worker shape; `PROJECTIONS` binding when split | Service binding only |
| Local dev tooling | Wrangler (`wrangler dev`) | Cloudflare Vite plugin (only if a Vite-built web app joins the Worker) |
| Hosting | Own Cloudflare account | Vercel (≈4–5× the cost, no actors); EAS Hosting (Expo's account) |
