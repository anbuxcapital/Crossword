# Modular monolith principles applied to TypeScript on Workers

Slug: `modular-monolith-principles` · Researched 2026-09-02 against the pinned stack (wrangler 4.128.0, hono 4.13.5, zod 4.5.4, TypeScript 7.0.2, vitest 4.1.11, `@cloudflare/vitest-plugin` 1.1.3 / `@cloudflare/vitest-pool-workers` 0.22.0, pnpm 11.24.0 — pinned, not current: npm `latest` is 11.25.0 (published 2026-08-29), Node 26.8.1). Companion documents: `in-process-event-bus.md` (bus mechanics), `domain-spec-extraction.md` (endpoints, formulas), `workers-modular-monolith.md` (Workers RPC seams), `testing-and-dx.md`, `hono-best-practices.md`.

## Summary

- **What "modular monolith" means here.** One deployment unit (one Worker) whose code is split into business modules that are independent, cohesive, encapsulated and communicate only through a declared contract (Grzybek). Simon Brown's rule of thumb is the design driver: prefer boundaries the *compiler* enforces over boundaries enforced by discipline or post-hoc tooling, and keep the public surface of each module as small as possible ("the fewer public types you have, the fewer the number of potential dependencies").
- **Module = folder with one public `index.ts`.** `workers/gateway/src/modules/<name>/` holds `index.ts` (commands + queries), `contract.ts` (Zod schemas of the module's integration events, DTOs, example payloads), `http.ts` (its Hono sub-app), `subscriptions.ts` (handlers for other modules' events) and `internal/**` (Durable Object classes, SQL, pure domain functions). Nothing outside the folder may import `internal/**`; the only sanctioned cross-module imports are another module's `index.ts` and `contract.ts`.
- **Commands, queries, events.** Commands mutate exactly one aggregate and return its snapshot plus the integration events it produced; queries read D1 projections or a snapshot and never mutate; integration events are plain JSON validated by a Zod discriminated union and delivered by the in-process bus (see `in-process-event-bus.md`). *Domain* events (state transitions inside an aggregate) never leave the aggregate class; only *integration* events appear in `contract.ts`. This is Grzybek's split, adapted to a stack where the aggregate is a Durable Object holding a snapshot rather than an event-sourced entity.
- **Data ownership.** Every D1 table is prefixed with its module name (`economy_wallet`, `leaderboard_daily`); SQL for a table lives only inside that module; a module that needs another module's data either calls its query API or maintains its own projection fed by events (leaderboard keeps `leaderboard_daily` from `solve.finished` rather than reading `solve_state`). D1 has no schemas/namespaces, so the prefix *is* the schema.
- **Composition root.** `src/app/` is the only place that imports every module: it builds the event registry (`z.discriminatedUnion` of all `contract.ts` event schemas), the handler table, a per-request `Modules` object (a record of module APIs bound to `env`) and the Hono tree (`app.route("/economy", economy.http)`). Modules receive their dependencies as *ports* (structural types of other modules' public APIs), never by importing `app/`.
- **Enforcement under TypeScript 7.** TS 7.0.2 ships no compiler API (`lib/typescript.js` is absent from the tarball), so `typescript-eslint` (peer `typescript >=4.8.4 <6.1.0`) and dependency-cruiser (TS 7 support announced for TS 7.1) cannot parse `.ts` against it. The workable layout is: `typescript@7.0.2` in the Worker packages for `tsc`, and a separate `tools/lint` workspace package that pins `typescript@6.0.2` for ESLint 10.9.1 + `eslint-plugin-boundaries` 7.2.0 + `eslint-plugin-import-x` 4.17.1 + dependency-cruiser 18.2.0. In addition, ship a **TS-API-free architecture test** (a Vitest file that regex-scans `import` statements and SQL table names) so the boundaries are also enforced by `pnpm test` inside the same toolchain that already works, regardless of what the lint ecosystem does over the next release cycle.
- **Extraction path stays mechanical.** Because every public API method takes and returns JSON only (an `RpcSafe<T>` type-level check enforces it), a module can be moved to its own Worker by wrapping its `index.ts` in a `WorkerEntrypoint` class and changing one line in the composition root from the in-process adapter to `env.<BINDING>` (`services: [{ binding, service, entrypoint }]`, Durable Objects via `script_name`). Callers keep writing `modules.economy.credit(...)`. Service bindings run "on the same thread of the same Cloudflare server" with "zero overhead or added latency", so the split adds no latency at the call site — with two documented caveats: each service-binding call counts toward the calling Worker's subrequest limit, and the "no additional request fees" statement applies to Standard pricing only (CPU time of both Workers is still billed). Sources: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/ ; https://developers.cloudflare.com/workers/platform/pricing/
- **Crosscut module list (10 + shared):** `shared` (kernel), `events` (generic bus), `identity`, `catalog`, `economy`, `solve`, `social`, `collections`, `leaderboard`, `feed`, `notifications` (stub). Allowed dependency directions form a DAG with `feed` and the composition root at the top; see the matrix in Recommendation R3.

## Findings

### F1. Definition and module properties (Grzybek)

Kamil Grzybek: "Modular Monolith architecture is a explicit name for a Monolith system designed in a modular way." A module is a business module ("the module in the Modular Monolith is a business module that is able to fully provide a set of desired features"), organised as a vertical slice rather than by technical layer. Independence "is determined by three main factors: number of dependencies, strength of dependencies, stability of the modules on which the module depends on". Encapsulation: "everything that we share outside becomes the public API of the module. Therefore, encapsulation is an inseparable element of modularity." Both synchronous (facades) and asynchronous (published events) communication count as valid contracts.
Source: https://www.kamilgrzybek.com/blog/posts/modular-monolith-primer

Consequence: the unit of modularity is a *feature-complete business capability* (economy, solve, feed), not a layer (controllers, repositories). A module's `index.ts` is its entire public API.

### F2. Reference implementation: separate schemas, integration events, architecture tests (Grzybek's repo)

`modular-monolith-with-ddd`: each module has Application / Domain / Infrastructure / IntegrationEvents projects; "Each Module has its own interface which is used by API"; "Modules communicate each other only asynchronously using Events Bus—direct method calls are not allowed"; Outbox/Inbox gives "'At-Least-Once delivery' and 'At-Least-Once processing'"; each module has its own database schema; commands use the write model, queries use raw SQL on the read model; NetArchTest enforces layering and encapsulation "testing what the compiler cannot enforce".
Source: https://github.com/kgrzybek/modular-monolith-with-ddd

Consequence for Crosscut: adopt the *separation* (own schema per module, integration-event contracts as the published surface, architecture tests), but **not** the "events only" rule: the decided architecture allows direct calls for commands and queries (concepts.md §2) and uses events for reactions. The IntegrationEvents project maps to `contract.ts`; the DB schema maps to table prefixes (F12).

### F3. "Lean on the compiler" and small public surfaces (Simon Brown)

Simon Brown's "package by component" bundles "all of the responsibilities related to a single coarse-grained component into a single Java package", treating components "as a stepping stone to a microservices architecture". On enforcement: "The fewer public types you have, the fewer the number of potential dependencies"; static-analysis tools (NDepend, Structure101, ArchUnit) exist, but he prefers to "lean on the compiler to enforce your architectural principles, rather than discipline, post-compilation tooling, and automated fitness functions." Also: "if people can't build monoliths properly, microservices won't help."
Sources: https://simonbrown.je/modular-monolith/ ; GOTO 2018 talk https://www.youtube.com/watch?v=5OjqD-ow8GE

Consequence: TypeScript has no package-private visibility, so the compiler can only enforce a boundary when the module is a *package* whose `exports` map hides internals (F8). For in-folder modules, tooling (F9–F11) and tests (R7) must do it. The design should minimise the exported surface either way.

### F4. Ardalis and Sam Newman (definitions)

Ardalis (Steve Smith): a modular monolith "structures the application as a single deployment unit ... but organizes its internal components or modules in such a way that they are loosely coupled and highly cohesive", each module "designed around a business domain, encapsulating its logic, data, and dependencies", communicating "through well-defined interfaces or shared libraries". (Page returned HTTP 403 to the fetcher; quoted from search-engine excerpts of the article — medium confidence.) [UNVERIFIED] Fact-check 2026-09-02: the page still returns HTTP 403; search-engine excerpts reproduce the quoted wording, so the claim is consistent with secondary sources but not confirmed against the primary page.
Source: https://ardalis.com/introducing-modular-monoliths-goldilocks-architecture/ (403; wording via WebSearch excerpts)

Sam Newman (*Monolith to Microservices*, ch. 1): a modular monolith is a single process made of separate modules that can be worked on independently but must be combined for deployment; well-defined boundaries "allow for a high degree of parallel working, while sidestepping the challenges of a distributed microservice architecture". (Book text; the author's page only lists the book — medium confidence.) [UNVERIFIED] Fact-check 2026-09-02: the cited page is only a book listing with ordering links and a table of contents; it contains neither the definition nor the quoted phrase, so the quote cannot be verified against a primary online source.
Source: https://samnewman.io/books/monolith-to-microservices/ (book listing only)

### F5. TypeScript 7.0 has no programmatic API; TS 7.1 will ship a new one

Announcement (2026-07-08): TypeScript 7 is the native (Go) port, "8x and 12x on full builds"; "TypeScript 7.0 is made available, but does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API." Fallback: `@typescript/typescript6`, which "provides a `tsc6` command" and "reexports the TypeScript 6 API". tsconfig changes carried over from the 6.0 deprecations: `strict` true by default, `baseUrl` "no longer ... considered a look-up root for module resolution", `moduleResolution node/node10` removed, `module amd/umd/systemjs/none` removed, `outFile` removed, `types` defaults to `[]`, `rootDir` defaults to `./`. Project references are supported and `--builders` parallelises multi-project builds.
Verified locally: `npm pack typescript@7.0.2 --dry-run` lists 416 files / 365.6 kB with `lib/tsc.js` (609 B) and **no** `lib/typescript.js`; `typescript@6.0.2` ships `lib/typescript.js` (9.1 MB).
Sources: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ ; https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ ; `npm view @typescript/typescript6 readme`

### F6. typescript-eslint cannot run on TS 7.0

`typescript-eslint@8.69.0` and `@typescript-eslint/parser@8.69.0` (published 2026-08-31) declare `peerDependencies.typescript: ">=4.8.4 <6.1.0"` and `eslint: "^8.57.0 || ^9.0.0 || ^10.0.0"`. Issue #10940 ("Use TS 7 (tsgo / typescript-go) for type information") is open; maintainers list three blockers: ESLint has no async parsers, tsgo is "many months away from being stable", and AST/type information must be marshalled from Go/WASM.
Sources: `npm view typescript-eslint@8.69.0 peerDependencies` ; https://github.com/typescript-eslint/typescript-eslint/issues/10940

Consequence: any ESLint setup that parses `.ts` needs a TypeScript 6 package resolvable from where ESLint runs, even without type-aware rules (the parser itself needs the TS API).

### F7. dependency-cruiser: TS 7 support deferred to TS 7.1; parsing needs `typescript` installed

dependency-cruiser 18.2.0 (2026-08-10; engines `node ^22||^24||>=26`) has no `typescript` dependency of its own. FAQ: "Install the compiler you use in the same spot dependency-cruiser is installed"; the `tsc` parser "will need `typescript` to be installed"; `swc` is an alternative parser "if your codebase can be compiled successfully with `swc`". Release v18.1.0 (2026-07-12): "TypeScript 7 support: typescript@7.1.0 is expected to ship with a public API - so that's the first version in the TypeScript 7 (formerly tsgo) version range dependency-cruiser will be able to support".
Rule model: top-level `forbidden`, `allowed`, `allowedSeverity`, `required`, `options`; rules have `name`, `severity`, `comment`, `from { path, pathNot }`, `to { path, pathNot, circular, reachable, dependencyTypes }`; capturing groups in `from.path` are usable as `$1` in `to`; options include `tsConfig { fileName }`, `tsPreCompilationDeps`, `enhancedResolveOptions`, `includeOnly`, `doNotFollow`, `exclude`.
Sources: `npm view dependency-cruiser@18.2.0` ; https://github.com/sverweij/dependency-cruiser/blob/main/doc/faq.md ; https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md ; https://github.com/sverweij/dependency-cruiser/releases (v18.1.0 body)

### F8. TypeScript honours `package.json` `exports` and `#` subpath `imports` under `bundler`/`nodenext`

"When `moduleResolution` is set to `node16`, `nodenext`, or `bundler`, and `resolvePackageJsonExports` is not disabled, TypeScript follows Node.js's package.json `"exports"` spec when resolving from a package directory"; likewise `#`-prefixed specifiers resolve "through the `"imports"` field of the nearest ancestor package.json". Extra conditions via `customConditions`. Project references: "Importing modules from a referenced project will instead load its *output* declaration file (`.d.ts`)"; the handbook says referenced projects must have `composite` enabled, which in turn forces `declaration: true` and requires `include`/`files` to cover all source files — relevant because the Worker packages use `noEmit` today, so promoting a module to a referenced project means emitting declarations; `tsc --build` orders and rebuilds them.
Sources: https://www.typescriptlang.org/docs/handbook/modules/reference.html ; https://www.typescriptlang.org/docs/handbook/project-references.html

Consequence: a module packaged as a workspace package with `"exports": { ".": "./src/index.ts", "./contract": "./src/contract.ts" }` makes deep imports a *compile error* — the compiler-enforced boundary Brown asks for. Project references alone do not stop deep imports (they only change which `.d.ts` is loaded). Whether wrangler's esbuild bundler also honours `imports`/`exports` for workspace packages is [UNVERIFIED] here (esbuild documents support, but it was not exercised in this research nor in the 2026-09-02 fact-check; C23).

### F9. ESLint 10 is the only line; flat config is the only config

ESLint v10.0.0 (2026-02-06): "the eslintrc config system has been completely removed in ESLint v10.0.0"; requires "Node.js ^20.19.0 || ^22.13.0 || >=24"; the `v10_config_lookup_from_file` flag "has been removed" because that behaviour (config lookup from the linted file's directory) is now unconditional — passing the flag to ESLint 10 is an error, so drop it from any migrated scripts. npm `latest` is 10.9.1; `maintenance` tag is 9.39.5. (Search summaries state ESLint 9.x reached end-of-life on 2026-08-06 — medium confidence, not read from eslint.org directly.)
Sources: https://eslint.org/blog/2026/02/eslint-v10.0.0-released/ ; `npm view eslint dist-tags`

### F10. eslint-plugin-boundaries 7.2.0: one `dependencies` rule with policies; `entry-point`/`no-private` are deprecated aliases

Version 7.2.0 (2026-08-09), `peerDependencies: { eslint: ">=6.0.0" }`, `engines.node >=18.18`, flat-config example (`export default [...]`). Settings: `boundaries/elements` (entries with `type`, `pattern`, `capture`, `basePattern`, `baseCapture`), `boundaries/files` (`pattern`, `category`), `boundaries/ignore`, `boundaries/include`, `boundaries/dependency-nodes` (default `["import","export","require","dynamic-import"]`), `boundaries/root-path`. Rule `boundaries/dependencies` takes `{ default: "allow" | "disallow", message, policies: [{ from, to, dependency, allow, disallow, message }] }`; selectors are `{ element: { type, types, captured, path, fileInternalPath, parent }, file: { categories }, module: { origin: "local"|"external"|"core", source }, dependency: { kind: "value"|"type", relationship } }`, combined with AND. Entry-point enforcement is expressed as `disallow: { to: { element: { type: "module", fileInternalPath: "!index.ts" } } }`. Rules list: `dependencies` (canonical), `no-unknown-files`, `no-unknown-dependencies`, `no-ignored-dependencies`; deprecated: `element-types`, `entry-point`, `external`, `no-private`. TypeScript guide: requires `@typescript-eslint/parser` and `eslint-import-resolver-typescript` under `settings["import/resolver"].typescript`.
Sources: `npm view eslint-plugin-boundaries@7.2.0` ; https://www.jsboundaries.dev/docs/settings/ ; https://www.jsboundaries.dev/docs/policies/ ; https://www.jsboundaries.dev/docs/selectors/ ; https://www.jsboundaries.dev/docs/rules/ ; https://www.jsboundaries.dev/docs/guides/typescript-support/

### F11. eslint-plugin-import-x 4.17.1 and the resolver do not need the TS API (the parser still does)

`eslint-plugin-import-x@4.17.1`: peers `eslint ^8.57.0 || ^9.0.0 || ^10.0.0`, `@typescript-eslint/utils ^8.56.0`, `eslint-import-resolver-node *`; deps include `unrs-resolver`, `@typescript-eslint/types` (types only). `eslint-import-resolver-typescript@4.4.5` additionally declares a peer on `eslint-plugin-import *` (optional in practice). Under pnpm's strict peer handling these must be installed in `tools/lint` (or the peer-dependency rules relaxed) or install will warn/fail — see R6. Flat config: `import { importX } from "eslint-plugin-import-x"` and `importX.flatConfigs.recommended` / `.typescript`. Rules: `no-restricted-paths` (`basePath`, `zones: [{ target, from, except, message }]`, `target`/`from` accept arrays of paths or globs), `no-internal-modules`, `no-cycle`. `eslint-import-resolver-typescript@4.4.5` depends on `get-tsconfig` + `unrs-resolver` (no `typescript`). ESLint core `no-restricted-imports` supports `patterns: [{ group | regex, message, allowTypeImports }]`.
Sources: `npm view eslint-plugin-import-x@4.17.1` ; https://github.com/un-ts/eslint-plugin-import-x ; https://github.com/un-ts/eslint-plugin-import-x/blob/master/docs/rules/no-restricted-paths.md ; `npm view eslint-import-resolver-typescript@4.4.5 dependencies` ; https://eslint.org/docs/latest/rules/no-restricted-imports

### F12. D1: one database is enough for launch; multiple bindings are allowed; no schemas

Limits: databases per account "10 (Free)" / "50,000 (Workers Paid)"; database size "500 MB (Free)" / "10 GB (Workers Paid)"; "100" columns per table; queries per Worker invocation "50 (Free)" / "1000 (Workers Paid)"; max string/BLOB 2,000,000 bytes. `d1_databases` in wrangler config is an array (multiple bindings per Worker). SQL statements page notes "D1 PRAGMA statements only apply to the current transaction" and does not offer schema namespaces (SQLite has none inside one database).
Sources: https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ ; https://developers.cloudflare.com/d1/sql-api/sql-statements/

Consequence: table ownership is a naming convention (`<module>_<table>`) plus tooling; a module that is split out can take its tables to a second D1 database later (one more `d1_databases` entry), which is only possible if no other module joins on them today.

### F13. Service bindings and `ctx.exports` keep the call site identical before and after extraction

Service bindings: "there is zero overhead or added latency. By default, both Workers run on the same thread of the same Cloudflare server", and "You can split apart functionality into multiple Workers, without incurring additional costs." Config `services: [{ binding, service, entrypoint }]` (`entrypoint` optional); Durable Objects in another Worker via `durable_objects.bindings[].script_name`. RPC: `import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers"`; compatibility date `2024-04-03` or the `rpc` flag; named entrypoints are reachable only through bindings on the same account, not from the internet; class instances crossing RPC must extend `RpcTarget`. `ctx.exports` (changelog 2025-09-26) gives "automatically-configured bindings corresponding to your Worker's top-level exports" — a service binding per `WorkerEntrypoint` export and a namespace per storage-configured `DurableObject` export. **It is gated behind the `enable_ctx_exports` compatibility flag** (there is no default-on compatibility date yet), so `wrangler.jsonc` must carry `"compatibility_flags": ["enable_ctx_exports"]` or `ctx.exports` is simply absent at runtime.
Cost caveats: each service-binding call counts toward the calling Worker's subrequest limit, and "without incurring additional costs" refers to request fees under Standard pricing only — CPU time of both Workers is billed.
Sources: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/ ; https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ ; https://developers.cloudflare.com/workers/runtime-apis/rpc/ ; https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ ; https://developers.cloudflare.com/workers/configuration/compatibility-flags/ ; https://developers.cloudflare.com/workers/platform/pricing/

### F14. Hono: one sub-app per module, mounted with `app.route()`; no controller classes

Hono's best-practices page: avoid "Ruby on Rails-like Controllers" (they break path-parameter inference); for larger applications create a `new Hono()` per feature file and mount with `app.route('/authors', authors)`; `createFactory().createHandlers(...)` if a controller-like grouping is wanted; export `type AppType = typeof app` for `hc`.
Source: https://hono.dev/docs/guides/best-practices

### F15. Testing: `@cloudflare/vitest-plugin` replaces `@cloudflare/vitest-pool-workers`; per-file storage isolation; Vitest `projects`

Cloudflare changelog 2026-08-19: "Version 1 of the Workers Vitest integration is published as @cloudflare/vitest-plugin. The package was formerly named `@cloudflare/vitest-pool-workers`"; codemod `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`. Docs config: `plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })]` with `vitest@^4.1.0`. npm: `@cloudflare/vitest-plugin` 1.1.3 (created 2026-08-20), `@cloudflare/vitest-pool-workers` 0.22.0 (last modified 2026-08-18), both with peer `vitest ^4.1.0`. The local template (`packages/core/vitest.config.ts`) already uses `cloudflareTest` from the 0.22 package. Isolation: "Storage isolation is per test file"; share with `--max-workers=1 --no-isolate`. `cloudflare:test` exports `createExecutionContext`, `waitOnExecutionContext`, `runInDurableObject`, `runDurableObjectAlarm`, `listDurableObjectIds`, `applyD1Migrations`. Note (fact-check 2026-09-02): the `@cloudflare/vitest-plugin@1.1.3` types file contains **no** `ProvidedEnv` — `env` is typed as `Cloudflare.Env`; code that augments `ProvidedEnv` (the old pool-workers pattern) will not type-check against the new package. Two more migration details: Cloudflare's configuration docs say `readD1Migrations` comes from `@cloudflare/vitest-plugin/config`, but the 1.1.3 `package.json` exports map has only `.` and `./types`, so import it from the package root (as S8 does) or you get a resolution error; and the tsconfig `types` entry must change from `@cloudflare/vitest-pool-workers/types` to `@cloudflare/vitest-plugin/types` (the codemod does this). Vitest: `test.projects: ['packages/*']` (workspace "is deprecated since 3.2 and replaced with the `projects` configuration"), `--project <name>` to run one.
Sources: https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ ; https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ ; https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/ ; https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ ; https://vitest.dev/guide/projects ; `npm view @cloudflare/vitest-plugin`

### F16. knip 6.34.0 parses with oxc (no TS API)

`knip@6.34.0` dependencies include `oxc-parser` and `oxc-resolver` and no `typescript`; engines `node ^20.19.0 || >=22.12.0`. It can therefore run against a TS 7 workspace to report unused exports per module — useful as a "public surface is minimal" check. Behaviour on this exact repo layout is UNVERIFIED (not executed).
Source: `npm view knip@6.34.0 dependencies engines`

## Recommendation for Crosscut

### R1. Module anatomy (folder = module)

```
workers/gateway/src/
  app/                       composition root — the ONLY folder that imports every module
    registry.ts              z.discriminatedUnion of all contract.ts events; HandlerTable
    modules.ts               createModules(env, exec, actor): Modules  (in-process adapters or RPC stubs)
    routes.ts                Hono tree: app.route("/economy", economy.http) ...
    index.ts                 export { WalletAggregate, Solve, ..., Projections, Events }; export default app
  shared/                    kernel: RequestContext, ids, dayKey(tz), DomainError re-export, RpcSafe<T>, Zod helpers
  events/                    generic bus: Envelope, DispatchContext, dispatch(), Subscription type (no module imports)
  modules/
    <name>/
      index.ts               public API object: commands + queries (+ `http`, `subscriptions`, `projections`)
      contract.ts            Zod schemas: events this module PUBLISHES, DTOs it RETURNS, `examples`
      http.ts                Hono sub-app for this module's routes (zValidator + calls into index.ts)
      subscriptions.ts       handlers for OTHER modules' events (imports only their contract.ts)
      internal/              private: *.do.ts (Aggregate subclasses), sql.ts, domain.ts (pure functions), projection.ts
      test/                  contract.test.ts, *.test.ts (run in workerd)
```

Rules (enforced by R6/R7):

1. Cross-module imports may target only `modules/<x>/index.ts` and `modules/<x>/contract.ts`. `internal/**`, `http.ts`, `subscriptions.ts` are private.
2. `shared/` and `events/` import nothing from `modules/`; `app/` imports everything; `modules/*` never import `app/`.
3. A module's `index.ts` exports **one object** (`export const economy = { credit, debit, spin, getWallet, ... }`) plus types. No barrel re-export of internals.
4. Every public method signature is `(...args: Json[]) => Promise<Json>` — checked at compile time with `RpcSafe<T>` (sketch S2) so that the module can be moved behind Workers RPC without changing callers (F13).
5. Dependencies on other modules arrive as **ports** (`Pick<typeof economy, "credit">` style structural types) injected by `app/modules.ts`; a module never resolves another module itself.

### R2. Commands vs queries vs events

| Kind | Where declared | Signature rule | Side effects | Returns |
|---|---|---|---|---|
| Command | `index.ts` | JSON in → `{ snapshot, events }` out | exactly one aggregate commit (`Aggregate.commit`) | the authoritative snapshot + integration events produced |
| Query | `index.ts` | JSON in → DTO out (DTO schema in `contract.ts`) | none (D1 projections or `snapshot()`) | data only, never the solution grid outside `solve`/`catalog` |
| Integration event | `contract.ts` (`defineEvent("economy.tokensCredited", 1, schema)`) | published by the owning module only | delivered by the bus to `subscriptions.ts` of other modules | — |
| Domain event | inside `internal/*.do.ts` (a state transition; often just a branch in `commit`) | never exported | — | — |

Naming: events are `<module>.<pastTenseFact>`; commands are imperative (`credit`, `startSolve`); queries start with `get`/`list`/`find`. A subscriber may issue a *command* on its own module in response to an event, but must never issue a command on a third module — it publishes a follow-on event instead (keeps the graph acyclic and the loop guard in the bus meaningful).

Domain vs integration event, concretely: `Solve` locking a word is a domain-level transition (recorded in the solve snapshot); `solve.finished { userId, puzzleId, solveId, secondsLeft, par, usedHints, firstSolve, tokensEarned, starsEarned, dayKey }` is the integration event, computed once by the producer so redelivery is deterministic (`in-process-event-bus.md` R11.9). Economy amounts (`floor(secondsLeft/5)`, `10 + (usedHints ? 0 : 2)`) are computed in `solve`'s pure `internal/domain.ts` from the prototype formulas and carried in the event; `economy` credits what the event says and never recomputes.

### R3. Module list and allowed dependency directions

`X → Y` means X may import Y's `index.ts`/`contract.ts` (i.e. call Y's commands/queries and/or subscribe to Y's events). The graph is a DAG; `feed` is a pure read-side composer at the top.

| Module | Owns (write model) | D1 tables (prefix) | May depend on | Subscribes to |
|---|---|---|---|---|
| `shared` | kernel types, `dayKey(tz)`, ids, `RpcSafe` | — | — | — |
| `events` | Envelope, `dispatch`, `Subscription` | — | `shared` | — |
| `identity` | `Profile` DO per user (display name, onboarding prefs, tz, language, plan/entitlement, push tokens); Better Auth tables | `identity_profile`, Better Auth tables (library-owned) | `shared`, `events` | — |
| `catalog` | puzzles (bundled JSON per language), setters, collections manifest, daily schedule | `catalog_puzzle`, `catalog_collection`, `catalog_daily` | `shared` | — |
| `economy` | `Wallet` DO per user: tokens, stars, streak, wheel spins, ledger; hint prices; token packs | `economy_wallet` (projection), `economy_ledger` | `shared`, `events`, `identity` (tz for day keys — query only) | `solve.finished`, `collections.completed`, `billing`-style `identity.packPurchased` |
| `solve` | `Solve` DO per user×puzzle (server-authoritative grid, timer, hints, autocheck) | `solve_state` (continue-solving + best-time projection) | `shared`, `events`, `catalog` (solution), `economy` (port: `debit` for hints) | — |
| `social` | `PuzzleStats` DO per puzzle (likes, solved, solvingNow), `UserSocial` DO per user (likes/saves) | `social_puzzle_stats`, `social_user_saves` | `shared`, `events`, `catalog` (existence check) | `solve.started/paused/resumed/finished` |
| `collections` | `Progress` DO per user (completions, per-collection progress, unlocks, rewards claimed) | `collections_progress` | `shared`, `events`, `catalog` (manifest) | `solve.finished` |
| `leaderboard` | own denormalised rows per puzzle per day | `leaderboard_daily` | `shared`, `events`, `identity` (display names — query) | `solve.finished` |
| `feed` | nothing stateful; composes pages, stories, ticker, streak-at-risk | `feed_cursor` (optional) | `catalog`, `economy`, `social`, `collections`, `solve`, `identity` (queries only) | — |
| `notifications` (stub) | `notifications_outbox` rows, no delivery in v1 | `notifications_outbox` | `shared`, `events`, `identity` (push tokens) | `economy.streakExtended/streakAtRisk`, `collections.completed` |
| `app` (composition root) | wiring | — | everything | — |

Layering read bottom-up: `shared` → `events` → {`identity`, `catalog`} → `economy` → {`solve`, `social`} → {`collections`, `leaderboard`} → {`feed`, `notifications`} → `app`. `economy` is deliberately below `solve` so that "hint costs tokens" is a port call from `solve` into `economy`, never the reverse; `economy` learns about solves only through `solve.finished`.

Naming map to sibling documents: `catalog` = "content" (domain-spec-extraction), `solve` = "solving", `economy` = "wallet + streak + wheel" (+ "billing" credit path), `collections` = "progress". `domain-spec-extraction.md` folds wallet/streak/progress/wheel into one `User` DO for atomicity; `workers-modular-monolith.md` uses a shared `Player` DO. This document takes the stricter position: **one Durable Object class belongs to exactly one module**, so per-user state is split into `identity.Profile`, `economy.Wallet`, `collections.Progress` (three objects per user, idle objects are free). The cost is that "solve → tokens + streak + collection progress" is no longer one commit; the bus's per-handler ack and event-id dedupe (`in-process-event-bus.md` R5–R7) make that safe. If you later want the single-commit variant, merge `collections.Progress` into `economy.Wallet` (both are reward-loop state) — do not merge across identity.

### R4. Data ownership rules (tables)

1. Every table name starts with `<module>_`. Migrations live in `workers/gateway/migrations/` (one D1 database), but each file touches tables of one module only and is named `NNNN_<module>_<what>.sql`.
2. SQL strings appear only in `modules/<m>/internal/sql.ts` (or `projection.ts`). The arch test (S7) fails if a module's source mentions a foreign prefix in a `FROM/JOIN/INTO/UPDATE/TABLE` position.
3. No cross-module JOINs. A read model that needs two modules' data is either composed in-process by a query on each module (`feed`), or is a table owned by the composer and fed by events (`leaderboard_daily`).
4. `Projections` (the one D1 writer for aggregates, from `packages/core`) stays a single `WorkerEntrypoint` in `app/`, but its `projections()` list is assembled from each module's exported `projections` array — the column mapping stays inside the module that owns the state.
5. Library-owned tables (Better Auth) are not prefixed; they belong to `identity` by convention and are the only exception.

### R5. Composition root and the per-request `Modules` object

Workers forbid caching per-request I/O objects in module scope (`in-process-event-bus.md` F3), so modules are **not** instantiated with `env` at startup. Each module's `index.ts` exports env-free functions whose first argument is a `RequestContext` (`{ env, exec, actor, correlationId, now }`). `app/modules.ts` binds that context once per request and exposes a `Modules` record on Hono's context (`c.set("modules", ...)`), so route handlers and subscribers write `modules.economy.credit({...})`. The same file is where an extracted module is swapped for its RPC stub (S5). Hono's own guidance (F14) — one sub-app per module, no controller classes — matches `http.ts` per module mounted from `app/routes.ts`.

### R6. Boundary tooling that works today (TypeScript 7 caveat)

Because TS 7.0.2 has no compiler API (F5) and typescript-eslint requires `<6.1.0` (F6), run linting from a dedicated workspace package that resolves TypeScript 6:

```
tools/lint/package.json
  devDependencies: eslint 10.9.1, typescript 6.0.2, typescript-eslint 8.69.0,
                   eslint-plugin-boundaries 7.2.0, eslint-plugin-import-x 4.17.1,
                   eslint-import-resolver-typescript 4.4.5, dependency-cruiser 18.2.0,
                   # peers required by the above under pnpm strict peer handling (F11):
                   @typescript-eslint/utils 8.69.0, eslint-import-resolver-node (any),
                   eslint-plugin-import (any; optional peer of the TS resolver — or relax peer rules)
  scripts: "lint": "eslint --config ./eslint.config.js ../../workers ../../packages",
           "deps":  "depcruise --config ./.dependency-cruiser.cjs ../../workers/gateway/src"
```

With pnpm's isolated `node_modules`, `@typescript-eslint/parser` inside `tools/lint` resolves `typescript@6.0.2`, while `workers/gateway` keeps `typescript@7.0.2` for `tsc`. The two never meet. (The layout is a recommendation built on the verified peer ranges; it was not executed in this research — see Open questions.)

What each tool contributes:

- **eslint-plugin-boundaries** (`boundaries/dependencies`, F10): the allow-matrix of R3, entry-point enforcement via `fileInternalPath: "!index.ts"` (contract.ts allowed explicitly), and "modules may not import `app/`". This is the primary, human-readable rule set (S6).
- **eslint-plugin-import-x** (F11): `no-cycle` (module graph must be a DAG), `no-restricted-paths` as a second opinion on `internal/**`, `flatConfigs.typescript` for resolution.
- **dependency-cruiser** (F7): the same graph as a CI gate with `forbidden` rules using capturing groups (S6b), plus `--output-type dot` for the architecture diagram in `docs/`. Runs with the `tsc` parser against TS 6 in `tools/lint`; switch to `swc` or TS 7.1 later.
- **Vitest architecture test** (S7): TS-API-free, runs inside the same `pnpm test` that already passes with TS 7; guards import paths, SQL table prefixes, and the `RpcSafe` surface. This is the fallback that must never be skipped, because it does not depend on the lint ecosystem catching up with TS 7.1.
- Optional: **knip** (F16) to list unused exports per module and keep public surfaces minimal; **Biome/oxlint `noRestrictedImports`** as suggested in `workers-modular-monolith.md` if the TS 6 side-package is judged too much ceremony — they parse TS natively but cannot express the allow-matrix with element types; use them for the deep-import ban only.

Do **not** rely on TS path aliases (`baseUrl` is gone in TS 7, F5): use relative imports (`../economy`) inside the Worker, which every tool above resolves without configuration. If compiler-enforced boundaries are wanted later, promote a module to a workspace package with an `exports` map (F8) — the folder layout above is already package-shaped (`index.ts`, `contract.ts`).

### R7. Contract tests per module

Each module ships `test/contract.test.ts` running in workerd via `@cloudflare/vitest-plugin` (F15):

1. **Published events** — every entry in `contract.examples` parses against its own schema and against the global registry (`DomainEvent.safeParse`), and an event with an unknown `type` is rejected.
2. **Public API surface freeze** — `expect(Object.keys(economy).sort()).toEqual([...])` and a compile-time `RpcSafe<typeof economy>` assertion (S2). Adding a method is a deliberate, reviewed diff.
3. **Consumer-driven checks** — a subscriber module imports the producer's `contract.examples` and feeds them to its handler, asserting its own state (e.g. `collections.onSolveFinished(examples.solveFinished)` increments progress; delivering it twice is a no-op).
4. **Ownership** — the module's aggregates get the template's three tests (projection on commit, idempotency, failed flush → alarm → recovery) and every query is asserted against the module's own tables only.

Use Vitest `projects` (F15) so each module can be run alone (`vitest --project economy`) while sharing one `wrangler.jsonc`; storage isolation is per test file, so every test uses unique ids (already the template's convention).

### R8. Extraction of a module into its own Worker (later)

1. Add `modules/<m>/entrypoint.ts`: `export class Economy extends WorkerEntrypoint<Env> { credit(input) { return economy.credit(ctxFrom(this), input); } ... }` — one line per public method (S5). Export it from `app/index.ts` and add `"compatibility_flags": ["enable_ctx_exports"]` to `wrangler.jsonc` (F13) — without the flag `ctx.exports` is undefined and this step silently fails. From this moment `ctx.exports.Economy` is a working loopback stub; you can flip `app/modules.ts` to use it in the monolith to *prove* RPC-compatibility before any split.
2. Create `workers/economy` with its own `wrangler.jsonc`, move the folder verbatim, move `economy_*` migrations (same D1 database, or a new `d1_databases` entry, F12), declare its Durable Objects there.
3. In the gateway: `services: [{ binding: "ECONOMY", service: "crosscut-economy", entrypoint: "Economy" }]`; if other Workers need its DO namespace, `durable_objects.bindings[].script_name: "crosscut-economy"`. `app/modules.ts` returns `env.ECONOMY` for the `economy` slot. No caller changes.
4. Events: the bus keeps calling `subscriptions` in-process for modules that remain; for the extracted module, the gateway's `Events` entrypoint forwards its subscriptions over the same service binding (`env.ECONOMY.onEvent(envelope)`), or, if fan-out/rate limits demand it, that is the moment to introduce a Queue for that one subscription (`in-process-event-bus.md` R9).
5. Because errors cross RPC as `{ name, message }` only, `DomainError` mapping in `app.onError` is already by `err.name` — unchanged.

## Code sketches

### S1. `shared/context.ts` — the request context every module function receives

```ts
// workers/gateway/src/shared/context.ts
export type Actor = { kind: "user"; userId: string } | { kind: "system"; reason: string };

export interface RequestContext {
  env: Env;                       // wrangler-generated bindings type
  exec: ExecutionContext | null;  // null when running from a DO alarm / entrypoint without ctx
  actor: Actor;
  correlationId: string;
  now: () => Date;                // injected clock (streaks, daily drops, wheel cooldowns)
}
```

### S2. `shared/rpc-safe.ts` — compile-time "this API can move behind Workers RPC"

```ts
// Structured-cloneable subset we allow on public module APIs (plain JSON only).
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

type IsJson<T> = T extends Json ? true : false;

/** Every public method: (ctx, ...Json) => Promise<Json>. Fails to compile otherwise. */
export type RpcSafe<T> = {
  [K in keyof T]: T[K] extends (ctx: any, ...args: infer A) => Promise<infer R>
    ? A extends Json[] ? (IsJson<R> extends true ? T[K] : never) : never
    : never;
};

// In each module's index.ts:
//   export const economy = { ... } satisfies RpcSafe<typeof economy>;
// (RPC additionally forbids class instances unless they extend RpcTarget — F13; Json excludes them.)
```

### S3. `modules/economy/contract.ts` — the published surface

```ts
import * as z from "zod";
import { defineEvent } from "../../events/define";

export const TokensCredited = defineEvent("economy.tokensCredited", 1, z.object({
  userId: z.string(),
  amount: z.int().positive(),
  reason: z.enum(["time_bonus", "wheel", "pack", "collection"]),
  ref: z.string(),           // event id / purchase id that caused it (idempotency key)
  balance: z.int().nonnegative(),
}));

export const StreakExtended = defineEvent("economy.streakExtended", 1, z.object({
  userId: z.string(), count: z.int().positive(), dayKey: z.iso.date(),
}));

export const WalletView = z.object({
  tokens: z.int().nonnegative(), stars: z.int().nonnegative(),
  streak: z.object({ count: z.int().nonnegative(), todaySolved: z.boolean(), dayEndsAt: z.iso.datetime() }),
});
export type WalletView = z.infer<typeof WalletView>;

export const events = [TokensCredited, StreakExtended] as const;
export const examples = {
  tokensCredited: TokensCredited.example({ userId: "u1", amount: 12, reason: "time_bonus", ref: "evt_1", balance: 281 }),
};
```

### S4. `modules/economy/index.ts` — commands and queries, env-free

```ts
import type { RequestContext } from "../../shared/context";
import type { RpcSafe } from "../../shared/rpc-safe";
import { aggregateStub } from "@app/core";
import { WalletAggregate } from "./internal/wallet.do";   // private
import { walletProjection } from "./internal/projection";
import { http } from "./http";
import { subscriptions } from "./subscriptions";
import type { WalletView } from "./contract";

const wallet = (ctx: RequestContext, userId: string) =>
  aggregateStub(ctx.env.WALLET, "wallet", userId);

export const economy = {
  // commands — one aggregate commit each; return snapshot + integration events
  async credit(ctx: RequestContext, input: { userId: string; amount: number; reason: string; ref: string }) {
    return wallet(ctx, input.userId).credit(input);           // DO enforces idempotency on `ref`
  },
  async debit(ctx: RequestContext, input: { userId: string; amount: number; reason: string; ref: string }) {
    return wallet(ctx, input.userId).debit(input);            // throws DomainError("INSUFFICIENT_TOKENS")
  },
  async markSolvedToday(ctx: RequestContext, input: { userId: string; dayKey: string; eventId: string }) {
    return wallet(ctx, input.userId).markSolvedToday(input);
  },
  // queries — read-only
  async getWallet(ctx: RequestContext, input: { userId: string }): Promise<WalletView> {
    const snap = await wallet(ctx, input.userId).snapshot();
    return toWalletView(snap.state, ctx.now());
  },
} satisfies RpcSafe<typeof economy>;

// Things the composition root mounts/registers (not callable cross-module):
export const economyWiring = { http, subscriptions, projections: [walletProjection], durableObjects: { WalletAggregate } };
```

`modules/economy/subscriptions.ts` imports only `../solve/contract` and `../collections/contract` and calls `economy.credit` / `economy.markSolvedToday` on its own module:

```ts
import type { Subscription } from "../../events/bus";
import { SolveFinished } from "../solve/contract";
import { economy } from "./index";

export const subscriptions: Subscription[] = [
  { name: "economy.onSolveFinished", type: SolveFinished.type, mode: "critical",
    async handle(e, ctx) {
      if (e.payload.firstSolve) {
        await economy.credit(ctx, { userId: e.payload.userId, amount: e.payload.tokensEarned, reason: "time_bonus", ref: e.id });
      }
      await economy.markSolvedToday(ctx, { userId: e.payload.userId, dayKey: e.payload.dayKey, eventId: e.id });
    } },
];
```

### S5. `app/modules.ts` — composition root; the single switch for extraction

```ts
import type { RequestContext } from "../shared/context";
import { economy } from "../modules/economy";
import { solve } from "../modules/solve";
import { catalog } from "../modules/catalog";
// ...

type Bound<T> = { [K in keyof T]: T[K] extends (ctx: RequestContext, ...a: infer A) => infer R ? (...a: A) => R : never };

function bind<T extends object>(api: T, ctx: RequestContext): Bound<T> {
  return Object.fromEntries(
    Object.entries(api).map(([k, fn]) => [k, (...a: unknown[]) => (fn as any)(ctx, ...a)]),
  ) as Bound<T>;
}

export function createModules(ctx: RequestContext) {
  return {
    catalog: bind(catalog, ctx),
    // In-process today. After extraction: `economy: ctx.env.ECONOMY` (Service<Economy>) — same shape.
    economy: bind(economy, ctx),
    solve: bind(solve, ctx),
    // ...
  };
}
export type Modules = ReturnType<typeof createModules>;
```

Extraction wrapper, added when a module leaves (or earlier, to exercise `ctx.exports.Economy` as a loopback — requires `"compatibility_flags": ["enable_ctx_exports"]` in `wrangler.jsonc`, F13):

```ts
// modules/economy/entrypoint.ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { economy } from "./index";
import { ctxFromEntrypoint } from "../../shared/context";

export class Economy extends WorkerEntrypoint<Env> {
  credit(input: Parameters<typeof economy.credit>[1])   { return economy.credit(ctxFromEntrypoint(this), input); }
  debit(input: Parameters<typeof economy.debit>[1])     { return economy.debit(ctxFromEntrypoint(this), input); }
  getWallet(input: Parameters<typeof economy.getWallet>[1]) { return economy.getWallet(ctxFromEntrypoint(this), input); }
}
```

```jsonc
// workers/gateway/wrangler.jsonc — after the split
{
  "services": [{ "binding": "ECONOMY", "service": "crosscut-economy", "entrypoint": "Economy" }],
  "durable_objects": { "bindings": [
    { "name": "WALLET", "class_name": "WalletAggregate", "script_name": "crosscut-economy" }
  ] }
}
```

`solve` receives economy as a port, so neither the in-process nor the RPC form leaks into it:

```ts
// modules/solve/index.ts
export type EconomyPort = Pick<Modules["economy"], "debit">;
export const solve = {
  async useHint(ctx: RequestContext, input: { solveId: string; kind: "fifty" | "letter" | "word" }, deps: { economy: EconomyPort }) { /* debit then reveal */ },
  // ...
};
```

(Passing `deps` as the last argument keeps `index.ts` env-free and testable with a fake port; `createModules` partially applies it.)

### S6. `tools/lint/eslint.config.js` — boundaries as data

```js
import boundaries from "eslint-plugin-boundaries";
import { importX } from "eslint-plugin-import-x";
import tsParser from "@typescript-eslint/parser";

// Allowed dependency matrix from R3 (module -> modules it may import index.ts/contract.ts of)
const ALLOW = {
  identity: [], catalog: [],
  economy: ["identity"],
  solve: ["catalog", "economy"],
  social: ["catalog"],
  collections: ["catalog"],
  leaderboard: ["identity"],
  feed: ["catalog", "economy", "social", "collections", "solve", "identity"],
  notifications: ["identity"],
};

export default [
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    files: ["../../workers/gateway/src/**/*.ts"],
    languageOptions: { parser: tsParser },
    plugins: { boundaries },
    settings: {
      "boundaries/root-path": new URL("../../workers/gateway/src", import.meta.url).pathname,
      "import/resolver": { typescript: { alwaysTryTypes: true } },
      "boundaries/elements": [
        { type: "shared",  pattern: "shared/*" },
        { type: "events",  pattern: "events/*" },
        { type: "module",  pattern: "modules/*", capture: ["name"] },
        { type: "app",     pattern: "app/*" },
      ],
    },
    rules: {
      "import-x/no-cycle": "error",
      "boundaries/no-unknown-files": "error",
      "boundaries/dependencies": ["error", {
        default: "disallow",
        policies: [
          { from: { element: { type: "shared" } }, allow: { to: { element: { type: "shared" } } } },
          { from: { element: { type: "events" } }, allow: { to: { element: { types: { anyOf: ["shared", "events"] } } } } },
          { from: { element: { type: "app" } },    allow: { to: {} } },   // composition root sees everything
          // a module may use its own files, shared, events ...
          { from: { element: { type: "module", captured: { name: "*" } } },
            allow: { to: [
              { element: { type: "module", captured: { name: "{{from.element.captured.name}}" } } }, // Handlebars template (v7 selectors)
              { element: { types: { anyOf: ["shared", "events"] } } },
            ] } },
          // ... and ONLY index.ts / contract.ts of the modules listed in ALLOW
          ...Object.entries(ALLOW).map(([name, deps]) => ({
            from: { element: { type: "module", captured: { name } } },
            allow: { to: { element: { type: "module", captured: { name: { anyOf: deps } }, fileInternalPath: { anyOf: ["index.ts", "contract.ts"] } } } },
          })),
          { disallow: { to: { element: { type: "app" } } }, from: { element: { type: "module" } },
            message: "modules must not import the composition root" },
        ],
      }],
    },
  },
];
```

Selector templates in eslint-plugin-boundaries v7 use Handlebars syntax — `{{from.element.captured.name}}` — not `${from.captured.name}`; the `${...}` form is only a deprecated legacy syntax for custom *messages*, and a `captured: { name: "${from.captured.name}" }` selector would not match as intended (corrected 2026-09-02 against https://www.jsboundaries.dev/docs/policies/ and https://www.jsboundaries.dev/docs/selectors/). The `fileInternalPath` selector is documented on the same pages (F10); the exact `anyOf` shorthand for captured values should still be confirmed against the selectors page when writing the real config.

**S6b. `.dependency-cruiser.cjs`** (same graph, CI gate + diagram):

```js
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "module-internals-are-private", severity: "error",
      from: { path: "^src/modules/([^/]+)/" },
      to:   { path: "^src/modules/([^/]+)/internal/", pathNot: "^src/modules/$1/" } },
    { name: "cross-module-only-via-index-or-contract", severity: "error",
      from: { path: "^src/modules/([^/]+)/" },
      to:   { path: "^src/modules/(?!$1/)[^/]+/", pathNot: "^src/modules/[^/]+/(index|contract)\\.ts$" } },
    { name: "modules-never-import-app", severity: "error", from: { path: "^src/modules/" }, to: { path: "^src/app/" } },
    { name: "kernel-imports-nothing", severity: "error", from: { path: "^src/(shared|events)/" }, to: { path: "^src/(modules|app)/" } },
  ],
  options: { tsConfig: { fileName: "../../workers/gateway/tsconfig.json" }, tsPreCompilationDeps: true, includeOnly: "^src/" },
};
```

### S7. `workers/gateway/test/arch.test.ts` — TS-API-free architecture test (runs with TS 7 today)

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../src/", import.meta.url).pathname;
const MODULES = ["identity","catalog","economy","solve","social","collections","leaderboard","feed","notifications"];
const ALLOW: Record<string, string[]> = { /* same matrix as S6 */ };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const IMPORT = /^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/gm;

describe("architecture", () => {
  for (const m of MODULES) {
    it(`${m} imports only allowed modules, and only via index.ts/contract.ts`, () => {
      for (const file of files(join(ROOT, "modules", m))) {
        const src = readFileSync(file, "utf8");
        for (const [, spec] of src.matchAll(IMPORT)) {
          if (!spec.startsWith(".")) continue;
          const target = relative(ROOT, join(file, "..", spec)).replace(/\\/g, "/");
          const hit = /^modules\/([^/]+)(?:\/(.*))?$/.exec(target);
          if (!hit || hit[1] === m) continue;
          const [, other, rest = "index"] = hit;
          expect(ALLOW[m], `${file} -> ${target}`).toContain(other);
          expect(["index", "index.ts", "contract", "contract.ts"], `${file} deep-imports ${target}`).toContain(rest);
          expect(target.startsWith("app/"), `${file} imports composition root`).toBe(false);
        }
      }
    });
    it(`${m} touches only its own D1 tables`, () => {
      const SQL = /\b(?:from|join|into|update|table(?: if not exists)?)\s+([a-z_][a-z0-9_]*)/gi;
      for (const file of files(join(ROOT, "modules", m))) {
        for (const [, table] of readFileSync(file, "utf8").matchAll(SQL)) {
          const owner = MODULES.find((x) => table.startsWith(`${x}_`));
          if (owner) expect(owner, `${file} references ${table}`).toBe(m);
        }
      }
    });
  }
});
```

