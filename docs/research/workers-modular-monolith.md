# Single-Worker modular monolith structure (Crosscut backend)

Research date: 2026-09-02. Stack under consideration: wrangler 4.128.0 (npm latest; installed in IOSApp: 4.124.0 / 4.127.1), hono 4.13.5, zod 4.5.4, TypeScript 7.0.2, @cloudflare/workers-types 5.20260902.1 (npm latest; installed in IOSApp: 5.20260901.1, which is what F2/F4 cite), vitest 4.1.11, pnpm 11.24.0 (installed; npm latest is 11.25.0), Node 26.8.1. Every API/config/version claim below was checked against a primary source (Cloudflare docs, Cloudflare changelog, workers-sdk changelog, npm registry, installed type definitions) unless explicitly marked **UNVERIFIED**. A first fact-check pass confirmed C1-C23 and C25-C27 and **refuted C24** (the S6 Biome config as originally written); the affected sections (F3, F8, R7, S4, S6) were corrected in place. A second pass (see "Fact-check log" at the end) confirmed all of C1-C27 against the corrected text — no claim refuted, none unverifiable — and tightened F3/C7/C8 (RPC error `name`/`.remote` behaviour: observed vs documented), F6/C16 (peer dependencies, "code had hung" noise), S3 (`Env` typing), S4 (`noUnusedLocals`), S8 and C24/C25 (now executed).

## Summary

- **Ship one Worker (`workers/gateway`) that exports: a default Hono `fetch` handler, the Durable Object aggregate classes, and a handful of named `WorkerEntrypoint` classes.** Inside the Worker, modules are plain TypeScript folders with one public `index.ts`. Cross-module calls are ordinary function calls; domain events are a typed, in-process dispatcher (a table of subscriber functions wired in the composition root) with no queue and no pub/sub infrastructure.
- **Use Workers RPC only at real seams:** Durable Objects (aggregates) and the few modules that are plausible future split candidates (`Projections`, `Notifications`, later `Leaderboards`). Everything else stays a direct import. RPC is not free: values must be structured-clone-able (class instances are not), errors arrive as `Error` with only `name` and `message`, stubs need disposal, and each service-binding call counts toward the 32-invocations-per-request cap.
- **`ctx.exports` (loopback bindings) is on by default for compatibility dates >= 2025-11-17** and gives a service-binding stub for every exported `WorkerEntrypoint` and a namespace for every exported Durable Object with configured storage, without wrangler config. Use it, but hide it behind one `resolveModules(env, ctx)` function so a module can later move to another Worker by adding a `services`/`script_name` binding, with zero changes in callers.
- **Boundary enforcement must not depend on the TypeScript JS API: TypeScript 7.0 ships no programmatic API** (it lands in 7.1), so `typescript-eslint` (peer `<6.1.0`) and `dependency-cruiser` (announced: first supported TS 7 is 7.1) cannot parse `.ts` files against `typescript@7.0.2`. Recommendation: enforce module boundaries with **Biome `noRestrictedImports`** (or oxlint `no-restricted-imports`) which parse TypeScript natively, plus TS path aliases so "deep imports" are syntactically recognisable. Keep dependency-cruiser as a later add-on (once TS 7.1 has an API, or via a `typescript@6` alias in a tools package).
- **Splitting a module out later is a supported, documented path:** named entrypoint -> `services: [{ binding, service, entrypoint }]`; Durable Objects -> `durable_objects.bindings[].script_name` and, for moving existing object storage, the declarative `exports` config states `transferred` / `expecting-transfer`; local dev of both Workers with `wrangler dev -c a -c b`; types with `wrangler types -c a -c b`.
- **Testing:** the Vitest integration has been renamed `@cloudflare/vitest-plugin` (1.x, current 1.1.3; `@cloudflare/vitest-pool-workers` 0.22.0 is the pre-rename package with the same `cloudflareTest` plugin API). `ctx.exports` works in tests since pool 0.11.0 (`additionalExports` covers exports the esbuild scan cannot infer).

## Findings

### F1. Named `WorkerEntrypoint` classes and how to bind to them
- A Worker file may export several classes extending `WorkerEntrypoint` next to the default export. A binding targets one with the `entrypoint` field: `services: [{ "binding": "ADMIN", "service": "todo-app", "entrypoint": "AdminEntrypoint" }]`; omitting `entrypoint` binds the default export. `this.env` and `this.ctx` are available inside the class.
  Source: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/ and https://developers.cloudflare.com/workers/wrangler/configuration/ (services: `binding`, `service`, `entrypoint`).
- Service bindings run the target Worker "on the same thread of the same Cloudflare server" with "zero overhead or added latency", but there is a **limit of 32 Worker invocations per request**, each service-binding call counts toward it, and each call counts toward subrequest limits.
  Source: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/

### F2. `ctx.exports` loopback bindings
- `ctx.exports` contains "automatically-configured loopback bindings for all of your top-level exports": a Service Binding for each export extending `WorkerEntrypoint` (or implementing a fetch handler) and a Durable Object namespace for each `DurableObject` export **whose storage has been configured via a migration** (the runtime context page still says "migration"; with the S1 config — declarative `exports`, no `migrations` — the equivalence rests on the vitest-plugin CHANGELOG 0.18.0 and the wrangler configuration page, which document `exports` as the replacement that populates the same DO namespaces). Loopback bindings can be called with `ctx.exports.Greeter({ props: {...} })` to set the callee's `ctx.props` because "the caller is the same Worker, and thus can be presumed to be trusted" — this `props` statement is on the context page, not in the changelog. `wrangler types` generates the types; declare entrypoints as `extends WorkerEntrypoint<Env, Props>`.
  Source: https://developers.cloudflare.com/workers/runtime-apis/context/ (props, DO namespaces); announcement: https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ (introduces the feature; says only that it "will be on by default in the future" — the 2025-11-17 default date is on the compatibility-flags page, see next bullet); https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-plugin/CHANGELOG.md (0.18.0) and https://developers.cloudflare.com/workers/wrangler/configuration/ for `exports` as the migration equivalent. (Fact-check: citation attribution corrected.)
- Compatibility flag `enable_ctx_exports` (disable: `disable_ctx_exports`), **default on for compatibility dates >= 2025-11-17**. Related: `rpc` (default 2024-04-03) and `rpc_params_dup_stubs` (default 2026-01-20: stubs embedded in RPC params are duplicated instead of transferred).
  Source: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- `DurableObjectState.exports` exists and "has exactly the same meaning as ExecutionContext's ctx.exports", so an aggregate can reach `Projections` via `this.ctx.exports.Projections` (this is what `packages/core/src/aggregate.ts` does and what its 8 workerd tests exercise).
  Source: https://developers.cloudflare.com/durable-objects/api/state/ ; local: /Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts (`resolveProjections()`), /Users/peter/Projects/IOSApp/packages/core/test/wrangler.jsonc
- Typing: `@cloudflare/workers-types` 5.20260901.1 defines `ExecutionContext.exports: Cloudflare.Exports`, where `Cloudflare.Exports` is derived from `Cloudflare.GlobalProps.mainModule` (`typeof import("my-main-module")`) and `durableNamespaces` (union of DO export names). `wrangler types` populates `Cloudflare.GlobalProps.durableNamespaces` from the `exports`/migrations config (vitest-pool-workers changelog 0.18.0: "`wrangler types` is also aware of `exports`. Live entries ... are added to `Cloudflare.GlobalProps.durableNamespaces`, which types `ctx.exports.X`").
  Source: installed file /Users/peter/Projects/IOSApp/node_modules/.pnpm/@cloudflare+workers-types@5.20260901.1/node_modules/@cloudflare/workers-types/index.d.ts (lines ~496, ~15552-15600); https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-plugin/CHANGELOG.md (0.18.0)

