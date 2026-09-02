# Zod 4.5 usage for schemas shared between the Crosscut API and the Expo client

Research date: 2026-09-02. Verified against zod 4.5.4, @hono/zod-validator 0.9.1, @hono/zod-openapi 1.6.2, hono-openapi 1.3.1, hono 4.13.5, TypeScript 7.0.2, pnpm 11.24.0 (the locally installed version; npm `latest` was 11.25.0 on 2026-09-02 — nothing below depends on the difference), Node 26.8.1, @cloudflare/vitest-pool-workers 0.22.0, wrangler 4.128.0. All other pinned versions (zod 4.5.4, hono 4.13.5, TS 7.0.2, wrangler 4.128.0, vitest-pool-workers 0.22.0, @hono/zod-validator 0.9.1, @hono/zod-openapi 1.6.2, hono-openapi 1.3.1, esbuild 0.28.2) were current on npm as of 2026-09-02 (fact-check, `npm view`). Everything marked "measured" was run locally in a scratch lab (`scratchpad/zodlab`); everything else cites an official URL. Items I could not verify are marked UNVERIFIED and carry confidence "low" in the claims table.

## Summary

- Import from the package root: `import * as z from "zod"`. On 4.x the root *is* Zod 4; `zod/v4` is a permanent alias kept for libraries, `zod/v3` is the legacy API, `zod/mini` (alias `zod/v4-mini`) is the tree-shakable functional variant, and `zod/v4/core` is the shared base that library code should target. All subpaths exist in the 4.5.4 `exports` map.
- Zod 4 requires TypeScript >= 5.5 with `strict: true`. Measured: zod 4.5.4 types, `@hono/zod-validator`, `@hono/zod-openapi`, `hono-openapi` and Hono RPC (`hc`) all typecheck with TypeScript 7.0.2 (`tsc -v` = 7.0.2) in 0.2 s for a small shared package.
- Bundle cost in a Worker (measured with esbuild, minified, gzip): a Worker with one object schema on classic `zod` is ~25 KB gz; the same on `zod/mini` is ~7 KB gz; `z.toJSONSchema` adds ~1.6 KB; `z.compile` adds ~7 KB. Against the 3 MB (free) / 10 MB (paid) gzip limit this is irrelevant on the Worker; on the Expo app it is also small compared to React Native itself. Use classic `zod` everywhere; do not adopt Mini.
- The API-relevant breaking changes from v3: `error` param replaces `message`/`invalid_type_error`/`required_error`/`errorMap`; `.default()` now short-circuits and must match the *output* type (`.prefault()` is the old behavior); `z.coerce.*` input type is `unknown` and a missing key errors unless `.default()`; `z.email()/z.uuid()/z.url()/z.iso.datetime()` are top-level (method forms deprecated); `.strict()/.passthrough()/.strip()` deprecated in favor of `z.strictObject()/z.looseObject()` (`z.object()` still strips); `.format()/.flatten()/.errors` replaced by `z.treeifyError()/z.prettifyError()` and `.issues`; `z.record()` needs two args (a TypeScript-level constraint — `z.record(z.string())` does not throw at runtime on 4.5.4, fact-check measured); `z.nativeEnum()` deprecated; `z.discriminatedUnion` accepts nested unions/pipes; UUID validation is stricter (RFC 9562 variant bits).
- Zod 4.5 (2026-08-28) adds `z.compile()` (runtime `new Function` code generation with silent fallback), top-level `z.validate(schema, data)` boolean fast path, ~9x lower per-schema memory, `z.deepPartial`, `.exactPartial`, and two soundness changes that matter for an API: `z.iso.datetime()` now requires seconds (measured: `"2026-09-02T10:00Z"` fails) and string `.min/.max/.length` count code points.
- `z.compile` uses `new Function`, which Cloudflare Workers forbid in production ("For security reasons, the following are not allowed: eval(), new Function"). Measured: inside vitest-pool-workers 0.22.0 only `new Function` is permitted (via the test pool's unsafe-eval shim); direct and indirect `eval` are blocked locally with "Code generation from strings disallowed for this context" (fact-check measured), so local tests will not reveal the production difference for `z.compile`. The fallback is silent: `z.compile(schema)` wraps codegen in try/catch and returns the *original* schema object when `new Function` throws, unless `{ strict: true }` is passed (then `ZodCompileUnsupportedError`) — measured with `node --disallow-code-generation-from-strings`. Do not use `z.compile` or `import "zod/compile"` in the Worker — per-request parsing of small crossword payloads is nowhere near the hot path.
- Hono integration: `@hono/zod-validator` 0.9.1 peers on `zod ^3.25 || ^4` and `hono >= 4.11.2`; `@hono/zod-openapi` 1.6.2 peers on `zod ^4` and depends on `@asteasolutions/zod-to-openapi ^9.1` (peer `zod ^4`); `hono-openapi` 1.3.1 is validator-agnostic via Standard Schema (Zod 4 implements `~standard`). Measured gotchas: (1) the default zValidator 400 body is `{"success":false,"error":{"name":"ZodError","message":"[...]"}}` with the issue list only inside a JSON *string*, so always pass a hook; (2) `.openapi()` is only present on schemas constructed *after* `extendZodWithOpenApi` ran, because Zod 4 instances do not inherit from `ZodType.prototype`, so a shared package must never rely on `.openapi()`; use `.meta()`; (3) `hc`'s `InferResponseType` includes the validator's 400 branch, so narrow on `res.ok` or use `InferResponseType<T, 200>`.
- Shared package shape: `packages/shared` exports schemas plus `z.input`/`z.output` types, declares `zod` as a `peerDependency` (plus devDependency), and the Worker and the Expo app each depend on the same `zod` via a pnpm catalog. pnpm 11 defaults (`autoInstallPeers: true`, `dedupePeerDependents: true`, `resolvePeersFromWorkspaceRoot: true`) produced exactly one `zod@4.5.4` in the lab's *runtime* dependency graph (zod, @hono/zod-validator, @hono/zod-openapi, hono-openapi). Correction (fact-check, `pnpm why zod` in `scratchpad/zodlab`): the lab's `node_modules/.pnpm` actually holds **two** zod copies, because `@cloudflare/vitest-pool-workers@0.22.0` hard-pins `zod: 4.4.3` as a regular dependency; that dev-only copy never enters the Worker bundle and `pnpm dedupe --check` cannot remove it. Metro resolves package `exports` by default since Metro 0.82 / RN 0.79, so `zod` and `zod/mini` subpaths resolve in Expo; the Hermes `instanceof` bug was fixed in zod 4.0.17 and the `export * as` Babel plugin has been built into `babel-preset-expo` since SDK 49.

## Findings

### F1. Package layout and import paths (zod 4.5.4)

`npm view zod@4.5.4 exports` shows these subpaths: `.`, `./v3`, `./v4`, `./mini`, `./v4-mini`, `./v4/core`, `./v4/mini`, `./v4/locales`, `./v4/locales/*`, `./locales`, `./compile`, `./package.json`. Each has four conditions: `types` (`.d.cts`), `import` (`.js`), `require` (`.cjs`) and a custom `@zod/source` (-> `./src/*.ts`) (corrected by fact-check, `npm view zod@4.5.4 exports` run 2026-09-02; an earlier draft said "only types/import/require"). There is no `react-native` or `browser` condition, so Metro will pick `import`; Metro and esbuild ignore the unknown `@zod/source` condition. `sideEffects` is `["./compile.js", "./compile.cjs", "./src/compile.ts"]` — everything else is tree-shakable. No `engines` field.

- zod.dev/v4/versioning: "The package root (`"zod"`) now exports Zod 4", and the `zod/v4` / `zod/v3` / `zod/v4-mini` subpaths "will remain available forever". New projects install `zod@^4` and import from `"zod"`. https://zod.dev/v4/versioning
- Library authors (this applies to `packages/shared` only if it wants to accept *arbitrary* schemas from callers): import only from `"zod/v4/core"` and constrain on `$ZodType`, declare `zod` as a peer dependency. https://zod.dev/library-authors
- Zod Mini: `import * as z from "zod/mini"`; functional wrappers (`z.optional(z.string())`, `.check(z.minLength(5))`); the docs themselves say to skip it for backend code and for most apps because the DX loss outweighs the size win. https://zod.dev/packages/mini

### F2. Requirements: TypeScript 5.5+, strict mode — and TypeScript 7 works

- "Zod is tested against TypeScript v5.5 and later" and "You must enable `strict` mode in your `tsconfig.json`". https://zod.dev/
- Measured: with TypeScript 7.0.2 (`moduleResolution: Bundler`, `strict`, `isolatedModules`) the lab compiled 0 errors across: branded ids, `z.templateLiteral`, `z.discriminatedUnion` of `z.strictObject`s, `z.coerce` query schema with `.default/.prefault/.stringbool`, `z.codec`, `z.toJSONSchema`, `zValidator` routes, `hc<AppType>` client with `InferResponseType`, `@hono/zod-openapi` `createRoute`, `hono-openapi` `describeRoute/resolver/validator`, and a `zod/mini` schema passed through a `$ZodType`-constrained function. Wall time 0.18 s.
- TypeScript 7's known ecosystem caveat is the missing stable programmatic API for tools that embed the compiler (Volar-style tooling), not type-checking; nothing zod-specific was found. https://github.com/withastro/roadmap/discussions/1321

### F3. Breaking changes from v3 that touch an API codebase

Source: https://zod.dev/v4/changelog (quotes below are from that page) plus https://zod.dev/api and measured behavior.

| Area | Zod 4 behavior |
|---|---|
| Error customization | Unified `error` param: `z.string({ error: (iss) => ... })`, `z.string().min(5, { error: "..." })` or the string shorthand `z.string("Not a string!")`. `message` is deprecated; `invalid_type_error`/`required_error` are dropped; `errorMap` renamed to `error`. Precedence: check-level > schema-level > per-parse `parse(data, { error })` > `z.config({ customError })` > locale. https://zod.dev/error-customization |
| `.default()` | "If the input is `undefined`, ZodDefault short-circuits the parsing process and returns the default value. The default value must be assignable to the *output type*." `.prefault()` ("pre-parse default") restores the v3 behavior (value is parsed). Measured: `z.string().transform(s=>s.length).default(5)` returns `5`; `.prefault("hello")` returns `5` after parsing. |
| `z.coerce` | "The input type of all `z.coerce` schemas is now `unknown`"; a missing key is an error unless `.default()` is set. Measured: `z.coerce.number()` on `"abc"` yields `invalid_type` with message `Invalid input: expected number, received NaN`. |
| String formats | `z.email()`, `z.uuid()`, `z.uuidv4/6/7()`, `z.url()`, `z.httpUrl()`, `z.iso.date()`, `z.iso.datetime()`, `z.nanoid()`, `z.cuid2()`, `z.ulid()`, `z.jwt()`, `z.base64url()`; "The method forms (`z.string().email()`) still exist and work as before, but are now deprecated." `z.uuid()` "now validates UUIDs more strictly against the RFC 9562/4122 specification"; use `z.guid()` for lenient. |
| Objects | `.strict()`, `.passthrough()`, `.strip()` deprecated: "Instead use the top-level `z.strictObject()` and `z.looseObject()`". `z.object()` still strips unknown keys (measured). `.merge()` deprecated for `.extend()`; `.deepPartial()` removed as a method (4.5 brings back a functional `z.deepPartial()`). |
| Unions | `z.discriminatedUnion` now composes: options may be unions/pipes and the discriminator may be a literal, enum, `null`/`undefined`; `z.getDiscriminatedOption(schema, value)` picks one branch. Measured error for a bad discriminator: `Invalid discriminator value. Expected 'fifty' \| 'word'` at `properties.kind`. |
| Errors | `ZodError.format()` and `.flatten()` deprecated -> `z.treeifyError()`; `z.prettifyError()` returns a human string; `.errors` alias removed -> `.issues`; issue types are `z.core.$Zod*`. |
| Records / enums | `z.record(key, value)` requires two args at the type level only (fact-check measured: `z.record(z.string())` does not throw at runtime on 4.5.4); enum keys are exhaustively checked (use `z.partialRecord()`); `z.nativeEnum()` deprecated in favor of `z.enum()`. |
| Numbers | `z.number()` rejects NaN/Infinity; `z.int()` = safe integers; `z.int32()` etc. Measured: `z.int().min(0)` renders as JSON Schema `integer` with `maximum: 9007199254740991`. |
| Internals | `ZodEffects` is gone; refinements live in the schema, `.transform()` returns `ZodPipe` wrapping a `ZodTransform`; `._def` -> `._zod.def`. Also (4.4.0+) `z.unknown()`/`z.any()` keys are required. |
| Types | `z.infer` = `z.output`; `z.input` for the wire shape. `.brand<"X">()` infers `T & z.$brand<"X">`; brand direction can be `"in" \| "out" \| "inout"` (default out). https://zod.dev/api |

### F4. Zod 4.5 (released 2026-08-28; 4.5.4 on 2026-08-29)

Sources: https://zod.dev/blog/zod-4-5, https://zod.dev/blog/introducing-z-compile, https://zod.dev/compile, https://github.com/colinhacks/zod/releases, `npm view zod time`.

- `z.compile(schema)` returns a compiled clone; "Valid inputs take the compiled path; invalid inputs fall back to the regular parser" (package README). Implemented with `Function`-based code generation. Fact-check correction: the literal `new Function` in `v4/core/compile.js` appears only in a comment; the executable code uses an indirection (`const F = Function; new F(...)`), so the compiled lab bundle contains 0 literal `new Function` occurrences even *with* `z.compile` — a CI grep for the literal would **not** catch an accidental `z.compile` / `zod/compile` import. Grep for `zod/v4/core/compile` or ban the import via lint instead. Without `z.compile` the compile module is not pulled in at all (tree-shakes). Failure mode (fact-check, measured with `node --disallow-code-generation-from-strings`): `z.compile(schema)` catches the codegen error and silently `return schema` (the original, uncompiled object) unless `{ strict: true }` is passed, which throws `ZodCompileUnsupportedError`. Separately, zod's `util.allowsEval` returns `false` when `navigator.userAgent` includes "Cloudflare" (true in Workers since the `global_navigator` compat flag), which disables Zod's object-parsing JIT fast path there — a small perf caveat for the regular parser in production. `import "zod/compile"` turns on auto-compilation for every schema constructed *after* that import; `z.config({ jitless: true })` disables global mode. Not compiled (falls back): async refinements/transforms, `z.xor()`, recursive schemas, `z.coerce.*`, custom `when` checks, `.catch()` callbacks. Cost "7 KB gzipped (28 KB minified)". Measured: +7.1 KB gz in a Worker bundle.
- `z.validate(schema, data): boolean` and `z.validateAsync`. Measured on 4.5.4: it is a **top-level function** (`typeof z.validate === "function"`), and `schema.validate` is `undefined`. This matches the docs: the 4.5 blog and the v4.5.0 release notes describe it as standalone (`z.validate(z.string(), "hi")`), not as a method (fact-check; an earlier draft wrongly said the blog called it a "method").
- Memory: lazy method binding, "up to 9.8x" lower per-schema footprint; `safeParse` failure ~7.5x faster by skipping stack capture.
- New: `z.creditCard()`, `z.properties()`, `z.deepPartial()`, `.exactPartial()`, `z.input(schema)`/`z.output(schema)` projections for codecs, `z.toZod<T>()`, eight locales.
- Soundness changes that are effectively breaking for an API: `z.iso.datetime()` requires seconds (measured `"2026-09-02T10:00Z"` -> invalid); `.min/.max/.length` count Unicode code points; `__proto__` always stripped; stricter IPv6/ULID/httpUrl/emoji.

### F5. Bundle size and runtime in Cloudflare Workers (measured)

esbuild 0.28.2, `--bundle --minify --format=esm --platform=browser --conditions=workerd,worker --target=es2022`, one Worker with a 4-field object schema (`uuidv7`, coerced int with default, enum, iso datetime):

| Variant | minified | gzip |
|---|---|---|
| `zod` (classic) | 89,131 B | 25,218 B |
| `zod/mini` | 21,743 B | 7,201 B |
| `zod` + `z.toJSONSchema` | 94,742 B | 26,855 B |
| `zod` + `z.compile` | 117,663 B | 32,345 B |

Zod's own headline numbers (5.36 KB gz for `zod`, 1.88 KB for Mini) are per-feature core figures; a realistic Worker entry that pulls the English locale, format regexes and classic method surface lands at ~25 KB gz. Both are far below the Workers limit: "Free plan: 3 MB, Paid plan: 10 MB" gzip, 1 s startup budget, 128 MB per isolate. https://developers.cloudflare.com/workers/platform/limits/

Inside workerd (vitest-pool-workers 0.22.0, wrangler 4.128.0, `compatibility_date` 2025-09-01, `nodejs_compat`), 4/4 tests passed: parse+coerce, `z.compile` clone parses valid and rejects invalid input, `z.toJSONSchema` works, and a Hono route with `zValidator("query", ...)` returns 200 on `?limit=10` and 400 on `?limit=99`. `new Function("return 1")` did **not** throw in local workerd, whereas the Workers runtime docs list `eval()` and `new Function` as disallowed for security reasons. Nuance (fact-check measured): inside vitest-pool-workers 0.22.0 only `new Function` is permitted; direct and indirect `eval` are blocked locally with "Code generation from strings disallowed for this context". The local `new Function` allowance comes from the test pool's unsafe-eval shim, so "local workerd allows dynamic code" must not be generalized. https://developers.cloudflare.com/workers/runtime-apis/web-standards/

### F6. `@hono/zod-validator` 0.9.1

- Peers (npm): `zod ^3.25.0 || ^4.0.0`, `hono >=4.11.2`. Targets: `json | query | param | header | cookie | form`. Hook `(result, c) => ...` where `result` is `{ success: true, data } | { success: false, error: ZodError, data }` plus `target`. Option `validationFunction` overrides the default `safeParseAsync`. Types are selected structurally (`zod/v3` vs `zod/v4/core` type imports); runtime distinguishes v3/v4 with `'_def' in schema || '_zod' in schema` (only relevant for `header`). https://github.com/honojs/middleware/blob/main/packages/zod-validator/src/index.ts and README.
- Measured default failure response (no hook): `c.json(result, 400)` serializes to `{"success":false,"error":{"name":"ZodError","message":"[ ...issues JSON... ]"}}` — `issues` is not an enumerable property on `ZodError`, so clients would have to `JSON.parse(error.message)`. Always supply a hook (or `defaultHook`) that emits your own envelope.
- Measured typing: `c.req.valid("query").limit` is `number` (output type) after `z.coerce.number().default(20)`; the `hc` client must pass `query: { limit: "10" }` as strings ("Both path parameters and query values must be passed as `string`"). https://hono.dev/docs/guides/rpc
- Measured typing: `InferResponseType<typeof client.feed.$get>` is a union that includes `ZodSafeParseError<...>` (the validator's 400). Narrow with `if (!res.ok)` or `InferResponseType<typeof client.feed.$get, 200>`.

### F7. `@hono/zod-openapi` 1.6.2

- Peers: `zod ^4.0.0`, `hono >=4.10.0`; deps `@asteasolutions/zod-to-openapi ^9.1.0` (peer `zod ^4.0.0`), `@hono/zod-validator ^0.9.1`, `openapi3-ts`. Exports `OpenAPIHono`, `createRoute`, `z`, `extendZodWithOpenApi`; `app.doc()` (3.0) and `app.doc31()` (3.1); `defaultHook` for shared validation error formatting; RPC via `hc<typeof appRoutes>`. Source: https://raw.githubusercontent.com/honojs/middleware/main/packages/zod-openapi/src/index.ts — `import { z } from 'zod'` then `extendZodWithOpenApi(z)` at module load, i.e. it mutates the classic zod module.
- Measured, important: `extendZodWithOpenApi` sets `zod.ZodType.prototype.openapi`, but a Zod 4 instance is **not** on `ZodType.prototype`'s chain (`z.ZodType.prototype.isPrototypeOf(schema) === false`; Zod 4 copies methods at construction). Consequence: a schema constructed *before* `@hono/zod-openapi` was evaluated has `schema.openapi === undefined` (runtime `TypeError: SolveResult.openapi is not a function`); the same schema constructed *after* has it. Zod-to-openapi's README says to call it "only once in a common-entrypoint file", and since v8 with Zod 4 you can use `.meta()` instead of `.openapi()`: metadata from `.meta` is treated "as if that was metadata passed into `.openapi`". https://github.com/asteasolutions/zod-to-openapi
- Measured output: a shared `SolveResult` schema with `.meta({ id: "SolveResult", description })` plus `.openapi("SolveResult")` in the Worker produced `components.schemas.SolveResult` with `puzzleId` as `{"type":"string","pattern":"^(en|uk|ru)-(mini|cross)-[+-]?\\d+(\\.\\d+)?$"}`, `solvedAt` as `format: date-time`, and the path param with `example: "en-mini-1"`.

### F8. `hono-openapi` 1.3.1 (Standard Schema based)

- Peers: `hono ^4.11.2` (optional), `@hono/standard-validator ^0.2.0` (optional), `@standard-community/standard-json ^0.3.5`, `@standard-community/standard-openapi ^0.2.9`, `openapi-types ^12.1.3`, `@types/json-schema ^7.0.15`. Single export entry (`import { describeRoute, resolver, validator, openAPIRouteHandler } from "hono-openapi"`); no `hono-openapi/zod` subpath in 1.x. Docs: https://honohub.dev/docs/openapi/zod, example https://hono.dev/examples/hono-openapi. For Zod 4 named components use `.meta({ ref: "Name" })` (registry), not `.openapi()`. Fact-check measured with 1.3.1: `.meta({ id })` alone is **not** enough — a shared schema carrying only `.meta({ id: "ByIdSchema" })` that appears as a nested property of a response schema is emitted as `$ref: "#/components/schemas/ByIdSchema"` while its definition stays in an inline `$defs` of the response schema and nothing is added to `components.schemas` (dangling `$ref`, invalid document). It only lands in `components.schemas` when that exact schema is passed to `resolver()` at top level. Only `.meta({ ref: "Name" })` is reliably relocated. Note that `ref` is not part of Zod's documented `GlobalMeta` and leaks verbatim as a `"ref": "..."` key into `z.toJSONSchema` output. Peer caveat: hono-openapi 1.3.1 declares `@hono/standard-validator ^0.2.0`; pairing it with `@hono/standard-validator` 0.4.0 does not satisfy that range and produced three peer-keyed hono-openapi variants in the lab's `node_modules/.pnpm` (`…_@hono+standard-validator@0.2.0…`, `…@0.4.0_@standard-schema+spec@1.0.0…`, `…@1.1.0…`) — pin 0.2.x or accept the peer warning consciously.
- Measured: it typechecked with TS 7 and produced query parameters straight from the shared `FeedQuery` schema (`limit: {default: 20, type: integer, minimum: 1, maximum: 50}`, `lang` enum with default, `includeSolved` as `string` because it renders the *input* side of `z.stringbool()`).
- Zod 4 implements Standard Schema v1 (`~standard` present in `v4/core/schemas.js`; spec at https://standardschema.dev/, types in `@standard-schema/spec`), which is what makes this and `@hono/standard-validator` work (0.4.0 was used in the lab, but it falls outside hono-openapi 1.3.1's `^0.2.0` peer range — see the peer caveat above; prefer 0.2.x alongside hono-openapi 1.3.1).

### F9. JSON Schema and metadata

- `z.toJSONSchema(schema, { target: "draft-2020-12" | "draft-07" | "draft-04" | "openapi-3.0", io: "output" | "input", unrepresentable: "throw" | "any", cycles, reused, override, metadata })`. Unrepresentable: `z.date()`, `z.map/set`, `z.bigint`, `z.transform`, `z.custom`, etc. `z.fromJSONSchema()` exists (experimental). https://zod.dev/json-schema
- `.meta({ id, title, description, deprecated, examples })` registers in `z.globalRegistry`; `.describe()` is a shorthand for `description`; duplicate `id`s throw; metadata does not survive `.optional()/.extend()` because every method returns a new instance. https://zod.dev/metadata
- Measured: with `target: "openapi-3.0"` and `.meta({ id: "S" })` the standalone output is `{"$ref":"#/definitions/S","definitions":{...}}` (not `#/components/schemas`); the OpenAPI libraries do that relocation themselves — but hono-openapi 1.3.1 only does it reliably for `.meta({ ref })`; an `id`-only nested schema yields a dangling `#/components/schemas/...` `$ref` with the definition left in an inline `$defs` (fact-check measured; see F8). `io: "input"` renders coerced/defaulted fields on the wire side (`limit` integer with `default: 20`, `stringbool` as `string`).

### F10. IDs: `z.templateLiteral` vs regex for Crosscut ids

Crosscut puzzle ids are slugs like `en-mini-1`, `cross-en-1` (design handoff). Measured: `z.templateLiteral([z.enum(["en","uk","ru"]), "-", z.enum(["mini","cross"]), "-", z.int().positive()])` compiles to the regex `^(en|uk|ru)-(mini|cross)--?\d+$`, so it **accepts `en-mini-0`** and a negative sign despite `.positive()` — numeric checks are not encoded. A plain `z.string().regex(/^(en|uk|ru)-(mini|cross)-[1-9]\d*$/).brand<"PuzzleId">()` is exact and produces the same JSON Schema `pattern`. Prefer regex + brand for ids; keep `z.templateLiteral` for cases where the literal parts alone define the format.

### F11. pnpm 11 and "one copy of zod"

- Settings live in `pnpm-workspace.yaml` (only auth/registry in `.npmrc`). Defaults: `autoInstallPeers: true`, `dedupePeerDependents: true` ("packages with peer dependencies will be deduplicated after peers resolution"), `resolvePeersFromWorkspaceRoot: true`, `strictPeerDependencies: false`, `nodeLinker: "isolated"`, `minimumReleaseAge: 1440` minutes in v11 (0 before). `overrides:` and `catalog:` are top-level keys; `pnpm dedupe --check` fails CI when the lockfile could be deduplicated. https://pnpm.io/settings/peer-dependencies, https://pnpm.io/settings/node-modules, https://pnpm.io/settings/dependency-resolution, https://pnpm.io/cli/dedupe
- Measured: installing `zod@4.5.4`, `@hono/zod-validator`, `@hono/zod-openapi` (-> zod-to-openapi), `hono-openapi` and `@hono/standard-validator` resolved a single `zod@4.5.4` for the *runtime* graph (`@asteasolutions+zod-to-openapi@9.1.0_zod@4.5.4` peer-keyed). Correction (fact-check: `pnpm why zod` in `scratchpad/zodlab`; `npm view @cloudflare/vitest-pool-workers@0.22.0 dependencies`; `ls node_modules/.pnpm`): the same lab holds **two** zod copies — `zod@4.4.3` pulled by `@cloudflare/vitest-pool-workers@0.22.0`, which pins `zod: 4.4.3` as a hard (non-peer) dependency, and `zod@4.5.4` for everything else. Any package that installs the Workers test pool will therefore always carry a second zod in the pnpm store; `pnpm dedupe --check` will neither flag nor fix it. It is harmless for the Worker bundle, but an "exactly one zod" CI expectation must be scoped to the production dependency graph (e.g. `pnpm why zod --prod`). Observed: pnpm 11 auto-added `@hono/zod-openapi@1.6.2` to `minimumReleaseAgeExclude` because the exact version was younger than 24 h; expect this when pinning day-old releases.

### F12. Expo / Metro / Hermes

- Metro resolves `package.json#exports` by default since "Metro 0.82 (or React Native 0.79)"; option `resolver.unstable_enablePackageExports`; conditions asserted: `import` *or* `require` plus `react-native` (customizable via `resolver.unstable_conditionNames`); a subpath like `zod/mini` resolves to the exact target file. https://metrobundler.dev/docs/package-exports/
- Expo monorepos: SDK 52+ `expo/metro-config` configures `watchFolders`/`nodeModulesPaths` automatically (remove manual settings); with pnpm, "If isolated dependencies cause issues" set `nodeLinker: hoisted` in `pnpm-workspace.yaml`; duplicate React / React Native copies are unsupported (use `why`, overrides). https://docs.expo.dev/guides/monorepos/ Fact-check update: the Expo docs now state that SDK 54+ supports pnpm isolated dependencies natively and that SDK 55 enables monorepo autolinking resolution automatically, so `nodeLinker: hoisted` is a last resort rather than the first escape hatch.
- Hermes: zod issue #5070 ("Invalid element at key ... expected a Zod schema") was caused by Hermes not honoring `Symbol.hasInstance`; fixed in **zod 4.0.17** by removing internal `instanceof` reliance (issue closed 2025-08-09). https://github.com/colinhacks/zod/issues/5070
- `export * as core from "zod/v4/core"` needs `@babel/plugin-transform-export-namespace-from`; it has been built into `babel-preset-expo` since SDK 49, so current Expo SDKs need nothing. https://github.com/colinhacks/zod/issues/4741 (issue), https://twitter.com/Baconbrix/status/1686433157069864960 (preset note). Running zod 4.5.4 on a physical Hermes device (Expo SDK 54/55) was not tested here — [UNVERIFIED] (C36; the fact-check found no primary source either way for 4.5.x on Hermes).

### F13. Hono RPC and shared types

"For the RPC types to work properly in a monorepo, in both the Client's and Server's tsconfig.json files, set `"strict": true`"; keep identical Hono versions on both sides; large route trees slow the IDE — split with `.route()`, create per-feature clients, or pre-compile the client type (`export type Client = ReturnType<typeof hc<typeof app>>`). https://hono.dev/docs/guides/rpc

## Recommendation for Crosscut

1. **One zod, classic API, root import.** `import * as z from "zod"` everywhere (Worker, `packages/shared`, Expo app). Do not use `zod/mini` (DX cost, two idioms, 18 KB gz saving is irrelevant on both targets). Do not import `zod/v4` in app code; that alias is for libraries.
2. **`packages/shared` owns the wire contract.** Put request/response/event schemas there, export both the schema and `z.input`/`z.output` types. `peerDependencies: { zod: "^4.5.4" }` + `devDependencies: { zod }`; the Worker and the app list `zod: "catalog:"`. Add `pnpm dedupe --check` to CI so a second zod copy cannot creep into the *production* graph — scope the check accordingly, because `@cloudflare/vitest-pool-workers` 0.22.0 hard-pins `zod 4.4.3` and will always add a dev-only second copy that `dedupe` cannot remove (F11). Expo SDK 54+ supports pnpm isolated dependencies natively and SDK 55 auto-configures monorepo autolinking (Expo docs, fact-check), so keep `nodeLinker: isolated`; flip to `nodeLinker: hoisted` only as a last resort, never `shamefullyHoist`.
3. **Never call `.openapi()` in `packages/shared`.** Use `.meta({ id, description, examples })` (native, JSON-Schema-visible, understood by zod-to-openapi >= 8). Caveat (fact-check measured, F8): with hono-openapi 1.3.1 `.meta({ id })` alone is not enough for named components — nested `id`-only schemas produce a dangling `#/components/schemas/...` `$ref`. If the shared package must stay hono-openapi friendly, add `ref` alongside `id` (`.meta({ id: "SolveResult", ref: "SolveResult", ... })`, accepting that `ref` is outside Zod's documented `GlobalMeta` and leaks as a `"ref"` key into `z.toJSONSchema` output) or post-process the assembled document. Zod 4 instances do not pick up `extendZodWithOpenApi` after the fact, so `.openapi()` on a shared schema is an evaluation-order landmine. If `@hono/zod-openapi` is adopted in the Worker, import it in the Worker entry *before* any module that constructs schemas, and keep `.openapi()` calls (route params/examples) inside the Worker.
4. **OpenAPI: prefer `hono-openapi` 1.3.1 over `@hono/zod-openapi`** for a modular monolith: plain `Hono` routers (no `OpenAPIHono` subclass), no prototype mutation, Standard Schema based, response schemas via `resolver(schema)`. It measured correctly against the shared `FeedQuery` schema. Use `@hono/zod-openapi` only if you want `createRoute`-style typed responses; either way the shared package stays framework-free.
5. **Validation middleware:** `@hono/zod-validator` 0.9.1 (or `hono-openapi`'s `validator`, which wraps `@hono/standard-validator` — pin `@hono/standard-validator` 0.2.x to satisfy hono-openapi 1.3.1's `^0.2.0` peer; 0.4.0 produces a peer warning and duplicate peer-keyed hono-openapi variants, F8). Always pass a hook (or a module-level `defaultHook`) that returns your own error envelope `{ error: "VALIDATION", issues: z.treeifyError(result.error) }` — the default 400 body hides issues inside a string.
6. **Query/param schemas:** `z.coerce.number().int().min().max().default(n)`, `z.stringbool().default(false)`, `z.enum([...]).prefault("en")`. Remember `z.coerce` input is `unknown` and the `hc` client must send strings; use `InferResponseType<..., 200>` or `res.ok` narrowing.
7. **Ids:** `z.string().regex(/^(en|uk|ru)-(mini|cross)-[1-9]\d*$/).brand<"PuzzleId">()`; user ids `z.uuidv7().brand<"UserId">()` (Better Auth ids: verify their format before choosing `uuid` vs `z.string().min(1)`). Avoid `z.templateLiteral` for ids with numeric constraints (F10).
8. **Objects:** `z.object()` (strip) for inbound bodies from the app, `z.strictObject()` for command payloads that cross module boundaries (typos become 400s), `z.looseObject()` only for pass-through blobs (aggregate state snapshots). Use `z.discriminatedUnion("kind", [...])` for commands (`HintCommand`, `WheelSpin`, `Celebration`) and for the in-process domain events.
9. **Dates/times:** send ISO strings, validate with `z.iso.datetime()` (seconds mandatory since 4.5), and convert on the client with a `z.codec(z.iso.datetime(), z.date(), ...)` when a `Date` is actually needed. D1 `updated_at INTEGER` stays a number schema (`z.int().nonnegative()`).
10. **Money/economy fields:** `z.int().nonnegative()` for tokens/stars/streak, `z.int().min(0).max(300)` for `secondsLeft`, enum for hint kinds with the fixed costs (20/40/100) in shared constants, not in schemas.
11. **Do not use `z.compile` / `import "zod/compile"` in the Worker.** `new Function` is disallowed in production Workers; local workerd (the vitest pool's unsafe-eval shim) will not catch it; the fallback is silent (`z.compile` returns the original schema, fact-check measured), so you would ship a 7 KB no-op. Guard rails: a startup check `try { z.compile(S, { strict: true }) } catch { /* no codegen here */ }` detects a production no-op; and because the executable code uses `const F = Function; new F(...)`, do not rely on grepping the bundle for the literal `new Function` — grep for `zod/v4/core/compile` or ban the `zod/compile` import via lint. Use `z.validate(schema, data)` only where a boolean is enough (e.g. cheap pre-checks in feed assembly).
12. **Errors:** `z.treeifyError` for machine output, `z.prettifyError` for logs; register `z.config(z.locales.en())` only if you want localized messages (the app has EN/UK/RU UI copy — keep validation messages server-side in English and map codes in the app).
13. **TypeScript:** `strict: true` in every package tsconfig (Zod and Hono RPC both require it); TS 7.0.2 verified. Keep a single hono version via the catalog.

## Code sketches

### packages/shared/package.json (relevant parts)

```json
{
  "name": "@crosscut/shared",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "peerDependencies": { "zod": "^4.5.4" },
  "devDependencies": { "zod": "catalog:", "typescript": "catalog:" }
}
```

```yaml
# pnpm-workspace.yaml (root)
packages: ["apps/*", "workers/*", "packages/*"]
catalog:
  zod: 4.5.4
  hono: 4.13.5
  typescript: 7.0.2
allowBuilds:
  esbuild: true
  workerd: true
```

### packages/shared/src/ids.ts

```ts
import * as z from "zod";

export const PuzzleId = z
  .string()
  .regex(/^(en|uk|ru)-(mini|cross)-[1-9]\d*$/, { error: "malformed puzzle id" })
  .brand<"PuzzleId">()
  .meta({ id: "PuzzleId", examples: ["en-mini-1"] });
export type PuzzleId = z.infer<typeof PuzzleId>; // string & z.$brand<"PuzzleId">

export const UserId = z.uuidv7().brand<"UserId">();
export type UserId = z.infer<typeof UserId>;
```

### packages/shared/src/feed.ts (query with coercion; input vs output types)

```ts
export const FeedQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  lang: z.enum(["en", "uk", "ru"]).prefault("en"),
  includeSolved: z.stringbool().default(false),
});
export type FeedQueryIn = z.input<typeof FeedQuery>;   // what hc sends (strings)
export type FeedQueryOut = z.output<typeof FeedQuery>; // what the handler gets (numbers/booleans)
```

### packages/shared/src/commands.ts (discriminated union, strict objects)

```ts
export const HintCommand = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fifty"), clueIndex: z.int().min(0) }),
  z.strictObject({ kind: z.literal("letter"), row: z.int().min(0), col: z.int().min(0) }),
  z.strictObject({ kind: z.literal("word"), clueIndex: z.int().min(0) }),
]);
export type HintCommand = z.infer<typeof HintCommand>;

export const SolveResult = z.object({
  puzzleId: PuzzleId,
  solveSeconds: z.int().nonnegative(),
  usedHints: z.boolean(),
  tokensEarned: z.int().nonnegative(), // floor(secondsLeft / 5)
  starsEarned: z.int().nonnegative(),  // 10 + (usedHints ? 0 : 2)
  solvedAt: z.iso.datetime(),          // seconds required since 4.5
}).meta({ id: "SolveResult", ref: "SolveResult", description: "Result of a completed puzzle" });
// `ref` is what hono-openapi 1.3.1 needs to relocate the schema into components.schemas (F8);
// drop it if hono-openapi is not adopted (it is not part of Zod's GlobalMeta).
```

### workers/gateway: validator with an explicit error envelope

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as z from "zod";
import { FeedQuery, HintCommand, PuzzleId } from "@crosscut/shared";

const invalid = (result: { success: boolean; error?: z.ZodError }, c: any) =>
  result.success ? undefined
    : c.json({ error: "VALIDATION", issues: z.treeifyError(result.error!) }, 400);

export const feed = new Hono()
  .get("/feed", zValidator("query", FeedQuery, invalid), (c) => {
    const q = c.req.valid("query"); // q.limit: number, q.includeSolved: boolean
    return c.json({ items: [], next: null as string | null, limit: q.limit });
  })
  .post("/puzzles/:id/hint",
    zValidator("param", z.object({ id: PuzzleId }), invalid),
    zValidator("json", HintCommand, invalid),
    (c) => c.json({ ok: true as const, kind: c.req.valid("json").kind }));
```

### apps/app: typed client

```ts
import { hc, type InferResponseType } from "hono/client";
import type { AppType } from "@crosscut/gateway/types"; // compiled type only

const api = hc<AppType>(process.env.EXPO_PUBLIC_API_URL!);
type FeedPage = InferResponseType<typeof api.feed.$get, 200>;

const res = await api.feed.$get({ query: { limit: "20", lang: "en" } }); // strings on the wire
if (!res.ok) throw new Error("feed failed");
const page: FeedPage = await res.json();
```

### OpenAPI with hono-openapi (no prototype patching)

```ts
import { describeRoute, resolver, validator, openAPIRouteHandler } from "hono-openapi";
app.get("/feed",
  describeRoute({ responses: { 200: { description: "ok",
    content: { "application/json": { schema: resolver(FeedPage) } } } } }),
  validator("query", FeedQuery),
  (c) => c.json(buildFeed(c.req.valid("query"))));
app.get("/openapi.json", openAPIRouteHandler(app, { documentation: { info: { title: "Crosscut", version: "1" } } }));
```

### Client-side codec for dates

```ts
export const IsoDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});
IsoDate.parse("2026-09-02T10:00:00Z"); // Date
z.encode(IsoDate, new Date());         // ISO string
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | zod 4.5.4 `exports` map contains `.`, `./v3`, `./v4`, `./mini`, `./v4-mini`, `./v4/core`, `./v4/mini`, `./v4/locales`, `./v4/locales/*`, `./locales`, `./compile`, `./package.json`; every subpath has `types`, `import`, `require` **and** a custom `@zod/source` condition; `sideEffects` limited to the compile entry; no `engines` (original "only types/import/require" wording was refuted; corrected per `npm view zod@4.5.4 exports`, 2026-09-02) | `npm view zod@4.5.4 exports`, local package.json | high | refuted (corrected) |
| C2 | The package root `"zod"` exports Zod 4; `zod/v4`, `zod/v3`, `zod/v4-mini` subpaths remain available forever | https://zod.dev/v4/versioning | high | confirmed |
| C3 | Zod 4 is tested against TypeScript >= 5.5 and requires `strict: true` | https://zod.dev/ | high | confirmed |
| C4 | zod 4.5.4 + @hono/zod-validator 0.9.1 + @hono/zod-openapi 1.6.2 + hono-openapi 1.3.1 + hono 4.13.5 typecheck with TypeScript 7.0.2 (0 errors) | measured, `tsc -p` in scratch lab | high | confirmed |
| C5 | Unified `error` param replaces `message`/`invalid_type_error`/`required_error`/`errorMap`; precedence check > schema > per-parse > `z.config` > locale | https://zod.dev/error-customization, https://zod.dev/v4/changelog | high | confirmed |
| C6 | `.default()` short-circuits on `undefined` and must match the output type; `.prefault()` is the v3 behavior | https://zod.dev/v4/changelog; measured | high | confirmed |
| C7 | `z.coerce.*` input type is `unknown`; missing keys error unless `.default()` | https://zod.dev/v4/changelog; measured | high | confirmed |
| C8 | `z.email()`, `z.uuid()`, `z.url()`, `z.iso.datetime()` etc. are top-level; method forms still work but are deprecated; `z.uuid()` is stricter (RFC 9562) | https://zod.dev/v4/changelog, https://zod.dev/api | high | confirmed |
| C9 | `.strict()/.passthrough()/.strip()` deprecated in favor of `z.strictObject()/z.looseObject()`; `z.object()` strips unknown keys | https://zod.dev/v4/changelog; measured | high | confirmed |
| C10 | `ZodError.format()/.flatten()` deprecated -> `z.treeifyError()`; `.errors` removed -> `.issues`; `z.prettifyError()` exists | https://zod.dev/v4/changelog, https://zod.dev/error-customization; measured | high | confirmed |
| C11 | `z.record()` requires two args (TypeScript-level only; `z.record(z.string())` does not throw at runtime on 4.5.4); `z.nativeEnum()` deprecated; `z.discriminatedUnion` supports nested unions/pipes; `z.getDiscriminatedOption` exists | https://zod.dev/v4/changelog, https://zod.dev/api; measured | medium | confirmed |
| C12 | `z.toJSONSchema` options: `target` (`draft-2020-12` default, `draft-07`, `draft-04`, `openapi-3.0`), `io`, `unrepresentable`, `cycles`, `reused`, `override`, `metadata`; `z.date()`/`z.map`/`z.transform` etc. are unrepresentable | https://zod.dev/json-schema | high | confirmed |
| C13 | `.meta()` registers in `z.globalRegistry`; duplicate `id` throws; metadata is not carried across `.optional()/.extend()` | https://zod.dev/metadata | high | confirmed |
| C14 | Zod 4.5.0 shipped 2026-08-28, 4.5.4 on 2026-08-29; adds `z.compile`, `z.validate`, `z.deepPartial`, `.exactPartial`, `z.creditCard`, lazy method binding (~9x memory) | `npm view zod time`, https://zod.dev/blog/zod-4-5, https://github.com/colinhacks/zod/releases | high | confirmed |
| C15 | `z.compile` uses `new Function`; unavailable under CSP/no-eval, falls back to the runtime parser; `z.config({ jitless: true })` disables global mode; ~7 KB gz | https://zod.dev/compile, https://zod.dev/blog/introducing-z-compile; measured +7.1 KB | high | confirmed |
| C16 | Cloudflare Workers disallow `eval()` and `new Function` in production; local workerd (vitest-pool-workers) does not block `new Function` (nuance: only `new Function`, via the test pool's unsafe-eval shim; `eval` is blocked locally too) | https://developers.cloudflare.com/workers/runtime-apis/web-standards/; measured in workerd | high | confirmed |
| C17 | In 4.5.4 `z.validate(schema, data)` is a top-level function; `schema.validate` is undefined (consistent with the blog/release notes, which describe it as standalone) | measured (`typeof z.validate`, `typeof S.validate`); https://zod.dev/blog/zod-4-5 | high | confirmed |
| C18 | 4.5 soundness changes: `z.iso.datetime()` requires seconds; string length checks count code points; `__proto__` stripped | https://zod.dev/blog/zod-4-5; measured datetime | high | confirmed |
| C19 | Worker bundle (esbuild, gzip): classic zod ~25.2 KB, zod/mini ~7.2 KB, +toJSONSchema ~26.9 KB, +compile ~32.3 KB | measured | high | confirmed |
| C20 | Workers script size limits: 3 MB free / 10 MB paid (gzip); 1 s startup; 128 MB per isolate | https://developers.cloudflare.com/workers/platform/limits/ | high | confirmed |
| C21 | @hono/zod-validator 0.9.1 peers: `zod ^3.25.0 \|\| ^4.0.0`, `hono >=4.11.2`; hook receives `{success,data,error}`; `validationFunction` option | `npm view`, package README/source | high | confirmed |
| C22 | zValidator's default 400 body serializes ZodError as `{"success":false,"error":{"name":"ZodError","message":"[...]"}}` (issues only inside the message string) | measured inside workerd | high | confirmed |
| C23 | @hono/zod-openapi 1.6.2 peers `zod ^4.0.0`, `hono >=4.10.0`; depends on @asteasolutions/zod-to-openapi ^9.1.0 (peer `zod ^4.0.0`) and @hono/zod-validator ^0.9.1; calls `extendZodWithOpenApi(z)` on the classic `zod` module at import | `npm view`, https://raw.githubusercontent.com/honojs/middleware/main/packages/zod-openapi/src/index.ts | high | confirmed |
| C24 | `extendZodWithOpenApi` patches `ZodType.prototype.openapi`, but Zod 4 instances are not on `ZodType.prototype`'s chain, so schemas built before the patch lack `.openapi()`; `.meta()` is the supported alternative since zod-to-openapi v8 | measured; https://github.com/asteasolutions/zod-to-openapi | high | confirmed |
| C25 | hono-openapi 1.3.1 is Standard Schema based; peers `hono ^4.11.2` (optional), `@hono/standard-validator ^0.2.0` (optional), `@standard-community/standard-json ^0.3.5`, `@standard-community/standard-openapi ^0.2.9`, `openapi-types ^12.1.3`, `@types/json-schema ^7.0.15`; Zod 4 components via `.meta({ ref })` (`.meta({ id })` alone is not relocated for nested schemas, measured) | `npm view`, https://honohub.dev/docs/openapi/zod; measured | high | confirmed |
| C26 | Zod 4 implements Standard Schema v1 (`~standard`) | `~standard` present in `zod/v4/core/schemas.js`; https://standardschema.dev/ | medium | confirmed |
| C27 | `hc` requires query/param values as strings; monorepo RPC needs `strict: true` on both sides; IDE slowness mitigated by `.route()` splitting or pre-compiled client types | https://hono.dev/docs/guides/rpc | high | confirmed |
| C28 | `InferResponseType` for a zValidator route includes the `ZodSafeParseError` 400 branch; narrow via `res.ok` or `InferResponseType<T, 200>` | measured with TS 7.0.2 | high | confirmed |
| C29 | `z.templateLiteral` with `z.int().positive()` compiles to `--?\d+` and accepts `en-mini-0`; numeric checks are not enforced | measured | high | confirmed |
| C30 | pnpm 11 defaults: `autoInstallPeers: true`, `dedupePeerDependents: true`, `resolvePeersFromWorkspaceRoot: true`, `strictPeerDependencies: false`, `nodeLinker: isolated`, `minimumReleaseAge: 1440`; settings live in `pnpm-workspace.yaml` | https://pnpm.io/settings/peer-dependencies, https://pnpm.io/settings/node-modules, https://pnpm.io/settings/dependency-resolution | high | confirmed |
| C31 | With those defaults the lab resolved a single `zod@4.5.4` for the *runtime* graph (zod, @hono/zod-validator, @hono/zod-openapi with zod-to-openapi peer-keyed `_zod@4.5.4`, hono-openapi) — but `node_modules/.pnpm` also holds `zod@4.4.3`, hard-pinned by `@cloudflare/vitest-pool-workers@0.22.0`; the original single-copy statement was refuted for the full install | `pnpm why zod` in `scratchpad/zodlab`; `npm view @cloudflare/vitest-pool-workers@0.22.0 dependencies`; `ls node_modules/.pnpm` | high | refuted (corrected) |
| C32 | Metro resolves `package.json#exports` by default since Metro 0.82 / RN 0.79; conditions `import`/`require` + `react-native`; subpaths like `zod/mini` resolve | https://metrobundler.dev/docs/package-exports/ | high | confirmed |
| C33 | Expo SDK 52+ configures monorepo Metro settings automatically; pnpm users can set `nodeLinker: hoisted` if isolated deps cause issues; duplicate React/RN copies unsupported (docs now add: SDK 54+ supports pnpm isolated deps natively, SDK 55 auto-configures monorepo autolinking) | https://docs.expo.dev/guides/monorepos/ | high | confirmed |
| C34 | Hermes `instanceof`/`Symbol.hasInstance` bug with Zod 4 was fixed in zod 4.0.17 | https://github.com/colinhacks/zod/issues/5070 (closed 2025-08-09) | high | confirmed |
| C35 | `@babel/plugin-transform-export-namespace-from` (needed for zod's `export * as core`) is built into babel-preset-expo since SDK 49 | https://github.com/colinhacks/zod/issues/4741, https://twitter.com/Baconbrix/status/1686433157069864960 | medium | confirmed |
| C36 | [UNVERIFIED] zod 4.5.4 on a physical Hermes device (Expo SDK 54/55) works without extra config | UNVERIFIED (not run; no primary source found either way for 4.5.x on Hermes) | low | unverifiable |
| C37 | Zod's headline sizes: classic core 5.36 KB gz, Mini 1.88 KB gz; string parsing 14.7x, object parsing 6.5x faster than v3; 100x fewer tsc instantiations | https://zod.dev/v4 | medium | confirmed |

## Open questions

1. Better Auth user id format: if it is not a UUIDv7 (Better Auth defaults vary by adapter), `UserId` must be `z.string().min(1).brand<"UserId">()` instead of `z.uuidv7()`. Verify against the Better Auth/Drizzle schema chosen for D1.
2. Hermes runtime check: run the shared package inside an Expo development build on a device (and Expo Go) with zod 4.5.4 to confirm no regression of the 4.0.17 `instanceof` fix and no Babel error on `export * as core` (C36, [UNVERIFIED]).
3. `z.toJSONSchema({ target: "openapi-3.0" })` emits `#/definitions/...` for `.meta({ id })` schemas; **Answered by the fact-check (measured):** hono-openapi 1.3.1 rewrites the `$ref` target to `#/components/schemas/<id>` for nested `id`-only schemas but leaves the definition in an inline `$defs` and adds nothing to `components.schemas` (dangling ref); only top-level `resolver()` schemas or `.meta({ ref })` schemas land in components. Remaining decision: add `ref` in the shared package or post-process the document (Recommendation 3).
4. Whether to expose OpenAPI at all in v1: hono-openapi adds five peer packages to the Worker; if the only consumer is the Expo app, Hono RPC types via `hc` may be sufficient and the OpenAPI layer can wait.
5. Locale strategy: the app is EN/UK/RU. Decide whether validation messages are ever user-facing (then `z.config(z.locales.uk())` per request via per-parse `error` maps) or whether the app maps issue `code`/`path` to its own copy (recommended).
6. Domain events across modules are in-process calls; decide whether event payloads are validated with the shared schemas at the boundary (cheap, catches drift) or trusted (faster). `z.validate(schema, payload)` gives a boolean fast path if you want assertion-only checks in production.
7. Cloudflare's local workerd allowed `new Function`; confirm on a deployed preview that a stray `z.compile` really degrades silently (Zod says it does) rather than throwing, before relying on "fallback" anywhere. **Largely answered by the fact-check:** on 4.5.4 a direct `z.compile(schema)` wraps codegen in try/catch and returns the original schema (`compile.js`: `return schema`) unless `{ strict: true }` is passed (measured with `node --disallow-code-generation-from-strings`); a deployed-preview run would only confirm that Workers raise the same kind of error. Also note `util.allowsEval` is `false` when `navigator.userAgent` contains "Cloudflare", so Zod's object JIT fast path is off in Workers (F4).

## Fact-check log

Fact-check run 2026-09-02 against the lab in `scratchpad/zodlab` and npm/official sources. Verdicts: 34 confirmed, 2 refuted (corrected in place above), 1 unverifiable.

| id | verdict | source |
|---|---|---|
| C1 | refuted (corrected) | `npm view zod@4.5.4 exports` (run 2026-09-02): subpath list, `sideEffects` and absence of `engines` correct, but every subpath carries four conditions (`types`, `import`, `require`, `@zod/source`); `./v4/locales/*` and `./package.json` also present |
| C2 | confirmed | https://zod.dev/v4/versioning |
| C3 | confirmed | https://zod.dev/ |
| C4 | confirmed | measured, `tsc -p` in scratch lab |
| C5 | confirmed | https://zod.dev/error-customization, https://zod.dev/v4/changelog |
| C6 | confirmed | https://zod.dev/v4/changelog; measured |
| C7 | confirmed | https://zod.dev/v4/changelog; measured |
| C8 | confirmed | https://zod.dev/v4/changelog, https://zod.dev/api |
| C9 | confirmed | https://zod.dev/v4/changelog; measured |
| C10 | confirmed | https://zod.dev/v4/changelog, https://zod.dev/error-customization; measured |
| C11 | confirmed (nuance: `z.record` two-arg rule is type-level only; runtime does not throw) | https://zod.dev/v4/changelog, https://zod.dev/api; measured |
| C12 | confirmed | https://zod.dev/json-schema |
| C13 | confirmed | https://zod.dev/metadata |
| C14 | confirmed | `npm view zod time`, https://zod.dev/blog/zod-4-5, https://github.com/colinhacks/zod/releases |
| C15 | confirmed | https://zod.dev/compile, https://zod.dev/blog/introducing-z-compile; measured |
| C16 | confirmed (nuance: only `new Function` is allowed locally via the test pool's unsafe-eval shim; `eval` is blocked) | https://developers.cloudflare.com/workers/runtime-apis/web-standards/; measured in vitest-pool-workers 0.22.0 |
| C17 | confirmed (nuance: the blog/release notes already describe `z.validate` as standalone) | measured; https://zod.dev/blog/zod-4-5, v4.5.0 release notes |
| C18 | confirmed | https://zod.dev/blog/zod-4-5; measured |
| C19 | confirmed | measured (esbuild 0.28.2) |
| C20 | confirmed | https://developers.cloudflare.com/workers/platform/limits/ |
| C21 | confirmed | `npm view @hono/zod-validator@0.9.1`, README/source |
| C22 | confirmed | measured inside workerd |
| C23 | confirmed | `npm view @hono/zod-openapi@1.6.2`, package source |
| C24 | confirmed | measured; https://github.com/asteasolutions/zod-to-openapi |
| C25 | confirmed | `npm view hono-openapi@1.3.1`, https://honohub.dev/docs/openapi/zod |
| C26 | confirmed | `zod/v4/core/schemas.js`; https://standardschema.dev/ |
| C27 | confirmed | https://hono.dev/docs/guides/rpc |
| C28 | confirmed | measured with TS 7.0.2 |
| C29 | confirmed | measured |
| C30 | confirmed | https://pnpm.io/settings/peer-dependencies, https://pnpm.io/settings/node-modules, https://pnpm.io/settings/dependency-resolution |
| C31 | refuted (corrected) | `pnpm why zod` in `scratchpad/zodlab`; `npm view @cloudflare/vitest-pool-workers@0.22.0 dependencies` (`{"zod":"4.4.3", ...}`); `ls node_modules/.pnpm` shows both `zod@4.4.3` and `zod@4.5.4` |
| C32 | confirmed | https://metrobundler.dev/docs/package-exports/ |
| C33 | confirmed (update: SDK 54+ supports pnpm isolated deps natively; SDK 55 auto-configures monorepo autolinking) | https://docs.expo.dev/guides/monorepos/ |
| C34 | confirmed | https://github.com/colinhacks/zod/issues/5070 |
| C35 | confirmed | https://github.com/colinhacks/zod/issues/4741, https://twitter.com/Baconbrix/status/1686433157069864960 |
| C36 | unverifiable [UNVERIFIED] | none — not run; no primary source found either way for 4.5.x on Hermes |
| C37 | confirmed | https://zod.dev/v4 |
