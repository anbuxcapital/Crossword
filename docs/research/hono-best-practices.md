# Hono 4.13 on Workers: composition, validation, RPC client, errors, OpenAPI

Research date: 2026-09-02. Target stack: hono 4.13.5, zod 4.5.4, @hono/zod-validator 0.9.1,
@hono/zod-openapi 1.6.2, hono-openapi 1.3.1, wrangler 4.128.0, TypeScript 7.0.2, vitest 4.1.11,
pnpm 11.24.0 (a local pin — npm `latest` is 11.25.0 as of 2026-09-02), Node 26.8.1. Fact-check
2026-09-02: Node 26.8.1, wrangler 4.128.0, TypeScript 7.0.2, vitest 4.1.11, zod 4.5.4 and hono 4.13.5
all match npm `latest`.

Everything marked **[verified locally]** was exercised in a scratch project at
`/private/tmp/claude-501/-Users-peter-Projects-IOS-Crosswords/9d054732-b7c8-4939-80a1-8eb9aba21fda/scratchpad/honocheck`
(pinned versions above; `tsc --noEmit` with TypeScript 7.0.2 passes; 7/7 tests pass inside workerd
with `@cloudflare/vitest-plugin` 1.1.3). Anything marked **UNVERIFIED** could not be confirmed
against a primary source and carries confidence "low" in the Claims table.

## Summary

- **Composition.** Hono's own guidance is: no controller classes; one `Hono` instance per module,
  built with `createFactory<AppEnv>().createApp()` and **method-chained** routes; the gateway
  mounts them with `app.basePath('/v1').route('/feed', feed).route('/hints', hints)` and exports
  `type AppType = typeof routes` (the best-practices page writes `typeof app`; the two are equivalent
  only because `routes` *is* the chained expression — do not export `typeof app` after non-chained
  route registration). This is exactly the shape a modular monolith wants: each Crosscut
  module (feed, puzzles, play, hints, wallet, wheel, collections, leaderboard, profile, streak)
  owns a `routes.ts` sub-app; the gateway file is only wiring. Chaining is not optional: `hc` and
  `testClient` lose route types otherwise.
- **Validation.** `@hono/zod-validator` 0.9.1 supports zod 4 natively (peer `^3.25.0 || ^4.0.0`;
  its runtime `dist/index.mjs` imports only `hono/validator` and calls `schema.safeParseAsync` — the
  `zod/v3` / `zod/v4` / `zod/v4/core` imports exist only in its `.d.mts`/`.d.ts` type files; corrected
  by fact-check against the 0.9.1 tarball). Your application code imports
  `import * as z from "zod"` — in zod 4.x the package root *is* zod 4; `zod/v4` is only a
  permanent alias. The hook is `(result, c) => Response | void | Promise<...>` where
  `result` is `{ success, data, error, target }`; without a hook the middleware returns the raw
  `safeParse` failure as a 400 JSON body **and that 400 body is part of the `hc` response type
  union** (0.8.0 change). Use `z.flattenError()` / `z.treeifyError()` (the `error.flatten()`
  method is deprecated in zod 4).
- **Errors.** `HTTPException` from `hono/http-exception` (`status`, `{ message, res, cause }`,
  `getResponse()`); one `app.onError` on the gateway; `app.notFound` for 404 JSON. Errors that
  cross a Workers RPC boundary keep only `name` + `message` (no stack, no `cause`, no own
  properties), so `DomainError` / `NotInitializedError` from `packages/core` are mapped on
  `err.name`, never `instanceof`.
- **Middleware.** All built-ins used here are subpath exports of `hono` (no extra packages):
  `hono/cors`, `hono/logger`, `hono/request-id`, `hono/secure-headers`, `hono/timing`,
  `hono/bearer-auth`, `hono/combine`, `hono/body-limit`. Custom device/bearer auth is a
  `factory.createMiddleware` that `c.set('userId', …)`.
- **RPC client.** `hc<AppType>` from `hono/client`. In a pnpm monorepo, do **not** make the Expo
  app import the Worker's source types; have the Worker emit `.d.ts` and publish a
  `hcWithType` wrapper from a shared package. Measured with TS 7.0.2 on a synthetic 120-route
  app: consumer type-check from source = 1.37 M instantiations / 0.225 s; from emitted `.d.ts`
  = 0.19 M instantiations / 0.059 s (7x fewer instantiations). Both are fast with TS 7; the
  point is IDE (tsserver) responsiveness and dependency isolation, not build wall-clock time.
- **Testing.** The Cloudflare Vitest integration was **renamed** on 2026-08-19:
  `@cloudflare/vitest-pool-workers` → `@cloudflare/vitest-plugin` (v1, currently 1.1.3). `SELF`
  from `cloudflare:test` is **deprecated, not removed** (corrected by fact-check: 1.1.3's
  `types/cloudflare-test.d.ts` still declares `SELF: Fetcher` with `@deprecated`, and
  `dist/worker/lib/cloudflare/test.mjs` still re-exports it as a Proxy over `exports.default`; it is
  simply no longer documented on the Test APIs page). Prefer `import { env, exports } from
  "cloudflare:workers"` and `exports.default.fetch(...)`. Caveat from the Test APIs page: "Unlike the
  previous SELF binding, exports does not expose Assets" — use `startDevWorker()` if the gateway
  Worker serves the Expo web build via an assets binding. The config API (`cloudflareTest({ wrangler: { configPath }})`)
  is unchanged; there is a codemod. The `packages/core` template you are copying pins the old
  package (0.22.0, whose types already mark `SELF` and `env` from `cloudflare:test` as
  `@deprecated`). `app.request(path, init, env)` is the fast in-process test; `exports.default.fetch`
  is the full-stack one.
