# Testing inside workerd and developer experience

Research date: 2026-09-02. Scope: how the Crosscut backend (one Cloudflare Worker, modular monolith, Hono + Zod + Durable Objects + D1) is tested inside the real Workers runtime, and how the local developer loop (wrangler dev, local D1, generated types, TypeScript 7, pnpm 11, Turborepo 2.10) is wired.

Everything marked **verified** was checked against a primary source (official docs, the npm registry, the installed package in `/Users/peter/Projects/IOSApp`, or a command actually run on this machine). Anything I could not confirm is marked **UNVERIFIED** in the text and gets `low` confidence in the claims table.

## Summary

1. **The test package has been renamed.** `@cloudflare/vitest-pool-workers` 0.22.0 (2026-08-18) is the last release under that name; version 1 ships as `@cloudflare/vitest-plugin` (1.0.0 on 2026-08-20, latest 1.1.3). "The Vitest configuration API is unchanged" — only the dependency name, the import specifier and the tsconfig `types` entry change. Cloudflare's docs and example fixtures now reference the new name everywhere. Crosscut should start on `@cloudflare/vitest-plugin@^1.1.3`: same `cloudflareTest()` API the template already uses, plus a 1.1.2 fix for tests that repeatedly construct the same Durable Object, plus wrangler 4.128 / workerd 1.20260831 alignment.
2. **The config API is the `cloudflareTest()` Vite plugin** used with `defineConfig` from `vitest/config`. `defineWorkersConfig` / `defineWorkersProject` / `test.poolOptions.workers` are gone (Vitest 4 removed `poolOptions`). The installed 0.22.0 typings export only: `cloudflareTest`, `cloudflarePool`, `readD1Migrations`, `buildPagesASSETSBinding`, `D1Migration` (+ internals).
3. **Storage isolation is now per test *file*, not per test.** The `isolatedStorage` and `singleWorker` options no longer exist (confirmed by their absence in the 0.22.0 option schema). Tests in one file share state; different files do not. To share storage across files run `vitest --max-workers=1 --no-isolate`. Consequence for Crosscut: every test uses its own entity ids (the template's tests already do this).
4. **`cloudflare:test` helpers that matter:** `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`, `listDurableObjectIds`, `applyD1Migrations` (+ `readD1Migrations` in the Node-side config), `createExecutionContext`/`waitOnExecutionContext`, `reset()`, `abortAllDurableObjects()`, `evictAllDurableObjects()`. `env` and `SELF` from `cloudflare:test` are marked `@deprecated` in 0.22.0's typings; the replacements are `import { env, exports } from "cloudflare:workers"` and `exports.default.fetch()`. `fetchMock` is no longer exported; outbound requests are mocked with MSW >= 2.14 (`@msw/cloudflare`'s `setupNetwork()`).
5. **End-to-end Hono tests** go through `exports.default.fetch(url, init)` (the Worker's real default export, middleware, `onError`, `ctx.exports` loopback included). Faster route-level tests use Hono's `app.request(path, init, env)` with the real `env` from `cloudflare:workers`.
6. **Fake timers work inside workerd** for `Date`/`setTimeout` (I ran `vi.useFakeTimers()` + `vi.setSystemTime()` + `vi.advanceTimersByTimeAsync()` in a probe test in the template package: passes). They do **not** apply to the KV/R2/cache simulators, and Durable Object alarms are driven by `runDurableObjectAlarm(stub)`, not by advancing time. Crosscut should still inject "now" explicitly into commands (streaks, daily puzzle, wheel cooldowns) so tests do not depend on global mocks.
7. **Coverage:** V8 coverage is not supported inside workerd; use `@vitest/coverage-istanbul` (its peer dependency pins the exact vitest version, 4.1.11).
8. **Local state:** `wrangler dev` persists to `.wrangler/state/v3/{d1,do,kv,r2,cache}` (override with `--persist-to`). `wrangler d1 migrations apply <db> --local` and `wrangler d1 execute <db> --local --file=./seed.sql` verified on this machine with wrangler 4.127.1. Local workerd runs with `TZ=UTC`.
9. **Types:** `wrangler types` writes `worker-configuration.d.ts` containing `Cloudflare.Env`, a global `Env`, and `Cloudflare.GlobalProps` (with `durableNamespaces`); Durable Object bindings are typed as `DurableObjectNamespace<import("./src/index").User>`. `wrangler types --check` fails when the committed file is stale — put it in the turbo `typecheck` pipeline.
10. **TypeScript 7.0.2 is the native Go compiler**, still installed as `typescript` with the `tsc` binary (platform binaries come from `@typescript/typescript-<platform>` optionalDependencies). `tsc --noEmit` on the template package passes in ~0.08 s. Removed options: `baseUrl`, `moduleResolution node/node10/classic`, `target es5`, `module amd/umd/system/none`, `outFile`, `downlevelIteration`, `esModuleInterop:false`. New defaults: `strict: true`, `module: esnext`, `types: []`, `rootDir: .`. The template tsconfig (`ES2022`, `ESNext`, `Bundler`, explicit `types`) is already compliant.
11. **pnpm 11:** `onlyBuiltDependencies`, `neverBuiltDependencies`, `ignoredBuiltDependencies`, `onlyBuiltDependenciesFile`, `ignoreDepScripts` were removed; `allowBuilds: { esbuild: true, workerd: true }` in `pnpm-workspace.yaml` replaces them; `strictDepBuilds` defaults to true (install exits non-zero on unreviewed build scripts); the `package.json` `pnpm` field is no longer read; `minimumReleaseAge` defaults to 1440 minutes (1 day), so packages published less than a day ago are skipped by a fresh install unless the setting is lowered or the package excluded. Historical bug (fixed): `pnpm install --ignore-workspace` on pnpm 11.7.0 clobbered `allowBuilds` values into the placeholder `set this to true or false` — issue #12469 was closed on 2026-06-20 and the fix (PR #12488) shipped in pnpm 11.9.0, so it does not affect the pinned pnpm 11.24.0. The template's `pnpm-workspace.yaml` still contains that placeholder as a leftover and must be fixed by hand.
12. **Turborepo 2.10:** root `package.json` needs `devEngines.packageManager` (or legacy `packageManager`); `turbo.json` uses `$schema: https://turborepo.dev/schema.json`, `dependsOn: ["^task"]`, `outputs`, `cache: false` + `persistent: true` for `dev`.

## Findings

### F1. Package rename: `@cloudflare/vitest-pool-workers` → `@cloudflare/vitest-plugin`

- npm (verified 2026-09-02): `@cloudflare/vitest-pool-workers` latest is 0.22.0, modified 2026-08-18. `@cloudflare/vitest-plugin` created 2026-08-20, latest 1.1.3; deps `wrangler 4.128.0`, `miniflare 5.20260831.0-alpha`; peers `vitest ^4.1.0`, `@vitest/runner ^4.1.0`, `@vitest/snapshot ^4.1.0`. 0.22.0 bundles `wrangler 4.124.0` and `miniflare 5.20260815.0-alpha` (its own copies, independent of the project's wrangler).
- Cloudflare changelog 2026-08-19: "Version 1 of the Workers Vitest integration is published as @cloudflare/vitest-plugin ... The Vitest configuration API is unchanged. Existing projects must update the dependency name, package imports, and TypeScript `types` entries." Codemod: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` (`@cloudflare/codemods` 0.1.0 exists on npm). Source: https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ and https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/
- CHANGELOG 1.0.0 (https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/vitest-plugin/CHANGELOG.md): the codemod "Replaces the dependency in your package.json, moving plain version ranges to ^1.0.0 ... Rewrites imports ... Updates the types entry in your test tsconfig.json". 1.1.2: "Fix slowdowns and crashes in tests that repeatedly recreate Durable Objects ... could get progressively slower and eventually fail with a stack overflow." 1.1.0: experimental `newConfig` for `cloudflare.config.ts` (not needed). 0.22.0: "Mocking requests with MSW in Worker tests now requires MSW >= 2.14" and "Use a fixed default compatibility date rather than the current date ... workerd only accepts a compatibility date up to 7 days beyond its own release".
- Cloudflare's own docs pages (Configuration, Write your first test, Recipes, Durable Objects testing example) all now import from `@cloudflare/vitest-plugin`; recipes live under `fixtures/vitest-plugin-examples/`. Sources: https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ , https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ , https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/ , https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/

### F2. Current configuration API (verified against installed 0.22.0 `dist/pool/index.d.mts`)

```ts
import { cloudflareTest } from "@cloudflare/vitest-plugin"; // or "@cloudflare/vitest-pool-workers" on 0.22
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

- `cloudflareTest(options | async (ctx) => options)` returns a `Vite.Plugin`. `ctx.inject(key)` reads values provided by `globalSetup`.
- Option schema (`WorkersPoolOptionsSchema`): `main?`, `remoteBindings` (boolean, default false), `verbose?`, `additionalExports` (record of name → `"WorkerEntrypoint" | "DurableObject" | "WorkflowEntrypoint"`), `miniflare?` (Miniflare worker options minus script/modules, e.g. `bindings`, `compatibilityDate`, `compatibilityFlags`, `workers[]`), `wrangler?: { configPath?, environment? }`. Miniflare values take precedence over the Wrangler config. This list is exact for 0.22.0; on the recommended 1.1.3 the Zod schema additionally contains `experimental: { newConfig?: boolean | { configPath?: string } }` (the `cloudflare.config.ts` loader mentioned in F1).
- **Not present:** `isolatedStorage`, `singleWorker`, `defineWorkersConfig`, `defineWorkersProject` (grep of `dist/pool/index.mjs` for `isolatedStorage|singleWorker` returns nothing).
- The Vitest 3→4 migration guide states the removals: "Delete `isolatedStorage` and `singleWorker` from configuration. For shared storage across test files, add `--max-workers=1 --no-isolate` CLI flags"; "Replace `import { env, SELF } from 'cloudflare:test'` with `import { env, exports } from 'cloudflare:workers'` and update `SELF.fetch()` calls to `exports.default.fetch()`" — with the caveat that `exports.default.fetch()` "behaves the same as SELF.fetch(), except that it does not expose Assets" (irrelevant for Crosscut's API Worker, which serves no static assets); "Remove fetchMock ... mock `globalThis.fetch` directly or use MSW instead." Source: https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/
- "Custom Vitest `environment`s or `runner`s are not supported when using the Workers Vitest integration." Source: configuration page above.
- Versions: docs say "The @cloudflare/vitest-plugin package requires Vitest 4.1 or later"; install command `npm i -D vitest@^4.1.0 @cloudflare/vitest-plugin`. Vitest 4 itself "requires Vite >= 6.0.0 and Node.js >= 20.0.0", renamed `workspace` → `projects`, removed `poolOptions`, and `maxThreads/maxForks` → `maxWorkers`. Source: https://vitest.dev/guide/migration
- tsconfig for tests (docs): `"types": ["@cloudflare/vitest-plugin/types"]` plus the `wrangler types` output in `include`; the docs example sets `"moduleResolution": "bundler"`.

### F3. Isolation and concurrency (verified: docs + fixture comments)

- "Storage isolation is per test file. Each test file gets its own storage environment, and any writes to storage during a test file are not visible to other test files." Test files run concurrently by default; "--max-workers=1 --no-isolate" makes files share storage. Source: https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/
- Setup files: the D1 fixture's `test/apply-migrations.ts` says "Setup files run outside the per-test-file storage isolation, and may be run multiple times. `applyD1Migrations()` only applies migrations that haven't already been applied, therefore it is safe to call this function here." Source: https://raw.githubusercontent.com/cloudflare/workers-sdk/main/fixtures/vitest-plugin-examples/d1/test/apply-migrations.ts
- The plugin injects `nodejs_compat`, `no_nodejs_compat_v2` and `export_commonjs_default` compatibility flags automatically; docs warn that code using Node APIs may pass tests but fail in production unless `nodejs_compat` is in the Wrangler config (Crosscut's wrangler.jsonc already includes it).
- Known-issue hygiene: "Always `await` all `Promise`s that read or write to storage services"; "use the `using` keyword" for non-primitive RPC return values; consume response bodies fully. Source: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
- Vitest flags (verified): `maxWorkers` (number | percentage string; default all available parallelism, half in watch mode), `isolate` (default true, `--no-isolate`), `fileParallelism` (default true, `--no-file-parallelism` "will override `maxWorkers` to 1"). Sources: https://vitest.dev/config/maxworkers , https://vitest.dev/config/isolate , https://vitest.dev/config/fileparallelism
- **Historical caveat, not on the current page (upstream history verified during fact-check, behaviour on 0.22/1.x not guaranteed):** older docs said "Durable Object alarms are not reset between test runs and do not respect isolated storage". The current known-issues page has no alarm section (8 top-level sections verified: Coverage, Fake timers, Dynamic import(), WebSockets, Storage isolation, Missing properties on ctx.exports, Module resolution, Importing modules from global setup file; "Await all storage operations", "Explicitly signal resource disposal" and "Consume response bodies" are sub-items under Storage isolation). Upstream history: workers-sdk #5388 was closed as completed on 2026-03-02 by workerd PR #1918 (alarms deleted on `abortAllDurableObjects()`), but that change was later reverted and vitest-pool-workers stopped calling that API — so there is currently **no upstream mechanism guaranteeing alarm reset between test files**. Treat alarms as "always run or clear them inside the test" and keep the guard test from Open question 3.

### F4. `cloudflare:test` exports in 0.22.0 (verified from `types/cloudflare-test.d.ts`)

| Export | Notes |
|---|---|
| `env` | `Cloudflare.Env`; `@deprecated Instead, use import { env } from "cloudflare:workers"` |
| `SELF` | `Fetcher` to the `main` Worker's default export; `@deprecated ... use import { exports } from "cloudflare:workers" and exports.default.fetch()`. Doc comment: "this `main` worker runs in the same isolate/context as tests, so any global mocks will apply to it too." Still works in 0.22.0 (probe test). |
| `runInDurableObject(stub, (instance, state) => R)` | Runs callback inside the object; `instance` is the exact imported class; `state.storage` accessible. |
| `runDurableObjectAlarm(stub): Promise<boolean>` | "Immediately runs and removes the Durable Object pointed to by stub's alarm"; `true` if one ran. |
| `evictDurableObject(stub, { webSockets? })` | Tears down the in-memory instance; storage persists. |
| `listDurableObjectIds(namespace)` | IDs created in the namespace; respects per-file isolation. |
| `reset()` | "Deletes all data from all attached bindings." |
| `abortAllDurableObjects()` / `evictAllDurableObjects()` | Reset instances without deleting storage / graceful eviction. |
| `createExecutionContext()` / `waitOnExecutionContext(ctx)` | For unit tests calling `worker.fetch(req, env, ctx)` directly; waits for `ctx.waitUntil` promises. |
| `createScheduledController`, `createMessageBatch`, `getQueueResult` | Cron / Queues helpers (Queues not used by Crosscut). |
| `applyD1Migrations(db, migrations, tableName = "d1_migrations")` | Applies un-applied migrations; `D1Migration = { name: string; queries: string[] }`. |
| `adminSecretsStore`, `introspectWorkflow`, `introspectWorkflowInstance`, `createPagesEventContext` | Not needed for Crosscut. |
| `fetchMock` | **No `export const fetchMock`** in 0.22.0's typings (only leftover `MockAgent`/`MockInterceptor` type declarations). Use MSW. |

`readD1Migrations(path)` lives in the Node-side package root (`@cloudflare/vitest-plugin` / `@cloudflare/vitest-pool-workers`), "ordered by migration number", each file "split into an array of SQL queries". Docs inconsistency for implementers: the migrate-to-vitest-plugin guide and the test-apis page reference a `@cloudflare/vitest-plugin/config` subpath, but the 1.1.3 `package.json` `exports` map contains only `.` and `./types` — import `readD1Migrations` from the package root (as F6/R2 do). 0.22.0's `./codemods/vitest-v3-to-v4` subpath is also gone in 1.1.3.

Sources: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ and the installed typings.

### F5. Testing Durable Objects, RPC and `ctx.exports` (verified from official fixtures)

- `fixtures/vitest-plugin-examples/durable-objects/test/alarm.test.ts`: schedule via `runInDurableObject(stub, (instance) => instance.scheduleReset(60_000))`, then `expect(await runDurableObjectAlarm(stub)).toBe(true)`, and a second call returns `false`.
- `rpc/test/unit.test.ts`: named entrypoints via `env.TEST_NAMED_ENTRYPOINT.ping()`; Durable Object RPC via `stub.increment(3)` and `await stub.value`; `using result = await stub.getCounter()` for `RpcTarget` results; errors asserted with `await expect(async () => await stub.x()).rejects.toThrowErrorMatchingInlineSnapshot(...)` — the same "wrap in an async function" pattern the template's `vitest.config.ts` comment relies on; RPC only exposes prototype members ("Only properties and methods defined on the prototype can be accessed over RPC" — relevant for aggregates: declare commands as methods, never as arrow-function fields). Also shows constructing a `WorkerEntrypoint` with a mocked `env` (`new TestDefaultEntrypoint(ctx, { ...env, KV_NAMESPACE: mockedKv })`) for pure unit tests of a module.
- `context-exports/test/durable-objects.test.ts`: `exports.Counter.idFromName("/path")` from `cloudflare:workers` — i.e. tests can reach Durable Objects and named entrypoints through the same loopback the `Aggregate` base class uses (`ctx.exports.Projections`). Exports that the plugin's esbuild pass cannot detect (wildcard re-exports, virtual modules) are declared with `additionalExports`, and Durable Objects are always discoverable from the `migrations` block.
- Sources: https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/durable-objects , https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/rpc , https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/context-exports

### F6. D1 in tests (verified: fixture + template + probe)

- `d1/vitest.config.ts`: `defineConfig(async () => { const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations")); ... cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc", environment: "production" }, miniflare: { bindings: { TEST_MIGRATIONS: migrations } } }) ... test: { setupFiles: ["./test/apply-migrations.ts"] } })`.
- `d1/test/env.d.ts` augments the generated types: `declare namespace Cloudflare { interface Env { DATABASE: D1Database; TEST_MIGRATIONS: import("cloudflare:test").D1Migration[]; } }`.
- The template (`/Users/peter/Projects/IOSApp/packages/core`) already does exactly this and passes 8/8 tests; my probe confirmed `env.DB.prepare("SELECT 1").first()` works from `cloudflare:workers`' `env`.
- Sources: https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/d1

### F7. Testing a Hono app (verified: Hono docs)

- `app.request(path | Request, init?, env?, executionCtx?)` — "All you need to do is create a Request and pass it to the Hono application to validate the Response"; the third argument supplies bindings. Source: https://hono.dev/docs/guides/testing
- `testClient(app)` from `hono/testing` gives a typed RPC-style client but "you must define your routes using chained methods directly on the Hono instance" for inference. Source: https://hono.dev/docs/helpers/testing
- Hono's Cloudflare Workers page still says "we recommend using @cloudflare/vitest-pool-workers" — it is Hono's own recommendation, not Cloudflare's, and it uses the stale package name (same tool). Source: https://hono.dev/docs/getting-started/cloudflare-workers
- `@hono/zod-validator@0.9.1` peers: `zod ^3.25.0 || ^4.0.0`, `hono >=4.11.2` (npm, verified) — compatible with hono 4.13.5 / zod 4.5.4.

### F8. Fake timers and coverage inside workerd

- Docs: "Vitest's fake timers do not apply to KV, R2 and cache simulators. For example, you cannot expire a KV key by advancing fake time." and "Native code coverage via V8 is not supported. You must use instrumented code coverage via Istanbul instead." Source: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
- Probe (run in the template with 0.22.0 / vitest 4.1.11, 4/4 passed, then deleted): `vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-02T00:00:00Z"))` makes `Date.now()` return that instant inside workerd; a `setTimeout(…, 60_000)` fires after `await vi.advanceTimersByTimeAsync(60_000)`. Vitest 4 does not fake `nextTick`/`queueMicrotask` unless listed in `toFake`. Source: https://vitest.dev/api/vi.html#vi-usefaketimers
- The fake `Date` **is** visible *inside a Durable Object instance* (fact-check probe, 2026-09-02: `runInDurableObject(stub, () => Date.now())` returned the `vi.setSystemTime()` value inside the template's `Counter` Durable Object; 4/4 tests passed, probe file deleted). This matches the `SELF` doc comment that the main Worker "runs in the same isolate/context as tests, so any global mocks will apply to it too". Still prefer explicit clock injection so tests do not depend on global mocks.
- Coverage: `@vitest/coverage-istanbul@4.1.11` exists; its `peerDependencies` is `vitest: 4.1.11` (exact) — keep vitest and the coverage package in lockstep. Vitest docs: istanbul "works across any JavaScript runtime". Source: https://vitest.dev/guide/coverage
- Debugging: `vitest --inspect --no-file-parallelism` opens an inspector on 9229 (or `--inspect=<port>`, `test.inspector.port`); VS Code compound launch "Debug Workers tests". Source: https://developers.cloudflare.com/workers/testing/vitest-integration/debugging/

### F9. `wrangler dev` and local state (verified: `wrangler dev --help` on 4.127.1 + docs)

- Flags: `--persist-to` "Specify directory to use for local persistence (defaults to .wrangler/state)"; `-l, --local` "Run locally with remote bindings disabled"; `-r, --remote` (default false); `--ip`, `--port`, `--inspector-port`; `--test-scheduled` "Test scheduled events by visiting /__scheduled in browser" (default false); `--var`, `-e/--env`, `--env-file`, `--log-level`, `--live-reload`, `--types` "Generate types from your Worker configuration", `--tunnel`.
- Docs: local data lives in `.wrangler/state` with subdirectories per binding type; delete the folder (or a subfolder) to reset — "Miniflare will recreate it the next time you run your dev command"; add the folder to `.gitignore`; if you use `--persist-to` with `wrangler dev` you must pass it to every other command that touches local data. Source: https://developers.cloudflare.com/workers/local-development/local-data/
- "the local workerd runtime runs with TZ=UTC" to match production. Bindings can be switched to real resources with `remote: true` in the binding config (writes affect real data). `.dev.vars` holds local secrets. Source: https://developers.cloudflare.com/workers/development-testing/
- On this machine (scratch project): `wrangler d1 migrations apply crosscut --local` printed "Executing on local database crosscut (…) from .wrangler/state/v3/d1", auto-answered the confirmation in a non-interactive shell ("Using fallback value in non-interactive context: yes"), and created `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`. Help text: "If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied."

### F10. D1 migrations and seeding (verified: `--help` + docs)

- `wrangler d1 migrations create <database> <message>`; `wrangler d1 migrations list|apply <database> [--local|--remote|--preview] [--persist-to <dir>] [-e env]` (`--persist-to` requires `--local`).
- `wrangler d1 execute <database> (--command "<sql>" | --file <path>) [--local|--remote] [--json] [-y]` — "You must provide either --command or --file".
- Migration files are `NNNN_name.sql` in the `migrations` directory by default; applied migrations are tracked in the `d1_migrations` table; binding-level config keys `migrations_dir`, `migrations_table`, `migrations_pattern`; docs recommend addressing the database by **name** rather than binding to avoid applying to the wrong DB; use `PRAGMA defer_foreign_keys = true` when a schema change would violate FKs. Source: https://developers.cloudflare.com/d1/reference/migrations/ and https://developers.cloudflare.com/d1/best-practices/local-development/
- There are no down migrations, and the `--local`/`--remote`/`--preview`/`--persist-to` flags are not documented on the migrations reference page; both facts come from the CLI itself — `wrangler d1 migrations --help` lists only the `create`, `list` and `apply` subcommands, and the per-command `--help` lists the flags (wrangler 4.127.1, run locally).
- The same `migrations/` directory feeds both `wrangler d1 migrations apply --local` (dev) and `readD1Migrations` + `applyD1Migrations` (tests) — one source of truth.

### F11. `wrangler types` and keeping `Env` in sync (verified: `--help` + a real run)

- `wrangler types [path]` (default `worker-configuration.d.ts`); `--env-interface` (default `"Env"`), `--include-runtime` (default true), `--include-env` (default true), `--strict-vars` (default true; literal/union types for vars), `--check` "Check if the types at the provided path are up to date without regenerating them" (verified: prints "Types at worker-configuration.d.ts are up to date." and is meant to fail CI when stale).
- Generated shape (real output, `--include-runtime=false`):

```ts
interface __BaseEnv_Env { DB: D1Database; APP_ENV: "dev"; USER: DurableObjectNamespace<import("./src/index").User>; }
declare namespace Cloudflare {
  interface GlobalProps { mainModule: typeof import("./src/index"); durableNamespaces: "User"; }
  interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
declare namespace NodeJS { interface ProcessEnv extends StringifyValues<Pick<Cloudflare.Env, "APP_ENV">> {} }
```

- This is why `env` from `cloudflare:workers` is typed as `Cloudflare.Env` in tests and why test-only bindings are added by augmenting `Cloudflare.Env` (F6).
- Docs: "To ensure that your types are always up-to-date, make sure to run wrangler types after any changes to your config file"; runtime types generated per compatibility date/flags are preferred over `@cloudflare/workers-types` for Workers, but "There are no plans to stop publishing the @cloudflare/workers-types package, which will still be the recommended way to type libraries and shared packages in the workers environment." Source: https://developers.cloudflare.com/workers/languages/typescript/
- Verified empirically (fact-check probe, 2026-09-02): a tsconfig that lists both `@cloudflare/workers-types` and a `worker-configuration.d.ts` generated with `--include-runtime` yields ~1300 `TS2300`/`TS2451` duplicate-identifier errors under `skipLibCheck: false`, and **0 errors under `skipLibCheck: true`**. The template's tsconfig has `skipLibCheck: true`, which is why the combination would appear to work — `skipLibCheck` masks the conflict rather than resolving it. Recommendation below (R6) avoids the combination.

### F12. TypeScript 7.0.2 (verified: npm + local run + Microsoft blog)

- npm: `typescript@7.0.2` has `bin: { tsc: 'bin/tsc' }`, engines `node >=16.20.0`, and platform packages `@typescript/typescript-{darwin-arm64, linux-x64, …}@7.0.2` as `optionalDependencies`. Local: `tsc --version` → `Version 7.0.2`; `tsc --noEmit` on `packages/core` passes in 0.077 s wall time; `tsc --help` still lists `--noEmit`, `--project/-p`, `--build/-b`.
- Blog "Announcing TypeScript 7.0": a "10x faster native port" written in Go; "speedups between 8x and 12x on full builds"; the executable remains `tsc` and the package name remains `typescript`; TypeScript 6.0 stays available as `@typescript/typescript6` with executable `tsc6`; "TypeScript 7.0 does not ship with an API" / "does not yet expose a stable programmatic API" (affects Vue/Volar/Angular, not this stack — Vite/esbuild strip types without the TS API); new `--builders` flag for parallel project-reference builds; LSP-based editor support with a dedicated VS Code extension. Removed: `target es5`, `downlevelIteration`, `moduleResolution node/node10/classic`, `module amd/umd/systemjs/none`, `baseUrl`, `esModuleInterop:false`/`allowSyntheticDefaultImports:false`. New defaults: `strict: true`, `module: esnext`, `types: []`, `rootDir: ./`. Source: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- "Announcing TypeScript 6.0": the same options are deprecated in 6.0 (`ignoreDeprecations: "6.0"` escape hatch), `--outFile` removed, `target` defaults to the current-year ES version, and "we intend for it to be the last release based on the current JavaScript codebase". Source: https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/
- Impact on a pnpm workspace: none structurally — each package keeps its own `tsconfig.json` and `tsc --noEmit`; because `types` defaults to `[]`, every package must list its ambient type sources explicitly (`@cloudflare/workers-types` + `@cloudflare/vitest-plugin/types` for libraries; `./worker-configuration.d.ts` + `@cloudflare/vitest-plugin/types` for the Worker). `moduleResolution: "Bundler"` remains valid. Project references / `--build` are optional; UNVERIFIED whether `tsc -b` semantics changed beyond the new `--builders` flag.

### F13. pnpm 11 (verified: pnpm docs + release post + issue tracker)

- Release notes 11.0: "onlyBuiltDependencies, onlyBuiltDependenciesFile, neverBuiltDependencies, ignoredBuiltDependencies, and ignoreDepScripts have all been removed" in favour of `allowBuilds`; "pnpm no longer reads the pnpm field in package.json"; "pnpm no longer reads non-auth settings from .npmrc" (use `pnpm-workspace.yaml` or `~/.config/pnpm/config.yaml`); "Drops Node.js 18, 19, 20, and 21"; `npm_config_*` env vars replaced by `pnpm_config_*`; codemod `pnpm-v10-to-v11`. Source: https://pnpm.io/blog/releases/11.0
- Build settings: `allowBuilds` is "a map of package matchers to explicitly allow (true) or disallow (false) script execution"; supports version specifiers (`nx@21.6.4 || 21.6.5: true`); "Packages not listed in allowBuilds are disallowed by default and are treated as unreviewed"; `strictDepBuilds` (default true): "the installation will exit with a non-zero exit code if any dependencies have unreviewed build scripts"; `dangerouslyAllowAllBuilds` exists but is discouraged; `pnpm approve-builds` writes entries. Source: https://pnpm.io/settings/build
- Bug #12469 (reported on pnpm 11.7.0, 2026-06-17; **closed as completed 2026-06-20**): `pnpm install --ignore-workspace` (even with `--frozen-lockfile`) rewrote `allowBuilds` values to the placeholder `set this to true or false`. Fixed by PR #12488 "fix: avoid updating allowBuilds when workspace is ignored", released in pnpm 11.9.0 (2026-06-23; the release notes cite #12469). This machine runs pnpm 11.24.0, so the bug is not a live hazard here. The template repo's `/Users/peter/Projects/IOSApp/pnpm-workspace.yaml` still reads `allowBuilds: { esbuild: set this to true or false, workerd: set this to true or false }` — a leftover of that corruption that must be fixed by hand. Sources: https://github.com/pnpm/pnpm/issues/12469 (state closed) ; https://github.com/pnpm/pnpm/pull/12488 ; https://github.com/pnpm/pnpm/releases/tag/v11.9.0 ; `cat /Users/peter/Projects/IOSApp/pnpm-workspace.yaml`
- `minimumReleaseAge` defaults to 1440 minutes (1 day) in pnpm 11 (11.0 release post). Consequence for R1: `@cloudflare/vitest-plugin@1.1.3` was published 2026-09-01T17:21Z and `typescript@7.0.2` was modified 2026-09-02, so a fresh `pnpm install` on 2026-09-02 may skip or refuse them until the window passes — lower `minimumReleaseAge` in `pnpm-workspace.yaml` or exclude those packages (`minimumReleaseAgeExclude`) if the install picks older versions. Source: https://pnpm.io/blog/releases/11.0
- Version note: R7 pins pnpm 11.24.0 because that is what is installed locally; npm `latest` is 11.25.0 (2026-08-29).

### F14. Turborepo 2.10.12 (verified: turborepo.dev docs)

- Root `package.json`: `"devEngines": { "packageManager": { "name": "pnpm", "version": "…" } }` ("The legacy top-level `packageManager` field is also supported"); install with `pnpm add turbo --save-dev --workspace-root`; `pnpm-workspace.yaml` lists `apps/*`, `packages/*`. Source: https://turborepo.dev/docs/getting-started/add-to-existing-repository , https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository
- `turbo.json`: `"$schema": "https://turborepo.dev/schema.json"`; task keys `dependsOn` (`"^build"` = dependencies first, `"lint"` = same package, `"web#lint": { dependsOn: ["utils#build"] }` = arbitrary), `outputs` (globs, `!` negation), `cache` (default true), `inputs` (`$TURBO_DEFAULT$`, `$TURBO_ROOT$`), `env`, `persistent` (default false), `interactive`, `interruptible`, `with`; global `ui: "tui" | "stream"` and `globalDependencies`. `dev` should be `{ "cache": false, "persistent": true }`; run `turbo dev --filter=<pkg>`; `turbo watch <task>` re-runs on changes respecting the graph. Sources: https://turborepo.dev/docs/reference/configuration , https://turborepo.dev/docs/crafting-your-repository/developing-applications
- Vitest `test.projects` (glob `'packages/*'` or inline configs; `--project <name>`) is the alternative to one-vitest-per-package; the official fixtures use per-package `defineProject` + `mergeConfig(configShared, …)`. Source: https://vitest.dev/guide/projects

## Recommendation for Crosscut

### R1. Toolchain pins (workers/api and packages/core)

```json
"devDependencies": {
  "@cloudflare/vitest-plugin": "^1.1.3",
  "@cloudflare/workers-types": "^5.20260902.1",
  "@vitest/coverage-istanbul": "4.1.11",
  "typescript": "^7.0.2",
  "vitest": "4.1.11",
  "wrangler": "^4.128.0",
  "msw": "^2.15.0",
  "@msw/cloudflare": "^0.0.1"
}
```

- Prefer `@cloudflare/vitest-plugin` over `@cloudflare/vitest-pool-workers@0.22.0`: identical API, includes the 1.1.2 Durable Object re-creation fix (aggregate tests create many objects), and bundles workerd 1.20260831. Note that *every* 1.x release already accepts a `compatibility_date` of 2026-08-27 (1.0.0 bundles miniflare 5.20260820 → workerd 1.20260820, window to 2026-08-27; 1.1.0 → 5.20260825; 1.1.1 → 5.20260826; 1.1.2 → 5.20260828; 1.1.3 → 5.20260831) — only 0.22.0 (workerd 1.20260815, window to 2026-08-22) is too old. If the team insists on 0.22.0, the Worker's `compatibility_date` used in tests must be ≤ 2026-08-22, which is why the template's test config uses 2025-09-01. The 1.1.3 recommendation stands for the 1.1.2 DO fix, not for the compatibility date. The plugin bundles its own wrangler/miniflare regardless of the project's wrangler version.
- pnpm 11's default `minimumReleaseAge` of 1 day (F13) can make a fresh `pnpm install` on 2026-09-02 skip `@cloudflare/vitest-plugin@1.1.3` (published 2026-09-01T17:21Z) and `typescript@7.0.2` (modified 2026-09-02); lower the setting or exclude those packages if the lockfile resolves to older versions.
- Pin `vitest` and `@vitest/coverage-istanbul` to the same exact version.
- `msw`/`@msw/cloudflare` only if a module calls external HTTP (Apple/RevenueCat webhooks verification, push delivery). Not needed for the first milestone.

### R2. One `wrangler.jsonc`, one migrations directory, one `vitest.config.ts` per Worker package

`workers/api/vitest.config.ts`:

```ts
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")) },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    coverage: { provider: "istanbul", include: ["src/**"] },
    onUnhandledError(error) { /* keep the template's RPC duplicate filter verbatim */ },
  },
}));
```

Point tests at the **real** `wrangler.jsonc` (not a test copy) so bindings, DO migrations and flags match production; add test-only bindings through `miniflare.bindings`. Keep `packages/core`'s separate fixture Worker as is (it is a library and needs its own host Worker).

### R3. Test tiers (all run inside workerd; startup cost is ~1–2 s per file)

| Tier | What | How |
|---|---|---|
| Domain rules | streak arithmetic, token/star rewards (`parFor`, hint costs, `colProgress`, wheel prizes, pricing plan copy) | plain functions in `packages/shared` or `workers/api/src/modules/*/rules.ts`; tested with no bindings. Pass `now` in explicitly. |
| Aggregates | `User`/`Wallet`/`PuzzleAttempt`/`DailyDrop` objects extending `Aggregate` | `aggregateStub(env.X, kind, id)` → commands → assert D1 projection rows; `runDurableObjectAlarm` for failed-flush retry; `evictDurableObject` for reload; idempotency test per command (the template's three-test minimum). |
| Modules and events | e.g. `PuzzleSolved` → economy credits tokens, streak module updates, collections progress, leaderboard projection | call the module's handler directly with the real `env` (or construct the `WorkerEntrypoint` with `createExecutionContext()` and a partially mocked `env` as in the rpc fixture) and assert on D1 + snapshots. Because events are in-process calls, an event test is just a function call. |
| HTTP end-to-end | Hono routes: auth header → validation → module → aggregate → projection → response | `exports.default.fetch("http://x/feed", { headers })`; assert status, JSON, and D1 rows. Use `app.request()` for cheap validation-only tests of the Zod layer. |

Conventions: unique ids per test (`crypto.randomUUID()`), one feature per file (per-file isolation), never rely on `beforeAll` state from another file, always `await` storage calls and consume bodies, `using` for RpcTarget results, `await expect(async () => { await stub.cmd(); }).rejects.toThrow()` for command failures.

### R4. Time

Crosscut's economy is day-bounded (daily drop, streak "9h 14m left today", one free spin per day). Pass `now: number` from the gateway into every command and event payload; the Hono layer reads `Date.now()` once per request. Tests then set time by argument. Use `vi.useFakeTimers()` + `vi.setSystemTime()` only for gateway-level tests (verified to work inside workerd) and never expect it to advance KV TTLs or Durable Object alarms — call `runDurableObjectAlarm(stub)` for alarm paths (streak-expiry alarms, projection retries).

### R5. Local developer loop

```
pnpm install                              # allowBuilds must whitelist esbuild + workerd
pnpm --filter api types                   # wrangler types  → worker-configuration.d.ts (committed)
pnpm --filter api migrate:local           # wrangler d1 migrations apply crosscut --local
pnpm --filter api seed:local              # wrangler d1 execute crosscut --local --file=./seed/dev.sql (puzzles en/ru/uk, collections)
pnpm dev                                  # turbo dev → wrangler dev --ip 0.0.0.0 --port 8787
```

- Commit `worker-configuration.d.ts`; CI runs `wrangler types --check` before `tsc --noEmit`.
- `.gitignore`: `.wrangler/`, `.dev.vars`.
- Reset local data with `rm -rf workers/api/.wrangler/state`.
- Local workerd is `TZ=UTC`; production is too — all "today" logic should be computed from the user's timezone offset stored in the `User` aggregate, not from the server clock's zone.

### R6. Types

- `workers/api/tsconfig.json`: `"types": ["./worker-configuration.d.ts", "@cloudflare/vitest-plugin/types"]` (runtime types generated by wrangler; do **not** also list `@cloudflare/workers-types` here — mixing them produces ~1300 duplicate-identifier errors that `skipLibCheck: true` silently hides, see F11).
- `packages/core` and `packages/shared`: keep `@cloudflare/workers-types` (Cloudflare's recommendation for libraries).
- Test-only bindings: `workers/api/test/env.d.ts` augments `Cloudflare.Env` with `TEST_MIGRATIONS: import("cloudflare:test").D1Migration[]`.
- Hono: `new Hono<{ Bindings: Env; Variables: { userId: string; now: number } }>()`, `Env` being the generated global.

### R7. Monorepo files

`pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "workers/*"
  - "packages/*"
allowBuilds:
  esbuild: true
  workerd: true
```

Fix the template's clobbered placeholder before copying it (it is a leftover of pnpm issue #12469, which was fixed in pnpm 11.9.0 — on the pinned pnpm 11.24.0 `pnpm install --ignore-workspace` no longer rewrites `allowBuilds`; source: https://github.com/pnpm/pnpm/releases/tag/v11.9.0). Root `package.json` gets `"devEngines": { "packageManager": { "name": "pnpm", "version": "11.24.0" } }` (or `"packageManager": "pnpm@11.24.0"`; 11.24.0 is the locally installed version, npm `latest` is 11.25.0) and `"turbo": "2.10.12"`. If a fresh install resolves older versions of packages published within the last day (see F13 `minimumReleaseAge`), add `minimumReleaseAge: 0` (or an exclude list) to `pnpm-workspace.yaml`.

`turbo.json`

```jsonc
{
  "$schema": "https://turborepo.dev/schema.json",
  "tasks": {
    "types":     { "inputs": ["wrangler.jsonc", "src/**/*.ts"], "outputs": ["worker-configuration.d.ts"] },
    "typecheck": { "dependsOn": ["types", "^typecheck"] },
    "test":      { "dependsOn": ["types"], "inputs": ["$TURBO_DEFAULT$", "migrations/**"], "outputs": ["coverage/**"] },
    "dev":       { "cache": false, "persistent": true },
    "migrate:local": { "cache": false },
    "seed:local":    { "cache": false }
  }
}
```

`packages/core` has no `types` task (no wrangler config of its own besides the test fixture), so its `typecheck`/`test` simply have no `types` dependency; turbo skips missing scripts.

### R8. CI

`pnpm install --frozen-lockfile` → `turbo typecheck test` → optional `vitest run --coverage` with the istanbul provider. Node 26 satisfies both pnpm 11 (≥22) and Vitest 4 (≥20). Vitest 4 tests run concurrently per file; if a suite needs cross-file state (it should not), run that package with `--max-workers=1 --no-isolate`.

## Code sketches

### Aggregate test (streak-at-risk alarm)

```ts
// workers/api/test/user.test.ts
import { runDurableObjectAlarm, evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { aggregateStub } from "@app/core";

const DAY = 86_400_000;
const user = (id: string) => aggregateStub(env.USER, "user", id);

describe("User streak", () => {
  it("increments the streak once per calendar day", async () => {
    const id = crypto.randomUUID();
    const u = user(id);
    await u.init(id);
    const t0 = Date.UTC(2026, 8, 1, 9);
    expect((await u.recordSolve({ puzzleId: "en-mini-1", now: t0 })).state.streak).toBe(1);
    expect((await u.recordSolve({ puzzleId: "en-mini-2", now: t0 + 3_600_000 })).state.streak).toBe(1); // same day, no-op
    expect((await u.recordSolve({ puzzleId: "en-mini-3", now: t0 + DAY })).state.streak).toBe(2);
    const row = await env.DB.prepare("SELECT streak FROM user_state WHERE id = ?").bind(id).first();
    expect(row).toMatchObject({ streak: 2 });
  });

  it("breaks the streak through the expiry alarm, even after eviction", async () => {
    const id = crypto.randomUUID();
    const u = user(id);
    await u.init(id);
    await u.recordSolve({ puzzleId: "en-mini-1", now: Date.UTC(2026, 8, 1, 9) });
    await evictDurableObject(u);                       // constructor must re-arm the alarm
    expect(await runDurableObjectAlarm(u)).toBe(true); // alarm scheduled at end of next day
    expect((await u.snapshot()).state.streak).toBe(0);
  });
});
```

### Module/event test (in-process event = direct call)

```ts
// workers/api/test/economy.test.ts
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { onPuzzleSolved } from "../src/modules/economy/handlers";

it("credits tokens for a first, hint-free solve under par", async () => {
  const userId = crypto.randomUUID();
  await env.USER.get(env.USER.idFromName(`user:${userId}`)).init(userId);
  const result = await onPuzzleSolved(env, {
    userId, puzzleId: "en-mini-1", size: 5, solveTimeSec: 120, usedHints: false, now: Date.UTC(2026, 8, 1, 9),
  });
  expect(result.tokensEarned).toBeGreaterThan(0);
  const row = await env.DB.prepare("SELECT tokens FROM wallet_state WHERE id = ?").bind(userId).first();
  expect(row).toMatchObject({ tokens: result.tokensEarned });
});
```

### HTTP end-to-end through the Hono default export

```ts
// workers/api/test/feed.test.ts
import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { signTestSession } from "./helpers/auth";

it("GET /feed returns today's drop first", async () => {
  const res = await exports.default.fetch("http://crosscut.test/feed", {
    headers: { authorization: `Bearer ${await signTestSession("u1")}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json<{ cards: Array<{ kind: string }> }>();
  expect(body.cards[0].kind).toBe("daily");
});
```

### Route-level validation test with `app.request`

```ts
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import app from "../src/app";

it("rejects a hint request without a puzzleId", async () => {
  const res = await app.request("/hints/fifty", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }, env);
  expect(res.status).toBe(400);
});
```

### Test setup file and type augmentation

```ts
// workers/api/test/setup.ts
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); // idempotent; setup files run outside per-file isolation

// workers/api/test/env.d.ts
declare namespace Cloudflare {
  interface Env { TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] }
}
```

### Outbound HTTP mock (only when a module calls the internet)

```ts
// test/network.ts
import { setupNetwork } from "@msw/cloudflare";
export const network = setupNetwork();
// test/setup.ts additions
beforeAll(() => network.enable()); afterEach(() => network.resetHandlers()); afterAll(() => network.disable());
// in a test
network.use(http.post("https://exp.host/--/api/v2/push/send", () => HttpResponse.json({ data: [{ status: "ok" }] })));
```

### package.json scripts (workers/api)

```json
{
  "scripts": {
    "dev": "wrangler dev --ip 0.0.0.0 --port 8787",
    "types": "wrangler types",
    "types:check": "wrangler types --check",
    "typecheck": "wrangler types --check && tsc --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "test:debug": "vitest --inspect --no-file-parallelism",
    "migrate:new": "wrangler d1 migrations create crosscut",
    "migrate:local": "wrangler d1 migrations apply crosscut --local",
    "seed:local": "wrangler d1 execute crosscut --local --file=./seed/dev.sql",
    "deploy": "wrangler deploy"
  }
}
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | `@cloudflare/vitest-pool-workers` was renamed to `@cloudflare/vitest-plugin` for v1 (1.0.0, 2026-08-20; latest 1.1.3); 0.22.0 (2026-08-18) is the last release under the old name; "The Vitest configuration API is unchanged." | https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ ; `npm view` on both packages | high | confirmed |
| C2 | Migration codemod: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` (rewrites dependency, imports and tsconfig `types`); `@cloudflare/codemods` 0.1.0 is on npm. | https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/vitest-plugin/CHANGELOG.md (1.0.0); `npm view @cloudflare/codemods` | high | confirmed |
| C3 | Current config API is the `cloudflareTest()` Vite plugin with `defineConfig` from `vitest/config`; `defineWorkersConfig`/`defineWorkersProject`/`poolOptions.workers` are gone. Installed 0.22.0 exports: `cloudflareTest`, `cloudflarePool`, `readD1Migrations`, `buildPagesASSETSBinding`, `D1Migration`. | https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ ; `dist/pool/index.d.mts` of installed 0.22.0 | high | confirmed |
| C4 | Plugin options are `main`, `remoteBindings`, `verbose`, `additionalExports`, `miniflare`, `wrangler.{configPath,environment}` (exact for 0.22.0; 1.1.3 adds `experimental.newConfig`); `isolatedStorage` and `singleWorker` no longer exist. | installed `dist/pool/index.d.mts` (Zod schema); 1.1.3 Zod schema; https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/ | high | confirmed |
| C5 | Storage isolation is per test file; test files run concurrently; `--max-workers=1 --no-isolate` shares storage across files. | https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/ | high | confirmed |
| C6 | Setup files run outside per-file isolation and may run multiple times; `applyD1Migrations()` is idempotent so it is safe there. | https://raw.githubusercontent.com/cloudflare/workers-sdk/main/fixtures/vitest-plugin-examples/d1/test/apply-migrations.ts | high | confirmed |
| C7 | `env` and `SELF` from `cloudflare:test` are `@deprecated` in 0.22.0; replacements are `import { env, exports } from "cloudflare:workers"` and `exports.default.fetch()`. Both old and new forms work in 0.22.0. | installed `types/cloudflare-test.d.ts`; https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ ; probe test run 2026-09-02 (4/4 passed) | high | confirmed |
| C8 | `fetchMock` is not exported by 0.22.0's `cloudflare:test` typings; the migration guide says to remove it and mock `globalThis.fetch` or use MSW; 0.22.0 requires MSW >= 2.14 and recommends `@msw/cloudflare` `setupNetwork()`. | installed typings; migrate-from-vitest-3-to-vitest-4 guide; CHANGELOG 0.22.0; `npm view @msw/cloudflare` (0.0.1, peer msw >=2.14.1) | high | confirmed |
| C9 | `cloudflare:test` provides `runInDurableObject`, `runDurableObjectAlarm` (returns true if an alarm ran), `evictDurableObject(stub, {webSockets?})`, `listDurableObjectIds`, `reset`, `abortAllDurableObjects`, `evictAllDurableObjects`, `createExecutionContext`, `waitOnExecutionContext`, `applyD1Migrations(db, migrations, table = "d1_migrations")`. | https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ ; installed typings | high | confirmed |
| C10 | The D1 recipe reads migrations in Node with `readD1Migrations(dir)`, passes them as `miniflare.bindings.TEST_MIGRATIONS`, applies them in `setupFiles`, and types them via `declare namespace Cloudflare { interface Env { TEST_MIGRATIONS: import("cloudflare:test").D1Migration[] } }`. | https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/d1 ; template `packages/core` (8/8 tests) | high | confirmed |
| C11 | RPC in tests: only prototype members are reachable ("Only properties and methods defined on the prototype can be accessed over RPC"); `using` disposes RpcTarget results; failures are asserted with `await expect(async () => await stub.m()).rejects…`. | https://raw.githubusercontent.com/cloudflare/workers-sdk/main/fixtures/vitest-plugin-examples/rpc/test/unit.test.ts | high | confirmed |
| C12 | Tests can reach Durable Objects and entrypoints via `exports.<Class>` from `cloudflare:workers` (the `ctx.exports` loopback); undetectable exports are declared with `additionalExports`. | https://raw.githubusercontent.com/cloudflare/workers-sdk/main/fixtures/vitest-plugin-examples/context-exports/test/durable-objects.test.ts ; known-issues page | high | confirmed |
| C13 | `vi.useFakeTimers()` + `vi.setSystemTime()` + `vi.advanceTimersByTimeAsync()` work inside workerd for `Date.now()` and `setTimeout`; fake timers do not apply to KV/R2/cache simulators. | probe test in template (passed); https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/ | high | confirmed |
| C14 | Fake `Date` is also visible inside the main Worker's Durable Object instances because the main Worker runs in the same isolate as the tests. | doc comment on `SELF` in installed typings ("any global mocks will apply to it too"); fact-check probe 2026-09-02: `runInDurableObject(stub, () => Date.now())` returned the `vi.setSystemTime()` value inside the template's `Counter` DO (4/4 passed) | high | confirmed |
| C15 | V8 coverage is unsupported in workerd; use Istanbul. `@vitest/coverage-istanbul@4.1.11` pins peer `vitest: 4.1.11` exactly. | known-issues page; https://vitest.dev/guide/coverage ; `npm view @vitest/coverage-istanbul@4.1.11 peerDependencies` | high | confirmed |
| C16 | Vitest 4 requires Node >= 20 and Vite >= 6; `workspace` → `projects`; `poolOptions` removed; `maxWorkers` replaces `maxThreads/maxForks`; `isolate` default true (`--no-isolate`); `fileParallelism` default true (`--no-file-parallelism` forces 1 worker). | https://vitest.dev/guide/migration ; https://vitest.dev/config/maxworkers ; https://vitest.dev/config/isolate ; https://vitest.dev/config/fileparallelism | high | confirmed |
| C17 | Debug tests with `vitest --inspect --no-file-parallelism` (port 9229 or `--inspect=<port>` / `test.inspector.port`). | https://developers.cloudflare.com/workers/testing/vitest-integration/debugging/ | high | confirmed |
| C18 | The plugin injects `nodejs_compat`, `no_nodejs_compat_v2`, `export_commonjs_default`; production must set `nodejs_compat` explicitly if Node APIs are used. | isolation-and-concurrency page | high | confirmed |
| C19 | 0.22.0 bundles wrangler 4.124.0 + miniflare 5.20260815; workerd accepts compatibility dates only up to 7 days past its release; the plugin now uses a fixed default date. Therefore a Worker with `compatibility_date: 2026-08-27` needs vitest-plugin 1.x (any 1.x release: 1.0.0 already bundles workerd 1.20260820, window to 2026-08-27; 1.1.3 bundles 1.20260831) or a lower date under 0.22.0. Earlier wording over-stated the requirement as "1.1.x". | `npm view` deps for 0.22.0 and 1.0.0–1.1.3; CHANGELOG 0.22.0 ("workerd only accepts a compatibility date up to 7 days beyond its own release") | high | confirmed |
| C20 | `wrangler dev` flags include `--persist-to` (defaults to `.wrangler/state`), `--local`, `--remote`, `--ip`, `--port`, `--inspector-port`, `--test-scheduled` (`/__scheduled`), `--var`, `--env`, `--env-file`, `--live-reload`, `--types`, `--tunnel`. | `wrangler dev --help` (4.127.1, run locally) | high | confirmed |
| C21 | Local state lives under `.wrangler/state/v3/<binding-type>` (verified `d1/miniflare-D1DatabaseObject`); delete to reset; commands touching local data must repeat `--persist-to` if `dev` used it; local workerd runs `TZ=UTC`. | https://developers.cloudflare.com/workers/local-development/local-data/ ; https://developers.cloudflare.com/workers/development-testing/ ; local run | high | confirmed |
| C22 | `wrangler d1 migrations apply <db> --local` applies `NNNN_name.sql` files from `migrations/` (or `migrations_dir`), tracks them in `d1_migrations`, auto-confirms in non-interactive shells, rolls back a failing migration; `wrangler d1 execute <db> --local (--file \| --command) [--json] [-y]` seeds local data; no down migrations (only `create`/`list`/`apply` subcommands exist). | `wrangler d1 migrations --help`, `wrangler d1 migrations apply --help`, `wrangler d1 execute --help`, local run (the flags and the absence of down migrations come from the CLI, not the docs page); https://developers.cloudflare.com/d1/reference/migrations/ | high | confirmed |
| C23 | `wrangler types [path]` defaults to `worker-configuration.d.ts`; flags `--env-interface` (default `Env`), `--include-runtime` (true), `--include-env` (true), `--strict-vars` (true), `--check`; output declares `Cloudflare.Env`, global `Env`, `Cloudflare.GlobalProps { mainModule; durableNamespaces }` and types DO bindings as `DurableObjectNamespace<import("./src/index").User>`. | `wrangler types --help` and a real run on 4.127.1; https://developers.cloudflare.com/workers/languages/typescript/ | high | confirmed |
| C24 | Cloudflare recommends generated runtime types for Workers but keeps publishing `@cloudflare/workers-types` as "the recommended way to type libraries and shared packages". | https://developers.cloudflare.com/workers/languages/typescript/ | high | confirmed |
| C25 | Listing both `@cloudflare/workers-types` and a runtime-inclusive `worker-configuration.d.ts` in one tsconfig produces duplicate global declarations (~1300 `TS2300`/`TS2451` errors under `skipLibCheck: false`; 0 errors under `skipLibCheck: true`, which masks the conflict — the template's tsconfig has `skipLibCheck: true`). | fact-check probe 2026-09-02 (`tsc --noEmit` with both type sources, toggling `skipLibCheck`) | high | confirmed |
| C26 | TypeScript 7.0.2 is the native Go compiler published as `typescript` with bin `tsc`; per-platform binaries via `@typescript/typescript-*` optionalDependencies; `tsc --noEmit` on the template passes (~0.08 s); TS 6.0 remains as `@typescript/typescript6` (`tsc6`); TS 7 has no programmatic API yet. | `npm view typescript@7.0.2`; local `tsc --version`/`tsc --noEmit`; https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ | high | confirmed |
| C27 | TS 7 removed `target es5`, `downlevelIteration`, `moduleResolution node/node10/classic`, `module amd/umd/systemjs/none`, `baseUrl`, `outFile`, `esModuleInterop:false`/`allowSyntheticDefaultImports:false`; defaults now `strict: true`, `module: esnext`, `types: []`, `rootDir: ./`; `--builders` controls parallel project builds. | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ ; https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ | high | confirmed |
| C28 | pnpm 11 removed `onlyBuiltDependencies`, `onlyBuiltDependenciesFile`, `neverBuiltDependencies`, `ignoredBuiltDependencies`, `ignoreDepScripts` in favour of `allowBuilds` (map, supports version specifiers); unlisted packages are unreviewed; `strictDepBuilds` defaults to true (install exits non-zero); `package.json` `pnpm` field and non-auth `.npmrc` settings are no longer read; Node >= 22. | https://pnpm.io/blog/releases/11.0 ; https://pnpm.io/settings/build | high | confirmed |
| C29 | ~~`pnpm install --ignore-workspace` (pnpm 11.7.0, issue open) rewrites `allowBuilds` values to the placeholder `set this to true or false`~~ **Corrected:** the bug existed on 11.7.0 but issue #12469 is closed (2026-06-20), fixed by PR #12488 and released in pnpm 11.9.0 (2026-06-23); it does not affect the pinned pnpm 11.24.0. The template's `pnpm-workspace.yaml` does still contain that placeholder as a leftover and must be fixed by hand. | https://github.com/pnpm/pnpm/issues/12469 (closed) ; https://github.com/pnpm/pnpm/pull/12488 ; https://github.com/pnpm/pnpm/releases/tag/v11.9.0 ; `/Users/peter/Projects/IOSApp/pnpm-workspace.yaml` | high (second half only) | refuted |
| C30 | Turborepo needs `devEngines.packageManager` (or legacy `packageManager`) in the root `package.json`; `turbo.json` schema `https://turborepo.dev/schema.json` with `dependsOn` (`^`), `outputs`, `cache`, `persistent`, `inputs` (`$TURBO_DEFAULT$`), `env`, `interactive`, `interruptible`, `with`; `dev` = `{ cache: false, persistent: true }`; `turbo dev --filter=<pkg>`, `turbo watch`. | https://turborepo.dev/docs/getting-started/add-to-existing-repository ; https://turborepo.dev/docs/reference/configuration ; https://turborepo.dev/docs/crafting-your-repository/developing-applications | high | confirmed |
| C31 | Hono: `app.request(path, init, env, executionCtx)` and `testClient` from `hono/testing` (typed only with chained route definitions); Hono's docs (their own recommendation, "we recommend using @cloudflare/vitest-pool-workers") still reference the old package name. `@hono/zod-validator@0.9.1` peers `zod ^3.25 \|\| ^4`, `hono >=4.11.2`. | https://hono.dev/docs/guides/testing ; https://hono.dev/docs/helpers/testing ; https://hono.dev/docs/getting-started/cloudflare-workers ; `npm view @hono/zod-validator@0.9.1 peerDependencies` | high | confirmed |
| C32 | vitest-plugin 1.1.2 fixed "slowdowns and crashes in tests that repeatedly recreate Durable Objects" (stack overflow) — a fix absent from 0.22.0. | CHANGELOG 1.1.2 | high | confirmed |
| C33 | Older docs stated Durable Object alarms are not reset between test runs / do not respect isolated storage; the current known-issues page has no such section. Upstream: workers-sdk #5388 was closed as completed on 2026-03-02 by workerd PR #1918 (alarms deleted on `abortAllDurableObjects()`), but that change was reverted and vitest-pool-workers stopped calling the API — no upstream mechanism currently guarantees alarm reset between files; the guard test in Open question 3 is the mitigation. | web search snippet of docs.cloudflare.com mirror; current page headings verified; https://github.com/cloudflare/workers-sdk/issues/5388 ; https://github.com/cloudflare/workerd/pull/1918 | medium | confirmed |

## Open questions

1. **Old vs new package name for the first commit.** The orchestrator's ground truth lists `@cloudflare/vitest-pool-workers 0.22.0` as "latest", which is true for that name, but the maintained successor is `@cloudflare/vitest-plugin 1.1.3` with the identical API. Recommendation is 1.1.3; confirm the team is fine deviating from the pinned list (it also drops the compatibility-date workaround, C19).
2. **Fake `Date` inside Durable Object instances (C14).** Settled by the fact-check probe: the fake `Date` is visible inside the template's `Counter` Durable Object. Explicit `now` injection (R4) remains the preferred design.
3. **Alarm behaviour across test files (C33).** The 1.x docs no longer mention alarms bleeding between tests, and the upstream fix (workerd PR #1918 via workers-sdk #5388) was reverted, so nothing guarantees a reset. Add one guard test that asserts `runDurableObjectAlarm(stub)` returns `false` on a fresh object in a new file.
4. **Mixing `@cloudflare/workers-types` with generated runtime types (C25).** Settled by the fact-check probe: the mix produces ~1300 duplicate-identifier errors under `skipLibCheck: false` and is only hidden by `skipLibCheck: true`. The recommendation avoids the mix by using workers-types only in library packages and generated types only in the Worker package. If `packages/core` must compile against `Cloudflare.Env` from the app, add a `types` reference from the Worker's tsconfig instead.
5. **TypeScript 7 `--build` / project references.** Not needed for the plan (per-package `tsc --noEmit` under turbo), but if build orchestration moves to `tsc -b`, verify `--builders` and the new `types: []`/`rootDir` defaults against the actual project graph.
6. **pnpm catalogs** for pinning `vitest`, `wrangler`, `typescript` once across packages were not verified for pnpm 11 in this research; per-package exact pins are the safe default.
7. **Auth in end-to-end tests.** The `signTestSession` helper in the sketches assumes Better Auth (from `concepts.md`) can mint a session in-test; whether to hit Better Auth's real sign-in route in a `beforeAll` per file or stub the session-verification middleware via a test binding is a design decision for the auth research topic.

## Fact-check log

Fact-check run 2026-09-02 against the sources below (docs re-fetched, npm registry queried, GitHub issue/PR state read, and probes run in `/Users/peter/Projects/IOSApp`). 32 claims confirmed, 1 refuted (C29), 0 unverifiable.

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ ; `npm view @cloudflare/vitest-pool-workers` ; `npm view @cloudflare/vitest-plugin` |
| C2 | confirmed | https://raw.githubusercontent.com/cloudflare/workers-sdk/main/packages/vitest-plugin/CHANGELOG.md ; `npm view @cloudflare/codemods` |
| C3 | confirmed | https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/ ; installed 0.22.0 `dist/pool/index.d.mts` |
| C4 | confirmed | installed 0.22.0 Zod schema; 1.1.3 Zod schema (adds `experimental.newConfig`); https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/ |
| C5 | confirmed | https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/ |
| C6 | confirmed | https://raw.githubusercontent.com/cloudflare/workers-sdk/main/fixtures/vitest-plugin-examples/d1/test/apply-migrations.ts |
| C7 | confirmed | installed `types/cloudflare-test.d.ts`; https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ ; migrate-from-vitest-3-to-vitest-4 guide (`exports.default.fetch()` does not expose Assets) |
| C8 | confirmed | installed typings; migrate-from-vitest-3-to-vitest-4 guide; CHANGELOG 0.22.0; `npm view @msw/cloudflare` |
| C9 | confirmed | https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ ; installed typings |
| C10 | confirmed | https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/d1 ; template `packages/core` test run |
| C11 | confirmed | https://raw.githubusercontent.com/cloudflare/workers-sdk/main/fixtures/vitest-plugin-examples/rpc/test/unit.test.ts |
| C12 | confirmed | https://raw.githubusercontent.com/cloudflare/workers-sdk/main/fixtures/vitest-plugin-examples/context-exports/test/durable-objects.test.ts ; known-issues page |
| C13 | confirmed | probe test in template; https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/ |
| C14 | confirmed | fact-check probe: `runInDurableObject(stub, () => Date.now())` returned the `vi.setSystemTime()` value inside the template's `Counter` DO (4/4 passed, probe deleted) |
| C15 | confirmed | known-issues page; https://vitest.dev/guide/coverage ; `npm view @vitest/coverage-istanbul@4.1.11 peerDependencies` |
| C16 | confirmed | https://vitest.dev/guide/migration ; https://vitest.dev/config/maxworkers ; https://vitest.dev/config/isolate ; https://vitest.dev/config/fileparallelism |
| C17 | confirmed | https://developers.cloudflare.com/workers/testing/vitest-integration/debugging/ |
| C18 | confirmed | https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/ |
| C19 | confirmed | `npm view` deps for 0.22.0 and 1.0.0–1.1.3; CHANGELOG 0.22.0 (note: every 1.x release already accepts 2026-08-27; only 0.22.0 is too old) |
| C20 | confirmed | `wrangler dev --help` (4.127.1) |
| C21 | confirmed | https://developers.cloudflare.com/workers/local-development/local-data/ ; https://developers.cloudflare.com/workers/development-testing/ ; local run |
| C22 | confirmed | `wrangler d1 migrations --help`, `wrangler d1 migrations apply --help`, `wrangler d1 execute --help`, local run; https://developers.cloudflare.com/d1/reference/migrations/ (the docs page does not itself state "no down migrations" or the `--local/--remote/--preview/--persist-to` flags; the CLI does) |
| C23 | confirmed | `wrangler types --help` and a real run on 4.127.1; https://developers.cloudflare.com/workers/languages/typescript/ |
| C24 | confirmed | https://developers.cloudflare.com/workers/languages/typescript/ |
| C25 | confirmed | fact-check probe: ~1300 `TS2300`/`TS2451` errors with `skipLibCheck: false`, 0 with `skipLibCheck: true` (template tsconfig uses `true`) |
| C26 | confirmed | `npm view typescript@7.0.2`; local `tsc --version` / `tsc --noEmit`; https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ |
| C27 | confirmed | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ ; https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ |
| C28 | confirmed | https://pnpm.io/blog/releases/11.0 ; https://pnpm.io/settings/build (the 11.0 post also sets `minimumReleaseAge` to 1440 minutes by default, now noted in F13/R1) |
| C29 | refuted | https://github.com/pnpm/pnpm/issues/12469 (state closed, closed_at 2026-06-20) ; https://github.com/pnpm/pnpm/pull/12488 ; https://github.com/pnpm/pnpm/releases/tag/v11.9.0 ; `cat /Users/peter/Projects/IOSApp/pnpm-workspace.yaml` (placeholder still present) |
| C30 | confirmed | https://turborepo.dev/docs/getting-started/add-to-existing-repository ; https://turborepo.dev/docs/reference/configuration ; https://turborepo.dev/docs/crafting-your-repository/developing-applications |
| C31 | confirmed | https://hono.dev/docs/guides/testing ; https://hono.dev/docs/helpers/testing ; https://hono.dev/docs/getting-started/cloudflare-workers ("we recommend" — Hono's recommendation, not Cloudflare's) ; `npm view @hono/zod-validator@0.9.1 peerDependencies` |
| C32 | confirmed | CHANGELOG 1.1.2 |
| C33 | confirmed | docs.cloudflare.com mirror snippet; current known-issues headings; https://github.com/cloudflare/workers-sdk/issues/5388 (closed 2026-03-02 via https://github.com/cloudflare/workerd/pull/1918 , later reverted; vitest-pool-workers no longer calls that API) |

Other corrections applied during the fact-check (not tied to a single claim): F3 heading count (8 top-level sections, three sub-items under Storage isolation); F4 `@cloudflare/vitest-plugin/config` subpath referenced by the docs does not exist in 1.1.3's `exports` (only `.` and `./types`; `./codemods/vitest-v3-to-v4` also gone); R7 pnpm pin 11.24.0 is the local install, npm `latest` is 11.25.0.