### F3. Workers RPC constraints (what crosses the boundary)
- Serializable: structured-clone types (plain objects, arrays, strings, numbers, Dates...), plus functions (become stubs), classes extending `RpcTarget` (become a single stub; properties are fetched asynchronously), byte-oriented `ReadableStream`/`WritableStream`, `Request`/`Response`, and other RPC stubs. **Application classes that do not extend `RpcTarget` cannot be passed.** Max serialized RPC size 32 MiB. Stream ownership transfers to the recipient. Smart Placement is ignored for RPC.
  Source: https://developers.cloudflare.com/workers/runtime-apis/rpc/ (`import { RpcTarget } from "cloudflare:workers"`)
- Errors: when an RPC method throws a standard `Error`, **only `message` and the prototype's `name` survive**; `stack`, `cause` and own properties are dropped; `AggregateError` and `SuppressedError` are not propagated. Throwing non-Error values is **not documented** on the error-handling page (second fact-check pass, raw page checked); empirically `throw "just a string"` from a `WorkerEntrypoint` method arrives at the caller as a generic `Error` with `name === "Error"` and `message === "just a string"`. The runtime may attach extra properties: `.remote: true` is added to errors thrown by **any** RPC method — `WorkerEntrypoint` loopback calls included, not only Durable Objects — and DO errors additionally carry `durableObjectId` (observed with workerd via `@cloudflare/vitest-plugin` 1.1.3; see DO errors below). Do not use `.remote` to tell DO errors apart from entrypoint errors. **Custom `Error` subclass names (fact-check, observed not documented):** the docs promise `name` retention only "If it is one of the standard JavaScript Error types", but empirically a custom `name` such as `DomainError` does survive — as an own `name` property on a plain `Error` (constructor `Error`), so `instanceof DomainError` is `false` on the caller side and only an `err.name === "DomainError"` check works (S8).
  Source: https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ ; empirical probe with workerd via @cloudflare/vitest-plugin 1.1.3 (loopback entrypoint and DO stub) — second fact-check pass
- Durable Object exceptions additionally carry `.retryable` (retry if idempotent), `.overloaded` (do not retry) and `.remote` (thrown from user code / infra inside the object; note `.remote` is *also* set on entrypoint RPC errors, F3 above, and DO errors additionally carry `durableObjectId` — observed). "Many exceptions leave the DurableObjectStub in a 'broken' state" — create a new stub after an exception.
  Source: https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
- Visibility: only prototype methods and class-level getters/setters are callable; arrow-function class fields, `#private` members and instance properties assigned in the constructor are never exposed. Security model is object-capability.
  Source: https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/
- Reserved names: `fetch` (HTTP only) and `connect` on entrypoints/DOs; `dup` and `constructor` on everything; `alarm`, `webSocketMessage`, `webSocketClose`, `webSocketError` on `WorkerEntrypoint`/`DurableObject` (allowed on `RpcTarget`).
  Source: https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/
- Lifecycle: stubs must be disposed (`using` declaration, Wrangler v4+ supports it natively; `Symbol.dispose` on `RpcTarget`); stubs are auto-disposed when the event handler completes (response sent), when an RPC method returns (unless the stub is in params/results), and stubs received as params are disposed when the call returns; `ctx.waitUntil()` extends that; `dup()` creates an independently disposable handle. Disposer exceptions do not propagate to the client.
  Source: https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
- Promise pipelining: RPC promises are custom thenables; omitting the intermediate `await` chains calls in one round trip; if the first call throws, pipelined calls fail with the same exception.
  Source: https://developers.cloudflare.com/workers/runtime-apis/rpc/
- TypeScript: `Service<T>` for entrypoint bindings, `DurableObjectNamespace<T>` for DO bindings; `wrangler types -c ./client/wrangler.jsonc -c ../sum-worker/wrangler.jsonc` emits `SUM_SERVICE: Service<import("../sum-worker/src/index").SumService>`; methods are rewritten to async stub types. In workers-types, `Rpc.Result<R>` maps a return type to `Promise<Stub<R>>` (stubable) or `Promise<Stubify<R> & MaybeDisposable<R>>` (serializable) and to `never` otherwise. **Caveat (fact-check):** `Serializable<R>` is structural, so a plain data class (`class Plainish { y = 2 }`) returned from an entrypoint method is *not* mapped to `never` — `ReturnType<Service<E>["plain"]>` stays a real type — even though such instances are rejected at runtime ("Classes which do not inherit RpcTarget cannot be sent over RPC at all"). The `never` collapse only trips on classes with `#private` fields or methods (via the async rewriting). So the type system does not catch the common "returned a DTO class" mistake; see R7 item 3 for what to do instead.
  Source: https://developers.cloudflare.com/workers/runtime-apis/rpc/typescript/ ; workers-types index.d.ts (`declare namespace Rpc`, `type Result<R>`); caveat verified with tsc 7.0.2 + @cloudflare/workers-types 5.20260902.1

### F4. Durable Object bindings, cross-Worker references, declarative `exports`
- `durable_objects.bindings[]`: `name`, `class_name`, optional `script_name` (class defined in another Worker) and `environment`. So a DO class can stay in Worker A while Worker B binds to it.
  Source: https://developers.cloudflare.com/workers/wrangler/configuration/
- The wrangler config now has a declarative top-level `exports` map keyed by DO class name: `{ "exports": { "MyDO": { "type": "durable-object", "storage": "sqlite" } } }`, with `state` values `created` (default), `deleted`, `renamed` (+`renamed_to`), `transferred` (+`transferred_to`), `expecting-transfer` (+`transfer_from`). "For new Workers, prefer the declarative exports field. migrations and exports are mutually exclusive." The installed wrangler 4.124 already contains the validation message "`migrations` and `exports` are mutually exclusive".
  Source: https://developers.cloudflare.com/workers/wrangler/configuration/ ; https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-plugin/CHANGELOG.md (0.18.0, PR #14382); local grep of wrangler-dist/cli.js
- DO stubs: `env.NS.getByName("foo")` (exists in workers-types 5.20260901.1 line ~660) or `idFromName` + `get`; "All RPC calls are asynchronous, accept and return serializable types, and propagate exceptions to the caller without a stack trace."
  Source: https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/

### F5. Local multi-Worker development
- `npx wrangler dev -c ./app/wrangler.jsonc -c ./api/wrangler.jsonc`: the first config is the primary Worker on `http://localhost:8787`; the others run as auxiliary Workers reachable via service bindings; Durable Object namespaces and Queues also work across them. The Vite plugin equivalent is `auxiliaryWorkers`.
  Source: https://developers.cloudflare.com/workers/development-testing/multi-workers/