- **OpenAPI.** Two viable options today, both zod-4-ready: `@hono/zod-openapi` 1.6.2 (zod-4-only,
  replaces `Hono` with `OpenAPIHono` + `createRoute`, brings `@asteasolutions/zod-to-openapi`)
  and `hono-openapi` 1.3.1 (additive `describeRoute()` + Standard-Schema `validator()`; for zod 4
  it calls zod's native `toJSONSchema`, no extra converter). Recommendation: **ship phase 1 without
  OpenAPI** (the only client is the Expo app and it gets types from `hc`), and if a spec is later
  needed add `hono-openapi` route-by-route, because it does not change how routes are written.

## Findings

### F1. Hono 4.13.x: what changed, what is exported

- 4.13.0 (2026-08-03): up to 1.25x faster JSON routes; first-class **QUERY** HTTP method
  (`cors()` `allowMethods` now defaults to `['GET','HEAD','PUT','POST','DELETE','PATCH','QUERY']`);
  new Method-Not-Allowed middleware (405 + `Allow`); `RegExpRouter` rejects unsupported paths at
  registration time; JWT/JWK `realm` option. 4.13.1–4.13.5 are bug/security fixes (4.13.5,
  2026-08-26: query parser stops at `#`, bounded dot-notation nesting in `parseBody()`).
  Source: https://github.com/honojs/hono/releases ; publish dates from `npm view hono time`.
- Verified subpath exports in 4.13.5 (`npm view hono@4.13.5 exports`): `hono/client`,
  `hono/factory`, `hono/validator`, `hono/http-exception`, `hono/cors`, `hono/logger`,
  `hono/request-id`, `hono/secure-headers`, `hono/timing`, `hono/bearer-auth`, `hono/combine`,
  `hono/body-limit`, `hono/context-storage`, `hono/testing`, `hono/cloudflare-workers`, `hono/ws`,
  `hono/jwt`, `hono/jwk`, `hono/etag`, `hono/cache`, `hono/csrf`, `hono/cookie`, `hono/types`,
  and `hono/method-not-allowed` (present in `npm view hono@4.13.5 exports`; omitted from an earlier
  draft of this list — see C23).
- `hono` declares no peer dependencies; `engines.node >= 16.9.0`.

### F2. Composition: factory, sub-apps, `app.route()`, ordering

- Best-practices page: "do not make controllers" (path params cannot be inferred); if you need
  handler separation use `factory.createHandlers()`; for larger apps put each area in its own
  `Hono` and mount with `app.route('/authors', authors)`; for RPC, **chain** the routes and export
  `type AppType = typeof app` (equivalent to this document's `typeof routes` only when `routes` is
  the chained expression). Source: https://hono.dev/docs/guides/best-practices . HEAD is
  auto-derived from GET — this is not stated on the docs pages; it is visible only in the
  `hono-base.js` source of 4.13.5.
- `hono/factory`: `createFactory<Env>({ initApp?, defaultAppOptions? })` returns
  `{ createApp(options?), createMiddleware, createHandlers }`; `createMiddleware` is also exported
  standalone. Type signature verified from `dist/types/helper/factory/index.d.ts` (4.13.5).
  Source: https://hono.dev/docs/helpers/factory
- Env generic: `new Hono<{ Bindings: …; Variables: … }>()`; `c.env` for bindings, `c.set/c.get`
  for request-scoped variables (retained only within one request); `c.var.x` dot access.
  `ContextVariableMap` augmentation is global and the docs warn it can mask undefined-variable
  bugs — prefer the `Variables` generic. Source: https://hono.dev/docs/api/context ,
  https://hono.dev/docs/api/hono
- Routing/order rules: handlers and middleware run in **registration order**; middleware
  registered after a handler never runs for that handler; `strict` mode defaults to `true`
  (`/hello` ≠ `/hello/`; documented on the Hono API page https://hono.dev/docs/api/hono , not the
  routing page); `basePath()` prefixes every route of that instance; `app.route('/', x)`
  merges without changing paths. Source: https://hono.dev/docs/api/routing (ordering, `basePath`,
  `route`), https://hono.dev/docs/guides/middleware
- `app.onError` precedence: "If both a parent app and its routes have `onError` handlers, the
  route-level handlers get priority." Source: https://hono.dev/docs/api/hono
- **[verified locally]** `factory.createApp()` sub-apps inherit `Bindings`/`Variables` from the
  factory; `app.basePath('/v1').route('/feed', feed).route('/hints', hints)` produces a typed
  client where `client.v1.feed[':id'].$get(...)` and `client.v1.hints.$post(...)` are inferred.

### F3. Validation with zod 4

- **zod 4.5.4 import paths.** In zod 4.x the root `"zod"` exports Zod 4; `"zod/mini"` is Zod Mini;
  `"zod/v3"` is legacy; `"zod/v4"` and `"zod/v4-mini"` "will remain available forever" but are no
  longer necessary. Library authors are told to import from `"zod/v4/core"` (a permalink) and to
  declare peer `^3.25.0 || ^4.0.0` for dual support. Verified against the package export map
  (`npm view zod@4.5.4 exports`: `.`, `./v3`, `./v4`, `./mini`, `./v4/core`, `./v4/mini`, …).
  Sources: https://zod.dev/v4/versioning , https://zod.dev/library-authors
- **`@hono/zod-validator` 0.9.1**: peers `zod: ^3.25.0 || ^4.0.0`, `hono: >=4.11.2`
  (`npm view @hono/zod-validator@0.9.1 peerDependencies`). Its shipped runtime `dist/index.mjs` imports only
  `hono/validator` and always calls `schema.safeParseAsync` (no branching on schema version); the
  `zod/v3`, `zod/v4` and `zod/v4/core` imports appear only in the `.d.mts`/`.d.ts` type files
  (corrected by fact-check against the 0.9.1 tarball). Practical consequence unchanged: **you do not
  import `zod/v4` yourself** — `import * as z from "zod"` is what its README uses. Changelog: 0.6.0 zod 4
  support; 0.7.0 peer widened; **0.8.0 the default 400 failure response is now surfaced to the RPC
  layer and the middleware needs hono ≥ 4.10 (4-argument `MiddlewareHandler`)**; 0.9.0 uses
  `InferInput` from `hono/validator` (hono ≥ 4.11.2); 0.9.1 caches header-schema metadata.
  Sources: https://github.com/honojs/middleware/blob/main/packages/zod-validator/README.md ,
  https://github.com/honojs/middleware/blob/main/packages/zod-validator/CHANGELOG.md ,
  local `dist/index.d.mts` of the published tarball.
- **Hook signature** (from `dist/index.d.mts`, 0.9.1):
  `(result: ({ success: true; data } | { success: false; error; data }) & { target }, c) =>
  Response | void | TypedResponse | Promise<…>`. The hook's return type replaces the default
  400 in the route's response type union. Optional 4th argument
  `{ validationFunction: (schema, value) => SafeParseResult | Promise<…> }` (e.g. to use
  `safeParse` instead of the default `safeParseAsync`, or `.passthrough()` semantics).
- Targets: `json`, `form`, `query`, `param`, `header`, `cookie`; header keys must be lowercase;
  multiple validators can be stacked and read with `c.req.valid(target)`.
  Source: https://hono.dev/docs/guides/validation
- **zod 4 error formatting**: `z.flattenError(err)` → `{ formErrors, fieldErrors }`;
  `z.treeifyError(err)`; `z.prettifyError(err)`; `error.flatten()` / `error.format()` are
  deprecated; `z.formatError` deprecated in favour of `treeifyError`.
  Source: https://zod.dev/error-formatting
- **[verified locally]** With a hook returning
  `c.json({ error: { code: 'invalid_request', issues: z.flattenError(result.error), target: result.target } }, 400)`
  a bad body yields status 400, `target === 'json'`, `fieldErrors` keyed by `kind` and `puzzleId`.
  `z.coerce.number().int().min(1).max(50).default(20)` on `query` coerces `"5"` → `5`.

### F4. Errors and 404

- `HTTPException(status?, { message?, res?, cause? })`; `status` is a `ContentfulStatusCode`
  (default 500); `getResponse()` builds a `Response` from `status` + `message` or returns the
  custom `res`. Handle in `app.onError((err, c) => err instanceof HTTPException ? err.getResponse() : …)`.
  Source: https://hono.dev/docs/api/exception and `dist/types/http-exception.d.ts` (4.13.5).
- `c.json(data, status?, headers?)` returns `Response & TypedResponse<JSONParsed<T>, Status, 'json'>`
  (from `dist/types/context.d.ts`); the explicit status literal is what makes `hc` produce
  discriminated unions on `res.status`. Source: https://hono.dev/docs/guides/rpc (status code typing).
- `app.notFound(handler)` customises 404; **for RPC-typed 404s inside a handler use
  `c.json({...}, 404)`, not `c.notFound()`**, because `c.notFound()` is untyped for the client.
  Source: https://hono.dev/docs/guides/rpc (known issues), https://hono.dev/docs/api/hono
- Workers RPC error propagation: "the `message` and prototype's `name` will be retained, though the
  stack trace is not"; own properties such as `cause` are not transmitted; `AggregateError` and
  `SuppressedError` are not propagated. Source:
  https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/
- Workers Logs indexes fields of objects passed to `console.log` (structured JSON) when
  `observability.enabled` is true in wrangler config; Cloudflare recommends logging JSON. Limits
  that matter for the structured logger middleware in the recommendation: each log entry is capped
  at 256 KB (larger entries are truncated) and there is a limit of 5 billion logs per account per
  day. Source: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- **[verified locally]** `HTTPException(401)` thrown from a factory middleware reaches `onError`,
  which returns `{ error: { code, message, requestId } }` with the same id as the `X-Request-Id`
  response header; unmatched paths go through `app.notFound` and return JSON 404 via
  `exports.default.fetch`.