### S8. `vitest.config.ts` with per-module projects (current plugin name)

```ts
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin"; // 0.22 users: "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("./migrations") } },
  }))],
  test: {
    setupFiles: ["./test/setup.ts"],
    projects: [
      { extends: true, test: { name: "arch",     include: ["test/arch.test.ts"] } },
      { extends: true, test: { name: "economy",  include: ["src/modules/economy/test/**/*.test.ts"] } },
      { extends: true, test: { name: "solve",    include: ["src/modules/solve/test/**/*.test.ts"] } },
      // ...
      { extends: true, test: { name: "http",     include: ["test/http/**/*.test.ts"] } },
    ],
  },
});
```

(`projects` entries with `extends: true` inherit the root config including `plugins` and `pool` — the Vitest projects guide states this explicitly (https://vitest.dev/guide/projects), so the `cloudflareTest` plugin carries into each project. Confirmed 2026-09-02 against the docs; not executed here.)

### S9. `app/routes.ts` — Hono mounting

```ts
import { Hono } from "hono";
import { economyWiring } from "../modules/economy";
import { solveWiring } from "../modules/solve";
import { feedWiring } from "../modules/feed";
import { createModules } from "./modules";
import type { AppEnv } from "../shared/hono";

export const app = new Hono<AppEnv>()
  .use("*", async (c, next) => { c.set("modules", createModules(requestContextFrom(c))); await next(); })
  .basePath("/v1")
  .route("/wallet", economyWiring.http)
  .route("/solves", solveWiring.http)
  .route("/feed", feedWiring.http);

export type AppType = typeof app;
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | Grzybek defines a modular monolith as "a Monolith system designed in a modular way"; a module is a business vertical slice; "everything that we share outside becomes the public API of the module". | https://www.kamilgrzybek.com/blog/posts/modular-monolith-primer | high | confirmed |
| C2 | Grzybek's reference implementation gives each module its own database schema, publishes IntegrationEvents as contracts, and enforces boundaries with NetArchTest; modules communicate only via an in-memory event bus with outbox/inbox (at-least-once). | https://github.com/kgrzybek/modular-monolith-with-ddd | high | confirmed |
| C3 | Simon Brown: "lean on the compiler to enforce your architectural principles, rather than discipline, post-compilation tooling, and automated fitness functions"; "The fewer public types you have, the fewer the number of potential dependencies." | https://simonbrown.je/modular-monolith/ | high | confirmed |
| C4 | [UNVERIFIED] Ardalis defines a modular monolith as a single deployment unit whose modules are loosely coupled, highly cohesive, each encapsulating logic, data and dependencies (quoted via search excerpt; page returned 403). | https://ardalis.com/introducing-modular-monoliths-goldilocks-architecture/ | medium | unverifiable |
| C5 | TypeScript 7.0 (2026-07-08) "does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API"; `@typescript/typescript6` re-exports the TS 6 API; `baseUrl`, `moduleResolution node10`, `outFile` removed; `strict` and `types: []` defaults. | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ ; https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ | high | confirmed |
| C6 | `typescript@7.0.2` tarball contains no `lib/typescript.js` (416 files, 365.6 kB, `lib/tsc.js` 609 B); `typescript@6.0.2` ships `lib/typescript.js` (9.1 MB). | `npm pack typescript@7.0.2 --dry-run`, `npm pack typescript@6.0.2 --dry-run` (run 2026-09-02) | high | confirmed |
| C7 | `typescript-eslint@8.69.0` / `@typescript-eslint/parser@8.69.0` require `typescript >=4.8.4 <6.1.0` and `eslint ^8.57.0 || ^9.0.0 || ^10.0.0`; TS 7 support issue #10940 is open. | `npm view typescript-eslint@8.69.0 peerDependencies` ; https://github.com/typescript-eslint/typescript-eslint/issues/10940 | high | confirmed |
| C8 | dependency-cruiser 18.2.0 (2026-08-10) needs `typescript` installed next to it for TS parsing (or the `swc` parser); v18.1.0 notes say TS 7.1 is "the first version in the TypeScript 7 (formerly tsgo) version range dependency-cruiser will be able to support". | `npm view dependency-cruiser@18.2.0` ; https://github.com/sverweij/dependency-cruiser/blob/main/doc/faq.md ; https://github.com/sverweij/dependency-cruiser/releases | high | confirmed |
| C9 | ESLint 10.0.0 (2026-02-06) removed eslintrc entirely; requires Node ^20.19.0 || ^22.13.0 || >=24; npm latest is 10.9.1. | https://eslint.org/blog/2026/02/eslint-v10.0.0-released/ ; `npm view eslint dist-tags` | high | confirmed |
| C10 | eslint-plugin-boundaries 7.2.0 (2026-08-09, peer `eslint >=6`) exposes one canonical rule `boundaries/dependencies` (`default`, `policies[{from,to,allow,disallow,message}]`), settings `boundaries/elements` (`type`, `pattern`, `capture`), `boundaries/root-path`, selectors incl. `fileInternalPath` and `captured`; `element-types`, `entry-point`, `external`, `no-private` are deprecated. | `npm view eslint-plugin-boundaries@7.2.0` ; https://www.jsboundaries.dev/docs/rules/ ; https://www.jsboundaries.dev/docs/policies/ ; https://www.jsboundaries.dev/docs/selectors/ ; https://www.jsboundaries.dev/docs/settings/ | high | confirmed |
| C11 | eslint-plugin-import-x 4.17.1 supports ESLint 8.57/9/10, exports `importX.flatConfigs.recommended` / `.typescript`, rules `no-restricted-paths` (`basePath`, `zones[{target,from,except,message}]`), `no-internal-modules`, `no-cycle`; its resolver (`eslint-import-resolver-typescript` 4.4.5) uses `get-tsconfig` + `unrs-resolver`, not the TS API. | `npm view eslint-plugin-import-x@4.17.1` ; https://github.com/un-ts/eslint-plugin-import-x ; docs/rules/no-restricted-paths.md ; `npm view eslint-import-resolver-typescript@4.4.5 dependencies` | high | confirmed |
| C12 | Under `moduleResolution` `bundler`/`nodenext` TypeScript honours package.json `exports` and `#` subpath `imports`; project references load a referenced project's `.d.ts` output and require `composite`. | https://www.typescriptlang.org/docs/handbook/modules/reference.html ; https://www.typescriptlang.org/docs/handbook/project-references.html | high | confirmed |
| C13 | Service bindings have "zero overhead or added latency" and run "on the same thread of the same Cloudflare server"; config is `services: [{ binding, service, entrypoint }]`; DOs in another Worker use `script_name`; `d1_databases` is an array. | https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ | high | confirmed |
| C14 | Workers RPC: `import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers"`; needs compatibility date >= 2024-04-03 or `rpc` flag; named entrypoints are reachable only through bindings; class instances over RPC must extend `RpcTarget`. `ctx.exports` provides loopback bindings for `WorkerEntrypoint` and storage-configured `DurableObject` exports. | https://developers.cloudflare.com/workers/runtime-apis/rpc/ ; https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ | high | confirmed |
| C15 | D1 limits: 10 databases (Free) / 50,000 (Paid); 500 MB / 10 GB per database; 100 columns per table; 50 / 1000 queries per Worker invocation; D1 has no schema namespaces (PRAGMA scoped to the transaction). | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/d1/sql-api/sql-statements/ | high | confirmed |
| C16 | Hono recommends one `Hono` instance per feature mounted with `app.route('/authors', authors)` and no controller classes; `createFactory().createHandlers()` if grouping is wanted. | https://hono.dev/docs/guides/best-practices | high | confirmed |
| C17 | `@cloudflare/vitest-pool-workers` was renamed `@cloudflare/vitest-plugin` (v1; 1.1.3 latest, created 2026-08-20); codemod `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`; config is `plugins: [cloudflareTest({ wrangler: { configPath } })]`, Vitest ^4.1; storage isolation is per test file (`--max-workers=1 --no-isolate` to share). | https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ ; https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ ; https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/ ; `npm view @cloudflare/vitest-plugin` | high | confirmed |
| C18 | Vitest `test.projects` replaces the deprecated `workspace` (since 3.2); `--project <name>` runs one project. | https://vitest.dev/guide/projects | high | confirmed |
| C19 | `knip@6.34.0` depends on `oxc-parser`/`oxc-resolver` and not on `typescript`, so it can run on a TS 7 workspace (behaviour on this layout not executed). | `npm view knip@6.34.0 dependencies` | medium | confirmed |
| C20 | The local template (`packages/core`) already uses `cloudflareTest` from `@cloudflare/vitest-pool-workers` 0.22 and passes 8/8 workerd tests with TS 7.0.2; its `tsconfig` (`ES2022`, `ESNext`, `Bundler`, explicit `types`) is TS 7 compliant. | /Users/peter/Projects/IOSApp/packages/core/vitest.config.ts, tsconfig.json; task context | high | confirmed |
| C21 | [UNVERIFIED] Sam Newman's *Monolith to Microservices* describes the modular monolith as a single process of separate modules worked on independently but combined for deployment (book text; the author's site only lists the book). | https://samnewman.io/books/monolith-to-microservices/ | medium | unverifiable |
| C22 | ESLint 9.x reached end-of-life on 2026-08-06 (search-engine summary; not read from eslint.org). | https://eslint.org/blog/2026/01/eslint-2025-year-review/ (via search) | low | confirmed |
| C23 | [UNVERIFIED] wrangler's esbuild bundling honours workspace-package `exports`/`imports` maps for in-repo module packages. | UNVERIFIED in this research | low | unverifiable |

## Open questions

1. **Per-user object split vs one `Player`/`User` DO.** This document recommends one DO class per module (`identity.Profile`, `economy.Wallet`, `collections.Progress`); `domain-spec-extraction.md` and `workers-modular-monolith.md` fold reward-loop state into one object for single-commit atomicity. Decide before scaffolding — it changes the event catalogue's producers and the dedupe tables.
2. **`tools/lint` with `typescript@6.0.2` alongside `typescript@7.0.2`** is derived from verified peer ranges but was not executed in this repo (pnpm isolation, `eslint-import-resolver-typescript` reading a TS 7 project's tsconfig that omits `baseUrl`). Prototype it in the first scaffold PR; if it is brittle, fall back to Biome/oxlint for the deep-import ban plus the Vitest arch test (S7), and defer boundaries/dependency-cruiser to TS 7.1 (no release date is published: the TS 7.0 post only says 7.1 is "on the horizon"; npm's `next` tag is `7.1.0-dev.20260902.1` as of 2026-09-02; dependency-cruiser's note names 7.1 as the first supportable version).
3. **eslint-plugin-boundaries selector details.** The template form is Handlebars (`{{from.element.captured.name}}`, corrected in S6 on 2026-09-02); the `anyOf` forms used in S6 come from the v7 policies/selectors docs but were not run; verify the exact syntax against https://www.jsboundaries.dev/docs/selectors/ when writing the config.
4. **Vitest `projects` + `cloudflareTest` inheritance.** Closed 2026-09-02: the Vitest projects guide says `extends: true` inherits `plugins` and `pool` from the root config (S8). Remaining check is only a smoke run with Vitest 4.1.11 / `@cloudflare/vitest-plugin` 1.1.3; the alternative is one config per module directory listed as globs in `test.projects`.
5. **Workspace-package modules (compiler-enforced boundaries).** If the team wants Brown's compiler enforcement now rather than lint enforcement, each module becomes `packages/modules/<name>` with an `exports` map; confirm wrangler's bundler resolves pnpm-linked packages with `exports` and that `wrangler types` output still applies (C23 is unverified).
6. **Which module owns `billing`?** Token packs are an `economy` concern, plan/entitlement an `identity` concern; a future RevenueCat/Stripe webhook route could live in `app/` (as an HTTP adapter) and call both — or be its own `billing` module above `economy` and `identity`. Not needed for the mocked v1.
7. **`feed` as a module vs a query layer in `app/`.** It owns no writes; keeping it a module preserves the option to give it its own denormalised `feed_item` table (event-fed) later. Confirm the read-composition cost (several in-process calls per page) is acceptable, which it is in-process but not after any extraction.

## Fact-check log

Fact-checked 2026-09-02. No claim was refuted; 20 confirmed, 3 unverifiable (marked [UNVERIFIED] in the text and the Claims table). Additional corrections applied to the body are listed after the table.

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://www.kamilgrzybek.com/blog/posts/modular-monolith-primer |
| C2 | confirmed | https://github.com/kgrzybek/modular-monolith-with-ddd |
| C3 | confirmed | https://simonbrown.je/modular-monolith/ |
| C4 | unverifiable | https://ardalis.com/introducing-modular-monoliths-goldilocks-architecture/ (HTTP 403 to fetchers); wording consistent with WebSearch excerpts only |
| C5 | confirmed | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ ; https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/ |
| C6 | confirmed | `npm pack typescript@7.0.2 --dry-run` ; `npm pack typescript@6.0.2 --dry-run` |
| C7 | confirmed | `npm view typescript-eslint@8.69.0 peerDependencies` ; https://github.com/typescript-eslint/typescript-eslint/issues/10940 |
| C8 | confirmed | `npm view dependency-cruiser@18.2.0` ; https://github.com/sverweij/dependency-cruiser/blob/main/doc/faq.md ; https://github.com/sverweij/dependency-cruiser/releases |
| C9 | confirmed | https://eslint.org/blog/2026/02/eslint-v10.0.0-released/ ; `npm view eslint dist-tags` |
| C10 | confirmed | `npm view eslint-plugin-boundaries@7.2.0` ; https://www.jsboundaries.dev/docs/ (rules, policies, selectors, settings) |
| C11 | confirmed | `npm view eslint-plugin-import-x@4.17.1` ; https://github.com/un-ts/eslint-plugin-import-x ; `npm view eslint-import-resolver-typescript@4.4.5 dependencies` |
| C12 | confirmed | https://www.typescriptlang.org/docs/handbook/modules/reference.html ; https://www.typescriptlang.org/docs/handbook/project-references.html |
| C13 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ |
| C14 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/rpc/ ; https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ |
| C15 | confirmed | https://developers.cloudflare.com/d1/platform/limits/ ; https://developers.cloudflare.com/d1/sql-api/sql-statements/ |
| C16 | confirmed | https://hono.dev/docs/guides/best-practices |
| C17 | confirmed | https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/ ; Cloudflare vitest-integration docs ; `npm view @cloudflare/vitest-plugin` |
| C18 | confirmed | https://vitest.dev/guide/projects |
| C19 | confirmed | `npm view knip@6.34.0 dependencies` |
| C20 | confirmed | /Users/peter/Projects/IOSApp/packages/core/vitest.config.ts, tsconfig.json |
| C21 | unverifiable | https://samnewman.io/books/monolith-to-microservices/ (book listing only; no definition text on the page) |
| C22 | confirmed | https://eslint.org/blog/2026/01/eslint-2025-year-review/ |
| C23 | unverifiable | none (wrangler/esbuild `exports` handling for workspace packages not tested) |

Body corrections applied in the same pass (not tied to a single claim id):

- S6 / Open question 3: selector templates use Handlebars `{{from.element.captured.name}}`; `${...}` is only a deprecated legacy message syntax — https://www.jsboundaries.dev/docs/policies/ ; https://www.jsboundaries.dev/docs/selectors/
- F13 / R8 / S5: `ctx.exports` requires `compatibility_flags: ["enable_ctx_exports"]` (no default-on date) — https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ ; https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- F15: `ProvidedEnv` does not exist in `@cloudflare/vitest-plugin@1.1.3` (`env` is `Cloudflare.Env`); `readD1Migrations` is exported from the package root, not `/config`; tsconfig `types` must move to `@cloudflare/vitest-plugin/types` — `@cloudflare/vitest-plugin@1.1.3` package.json / types
- Summary / F13: service-binding calls count toward the subrequest limit; "no additional request fees" is Standard-pricing-only, CPU time of both Workers is billed — https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/ ; https://developers.cloudflare.com/workers/platform/pricing/
- Open question 2: no published TS 7.1 date (TS 7.0 post says only "on the horizon"; npm `next` = 7.1.0-dev.20260902.1)
- Header: pnpm 11.24.0 is a pin; npm `latest` is 11.25.0 (2026-08-29)
- F11 / R6: added missing peers (`@typescript-eslint/utils ^8.56.0`, `eslint-import-resolver-node *`, `eslint-plugin-import *` for the TS resolver) — npm peerDependencies of eslint-plugin-import-x@4.17.1 and eslint-import-resolver-typescript@4.4.5
- F9: ESLint 10 removed the `v10_config_lookup_from_file` flag (behaviour unconditional; passing it errors) — https://eslint.org/blog/2026/02/eslint-v10.0.0-released/
- F8: referenced projects must set `composite`, which forces `declaration: true` and full `include`/`files` coverage — https://www.typescriptlang.org/docs/handbook/project-references.html
- S8 / Open question 4: `extends: true` inherits `plugins` and `pool` per the Vitest projects guide — https://vitest.dev/guide/projects