### F6. Testing inside workerd
- The Vitest integration package was **renamed from `@cloudflare/vitest-pool-workers` to `@cloudflare/vitest-plugin` at 1.0.0** (PR #15074); codemod `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` rewrites imports and the `types` entry (`@cloudflare/vitest-plugin/types`). Current: `@cloudflare/vitest-plugin` 1.1.3, peers `vitest ^4.1.0`, `@vitest/runner ^4.1.0` and `@vitest/snapshot ^4.1.0` (all three matter under pnpm strict peer resolution). Docs' canonical config: `import { cloudflareTest } from "@cloudflare/vitest-plugin"; export default defineConfig({ plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })] })`. `@cloudflare/vitest-pool-workers` 0.22.0 still exists (same plugin API; it is what `packages/core` currently uses and passes 8/8 tests with). Note: those 8 passing tests emit workerd "The Workers runtime canceled this request because it detected that your Worker's code had hung" messages. Second fact-check pass: this is not specific to the simulated projection-failure cases — in a probe under `@cloudflare/vitest-plugin` 1.1.3 **every** RPC method that throws (entrypoint or DO, any error type) produced that message, so expect it for any throwing RPC path in tests; expect that noise when copying `core` into this repo — the `vitest.config.ts` `onUnhandledError` filter only suppresses the pool-wrapper duplicates, not the workerd messages themselves.
  Source: https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-plugin/CHANGELOG.md ; https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ ; `npm view @cloudflare/vitest-plugin version peerDependencies`
- `ctx.exports` in tests since pool 0.11.0: integration tests see real stubs in `SELF`'s `ctx.exports`; unit tests get `createExecutionContext().exports`; alternatively `import { exports } from "cloudflare:workers"`. Exports are inferred by an esbuild static scan; unresolvable ones (e.g. wildcard re-exports of virtual modules) go in the `additionalExports` plugin option.
  Source: https://developers.cloudflare.com/changelog/post/2025-12-16-vitest-ctx-exports-support/ ; CHANGELOG 0.11.0 (PR #11533)
- Auxiliary Workers in tests (`miniflare.workers`) cannot use TypeScript, cannot access `cloudflare:test`, and use standard module resolution — a reason to keep the monolith testable as a single `main` Worker.
  Source: https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/

### F7. Hono composition
- Sub-apps: `app.route('/book', book)`; `new Hono().basePath('/api')`. **Order matters**: `route()` copies the sub-app's routes at call time, so register a sub-app's routes before mounting it. For the typed client keep chaining: `const routes = app.route('/authors', authors).route('/books', books); export type AppType = typeof routes`; handlers must `async/await` (not `.then`) or the client infers `unknown`; for large apps split client types per sub-router to avoid instantiating all route types at once.
  Source: https://hono.dev/docs/api/routing ; https://hono.dev/docs/guides/rpc
- Workers export: `export default app` or `export default { fetch: app.fetch, scheduled: ... }`; bindings typed with `new Hono<{ Bindings: Env }>()`.
  Source: https://hono.dev/docs/getting-started/cloudflare-workers

### F8. TypeScript 7 and boundary-enforcement tooling
- `typescript@7.0.2` (npm `latest`) contains `bin/tsc` and, under `dist/api/**`, both an async and a sync **unstable** API: `package.json` `exports` maps `./unstable/async` and `./unstable/sync` to `dist/api/**/api.js`, and `.` to `lib/version.cjs`. There is **no `lib/typescript.js` and no stable `main`/`.` entry exposing a compiler API** — so the tarball is not literally API-less, but there is no stable JS compiler API for tools such as typescript-eslint or dependency-cruiser to consume, and the conclusion below stands. The 7.0 announcement: "TypeScript 7.0 ... does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API." Microsoft's interim advice is to alias `@typescript/typescript6` for tools that need the old API. Note that `@typescript/typescript6@6.0.2` is a **shim**: its `lib/typescript.js` is `module.exports = require("@typescript/old")`, which resolves to `typescript@6.0.3`, so tools report 6.0.3 (not 6.0.2); pin/lockfile notes should say so. `typescript@6.0.3` (published after 6.0.2) is the last JS release; `typescript@7.1.0-dev.*` nightlies exist, no 7.1 stable yet.
  Source: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ ; `npm pack typescript@7.0.2 --dry-run` and the tarball's `package.json` `exports`; `npm view typescript dist-tags`; `npm view @typescript/typescript6 version` and its `lib/typescript.js` (fact-check pass)
- `typescript-eslint` / `@typescript-eslint/parser` 8.69.0 declare peer `typescript: ">=4.8.4 <6.1.0"`; issue #10940 (TS 7 / tsgo support) is open, labelled "blocked by external API". => **ESLint + eslint-plugin-boundaries (7.2.0) cannot parse `.ts` under TS 7.0** unless a TS 6 API package is present. Precision (fact-check): eslint-plugin-boundaries declares only `eslint >=6.0.0` as a peer dependency and does **not** require `@typescript-eslint/parser`; the blocker is practical, not declared — ESLint needs a TypeScript-capable parser to lint `.ts`, and `@typescript-eslint/parser` (peer `<6.1.0`) is the standard one.
  Source: `npm view typescript-eslint peerDependencies`; `npm view eslint-plugin-boundaries peerDependencies`; https://github.com/typescript-eslint/typescript-eslint/issues/10940 ; https://github.com/javierbrea/eslint-plugin-boundaries
- `dependency-cruiser` 18.2.0: parser `tsc` "only work[s] when the compiler ... `typescript` [is] installed in the same spot"; `swc` parser deprecated; release notes 18.1.0: "typescript@7.1.0 is expected to ship with a public API - so that's the first version in the TypeScript 7 ... range dependency-cruiser will be able to support." Its rules support capture groups: `from.path: "^src/modules/([^/]+)/.+"`, `to.pathNot: "^src/modules/$1/.+"` — the exact "no cross-module internals" rule.
  Source: https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md ; https://github.com/sverweij/dependency-cruiser/releases ; https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md
- Biome 2.5.11 `noRestrictedImports`: `paths` and gitignore-style `patterns[].group` with negation (since 2.2.0), `importNamePattern`; Biome parses TypeScript itself. oxlint 1.81.0 implements `no-restricted-imports` with `paths` and `patterns` (`group` globs, `regex`). The oxc.rs statement that oxlint "leverages the native Go port of the TypeScript compiler (tsgo aka TypeScript 7)" concerns **type-aware** linting only; `no-restricted-imports` is a syntactic rule, independent of tsgo, and is **not enabled by default** — it must be turned on with `--deny no-restricted-imports` or in the config file.
  Source: https://biomejs.dev/linter/rules/no-restricted-imports/ ; https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-imports.html ; https://oxc.rs/docs/guide/usage/linter.html
- **Empirical check of the S6 Biome config (fact-check, C24 refuted):** running `npx biome lint src` with `@biomejs/biome@2.5.11` and the original S6 `biome.json` on a scratch tree flagged the deep import in `src/app.ts` and `../bar/service` in `src/modules/foo/routes.ts`, but `src/modules/foo/service.ts` containing `import "hono"`, `import "../bar/service"` and `import "@modules/bar/service"` produced only the `hono` error (3 errors total, 5 expected). Cause: the override for `service.ts`/`aggregate.ts`/`events.ts` set `noRestrictedImports` options with only `paths`, which **replaces** (does not merge with) the `patterns` from the `src/modules/**` override — Biome's configuration reference states override settings supersede rather than merge. The globs themselves (`@modules/*/**`, `../**`) work. S6 and R7.2 now repeat `patterns` in that override.
  Source: empirical run of `npx biome lint src` with @biomejs/biome@2.5.11 ; https://biomejs.dev/reference/configuration/

### F9. Size and cost envelope for a monolith
- Worker bundle: 10 MB compressed on Paid (3 MB Free), 64 MB uncompressed; "Larger Worker bundles can impact startup time." Paid subrequests: 10,000 per invocation.
  Source: https://developers.cloudflare.com/workers/platform/limits/

## Recommendation for Crosscut

### R1. Topology: one Worker, three kinds of things exported from `src/index.ts`
1. `export default { fetch: app.fetch }` — the Hono gateway (auth once, Zod validation, module routes, static assets).
2. Aggregate classes (Durable Objects): `Player`, `Solve`, `PuzzleStats`, `DailyBoard`, plus whatever `concepts.md` already mandates. Declared with the declarative `exports` map (`"type": "durable-object", "storage": "sqlite"`), not `migrations`.
3. Named `WorkerEntrypoint`s, only for **split-eligible** modules: `Projections` (from `packages/core`), `Notifications` (Expo push / APNs), and later `Leaderboards` if it grows a scheduled rebuild. Everything else is a plain module.

`compatibility_date` = today's date (>= 2025-11-17) so `ctx.exports` is on without listing `enable_ctx_exports`; still list it explicitly in `wrangler.jsonc` for readability.

### R2. Plain TS module vs `WorkerEntrypoint` — decision rule
Use a **plain module (direct import of `modules/<m>/index.ts`)** when: the call is in-process, arguments/results include rich TS types, errors carry data (Zod issues, domain error codes), it is called on hot paths (per keystroke/hint), or it is never going to be deployed separately. Use a **`WorkerEntrypoint`** when at least one holds: it is a planned split (independent deploy cadence, different secrets/trust), it must be reachable from another Worker or from tests by name, or it needs `ctx.props`-scoped context. Use a **Durable Object** for any entity whose invariants need serialization (balances, streaks, wheel spins, per-puzzle counters, per-day leaderboards). Design rule for an entrypoint-eligible module: its public API must be **RPC-safe from day 1** — structured-clone parameters and results (DTOs from `schema.ts`, no class instances, no functions), and failures signalled by `Error` subclasses whose meaning is fully carried by `name` + `message` (e.g. `DomainError` with `name="DomainError"` and a machine-readable message prefix `INSUFFICIENT_TOKENS: ...`). Caveat: the docs only promise `name` retention for standard JavaScript Error types; a custom `name` surviving RPC is **observed, not documented** behaviour (F3), and it arrives as an own property on a plain `Error` — so callers must match on `err.name`, never `instanceof DomainError`.

### R3. Module map (bounded contexts derived from the design handoff)
| Module | Owns | Write model | Read model (D1) | Split candidate? |
|---|---|---|---|---|
| `identity` | Better Auth session, `userId` context | D1 (Better Auth) | — | no |
| `puzzles` | puzzle JSON catalog (en/ru/uk), daily drop id, par seconds, difficulty | static JSON + `puzzles` table | `puzzles`, `daily_drops` | no |
| `play` | solve sessions: start, hint purchase, submit, verification, timer, `tokens = floor(secLeft/5)`, `stars = 10 (+2 no hints)` | `Solve` DO (`solve:${userId}:${puzzleId}`) | `solves` | no |
| `economy` | tokens & stars balances, hint costs (20/40/100), token packs, no-ads entitlement | `Player` DO | `player_state` | no |
| `streaks` | streak counter, day-solved calendar, at-risk state | `Player` DO (same aggregate, separate slice of state) | `player_state` | no |
| `rewards` | fortune wheel (prizes 50/10/0/25/5/15, one spin per wheel key), mystery grid | `Player` DO | `player_state` | no |
| `collections` | manifest, progress per collection, unlock rules, completion badge + token reward | `Player` DO (progress) + manifest table | `collections`, `collection_progress` | no |
| `social` | likes/saves, solved counts, "solving now" | `PuzzleStats` DO per puzzle | `puzzle_stats` | maybe |
| `leaderboards` | top solvers today per puzzle, weekly | `DailyBoard` DO per puzzle-day | `board_entries` | yes |
| `notifications` | push tokens, streak-at-risk / daily-drop pings | `Player` DO (tokens) | — | yes (`WorkerEntrypoint`) |
| `billing` | RevenueCat/Stripe webhooks -> entitlement, token pack credit | — (calls `economy`) | `purchases` | maybe |
| `projections` | the only D1 writer for aggregate snapshots | — | all `*_state` tables | yes (`WorkerEntrypoint`, from `packages/core`) |

Aggregate ownership rule (from `concepts.md`): a module may own an aggregate; other modules never call that aggregate's commands directly — they call the owning module's public function, which calls the stub. `Player` is shared by `economy`/`streaks`/`rewards`/`collections`; to keep one owner, put the `Player` class in `modules/player/aggregate.ts` and let those four modules be *slices* that only expose use-cases over `Player` commands (see Open questions Q1).

### R4. Domain events as direct in-process calls
- `platform/events.ts` defines `DomainEvent` (a discriminated union: `PuzzleSolved`, `HintUsed`, `WheelSpun`, `CollectionCompleted`, `PurchaseCompleted`, `StreakBroken`...) and a `publish(evt, deps)` that looks up a **static subscriber table** built in the composition root. Delivery is `await` in registration order (deterministic, testable); each handler is idempotent on `(evt.id)` because the aggregates make replays no-ops (equal state = no version bump).
- Critical consequences are **not** events: crediting tokens/stars for a solve is part of the `play.submit` use-case (it calls `economy.creditSolve(...)` directly and returns the new balances to the client). Events are for fan-out whose loss is tolerable and reconcilable (stats, leaderboards, collections progress, notifications).
- Fan-out failure policy: run handlers with `Promise.allSettled`, log each rejection with the event id, never fail the request because a subscriber failed. Because there is no outbox, a Worker that dies mid-fan-out loses the remaining handlers; mitigate with an idempotent `reconcile(userId)` command that recomputes derived state from `Solve` snapshots (D1 registry) and can be run from an alarm or admin route (Open question Q2).
- When a subscriber's module is later split to its own Worker, the dispatcher entry changes from `collections.onPuzzleSolved` (plain function) to `modules.collections.onPuzzleSolved` (RPC stub) — same signature, same call site, provided the event payload was already structured-clone-safe (it is: plain JSON).

### R5. Folder layout
```
workers/gateway/
  wrangler.jsonc                 name, main, compatibility_date, exports (DOs), d1, assets, services (only after a split)
  worker-configuration.d.ts     generated: wrangler types
  vitest.config.ts               cloudflareTest({ wrangler: { configPath } })
  src/
    index.ts                     COMPOSITION ROOT: re-exports DO classes + entrypoints, default { fetch }
    app.ts                       Hono root: middleware, mounts every module's routes.ts, error mapping
    modules.ts                   resolveModules(env, ctx): the one place that knows env.X vs ctx.exports.X
    platform/                    cross-cutting, no domain knowledge
      auth.ts                    session middleware -> c.set("userId")
      errors.ts                  DomainError -> 422, NotInitializedError -> 404, RPC name mapping
      events.ts                  DomainEvent union, publish(), subscriber-table type
      ids.ts, clock.ts, http.ts  small helpers
    modules/
      <name>/
        index.ts                 PUBLIC API only: `export { ... } from "./service"; export type { ... } from "./schema"`
        routes.ts                Hono sub-app (`new Hono<AppEnv>()`), thin: validate -> service -> json
        service.ts               use-cases; takes a `Deps` object (stubs, modules, D1) — no Hono, no globals
        events.ts                events this module PUBLISHES (factory fns) + handlers it SUBSCRIBES to
        schema.ts                Zod: request/response DTOs and state shape (re-exported into packages/shared)
        repo.ts                  D1 queries for the read model + `defineProjection(...)` for its aggregates
        aggregate.ts             Durable Object class(es), extends Aggregate<State, Env> (if this module owns one)
        entrypoint.ts            OPTIONAL: `export class Name extends WorkerEntrypoint<Env>` facade over service.ts
        <name>.test.ts           workerd tests via cloudflare:test
packages/core/                   Aggregate, ProjectionsBase, aggregateStub, DomainError (copied in)
packages/shared/                 Zod schemas + `AppType` for the Expo client (hc)
```
Import rules (the "architecture"): `routes.ts -> service.ts -> (aggregate stub | repo | other module's index.ts | platform)`. `aggregate.ts` imports only `packages/core`, its own `schema.ts` and nothing from other modules. `entrypoint.ts` imports only its own `service.ts`. Only `src/index.ts`, `src/app.ts` and `src/modules.ts` may import `modules/*/aggregate.ts`, `modules/*/entrypoint.ts` and `modules/*/routes.ts`. Nothing in `modules/**` imports `src/app.ts` or `src/index.ts` (would create an import cycle through the composition root).

### R6. Composition root and the module-resolution seam
`src/modules.ts` exports `resolveModules(env, ctx)` returning an object of **interfaces** (`ProjectionsApi`, `NotificationsApi`, ...). Each entry resolves `env.BINDING` first (present only after a split) and falls back to `ctx.exports.ClassName` (loopback, same Worker) — the same rule `packages/core` already applies for `Projections`. Services receive this object as `deps.modules`; they never touch `env.*` service bindings or `ctx.exports` themselves. Routes build `deps` once per request from `c.env` and `c.executionCtx`.

### R7. Enforcing boundaries with today's toolchain
Given TS 7.0's missing API (F8):
1. **Path aliases** in `tsconfig.json`: `"@modules/*": ["./src/modules/*/index.ts"]`, `"@platform/*": ["./src/platform/*"]`, `"@core": ["../../packages/core/src/index.ts"]`. Rule: cross-module imports use `@modules/<name>` only; inside a module, only `./relative` imports. This makes every violation a syntactically recognisable specifier (`@modules/x/service`, `../y/...`).
2. **Biome `noRestrictedImports`** (or oxlint `no-restricted-imports`, same shape; in oxlint the rule must be explicitly enabled) as the CI gate: globally forbid `@modules/*/**` (deep imports) and, in an override scoped to `src/modules/**`, forbid `../**` (parent-relative) and `@modules/*/aggregate`-style specifiers; additionally forbid `hono` from `service.ts`/`aggregate.ts`/`events.ts` files via a second override (keeps framework out of the domain). **Biome override options replace, they do not merge** (https://biomejs.dev/reference/configuration/): the `service.ts`/`aggregate.ts`/`events.ts` override must therefore **repeat the `patterns` array alongside `paths`**, otherwise those files — exactly where boundary violations matter most — silently lose the deep-import and parent-relative rules (this was the original S6 bug; C24 refuted by an empirical run with Biome 2.5.11, see F8). Alternative structure: one override keyed on `src/modules/**` carrying both `patterns` and `paths`, plus a `routes.ts`-only override that re-allows `hono`. Biome parses TS natively, so this works with `typescript@7.0.2`. Keep the scratch-tree lint test (a fixture with a deliberate deep import, a parent-relative import and a `hono` import in `service.ts`, expecting 3 errors in that file) as a CI fixture so the config cannot regress silently.
3. **Type-level enforcement of RPC safety** for entrypoint-eligible modules is **weaker than originally stated** (fact-check with tsc 7.0.2 + workers-types 5.20260902.1): (a) a type alias whose conditional resolves to `never` (`type _Check = ... ? true : never`) is *not* a compile error — the only diagnostic is TS6196 "declared but never used" under `noUnusedLocals`; (b) `Rpc.Result<R>` does not collapse to `never` for plain data classes, because `Serializable<R>` is structural (F3) — `Service<E> extends Api` evaluates to `true` for a method returning `class Plainish { y = 2 }`, yet the runtime rejects it. Therefore: enforce DTO-ness **by construction** — entrypoint facades return `z.infer` types and parse results through Zod (`Schema.parse(...)` yields a plain object), never class instances; and if a type assertion is still wanted, use an assignability assertion that actually errors on mismatch, e.g. `export const _check: NotificationsApi = null! as Service<Notifications>;` or an exported `Assert<T extends true>` alias (see S4), understanding it will not catch plain data classes. The assertion **must be exported (or consumed via `void _check`)**: a non-exported `const _check` fails a build with `noUnusedLocals` (reproduced: TS6133 "'_check' is declared but its value is never read", tsc 7.0.2).
4. **Later**: `dependency-cruiser` with the capture-group rule (F8) once TS 7.1 ships its API — or now, by installing `"typescript": "npm:@typescript/typescript6@6.0.2"` in an isolated `tools/depcruise` workspace package so dependency-cruiser finds a JS-API TypeScript "in the same spot" (verified in the second fact-check pass: the `typescript6` alias + dependency-cruiser 18.2.0 combination works — it reports typescript 6.0.3 and flags the capture-group rule; C25). Note the alias is a shim that resolves to `typescript@6.0.3`, so that is the version tools will report (F8).
5. Do not use `eslint-plugin-boundaries` yet: it declares only `eslint >=6.0.0` as a peer, but in practice ESLint needs a TypeScript-capable parser to lint `.ts`, and the standard one, `@typescript-eslint/parser`, has a peer range excluding TS 7 (F8). Revisit at TS 7.1.
6. Strongest option if a module becomes a workspace package (`packages/mod-leaderboards`): a `package.json` `"exports": { ".": "./src/index.ts" }` map makes deep imports unresolvable by Node/esbuild/TypeScript resolution itself — no linter needed. Recommended for the moment a module is about to split.

### R8. Splitting a module into its own Worker without changing callers
Preconditions (cheap if done from day 1): the module has `entrypoint.ts`; all callers go through `deps.modules.<name>` from `resolveModules`; its DOs are addressed via `aggregateStub(env.NS, kind, id)` with an `env` binding (not `ctx.exports.Class`) so the namespace can be re-pointed.
Steps:
1. Create `workers/<name>/wrangler.jsonc` with `main: src/index.ts` exporting the entrypoint class and (if it owns DOs) those classes, with `exports: { Class: { type: "durable-object", storage: "sqlite", state: "expecting-transfer", transfer_from: "gateway" } }`; in the gateway mark the class `state: "transferred", transferred_to: "<name>"` (F4). If the DO stays in the gateway, instead add `script_name: "gateway"` on the new Worker's DO binding.
2. In `gateway/wrangler.jsonc` add `services: [{ binding: "<NAME>", service: "<name>", entrypoint: "<Class>" }]`; `resolveModules` now finds `env.<NAME>` and stops using the loopback — no caller changes.
3. `wrangler types -c workers/gateway/wrangler.jsonc -c workers/<name>/wrangler.jsonc` for `Service<import(...)>` types; `wrangler dev -c gateway -c <name>` for local dev (F5).
4. Event delivery to the moved module becomes an RPC call in the same dispatcher slot; make sure the handler signature only uses structured-clone payloads (already required by R2/R4).
5. Watch the 32-invocations-per-request cap: a request that fans out to N split modules spends N of them (F1). Whether Durable Object stub calls also count toward that cap is **UNVERIFIED** (Q7): the service-bindings page, the Workers limits page and the Durable Objects limits page are all silent on it — do not assume either way when budgeting a request that fans out to several DOs.

### R9. Testing plan for the monolith shape
- Use `@cloudflare/vitest-plugin@1.1.3` (rename of `vitest-pool-workers`; run the codemod on `packages/core` when copying it in). One `main` Worker in the test config; every module test talks to real DOs, D1 and `ctx.exports` inside workerd. Unit tests of `service.ts` take a fake `Deps`. Integration tests call `app.request()` or `SELF.fetch`. Because auxiliary test Workers cannot be TypeScript (F6), do not test the split shape in Vitest — test it with `wrangler dev -c ... -c ...` smoke runs.

## Code sketches

### S1. `wrangler.jsonc` (single-Worker shape)
```jsonc
{
  "name": "crosscut-gateway",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-02",
  "compatibility_flags": ["nodejs_compat", "enable_ctx_exports"],
  "observability": { "enabled": true },
  "exports": {
    "Player":      { "type": "durable-object", "storage": "sqlite" },
    "Solve":       { "type": "durable-object", "storage": "sqlite" },
    "PuzzleStats": { "type": "durable-object", "storage": "sqlite" },
    "DailyBoard":  { "type": "durable-object", "storage": "sqlite" }
  },
  "durable_objects": { "bindings": [
    { "name": "PLAYER", "class_name": "Player" },
    { "name": "SOLVE", "class_name": "Solve" },
    { "name": "PUZZLE_STATS", "class_name": "PuzzleStats" },
    { "name": "DAILY_BOARD", "class_name": "DailyBoard" }
  ]},
  "d1_databases": [{ "binding": "DB", "database_name": "crosscut", "database_id": "<id>" }],
  "assets": { "directory": "../../apps/app/dist", "binding": "ASSETS" }
  // after a split only: "services": [{ "binding": "NOTIFICATIONS", "service": "crosscut-notifications", "entrypoint": "Notifications" }]
}
```
(`exports` vs `migrations` are mutually exclusive; `packages/core/test/wrangler.jsonc` still uses `migrations` and is fine as-is.)

### S2. Composition root `src/index.ts`
```ts
import app from "./app";
export { Player } from "./modules/player/aggregate";
export { Solve } from "./modules/play/aggregate";
export { PuzzleStats } from "./modules/social/aggregate";
export { DailyBoard } from "./modules/leaderboards/aggregate";
export { Projections } from "./modules/projections/entrypoint";
export { Notifications } from "./modules/notifications/entrypoint";
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
```

### S3. `src/modules.ts` — the only place that knows where a module lives
```ts
import type { NotificationsApi } from "@modules/notifications";
import type { ProjectionsBinding } from "@core";

export interface Modules { projections: ProjectionsBinding; notifications: NotificationsApi }

// `wrangler types` generates `Env` from the bindings that exist today, so before the split
// `PROJECTIONS`/`NOTIFICATIONS` are not on `Env` and `env.PROJECTIONS` is a TS2339 error under
// strict TS (fact-check). Widen the type for the optional post-split bindings (alternatives: an
// `"PROJECTIONS" in env` guard, or a cast as packages/core/src/aggregate.ts does with
// `this.ctx.exports as Record<string, unknown>`).
type SplitBindings = { PROJECTIONS?: Service<Projections>; NOTIFICATIONS?: Service<Notifications> };

export function resolveModules(env: Env & SplitBindings, ctx: ExecutionContext): Modules {
  const x = ctx.exports; // loopback stubs, typed by `wrangler types`
  return {
    projections:   env.PROJECTIONS   ?? x.Projections,    // env.* exists only after a split
    notifications: env.NOTIFICATIONS ?? x.Notifications,
  };
}
```

### S4. A module's public API and entrypoint facade (`modules/notifications`)
```ts
// schema.ts
export const PushMessage = z.object({ userId: z.string(), title: z.string(), body: z.string() });
export type PushMessage = z.infer<typeof PushMessage>;

// service.ts  (no Hono, no env access; RPC-safe in and out)
export interface NotificationsApi { send(msg: PushMessage): Promise<{ accepted: boolean }> }
export function createNotifications(deps: { player: DurableObjectNamespace<Player>; fetch: typeof fetch }): NotificationsApi {
  return { async send(msg) { /* read tokens from Player, call Expo push with fetch */ return { accepted: true }; } };
}

// entrypoint.ts  (only because this module may be split later)
import { WorkerEntrypoint } from "cloudflare:workers";
export class Notifications extends WorkerEntrypoint<Env> implements NotificationsApi {
  send(msg: PushMessage) { return createNotifications({ player: this.env.PLAYER, fetch }).send(msg); }
}

// index.ts  (the ONLY file other modules may import)
export { createNotifications } from "./service";
export type { NotificationsApi } from "./service";
export { PushMessage } from "./schema";
// RPC-safety: enforce by construction — results are z.infer DTOs parsed through Zod, never class instances.
// The former `type _Check = Service<...> extends NotificationsApi ? true : never;` was NOT a compile-time check:
// a `never`-valued alias is not an error (only TS6196 unused under noUnusedLocals), and Rpc.Result<R> does not
// collapse to never for plain data classes (Serializable<R> is structural). Verified with tsc 7.0.2 +
// @cloudflare/workers-types 5.20260902.1. An assignability assertion at least errors on interface mismatch.
// It must be exported: a plain `const _check` fails the build under `noUnusedLocals`
// (TS6133 "'_check' is declared but its value is never read", reproduced with tsc 7.0.2).
export const _check: NotificationsApi = null! as Service<import("./entrypoint").Notifications>;
// (or: `void _check;`, or an exported alias:
//  type Assert<T extends true> = T; export type _ok = Assert<Service<...> extends NotificationsApi ? true : false>;)
// Neither catches a returned DTO *class* — hence Zod-parsed plain objects at the facade.
```

### S5. In-process events (`platform/events.ts` + wiring in `app.ts`)
```ts
export type DomainEvent =
  | { type: "PuzzleSolved"; id: string; userId: string; puzzleId: string; secondsLeft: number; usedHints: boolean; at: number }
  | { type: "WheelSpun"; id: string; userId: string; wheelKey: string; prize: number; at: number }
  | { type: "CollectionCompleted"; id: string; userId: string; collectionId: string; at: number };

type Handler<E extends DomainEvent> = (e: E) => Promise<void>;
export type Subscribers = { [T in DomainEvent["type"]]?: Handler<Extract<DomainEvent, { type: T }>>[] };

export function createPublisher(subs: Subscribers, ctx: ExecutionContext) {
  return async <E extends DomainEvent>(e: E): Promise<void> => {
    const hs = (subs[e.type] ?? []) as Handler<E>[];
    const results = await Promise.allSettled(hs.map((h) => h(e)));
    for (const r of results) if (r.status === "rejected") console.error("event handler failed", e.type, e.id, r.reason);
  };
}

// app.ts (composition root): static wiring, in delivery order
const subscribers: Subscribers = {
  PuzzleSolved: [social.onPuzzleSolved, leaderboards.onPuzzleSolved, collections.onPuzzleSolved, streaks.onPuzzleSolved],
  CollectionCompleted: [economy.onCollectionCompleted, notifications.onCollectionCompleted],
};
```
`play.submit` credits tokens/stars synchronously (`economy.creditSolve`) and then `await publish(PuzzleSolved)`; each subscriber writes through its own aggregate, where a replay is a no-op commit.

### S6. Biome boundary rules (`biome.json`, TS-7-proof)
Corrected after the fact-check (C24 refuted): Biome override options **supersede** the outer/previous override's options instead of merging (https://biomejs.dev/reference/configuration/), so the third override must repeat `patterns` next to `paths`. The original version (only `paths` in the third override) dropped the deep-import and parent-relative rules for `service.ts`/`aggregate.ts`/`events.ts` — verified empirically with `@biomejs/biome@2.5.11` (3 errors reported where 5 were expected).
```jsonc
{
  "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": {
    "patterns": [
      { "group": ["@modules/*/**"], "message": "Import a module only through @modules/<name> (its index.ts)." }
    ] } } } } },
  "overrides": [
    { "includes": ["src/modules/**"], "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": {
        "patterns": [
          { "group": ["../**"], "message": "No parent-relative imports inside a module; use @modules/<name>, @platform/*, @core." },
          { "group": ["@modules/*/**"], "message": "Deep import into another module." }
        ] } } } } } },
    { "includes": ["src/modules/**/service.ts", "src/modules/**/aggregate.ts", "src/modules/**/events.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": {
        // MUST repeat `patterns`: override options replace, they do not merge with the override above.
        "patterns": [
          { "group": ["../**"], "message": "No parent-relative imports inside a module; use @modules/<name>, @platform/*, @core." },
          { "group": ["@modules/*/**"], "message": "Deep import into another module." }
        ],
        "paths": { "hono": "Framework code belongs in routes.ts only." } } } } } } }
  ]
}
```
Alternative with less duplication: a single override on `src/modules/**` carrying both `patterns` and `paths: { "hono": ... }`, plus a `src/modules/**/routes.ts` override that repeats `patterns` and omits `paths` (re-allowing `hono` there). Either way, keep a scratch-tree fixture in CI: `src/app.ts` with `import "@modules/foo/service"`, `src/modules/foo/routes.ts` with `import "../bar/service"`, and `src/modules/foo/service.ts` with `import "hono"`, `import "../bar/service"`, `import "@modules/bar/service"`; `biome lint` must report 5 errors.
(oxlint equivalent uses `"no-restricted-imports": ["error", { patterns: [{ group: [...] }] }]` with the same globs; the rule is off by default in oxlint, so enable it via config or `--deny no-restricted-imports`.)

### S7. dependency-cruiser rule for later (needs a TypeScript with a JS API)
```js
{ name: "no-cross-module-internals", severity: "error",
  from: { path: "^workers/gateway/src/modules/([^/]+)/" },
  to:   { path: "^workers/gateway/src/modules/([^/]+)/", pathNot: "^workers/gateway/src/modules/$1/|/index\\.ts$" } }
```

### S8. Calling an aggregate + mapping RPC errors in Hono
```ts
app.post("/play/:puzzleId/hint", zValidator("json", HintRequest), async (c) => {
  const deps = makeDeps(c);                                  // env, ctx, modules, publish
  const snap = await play.buyHint(deps, c.get("userId"), c.req.param("puzzleId"), c.req.valid("json"));
  return c.json(snap);
});
app.onError((err, c) => {
  // Match on `name`, never `instanceof DomainError`: over RPC the error arrives as a plain `Error`
  // (constructor Error) with `name` as an own property, so instanceof is always false. A custom
  // name surviving RPC is observed (workerd via vitest-plugin 1.1.3), not documented — the docs
  // only promise name retention for standard Error types (F3).
  if (err.name === "DomainError") return c.json({ error: err.message }, 422);      // only name+message survive RPC
  if (err.name === "NotInitializedError") return c.json({ error: "not found" }, 404);
  if ((err as any).retryable) return c.json({ error: "try again" }, 503);          // DO runtime flag
  // Do NOT branch on `(err as any).remote`: it is set on entrypoint RPC errors too, not only DO errors.
  throw err;
});
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | A Worker can export multiple named `WorkerEntrypoint` classes; a service binding selects one via `services[].entrypoint`; `this.env`/`this.ctx` are available | https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ | high | confirmed |
| C2 | Service bindings run on the same thread with zero added latency, but at most 32 Worker invocations per request; each call counts as a subrequest | https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/ | high | confirmed |
| C3 | `ctx.exports` gives loopback service bindings for every `WorkerEntrypoint` export and DO namespaces for DO exports with configured storage; loopback callers may set `ctx.props` | https://developers.cloudflare.com/workers/runtime-apis/context/ ; https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ | high | confirmed |
| C4 | `enable_ctx_exports` is default-on for compatibility dates >= 2025-11-17 (disable with `disable_ctx_exports`) | https://developers.cloudflare.com/workers/configuration/compatibility-flags/ | high | confirmed |
| C5 | `DurableObjectState.exports` has the same meaning as `ctx.exports`, so aggregates can reach entrypoints without bindings (used and tested in packages/core) | https://developers.cloudflare.com/durable-objects/api/state/ ; /Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts | high | confirmed |
| C6 | Over RPC only structured-clone values, functions, `RpcTarget` subclasses, byte streams, Request/Response and stubs are serializable; other class instances are not; 32 MiB max | https://developers.cloudflare.com/workers/runtime-apis/rpc/ | high | confirmed |
| C7 | Errors crossing RPC keep only `message` and prototype `name`; stack/cause/own properties are dropped; AggregateError/SuppressedError not propagated (non-Error throws: not documented, observed to arrive as a generic `Error`; custom `name` survival: observed, not documented) | https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ ; empirical probe, vitest-plugin 1.1.3 | high | confirmed |
| C8 | DO exceptions carry `.retryable`, `.overloaded`, `.remote` (`.remote` is also set on entrypoint RPC errors; DO errors add `durableObjectId` — observed); a stub can be left broken after an exception | https://developers.cloudflare.com/durable-objects/best-practices/error-handling/ ; empirical probe, vitest-plugin 1.1.3 | high | confirmed |
| C9 | Only prototype methods and class getters/setters are RPC-visible; arrow-function fields, `#private` and constructor-assigned properties are not | https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/ | high | confirmed |
| C10 | Reserved RPC names: `fetch`, `connect`, `dup`, `constructor`; `alarm`/`webSocket*` reserved on entrypoints and DOs | https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/ | high | confirmed |
| C11 | Stubs are auto-disposed at end of the event handler / RPC method; `using` is supported natively by Wrangler v4+; `dup()` creates independent handles; RPC promises are pipelinable thenables | https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/ ; https://developers.cloudflare.com/workers/runtime-apis/rpc/ | high | confirmed |
| C12 | `Service<T>` / `DurableObjectNamespace<T>` types; `wrangler types -c a -c b` emits `Service<import(...)>`; `Rpc.Result<R>` is `never` for non-serializable returns | https://developers.cloudflare.com/workers/runtime-apis/rpc/typescript/ ; workers-types 5.20260901.1 index.d.ts | high | confirmed |
| C13 | DO bindings accept `script_name` to reference a class defined in another Worker | https://developers.cloudflare.com/workers/wrangler/configuration/ | high | confirmed |
| C14 | Wrangler's declarative `exports` map (`type: "durable-object"`, `storage`, `state: created/deleted/renamed/transferred/expecting-transfer`) replaces `migrations`; the two are mutually exclusive | https://developers.cloudflare.com/workers/wrangler/configuration/ ; workers-sdk vitest-plugin CHANGELOG 0.18.0 (PR #14382); wrangler 4.124 cli.js validation string | high | confirmed |
| C15 | `wrangler dev -c primary.jsonc -c other.jsonc` runs several Workers locally; the first is primary; service bindings and DO namespaces work across them | https://developers.cloudflare.com/workers/development-testing/multi-workers/ | high | confirmed |
| C16 | The Vitest integration was renamed to `@cloudflare/vitest-plugin` at 1.0.0 (current 1.1.3, peers vitest ^4.1.0, @vitest/runner ^4.1.0, @vitest/snapshot ^4.1.0; the CHANGELOG on main is still titled `@cloudflare/vitest-pool-workers` and the old `packages/vitest-pool-workers/CHANGELOG.md` path 404s — the `packages/vitest-plugin/CHANGELOG.md` links here are the correct ones); config is `cloudflareTest({ wrangler: { configPath } })`; codemod `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` | https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-plugin/CHANGELOG.md ; https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ ; npm view | high | confirmed |
| C17 | `ctx.exports` works in Vitest tests since pool 0.11.0 (SELF integration tests, `createExecutionContext().exports`, `exports` from `cloudflare:workers`); unresolvable exports declared via `additionalExports` | https://developers.cloudflare.com/changelog/post/2025-12-16-vitest-ctx-exports-support/ ; CHANGELOG 0.11.0 | high | confirmed |
| C18 | Auxiliary test Workers cannot be TypeScript and cannot use `cloudflare:test` | https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ | medium | confirmed |
| C19 | Hono `app.route()` copies routes at mount time (order matters); typed client requires chained `const routes = app.route(...)` and async handlers; split client types per sub-router for large apps | https://hono.dev/docs/api/routing ; https://hono.dev/docs/guides/rpc | high | confirmed |
| C20 | `typescript@7.0.2` ships no programmatic compiler API (no `lib/typescript.js`); the API is expected in 7.1; Microsoft recommends aliasing `@typescript/typescript6` (6.0.2) for tools that need it | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ ; `npm pack typescript@7.0.2 --dry-run` ; `npm view @typescript/typescript6 version` | high | confirmed |
| C21 | `typescript-eslint`/`@typescript-eslint/parser` 8.69.0 peer-depend on `typescript >=4.8.4 <6.1.0`; TS 7 support issue #10940 is open ("blocked by external API"), so ESLint-based TS boundary linting (eslint-plugin-boundaries 7.2.0) does not run on TS 7.0 | `npm view typescript-eslint peerDependencies` ; https://github.com/typescript-eslint/typescript-eslint/issues/10940 | high | confirmed |
| C22 | dependency-cruiser 18.2.0 needs `typescript` with a JS API co-located; maintainers state TS 7.1 will be the first TS 7 version supported; its rules support `$1` capture groups for "no cross-module internals" | https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md ; https://github.com/sverweij/dependency-cruiser/releases ; https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md | high | confirmed |
| C23 | Biome 2.5.11 `noRestrictedImports` supports `paths` and gitignore-style `patterns[].group` with negation, parsing TS natively; oxlint 1.81.0 has `no-restricted-imports` with `paths`/`patterns` and uses tsgo | https://biomejs.dev/linter/rules/no-restricted-imports/ ; https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-imports.html ; https://oxc.rs/docs/guide/usage/linter.html | high | confirmed |
| C24 | The corrected Biome `overrides` + `patterns` combination in S6 enforces the proposed layout (the original config was refuted in the first pass and fixed in place) | empirical run of `npx biome lint src` with @biomejs/biome@2.5.11 on the scratch fixture: exactly 5 errors, as expected; https://biomejs.dev/reference/configuration/ | high | confirmed |
| C25 | Installing `typescript` as `npm:@typescript/typescript6@6.0.2` inside an isolated tools package lets dependency-cruiser parse TS today | Microsoft alias guidance + dependency-cruiser co-location note; executed in the second fact-check pass: dependency-cruiser 18.2.0 reports typescript 6.0.3 and flags the capture-group rule | high | confirmed |
| C26 | Worker bundle limit 10 MB compressed (Paid) / 64 MB uncompressed; larger bundles can slow startup | https://developers.cloudflare.com/workers/platform/limits/ | high | confirmed |
| C27 | `packages/core`'s `resolveProjections()` (env binding first, `ctx.exports` fallback) is the right seam pattern; it passes `tsc --noEmit` on TS 7.0.2 and 8/8 workerd tests with vitest-pool-workers 0.22 | local repo + task brief | high | confirmed |

## Open questions

1. **`Player` aggregate ownership.** Economy, streaks, rewards and collections all mutate per-user state. One `Player` DO (one hop, one snapshot, cross-slice invariants like "spend tokens on a hint" + "mark hints used" in one commit) vs one DO per slice (cleaner module ownership, more hops per solve). Recommendation leans to one `Player` DO owned by a `player` module with slice modules exposing use-cases; needs a decision before schema work.
2. **Event durability without a queue.** In-process fan-out cannot survive an isolate crash mid-delivery. Is an idempotent `reconcile` command (rebuild derived state from `Solve` projections) plus an occasional alarm enough, or should the `Solve` aggregate record `deliveredTo[]` and re-drive missing handlers on its own alarm (a mini-outbox per aggregate, still no queue)?
3. **`ctx.exports.Class` vs `env.BINDING` for Durable Objects.** Loopback DO namespaces need no binding, but re-pointing to another Worker later requires `env` bindings with `script_name`. Proposal: always use `env.*` for DOs, `ctx.exports` (via `resolveModules`) for entrypoints. Confirm.
4. **Biome vs oxlint.** Both are TS-7-proof for this rule (`no-restricted-imports` is syntactic in both; oxlint's tsgo dependency only concerns type-aware rules, and its `no-restricted-imports` must be enabled explicitly). Biome also formats (replaces Prettier); oxlint aligns with an eventual typescript-eslint-compatible rule set. Pick one; do not run both.
5. **When does dependency-cruiser come back?** TS 7.1 (API) has only nightlies today. The `typescript6` alias trick (C25) is now validated (dependency-cruiser 18.2.0 + `@typescript/typescript6` reports TS 6.0.3 and runs the capture-group rule); decide whether to adopt it now in a `tools/depcruise` package for the circular-dependency check, or wait for 7.1.
6. **Vitest package migration.** The template `packages/core` uses `@cloudflare/vitest-pool-workers` 0.22.0; the parent verified it works. Switch to `@cloudflare/vitest-plugin` 1.1.3 when copying `core` into this repo (codemod available) or keep 0.22 for now?
7. **Per-request 32-invocation budget after splits.** A solve request today makes ~0 service-binding calls (all in-process) but several DO calls (DO calls are not service bindings — verify whether they count toward the same 32 cap; the docs quoted only mention service bindings). Genuinely open — re-confirmed in the second fact-check pass: the service-bindings page, the Workers limits page and the Durable Objects limits page are all silent on whether DO stub calls count toward the 32-invocation cap. Do not assume either way when budgeting a request that fans out to several DOs.
8. **`nodejs_compat` need.** Better Auth/Drizzle may need it; unrelated to structure but it changes the compat flag list in S1.

## Fact-check log

Second pass, 2026-09-02. Every claim in the Claims table was re-checked against its primary source and, where the source is silent, against an empirical probe (workerd via `@cloudflare/vitest-plugin` 1.1.3, tsc 7.0.2, `@biomejs/biome` 2.5.11, dependency-cruiser 18.2.0). No claim was refuted and none is unverifiable; the text corrections listed after the table were applied in place.

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ |
| C2 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/ |
| C3 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/context/ ; https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ |
| C4 | confirmed | https://developers.cloudflare.com/workers/configuration/compatibility-flags/ |
| C5 | confirmed | https://developers.cloudflare.com/durable-objects/api/state/ ; /Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts |
| C6 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/rpc/ |
| C7 | confirmed (wording tightened: non-Error throws and custom `name` survival are observed, not documented) | https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ (raw page) ; empirical probe, vitest-plugin 1.1.3 |
| C8 | confirmed (`.remote` also set on entrypoint RPC errors; DO errors add `durableObjectId`) | https://developers.cloudflare.com/durable-objects/best-practices/error-handling/ ; empirical probe, vitest-plugin 1.1.3 |
| C9 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/ |
| C10 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/rpc/reserved-methods/ |
| C11 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/ ; https://developers.cloudflare.com/workers/runtime-apis/rpc/ |
| C12 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/rpc/typescript/ ; @cloudflare/workers-types 5.20260901.1 index.d.ts |
| C13 | confirmed | https://developers.cloudflare.com/workers/wrangler/configuration/ |
| C14 | confirmed | https://developers.cloudflare.com/workers/wrangler/configuration/ ; workers-sdk packages/vitest-plugin/CHANGELOG.md (0.18.0) ; wrangler 4.124 cli.js |
| C15 | confirmed | https://developers.cloudflare.com/workers/development-testing/multi-workers/ |
| C16 | confirmed (peers also include @vitest/runner ^4.1.0 and @vitest/snapshot ^4.1.0; CHANGELOG on main still titled `@cloudflare/vitest-pool-workers`, old path 404s, `packages/vitest-plugin/CHANGELOG.md` links are correct) | https://github.com/cloudflare/workers-sdk/blob/main/packages/vitest-plugin/CHANGELOG.md ; https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ ; `npm view @cloudflare/vitest-plugin peerDependencies` |
| C17 | confirmed | https://developers.cloudflare.com/changelog/post/2025-12-16-vitest-ctx-exports-support/ ; vitest-plugin CHANGELOG 0.11.0 |
| C18 | confirmed | https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ |
| C19 | confirmed | https://hono.dev/docs/api/routing ; https://hono.dev/docs/guides/rpc |
| C20 | confirmed | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ ; `npm pack typescript@7.0.2 --dry-run` ; `npm view @typescript/typescript6 version` |
| C21 | confirmed | `npm view typescript-eslint peerDependencies` ; https://github.com/typescript-eslint/typescript-eslint/issues/10940 |
| C22 | confirmed | https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md ; https://github.com/sverweij/dependency-cruiser/releases ; https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md |
| C23 | confirmed | https://biomejs.dev/linter/rules/no-restricted-imports/ ; https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-restricted-imports.html ; https://oxc.rs/docs/guide/usage/linter.html |
| C24 | confirmed (corrected S6 config; executed: exactly 5 Biome errors on the fixture) | `npx biome lint src` with @biomejs/biome@2.5.11 ; https://biomejs.dev/reference/configuration/ |
| C25 | confirmed (executed: typescript6 alias + dependency-cruiser 18.2.0 reports TS 6.0.3 and flags the capture-group rule) | Microsoft alias guidance ; dependency-cruiser co-location note ; empirical run |
| C26 | confirmed | https://developers.cloudflare.com/workers/platform/limits/ |
| C27 | confirmed | local repo (packages/core) + task brief |

Text corrections applied in this pass (no claim ids refuted):
- F3/C7: "throwing non-Error values is undefined behaviour" is not on the error-handling page; reworded to "not documented; observed to arrive as a generic `Error`".
- F3/R2/S8: custom `DomainError` name survives RPC as an own `name` property on a plain `Error` (observed, not documented); `instanceof` cannot be used, `err.name` check is correct.
- F3/F3-DO/S8: `.remote: true` is attached to entrypoint RPC errors too, so it does not distinguish DO errors; DO errors additionally carry `durableObjectId`.
- S3: `env.PROJECTIONS ?? x.Projections` does not type-check before the split (TS2339); type widened to `Env & { PROJECTIONS?: Service<...> }`, with the `in` guard / cast alternatives noted.
- S4/R7.3: `const _check` fails under `noUnusedLocals` (TS6133, tsc 7.0.2); changed to `export const _check` with `void _check` / exported `Assert` alias alternatives.
- F6: workerd "code had hung" messages appear for any throwing RPC path under vitest-plugin 1.1.3, not only the simulated projection failures.
- F6/C16: added the `@vitest/runner` and `@vitest/snapshot` peer dependencies.
- C24/C25/Q5/R7.4: dropped "not executed"/UNVERIFIED wording; both are now executed and confirmed.
- Q7: kept open; the three relevant docs pages remain silent on DO stub calls vs the 32-invocation cap.