### F5. Middleware details

| Middleware | Import | Key facts (source) |
|---|---|---|
| CORS | `import { cors } from 'hono/cors'` | `origin: string \| string[] \| (origin, c) => string`, `allowMethods` (default now includes QUERY), `allowHeaders`, `exposeHeaders`, `maxAge`, `credentials`; scope with `app.use('/api/*', cors())`; wrap in a middleware to read `c.env`. https://hono.dev/docs/middleware/builtin/cors |
| Logger | `import { logger } from 'hono/logger'` | `logger(printFunc?)`, `PrintFunc(str, ...rest)`; prints `<-- METHOD path` / `--> METHOD path status time`; colours off with `NO_COLOR`. https://hono.dev/docs/middleware/builtin/logger |
| Request ID | `import { requestId } from 'hono/request-id'`, `type RequestIdVariables` | options `limitLength` (255), `headerName` (`X-Request-Id`), `generator(c)` (default `crypto.randomUUID()`); **an inbound `X-Request-Id` header is honoured unless `headerName: ''`**; read with `c.get('requestId')`. https://hono.dev/docs/middleware/builtin/request-id |
| Secure headers | `import { secureHeaders } from 'hono/secure-headers'` | sets HSTS, `X-Frame-Options`, `X-Content-Type-Options: nosniff`, CORP `same-origin`, `Referrer-Policy: no-referrer`, removes `X-Powered-By`; COEP off by default; each header can be `false` or a string; later middleware can override. https://hono.dev/docs/middleware/builtin/secure-headers |
| Timing | `import { timing, startTime, endTime, setMetric } from 'hono/timing'`, `type TimingVariables` | emits `Server-Timing`; options `total`, `enabled`, `totalDescription`, `autoEnd`, `crossOrigin` (needed for browsers to read it cross-origin). https://hono.dev/docs/middleware/builtin/timing |
| Bearer auth | `import { bearerAuth } from 'hono/bearer-auth'` | `token: string \| string[]` or `verifyToken: (token, c) => boolean \| Promise<boolean>`; `realm`, `prefix`, `headerName`, `hashFunction`, custom `noAuthenticationHeader` / `invalidAuthenticationHeader` / `invalidToken` messages; token must match `/[A-Za-z0-9._~+/-]+=*/` or 400. https://hono.dev/docs/middleware/builtin/bearer-auth |
| Combine | `import { some, every, except } from 'hono/combine'` | `some` = first passing middleware wins; `every` = all must pass; `except(cond, mw)` skips for matching paths. https://hono.dev/docs/middleware/builtin/combine |
| Custom | `factory.createMiddleware(async (c, next) => …)` | keeps `Env` types for `c` and `next`. https://hono.dev/docs/guides/middleware |

**[verified locally]** `requestId()`, `timing()`, `logger()`, `secureHeaders()` and
`cors()` stacked on a factory app: response carried `x-request-id`, `server-timing: aggregate;…`,
`x-content-type-options: nosniff`.

### F6. Typed RPC client (`hc`) in a pnpm monorepo

- `import { hc } from 'hono/client'`; `hc<AppType>(baseUrl, options?)`; call as
  `client.posts[':id'].$get({ param: { id: '123' }, query: { page: '1' } })` — **path params and
  query values are strings**; per-request `{ headers }` as the second argument, global headers
  in `hc(url, { headers })`; `options.fetch` overrides fetch (documented for Workers service
  bindings: `fetch: c.env.AUTH.fetch.bind(c.env.AUTH)`). `InferRequestType` / `InferResponseType`
  from `hono/client`. Source: https://hono.dev/docs/guides/rpc
- Requirements/limits (same page): routes must be **chained**; both server and client
  `tsconfig` need `"strict": true`; **promise chains (`.then(d => c.json(d))`) lose the type** —
  use `async/await`; `c.notFound()` is untyped. IDE performance section: "Compile your code
  before using it (recommended)" — export
  `type Client = ReturnType<typeof hc<AppType>>` and `hcWithType = (...args) => hc<AppType>(...args)`
  so `tsc` instantiates the types once; optionally specify type arguments manually
  (`.get<'foo/:id'>(…)`) and split client per module (`hc<typeof authorsApp>('/authors')`).
- **[verified locally]** `hc` custom `fetch` wired to `exports.default.fetch` inside a workerd
  test; `r.status === 200` narrows to `{ id, title, par }`, `404` to `{ error: { code } }`, and
  the **remaining branch is the zValidator default 400 body** (`ZodSafeParseError<…>`), which
  `tsc` reports if you try to read a 200 field without narrowing (TS2339 observed). Give every
  validator a hook or narrow on `status`.
- **Compile-time cost, measured [verified locally], TS 7.0.2, 10 modules x 12 routes = 120
  routes, each with 1–2 `zValidator`s:**
  - server type-check + `emitDeclarationOnly`: 0.97 M instantiations, check 0.16 s; emitted
    `app.d.ts` = 160 KB (all route types inlined), per-module `.d.ts` ≈ 16 KB. (Fact-check
    2026-09-02: `bench/tsconfig.server.json` currently fails with TS6059 `rootDir` errors, so the
    0.97 M server-side figure could not be re-run as the project stands; the 160 KB `.d.ts` size
    does reproduce.)
  - consumer with `hc<AppType>` importing **source**: 1.37 M instantiations, check 0.225 s.
  - consumer importing the **emitted `.d.ts`**: 0.19 M instantiations, check 0.059 s.
  Fact-check note: the instantiation counts reproduce; the absolute wall-clock numbers do not (a
  re-run gave 0.498 s / 0.147 s) — treat the timings as a ratio, not as absolute figures.
  Absolute times are small on TS 7 (native compiler); what matters is that with `.d.ts` the Expo
  app's tsserver never re-instantiates the Worker's route graph, and the Worker's zod/hono
  versions do not leak into the app's type graph.
- `hono/testing`: `testClient(app, env?, executionCtx?, options?)` returns the same typed client
  against `app.request`; needs chained routes. **[verified locally]** `testClient(routes, env)`.
  Source: https://hono.dev/docs/helpers/testing and `dist/types/helper/testing/index.d.ts`.

### F7. Testing inside workerd (this changed in August 2026)

- **Rename.** "@cloudflare/vitest-pool-workers is now @cloudflare/vitest-plugin" (changelog
  2026-08-19). "The Vitest configuration API is unchanged. Existing projects must update the
  dependency name, package imports, and TypeScript `types` entries." Codemod:
  `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` (`--dry-run`, `--files <glob>`).
  Manual: dependency `@cloudflare/vitest-plugin@^1.0.0`; `import { cloudflareTest } from
  "@cloudflare/vitest-plugin"`; tsconfig `"types": ["@cloudflare/vitest-plugin/types"]`; the same
  rename applies to subpath imports. Sources:
  https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ ,
  https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/
- **`SELF` is deprecated, not gone** (corrected by fact-check). `@cloudflare/vitest-plugin@1.1.3`
  still exports `SELF` at runtime (`dist/worker/lib/cloudflare/test.mjs`, implemented as a Proxy over
  `exports.default`) and in its types (`types/cloudflare-test.d.ts` declares `export const SELF:
  Fetcher` and `env` with `@deprecated` JSDoc pointing to `cloudflare:workers`); it is no longer
  documented on the Test APIs page. Prefer `exports.default.fetch()`: integration tests use
  `import { exports } from "cloudflare:workers"; await exports.default.fetch("http://example.com/404")`;
  `env` also comes from `cloudflare:workers`. Caveat (Test APIs page): "Unlike the previous SELF
  binding, exports does not expose Assets" — if the gateway Worker serves the Expo web build through
  an assets binding, test that path with `startDevWorker()` instead. Sources for the correction:
  the 1.1.3 tarball files named above;
  https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ . Unit tests use `createExecutionContext()` / `waitOnExecutionContext(ctx)`
  from `cloudflare:test`. Requirements: Vitest **4.1+**, compatibility date ≥ 2022-10-31, ES
  modules. Sources: https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ ,
  https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- Verified from package metadata: `@cloudflare/vitest-plugin@1.1.3` (modified 2026-09-01) declares
  three peers: `vitest ^4.1.0`, `@vitest/runner ^4.1.0`, `@vitest/snapshot ^4.1.0` (relevant for
  pnpm strict peer resolution); depends on `wrangler 4.128.0`, `miniflare 5.20260831.0-alpha`; its
  `exports` map is exactly `{ ".": { types, import }, "./types": { types } }` — there is **no
  `./config` subpath** (C24 refuted). Its root export includes `readD1Migrations` (from
  `dist/pool/index.d.mts`); import it from `@cloudflare/vitest-plugin`.
  `@cloudflare/vitest-pool-workers@0.22.0` (the version pinned by the `packages/core` template)
  already carries `@deprecated` JSDoc on `env` and `SELF` in `cloudflare:test` pointing to
  `cloudflare:workers`. Its types file still declares `SELF`, so the old package keeps working,
  but new code should not use it.
- `cloudflare:test` still provides the Durable Object/D1 helpers the core tests rely on:
  `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`, `listDurableObjectIds`,
  `applyD1Migrations(db, migrations)`, plus `createExecutionContext`, `waitOnExecutionContext`.
  Source: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- `cloudflareTest` options: `wrangler.configPath`, `main` (needed for Durable Objects defined in
  the same Worker without `scriptName`), `miniflare` (bindings, compat flags, auxiliary `workers`).
  Custom Vitest `environment`/`runner` unsupported. Source:
  https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/
- **Typing `exports.default`.** **[verified locally]** With only `@cloudflare/workers-types` in
  `types`, `exports.default` fails with `TS2339: Property 'default' does not exist on type
  'Exports'`. Running `wrangler types` (generates `worker-configuration.d.ts` with
  `interface Env` and `namespace Cloudflare { interface GlobalProps { mainModule: typeof import("./src/index") } }`)
  and switching `types` to `["./worker-configuration.d.ts", "@cloudflare/vitest-plugin/types"]`
  fixes it. Correction from fact-check: the `type Exports = Record<string, ExportValue>` quoted in
  an earlier draft is `WebAssembly.Exports` (line ~245 of the generated file), not
  `Cloudflare.Exports`. The real `Cloudflare.Exports` (line ~13649) is
  `{ [K in keyof MainModule]: LoopbackForExport<MainModule[K]> & (DurableObjectNamespace if listed in durableNamespaces) }`,
  driven by `Cloudflare.GlobalProps.mainModule`, which wrangler 4.128 already emits. So
  per-entrypoint typing of `exports.User` / `exports.Projections` is available today with no extra
  flag: `WorkerEntrypoint` exports become `LoopbackServiceStub`, and `DurableObject` exports become
  `LoopbackDurableObjectClass` / `DurableObjectNamespace` once `durableNamespaces` is populated from
  wrangler's `durable_objects` config. Alternative without `wrangler types`: with
  `@cloudflare/workers-types` alone you can declare
  `declare namespace Cloudflare { interface GlobalProps { mainModule: typeof import('./src/index') } }`
  yourself and `exports.default` type-checks; running `wrangler types` is still the better option.
  Cloudflare: `wrangler types` is preferred per Worker (matches compat date/flags);
  `@cloudflare/workers-types` stays "the recommended way to type libraries and shared packages".
  Source: https://developers.cloudflare.com/workers/languages/typescript/
- `app.request(pathOrRequest, init?, env?)`: third argument supplies bindings — pass `env` from
  `cloudflare:workers` to get real D1/DO bindings without going through the Worker's `fetch`.
  Source: https://hono.dev/docs/guides/testing . **[verified locally]**.
- Hono's Cloudflare Workers guide still names `@cloudflare/vitest-pool-workers`; that page is
  behind Cloudflare's rename. Source: https://hono.dev/docs/getting-started/cloudflare-workers

### F8. OpenAPI with zod 4: `@hono/zod-openapi` 1.6 vs `hono-openapi` 1.3

| | `@hono/zod-openapi` 1.6.2 | `hono-openapi` 1.3.1 |
|---|---|---|
| Publisher | honojs/middleware (official) | rhinobase (community, "still in development" per README) |
| Peer deps (`npm view`) | `zod ^4.0.0`, `hono >=4.10.0` | `hono ^4.11.2` (optional), `@hono/standard-validator ^0.2.0` (optional), `@standard-community/standard-json ^0.3.5`, `@standard-community/standard-openapi ^0.2.9`, `openapi-types ^12.1.3`, `@types/json-schema` |
| Runtime deps | `@asteasolutions/zod-to-openapi ^9.1.0`, `openapi3-ts ^4.5`, `@hono/zod-validator ^0.9.1` | none beyond peers; zod 4 → native `zod/v4/core` `toJSONSchema` (checked `"_zod" in schema`); zod 3 → needs `zod-openapi@4` |
| zod 4 status | 1.0.0 "migrated from v3 to v4"; peer is 4-only | supports zod 3 and 4; for zod 4 use `.meta({ ref })` / `.describe()` (Registry); `zod-openapi@4` only for zod 3 |
| Programming model | `new OpenAPIHono()`, `createRoute({ method, path: '/x/{id}', request, responses })`, `app.openapi(route, handler, hook?)`; `z` **must** be imported from `@hono/zod-openapi` (adds `.openapi()`); `defaultHook`, inherited by nested apps mounted with `app.route()` (1.5.0); `defineOpenAPIRoute` / `openapiRoutes` (1.3.0); `doc()` / `doc31()`; `openAPIRegistry.registerComponent(...)` for security schemes; mount children with Hono `:param` syntax, not `{param}` | plain `Hono`; add `describeRoute({...})` middleware and `validator(target, schema)` (Standard Schema) — request schemas are auto-included; `resolver(schema)` for responses; `openAPIRouteHandler(app, { documentation })` or `generateSpecs()`; `describeResponse` |
| RPC (`hc`) | supported (`hc<typeof appRoutes>`) | supported (routes are plain Hono) |
| Cost | second `Hono` subclass; handler signature tied to `createRoute`; extra ~3 deps; `z` import must be the re-exported one everywhere schemas carry OpenAPI metadata | peer range `@hono/standard-validator ^0.2.0` lags the current 0.4.0 (pnpm may warn); spec generation is async and happens at request time (cache it) |
| **[verified locally]** | `doc31` emitted OpenAPI 3.1 with `$ref: #/components/schemas/Wallet` and `example: 269`; `defaultHook` typed; TS 7 typecheck OK | with `@hono/standard-validator 0.4.0` + zod 4.5.4 and **no** `zod-openapi` package: spec generated in workerd (auto `operationId: getWalletByUserId`, `.meta({ ref: 'Wallet' })` → `components.schemas.Wallet`, `{userId}` path param); note zod 4 emits `minimum/maximum: ±9007199254740991` for `.int()` |

Sources: https://github.com/honojs/middleware/blob/main/packages/zod-openapi/README.md ,
https://github.com/honojs/middleware/blob/main/packages/zod-openapi/CHANGELOG.md ,
https://hono.dev/examples/zod-openapi , https://hono.dev/examples/hono-openapi ,
https://honohub.dev/docs/openapi/zod , published tarballs' `dist` (import graphs quoted above).
Note: `hono-openapi`'s own README (npm/GitHub) does not document the zod-3-vs-zod-4 install split
or the `@hono/standard-validator` peer; that guidance lives only on honohub.dev and in package
metadata, so the "Peer deps" column above is npm-derived, not README-derived.

### F9. Compatibility matrix (2026-09-02)

| Package | Version | Requires | Works with zod 4.5.4? | Source |
|---|---|---|---|---|
| hono | 4.13.5 | node ≥ 16.9 (no peers) | n/a | `npm view hono@4.13.5` |
| zod | 4.5.4 | – | root import is Zod 4 | https://zod.dev/v4/versioning |
| @hono/zod-validator | 0.9.1 | hono ≥ 4.11.2, zod ^3.25 \|\| ^4 | yes [verified locally] | `npm view`, CHANGELOG |
| @hono/zod-openapi | 1.6.2 | hono ≥ 4.10.0, zod ^4 | yes, zod-4-only [verified locally] | `npm view`, CHANGELOG 1.0.0 |
| hono-openapi | 1.3.1 | hono ^4.11.2, @hono/standard-validator ^0.2 (opt.), standard-json ^0.3.5, standard-openapi ^0.2.9 | yes via native `toJSONSchema` [verified locally with standard-validator 0.4.0] | `npm view`, dist source |
| @hono/standard-validator | 0.4.0 | hono ≥ 4.11.2, @standard-schema/spec ^1 | yes | `npm view` |
| @cloudflare/vitest-plugin | 1.1.3 | vitest ^4.1, wrangler 4.128.0, miniflare 5.2026083x | – | `npm view`, changelog |
| @cloudflare/vitest-pool-workers | 0.22.0 (legacy name) | vitest ^4.1 | – | `npm view`; deprecated JSDoc on `SELF`/`env` |
| wrangler | 4.128.0 | – | – | `npm view` |
| TypeScript | 7.0.2 (native) | – | all of the above type-check [verified locally] | local run |
| vitest | 4.1.11 | – | – | local run |

## Recommendation for Crosscut

1. **Directory shape (gateway Worker).**
   ```
   workers/gateway/src/
     index.ts            export default app; export { User, Projections, ... }
     http/app.ts         gateway composition: middleware stack, basePath('/v1'), .route(...) per module, AppType
     http/factory.ts     createFactory<AppEnv>()
     http/errors.ts      onError + notFound (JSON envelope)
     http/auth.ts        requireUser middleware (device id + bearer session)
     modules/<m>/routes.ts   chained factory.createApp() sub-app (HTTP only)
     modules/<m>/service.ts  in-process module API (called by other modules; the "event" targets)
     modules/<m>/aggregate.ts, projection.ts
   ```
   Module boundary rule: `routes.ts` may import only its own `service.ts`; cross-module calls go
   `service.ts → other module's service.ts` (direct in-process calls, no HTTP hops). The HTTP layer
   never talks to another module's aggregate directly.
2. **Env type.** Run `wrangler types` in `workers/gateway` and use the generated global `Env`:
   `type AppEnv = { Bindings: Env; Variables: RequestIdVariables & TimingVariables & { userId: string; deviceId: string } }`.
   Keep `@cloudflare/workers-types` only in `packages/core` (a library).
3. **Middleware order on the gateway** (registration order = execution order):
   `requestId({ headerName: '' })` (do not trust client-supplied ids; return ours in the header)
   → `timing({ crossOrigin: false })` (or drop in prod) → structured logger (custom `PrintFunc`
   that `console.log({ requestId, method, path, status, ms })` so Workers Logs indexes the fields)
   → `secureHeaders()` → `bodyLimit({ maxSize: 64 * 1024 })` on `/v1/*` → `cors()` on `/v1/*` only
   if a web build calls the API cross-origin (the Expo web build is served from the same Worker, so
   likely unnecessary) → per-module `.use(requireUser)` inside the module app (feed read can stay
   public; hints/wallet/wheel/play must be authenticated).
4. **Validation convention.** One helper `v = (target, schema) => zValidator(target, schema, hook)`
   is tempting but it fights the generic signature; instead export a single shared `hook` from
   `http/validation.ts` and pass it explicitly (`zValidator('json', HintBody, hook)`). The hook
   returns `c.json({ error: { code: 'invalid_request', issues: z.flattenError(result.error), target: result.target } }, 400)`.
   Rationale: without a hook, the raw `ZodSafeParseError` becomes the public 400 body **and** the
   RPC-typed failure shape. Schemas live next to the module (`modules/<m>/schemas.ts`) and are
   re-exported to `packages/shared` only when the app needs them at runtime (rare with `hc`).
5. **Error envelope.** `{ error: { code, message?, issues?, requestId } }`. `app.onError` maps:
   `HTTPException` → its status; `ZodError` (thrown outside validators) → 400; `err.name ===
   'DomainError'` → 422 (rule violations from aggregates: "insufficient tokens", "wheel already
   spun today"); `'NotInitializedError'` → 404; everything else → 500 + `console.error({...})`.
   Handlers that need a typed 4xx for the client return `c.json({ error: { code: 'x' } }, 4xx)`.
6. **RPC client packaging.** Add `packages/api-client` with `src/index.ts`:
   `export type { AppType } from '@crosscut/gateway/types'` is **not** the way (would drag Worker
   source into the app). Instead: gateway `tsc -p tsconfig.types.json` (`declaration`,
   `emitDeclarationOnly`, `outDir dist/types`) as a Turborepo task the client package
   `dependsOn`; `packages/api-client` imports `type AppType` from that `.d.ts` and exports
   `hcWithType` and `InferResponseType` aliases for TanStack Query. Both tsconfigs `strict: true`.
7. **Auth.** No `bearerAuth()` (it compares against static tokens); write `requireUser` with
   `factory.createMiddleware` that reads `Authorization: Bearer <session>` + `X-Device-Id`,
   verifies via the auth module (Better Auth session lookup, or anonymous device session for
   "Player-7F3A"), throws `HTTPException(401)`, and `c.set('userId')`.
8. **404/405.** `app.notFound` JSON envelope; consider Hono 4.13's Method-Not-Allowed middleware
   later: `import { methodNotAllowed } from 'hono/method-not-allowed'` (subpath confirmed in
   `npm view hono@4.13.5 exports`; docs at
   https://hono.dev/docs/middleware/builtin/method-not-allowed). Note it is constructed as
   `methodNotAllowed({ app })` — it takes the Hono instance so it can compute the `Allow` header. Set `strict: false` via
   `createFactory({ defaultAppOptions: { strict: false } })` so `/v1/feed/` ≠ 404 surprises.
9. **Testing.** Use `@cloudflare/vitest-plugin` 1.1.3 from day one (run the codemod on the copied
   `packages/core` so `vitest.config.ts`, `env.d.ts`/tsconfig `types`, and any `SELF` usage are
   updated). Two tiers per module: (a) `app.request(path, init, env)` handler tests with real
   bindings from `cloudflare:workers`, (b) `exports.default.fetch` end-to-end tests through
   middleware, aggregates and D1 (`readD1Migrations` + `applyD1Migrations` in `setup.ts`). Keep
   the `onUnhandledError` filter from the template's `vitest.config.ts`.
10. **OpenAPI.** Skip in phase 1. If needed for partners/admin tooling, add `hono-openapi`
    `describeRoute` + `resolver` to the routes you want documented and switch those routes'
    validators to `hono-openapi`'s `validator` (Standard Schema; same `c.req.valid`) — it keeps
    plain `Hono`, chained routes and `hc` intact. Choose `@hono/zod-openapi` only if you want the
    spec to be the source of truth for every route from the start.

## Code sketches

All sketches are the exact shapes that passed `tsc` (TS 7.0.2) and ran in workerd.

```ts
// http/factory.ts
import { createFactory } from "hono/factory";
import type { RequestIdVariables } from "hono/request-id";
import type { TimingVariables } from "hono/timing";
export type AppEnv = {
  Bindings: Env; // from `wrangler types` (worker-configuration.d.ts)
  Variables: RequestIdVariables & TimingVariables & { userId: string };
};
export const factory = createFactory<AppEnv>({ defaultAppOptions: { strict: false } });
```

```ts
// http/auth.ts
import { HTTPException } from "hono/http-exception";
import { factory } from "./factory";
export const requireUser = factory.createMiddleware(async (c, next) => {
  const h = c.req.header("authorization");
  if (!h?.startsWith("Bearer ")) throw new HTTPException(401, { message: "Missing bearer token" });
  const userId = await verifySession(c.env, h.slice(7)); // your auth module
  if (!userId) throw new HTTPException(401, { message: "Invalid session" });
  c.set("userId", userId);
  await next();
});
```

```ts
// http/validation.ts — one hook, reused by every zValidator
import type { Hook } from "@hono/zod-validator";
import * as z from "zod";
export const hook: Hook<unknown, AppEnv, string> = (result, c) => {
  if (!result.success) {
    return c.json(
      { error: { code: "invalid_request", target: result.target, issues: z.flattenError(result.error) } },
      400,
    );
  }
};
```

```ts
// modules/hints/routes.ts — chained sub-app, module-local schemas
import { zValidator } from "@hono/zod-validator";
import * as z from "zod";
import { factory } from "../../http/factory";
import { requireUser } from "../../http/auth";
import { hook } from "../../http/validation";
import { buyHint } from "./service";

const HintBody = z.object({ puzzleId: z.string().min(1), kind: z.enum(["fifty", "letter", "word"]) });

export const hints = factory
  .createApp()
  .use(requireUser)
  .post("/", zValidator("json", HintBody, hook), async (c) => {
    const { puzzleId, kind } = c.req.valid("json");
    const r = await buyHint(c.env, c.get("userId"), puzzleId, kind); // throws DomainError over RPC
    return c.json({ ok: true as const, cost: r.cost, balance: r.balance, payload: r.payload }, 200);
  });
```

```ts
// http/errors.ts
import { HTTPException } from "hono/http-exception";
import type { ErrorHandler, NotFoundHandler } from "hono";
import * as z from "zod";
export const notFound: NotFoundHandler<AppEnv> = (c) =>
  c.json({ error: { code: "not_found", message: `No route for ${c.req.method} ${c.req.path}` } }, 404);
export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get("requestId");
  if (err instanceof HTTPException) return err.res ?? c.json({ error: { code: "http_error", message: err.message, requestId } }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: { code: "invalid_request", issues: z.flattenError(err), requestId } }, 400);
  if (err.name === "DomainError") return c.json({ error: { code: "domain_error", message: err.message, requestId } }, 422); // RPC keeps name+message only
  if (err.name === "NotInitializedError") return c.json({ error: { code: "not_found", message: err.message, requestId } }, 404);
  console.error({ requestId, name: err.name, message: err.message, stack: err.stack });
  return c.json({ error: { code: "internal", message: "Internal Server Error", requestId } }, 500);
};
```

```ts
// http/app.ts — the only place modules are wired together
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { timing } from "hono/timing";
import { bodyLimit } from "hono/body-limit";
import { factory } from "./factory";
import { notFound, onError } from "./errors";
import { feed } from "../modules/feed/routes";
import { hints } from "../modules/hints/routes";

export const app = factory.createApp();
app.use(requestId({ headerName: "" }));           // never trust an inbound id
app.use(timing());
app.use(logger((msg, ...rest) => console.log({ msg, rest })));
app.use(secureHeaders());
app.use("/v1/*", bodyLimit({ maxSize: 64 * 1024 }));
app.use("/v1/*", cors({ origin: (o) => o, allowHeaders: ["Authorization", "Content-Type"], exposeHeaders: ["X-Request-Id"], maxAge: 600 }));
app.notFound(notFound);
app.onError(onError);

export const routes = app.basePath("/v1").route("/feed", feed).route("/hints", hints);
export type AppType = typeof routes;
```

```ts
// packages/api-client/src/index.ts — consumes the Worker's emitted .d.ts, not its source
import { hc } from "hono/client";
import type { InferResponseType } from "hono/client";
import type { AppType } from "@crosscut/gateway/dist/types/http/app"; // emitted by `tsc --emitDeclarationOnly`
export type Client = ReturnType<typeof hc<AppType>>;
export const hcWithType = (...args: Parameters<typeof hc>): Client => hc<AppType>(...args);
export type Feed = InferResponseType<Client["v1"]["feed"]["$get"], 200>;
```

```ts
// Expo app usage — status narrowing is what makes the 400/404 bodies typed
const api = hcWithType(process.env.EXPO_PUBLIC_API_URL!, { headers: () => ({ Authorization: `Bearer ${token}` }) });
const r = await api.v1.hints.$post({ json: { puzzleId: "mini1", kind: "letter" } });
if (r.status === 200) { const { balance } = await r.json(); }
else if (r.status === 400) { const { error } = await r.json(); /* error.issues.fieldErrors */ }
```

```ts
// test/hints.test.ts — @cloudflare/vitest-plugin 1.1.3
import { env, exports } from "cloudflare:workers";
import { app } from "../src/http/app";
it("handler-level", async () => {
  const res = await app.request("/v1/hints", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: "{}" }, env);
  expect(res.status).toBe(400);
});
it("end-to-end through the Worker", async () => {
  const res = await exports.default.fetch("http://x/v1/hints", { method: "POST" });
  expect(res.status).toBe(401);
  expect(res.headers.get("x-request-id")).toBeTruthy();
});
```

```ts
// vitest.config.ts (gateway)
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
  }))],
  test: { setupFiles: ["./test/setup.ts"] },
});
```

```ts
// Optional later: hono-openapi on a documented route (plain Hono stays)
import { describeRoute, resolver, validator, openAPIRouteHandler } from "hono-openapi";
const Wallet = z.object({ tokens: z.number().int(), stars: z.number().int() }).meta({ ref: "Wallet" });
wallet.get("/", describeRoute({ responses: { 200: { description: "ok", content: { "application/json": { schema: resolver(Wallet) } } } } }),
  validator("query", z.object({ v: z.string().optional() })), (c) => c.json({ tokens: 269, stars: 1284 }, 200));
app.get("/openapi.json", openAPIRouteHandler(routes, { documentation: { info: { title: "Crosscut", version: "1" } } }));
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | hono 4.13.5 (2026-08-26) is latest; 4.13.0 added QUERY method support, Method-Not-Allowed middleware and JSON-route speedups; 4.13.1–4.13.5 are fixes | https://github.com/honojs/hono/releases ; `npm view hono time` | high | confirmed |
| C2 | `hono/factory` exports `createFactory<Env>({ initApp?, defaultAppOptions? })` with `createApp`, `createMiddleware`, `createHandlers`; sub-apps from `factory.createApp()` inherit Bindings/Variables | https://hono.dev/docs/helpers/factory ; `dist/types/helper/factory/index.d.ts`; verified locally | high | confirmed |
| C3 | Hono best practice: no controllers; `app.route()` per module; chain routes and `export type AppType = typeof routes` for RPC | https://hono.dev/docs/guides/best-practices ; https://hono.dev/docs/guides/rpc | high | confirmed |
| C4 | `@hono/zod-validator` 0.9.1 peers: `zod ^3.25.0 \|\| ^4.0.0`, `hono >=4.11.2`; app code imports `import * as z from "zod"` (no `zod/v4` needed). Mechanism corrected: runtime `dist/index.mjs` imports only `hono/validator` and calls `safeParseAsync`; `zod/v3`, `zod/v4`, `zod/v4/core` appear only in the `.d.mts`/`.d.ts` type files | `npm view @hono/zod-validator@0.9.1 peerDependencies`; README; published tarball `dist/index.mjs` + `dist/index.d.mts` | high | confirmed |
| C5 | zValidator hook signature is `(result: {success,data,error?,target}, c) => Response \| void \| Promise<…>`; since 0.8.0 the default 400 failure body is part of the route's RPC response type | `dist/index.d.mts` 0.9.1; CHANGELOG 0.8.0; verified locally (TS2339 without narrowing) | high | confirmed |
| C6 | zod 4.x: root `"zod"` is Zod 4; `"zod/v4"` remains as a permanent alias; use `z.flattenError`/`z.treeifyError`; `error.flatten()`/`error.format()` deprecated | https://zod.dev/v4/versioning ; https://zod.dev/error-formatting ; `npm view zod@4.5.4 exports` | high | confirmed |
| C7 | `HTTPException` (`hono/http-exception`) takes `(status?, { message?, res?, cause? })`, exposes `status`, `res`, `getResponse()`; route-level `onError` takes priority over the parent's | https://hono.dev/docs/api/exception ; https://hono.dev/docs/api/hono ; `dist/types/http-exception.d.ts` | high | confirmed |
| C8 | Workers RPC errors preserve only `message` and the prototype `name`; no stack, no `cause`, no own properties; `AggregateError`/`SuppressedError` not propagated | https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ | high | confirmed |
| C9 | `c.json(data, status)` is typed `Response & TypedResponse<JSONParsed<T>, Status, 'json'>`; explicit status literals give `hc` discriminated unions; `c.notFound()` is untyped for RPC; promise chains lose types | `dist/types/context.d.ts`; https://hono.dev/docs/guides/rpc | high | confirmed |
| C10 | Built-in middleware import paths and options: `hono/cors`, `hono/logger`, `hono/request-id` (`RequestIdVariables`, honours inbound `X-Request-Id` unless `headerName:''`), `hono/secure-headers`, `hono/timing`, `hono/bearer-auth` (`verifyToken(token,c)`), `hono/combine` (`some/every/except`), `hono/body-limit` | hono.dev middleware pages cited in F5; `npm view hono@4.13.5 exports` | high | confirmed |
| C11 | `hc<AppType>` from `hono/client`; `options.fetch` override; `InferRequestType`/`InferResponseType`; both tsconfigs need `strict: true`; recommended `hcWithType` pattern for IDE performance | https://hono.dev/docs/guides/rpc | high | confirmed |
| C12 | Measured (TS 7.0.2, 120 routes): consumer type-check from source 1.37 M instantiations/0.225 s vs 0.19 M/0.059 s from emitted `.d.ts`; emitted `app.d.ts` ≈ 160 KB. Fact-check: instantiation counts and the 160 KB size reproduce; absolute timings do not (re-run: 0.498 s / 0.147 s); the 0.97 M server-side figure could not be re-run because `bench/tsconfig.server.json` fails with TS6059 | local benchmark in scratchpad `honocheck/bench`; re-run 2026-09-02 | medium | confirmed |
| C13 | Cloudflare renamed `@cloudflare/vitest-pool-workers` to `@cloudflare/vitest-plugin` (v1) on 2026-08-19; config API unchanged; codemod `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`; types entry `@cloudflare/vitest-plugin/types` | https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ ; migration guide URL in F7 | high | confirmed |
| C14 | ~~`SELF` from `cloudflare:test` is removed in the plugin~~ **Corrected: `SELF` is deprecated (still exported) in the plugin; prefer `exports.default.fetch()`.** 1.1.3's `types/cloudflare-test.d.ts` still declares `SELF: Fetcher` (and `env`) with `@deprecated`, and `dist/worker/lib/cloudflare/test.mjs` still re-exports `SELF` as a Proxy over `exports.default`; it is undocumented on the Test APIs page, and `exports` does not expose Assets (use `startDevWorker()`). The rest holds: `import { env, exports } from "cloudflare:workers"`, Vitest ≥ 4.1, 0.22.0 types carry the same `@deprecated` tags | `@cloudflare/vitest-plugin@1.1.3` tarball `types/cloudflare-test.d.ts` and `dist/worker/lib/cloudflare/test.mjs`; https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ ; https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ | high (as corrected) | refuted |
| C15 | `exports.default` only type-checks after `wrangler types` generates `worker-configuration.d.ts` (`Cloudflare.Exports`); `@cloudflare/workers-types` alone yields TS2339 | verified locally; https://developers.cloudflare.com/workers/languages/typescript/ | high | confirmed |
| C16 | `app.request(path, init, env)` accepts bindings as 3rd argument; `testClient(app, env)` from `hono/testing` gives a typed client for chained routes | https://hono.dev/docs/guides/testing ; https://hono.dev/docs/helpers/testing ; verified locally | high | confirmed |
| C17 | `@hono/zod-openapi` 1.6.2 is zod-4-only (peer `zod ^4.0.0`, `hono >=4.10.0`), depends on `@asteasolutions/zod-to-openapi ^9.1`; `z` must be imported from the package; `defaultHook` inherited via `app.route()` since 1.5.0; `defineOpenAPIRoute`/`openapiRoutes` since 1.3.0; `doc31()` emits 3.1 | `npm view`; CHANGELOG; README; verified locally | high | confirmed |
| C18 | `hono-openapi` 1.3.1 works with zod 4 without `zod-openapi`: converts via native `zod/v4/core` `toJSONSchema` when `"_zod" in schema`; `zod-openapi@4` needed only for zod 3; exports `describeRoute`, `describeResponse`, `resolver`, `validator`, `openAPIRouteHandler`, `generateSpecs` | published dist of `@standard-community/standard-json` 0.3.5 and `standard-openapi` 0.2.9; https://honohub.dev/docs/openapi/zod ; verified locally | high | confirmed |
| C19 | `hono-openapi` 1.3.1 declares optional peer `@hono/standard-validator ^0.2.0` while current is 0.4.0; 0.4.0 worked at runtime and type-level in the scratch test | `npm view hono-openapi@1.3.1 peerDependencies`; local run | medium | confirmed |
| C20 | Hono docs' Cloudflare Workers page still recommends `@cloudflare/vitest-pool-workers` (stale vs Cloudflare's rename) | https://hono.dev/docs/getting-started/cloudflare-workers | high | confirmed |
| C21 | Workers Logs indexes fields of objects passed to `console.log`; enable with `observability.enabled: true`. Limits added by fact-check: 256 KB per log entry (truncated) and 5 billion logs/account/day | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ | high | confirmed |
| C22 | Hono 4.13.5 + zod 4.5.4 + both validator/openapi packages type-check under TypeScript 7.0.2 (native) with `moduleResolution: Bundler` | local `tsc --noEmit` run | high | confirmed |
| C23 | Hono 4.13's Method-Not-Allowed middleware import path is `hono/method-not-allowed`; usage `methodNotAllowed({ app })` (takes the Hono instance to compute `Allow`) | `npm view hono@4.13.5 exports` (subpath present — an earlier draft of F1's list omitted it); https://hono.dev/docs/middleware/builtin/method-not-allowed | high | confirmed |
| C24 | ~~`@cloudflare/vitest-plugin/config` subpath (mentioned in Cloudflare configuration docs for `readD1Migrations`) exists~~ **Corrected: `/config` does not resolve; import `readD1Migrations` from `@cloudflare/vitest-plugin`.** 1.1.3 `package.json` `exports` is exactly `{ ".": { types, import }, "./types": { types } }`; `readD1Migrations` is exported from the root (`dist/pool/index.d.mts`). The configuration page is internally inconsistent (its example imports from the root; its API section says "Exported from @cloudflare/vitest-plugin/config") | `npm view @cloudflare/vitest-plugin@1.1.3 exports`; tarball `dist/pool/index.d.mts`; https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ | high (as corrected) | refuted |

## Open questions

1. **`@cloudflare/vitest-plugin/config`** — resolved (C24 refuted): Cloudflare's configuration
   page says `readD1Migrations` is exported from `@cloudflare/vitest-plugin/config`, but 1.1.3's
   export map is exactly `.` and `./types`, and the root export contains `readD1Migrations`. Use the
   root import (as the `packages/core` template already does); `/config` does not resolve.
2. **Precision of `Cloudflare.Exports`** — resolved by fact-check, no open question remains. The
   `type Exports = Record<string, ExportValue>` seen in the scratch project was `WebAssembly.Exports`
   (line ~245 of `worker-configuration.d.ts`), misread as `Cloudflare.Exports`. The real
   `Cloudflare.Exports` (line ~13649) maps each key of `Cloudflare.GlobalProps.mainModule` through
   `LoopbackForExport<…>` (plus `DurableObjectNamespace` for classes listed in `durableNamespaces`),
   and wrangler 4.128 already emits `interface GlobalProps { mainModule: typeof import("./src/index") }`.
   Per-entrypoint typing of `exports.User` / `exports.Projections` therefore works today with no
   extra flag; `runInDurableObject` / `env.USER` typing from `Env` is unaffected.
3. **Method-Not-Allowed middleware**: import path resolved (C23 confirmed:
   `hono/method-not-allowed`, constructed as `methodNotAllowed({ app })`); its interaction with
   `app.notFound` ordering was not tested. Not needed for phase 1.
4. **`hono-openapi` peer drift** (`@hono/standard-validator ^0.2.0` vs 0.4.0): works today; if
   pnpm 11's peer checks become strict in CI, pin `@hono/standard-validator@0.2.x` or add a
   `pnpm.overrides`-equivalent (pnpm 11 moved these keys to `pnpm-workspace.yaml`).
5. **TypeScript 7 in editors**: the benchmark is `tsc`; tsserver behaviour in VS Code with TS 7
   on a 100+-route `AppType` was not measured. The `.d.ts` hand-off keeps the app's editor
   session independent either way.
6. **`requestId` and mobile correlation**: with `headerName: ''` the client cannot propagate its
   own id; if the Expo app wants client-generated trace ids, accept a separate validated header
   (e.g. `X-Client-Trace`, UUID regex) rather than trusting `X-Request-Id`.
7. **Secure headers on a JSON API**: `secureHeaders()` sets HSTS `max-age=15552000` and
   `Cross-Origin-Resource-Policy: same-origin`; confirm CORP does not block the Expo web build if
   it is ever served from a different origin than the API (same Worker → fine).
8. **zod 4 JSON-schema noise** in `hono-openapi` (`.int()` → `minimum/maximum` ±2^53-1): cosmetic;
   `resolver(schema, options)` accepts custom `toJSONSchema` options — exact option names UNVERIFIED.

## Fact-check log

Fact-check performed 2026-09-02 against npm metadata, published tarballs and the cited docs pages.
22 claims confirmed, 2 refuted (C14, C24), 0 unverifiable. Corrections have been applied in place
in the Summary, F1, F2, F3, F4, F6, F7, F8, Recommendation #8, the Claims table and Open questions.

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://github.com/honojs/hono/releases ; `npm view hono time` |
| C2 | confirmed | https://hono.dev/docs/helpers/factory ; `dist/types/helper/factory/index.d.ts` (4.13.5) |
| C3 | confirmed | https://hono.dev/docs/guides/best-practices ; https://hono.dev/docs/guides/rpc (page exports `typeof app`; equivalent to `typeof routes` only for the chained expression) |
| C4 | confirmed | `npm view @hono/zod-validator@0.9.1 peerDependencies`; tarball `dist/index.mjs` (runtime imports only `hono/validator`; zod subpaths only in `.d.mts`/`.d.ts`) |
| C5 | confirmed | `dist/index.d.mts` 0.9.1; CHANGELOG 0.8.0 |
| C6 | confirmed | https://zod.dev/v4/versioning ; https://zod.dev/error-formatting ; `npm view zod@4.5.4 exports` |
| C7 | confirmed | https://hono.dev/docs/api/exception ; https://hono.dev/docs/api/hono ; `dist/types/http-exception.d.ts` |
| C8 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ |
| C9 | confirmed | `dist/types/context.d.ts` (4.13.5); https://hono.dev/docs/guides/rpc |
| C10 | confirmed | hono.dev built-in middleware pages; `npm view hono@4.13.5 exports` |
| C11 | confirmed | https://hono.dev/docs/guides/rpc |
| C12 | confirmed | local benchmark `honocheck/bench` (instantiation counts and 160 KB `.d.ts` reproduce; absolute timings do not — 0.498 s / 0.147 s on re-run; server tsconfig fails TS6059) |
| C13 | confirmed | https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ ; migration guide |
| C14 | **refuted** | `@cloudflare/vitest-plugin@1.1.3` tarball `types/cloudflare-test.d.ts` and `dist/worker/lib/cloudflare/test.mjs` (`SELF` still exported, `@deprecated`); https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ ; https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ |
| C15 | confirmed | local run; https://developers.cloudflare.com/workers/languages/typescript/ ; generated `worker-configuration.d.ts` (`Cloudflare.GlobalProps.mainModule` → `Cloudflare.Exports`) |
| C16 | confirmed | https://hono.dev/docs/guides/testing ; https://hono.dev/docs/helpers/testing |
| C17 | confirmed | `npm view @hono/zod-openapi@1.6.2`; CHANGELOG; README |
| C18 | confirmed | `@standard-community/standard-json` 0.3.5 and `standard-openapi` 0.2.9 dist; https://honohub.dev/docs/openapi/zod |
| C19 | confirmed | `npm view hono-openapi@1.3.1 peerDependencies`; local run |
| C20 | confirmed | https://hono.dev/docs/getting-started/cloudflare-workers |
| C21 | confirmed | https://developers.cloudflare.com/workers/observability/logs/workers-logs/ (limits: 256 KB/entry, 5 billion logs/account/day) |
| C22 | confirmed | local `tsc --noEmit` run, TypeScript 7.0.2 |
| C23 | confirmed | `npm view hono@4.13.5 exports` (`./method-not-allowed` present); https://hono.dev/docs/middleware/builtin/method-not-allowed |
| C24 | **refuted** | `npm view @cloudflare/vitest-plugin@1.1.3 exports` (only `.` and `./types`); tarball `dist/pool/index.d.mts`; https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ |

Other corrections applied from the fact-check: `@cloudflare/vitest-plugin` 1.1.3 declares three
peers (`vitest`, `@vitest/runner`, `@vitest/snapshot`, all `^4.1.0`); `hono/method-not-allowed`
added to F1's export list; F2 citations for `strict` default (Hono API page) and HEAD-from-GET
(`hono-base.js` source) corrected; `Cloudflare.GlobalProps` self-augmentation noted as an
alternative to `wrangler types`; pnpm 11.24.0 flagged as a local pin (latest 11.25.0);
`hono-openapi` peer-dep guidance noted as npm-derived rather than README-derived.
