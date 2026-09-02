# Wrangler 4.128 configuration and CLI reference for Crosscut

Research date: 2026-09-02. Target toolchain: wrangler 4.128.0 (bundles workerd 1.20260831.1 and
miniflare 5.20260831.0-alpha, requires Node >= 22), @cloudflare/workers-types 5.20260902.1,
pnpm 11.24.0, Node 26.8.1. (Fact-check note: npm latest pnpm is 11.25.0 and npm latest workerd is
1.20260902.1, newer than the 1.20260831.1 that wrangler 4.128 bundles; neither affects the
recommendations below.)

Verification method: every config key and CLI flag below was checked against (a) the official
docs at developers.cloudflare.com, (b) the `config-schema.json` and `--help` output shipped inside
the wrangler@4.128.0 npm package, (c) the wrangler CHANGELOG on GitHub, and (d) a throwaway Worker
run under `wrangler dev` in workerd (the "smoke test", see Findings 14). Anything not verified is
marked UNVERIFIED and gets confidence "low" in the Claims table.

## Summary

- Use `wrangler.jsonc` (with `"$schema": "node_modules/wrangler/config-schema.json"`). TOML is still
  accepted but Cloudflare recommends JSONC and "some newer Wrangler features will only be available
  to projects using a JSON config file".
- `compatibility_date`: use **`"2026-09-02"`** (today). It ran locally under wrangler 4.128's bundled
  workerd 1.20260831.1 (workerd accepts dates up to 7 days past its release). Wrangler's own
  fallback default is `2026-08-31`.
- `compatibility_flags`: **omit both `nodejs_compat` and `enable_ctx_exports`**. `nodejs_compat`
  (and `nodejs_compat_v2`) are enabled by default for dates >= 2026-08-04; `enable_ctx_exports` is
  default as of 2025-11-17 and wrangler prints a warning when you still list it. The core-package
  README's `["nodejs_compat", "enable_ctx_exports"]` is now redundant.
- Durable Objects: declare classes with the new **declarative `exports` map**
  (`{"Player": {"type": "durable-object", "storage": "sqlite"}}`) instead of the legacy `migrations`
  array. The two are mutually exclusive, exports is what the DO Getting Started guide now uses, and
  it is supported by `wrangler dev`, `wrangler types` and the Vitest pool (since wrangler 4.107).
  Caveat: once deployed with `exports` you cannot go back to `migrations`. The legacy array still
  works if you prefer it (the core-package tests use it; C3 2.72 templates still emit it).
- SQLite-backed Durable Objects **are available on the Workers Free plan** ("Workers Free plan can
  only create and access SQLite-backed Durable Objects"). No paid plan is needed for a first deploy.
  Free limits that matter: 100k Worker requests/day, 100k DO requests/day, D1 5M rows read /
  100k rows written per day, 5 cron triggers per account, Workers Logs 200k events/day (3-day
  retention). Paid plan is $5/month minimum.
- Rate limiting: top-level **`ratelimits`** array (`name`, `namespace_id`, `simple.{limit, period}`,
  period must be 10 or 60), needs wrangler >= 4.36.0, is non-inheritable per environment, and is
  simulated locally by `wrangler dev` (verified: third request in 10 s returned `success:false`).
  `unsafe.bindings` with `type: "ratelimit"` is the old form; do not use it.
- Cron: `"triggers": {"crons": ["0 0 * * *"]}` plus a `scheduled()` handler. Crons run in UTC and
  deploy with `wrangler deploy`. Test locally with `wrangler dev --test-scheduled` then
  `GET /__scheduled?cron=0+0+*+*+*`, or `GET /cdn-cgi/handler/scheduled?cron=...` (both verified).
- Local dev: `wrangler dev --ip 0.0.0.0 --port 8787` for a phone on the LAN; state persists under
  `.wrangler/state/v3/{d1,do,kv,ratelimit,...}`; `--persist-to <dir>` overrides it and must then be
  repeated on every command. `wrangler dev --remote` does NOT support Durable Objects, rate limiting
  or secrets, so it is useless for this project; per-binding `"remote": true` exists for D1/KV only.
  The Local Explorer (`e` in the terminal, or `/cdn-cgi/explorer` -- both served by `wrangler dev`
  4.128.0, verified; the docs attribute the URL to the Vite plugin and the keypress to Wrangler)
  inspects D1/KV/DO data.
- D1 CLI defaults to **local** (`d1 execute`, `d1 migrations apply/list`, `kv key put/get`); pass
  `--remote` for production. `d1 create` is always remote and needs a login.
- Types: `wrangler types` writes `worker-configuration.d.ts` with `Env`, `Cloudflare.Env`, per-env
  interfaces (`Cloudflare.ProductionEnv`), `Cloudflare.GlobalProps.durableNamespaces` (types
  `ctx.exports.X`) and the full runtime types for your date/flags. Put it in tsconfig `types`
  instead of `@cloudflare/workers-types` for the app Worker; keep `@cloudflare/workers-types` for
  shared library packages (Cloudflare says it stays published for that purpose).
- Secrets: `.dev.vars` (or `.env`, not both) locally; `wrangler secret put KEY` (reads stdin) or
  `wrangler deploy --secrets-file .env.production` (additive) in production; `.dev.vars.<env>` per
  environment.
- Environments: `env.production` inherits `name`, `main`, `compatibility_*`, `triggers`,
  `observability`, `assets`, `migrations`/`exports`, but NOT `vars`, `durable_objects`,
  `d1_databases`, `kv_namespaces`, `services`, `ratelimits` -- those must be repeated. Deploying with
  environments defined but no `--env` prints a warning; use `--env production` (Worker name becomes
  `crosscut-production`) or `--env=""` for the top level.
- Removed/deprecated: `wrangler publish` (removed, verified "Unknown argument"), `kv:namespace`
  colon syntax (removed), `node_compat` key and `--node-compat` flag (removed, "no longer supported
  as of Wrangler v4"), `usage_model` (no effect), `legacy_env` service environments (deprecated),
  Workers Sites (`site`, deprecated in favour of `assets`), `experimental_remote` -> `remote`,
  `@cloudflare/vitest-pool-workers` -> renamed to `@cloudflare/vitest-plugin` (same API).

## Findings

### 1. Config file format and schema

- "Wrangler supports both JSON (`wrangler.json` or `wrangler.jsonc`) and TOML (`wrangler.toml`)"
  and "Cloudflare recommends using `wrangler.jsonc` for new projects, and some newer Wrangler
  features will only be available to projects using a JSON config file."
  Source: https://developers.cloudflare.com/workers/wrangler/configuration/
- The shipped schema is `node_modules/wrangler/config-schema.json` (draft-07, `allowTrailingCommas:
  true`, root `allOf: [{$ref: RawConfig}]`). Reference it as
  `"$schema": "node_modules/wrangler/config-schema.json"` (path relative to the config file). Since
  wrangler 4.124 VS Code no longer flags trailing commas in files that reference this schema.
  Source: local inspection of wrangler@4.128.0; CHANGELOG 4.124.0.
- Top-level keys present in the 4.128 schema that this project cares about: `name`, `main`,
  `compatibility_date`, `compatibility_flags`, `workers_dev` (default true), `preview_urls`
  (default false), `routes`/`route`, `migrations`, `exports`, `triggers`, `limits`, `minify`,
  `keep_vars`, `upload_source_maps`, `placement`, `assets`, `observability`, `vars`,
  `durable_objects`, `kv_namespaces`, `d1_databases`, `services`, `ratelimits`, `dev`, `env`.
  `node_compat` and `usage_model` are ABSENT from the schema (removed). Source: local schema.

### 2. Required keys

- `name` (alphanumeric + dashes, max 63 chars when using workers.dev), `main` (entry file),
  `compatibility_date` (`yyyy-mm-dd`). Source:
  https://developers.cloudflare.com/workers/wrangler/configuration/

### 3. compatibility_date -- what to use in September 2026

- Docs: "When you start your project, you should always set `compatibility_date` to the current
  date." Source: https://developers.cloudflare.com/workers/configuration/compatibility-dates/
- Wrangler 4.128 hard-codes `DEFAULT_COMPAT_DATE = "2026-08-31"` (the release date of its bundled
  workerd 1.20260831.1); `wrangler deploy --latest` resolves to that. CHANGELOG 4.124.0: "`workerd`
  only accepts a compatibility date up to 7 days beyond its own release". Source: local bundle
  grep; https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md
- Verified: `"compatibility_date": "2026-09-02"` starts and serves requests under `wrangler dev`
  4.128.0 (smoke test). The production runtime accepts any date <= today.
- Recommendation: `"2026-09-02"`. If a teammate's wrangler is older than 4.128 and its workerd is
  more than 7 days older than the date, local dev fails to start -- pin wrangler in package.json.

### 4. compatibility_flags -- nodejs_compat and enable_ctx_exports are no longer needed

- Node.js compatibility: "Default as of 2026-08-04", flag `nodejs_compat`, disable
  `no_nodejs_compat`. "For compatibility dates of `2026-08-04` or later, Workers enables both
  `nodejs_compat` and `nodejs_compat_v2` by default." "Existing projects do not need to remove
  these flags when updating their compatibility date. Omit them from new configurations." To opt
  out you must add both `no_nodejs_compat` and `no_nodejs_compat_v2`.
  Sources: https://developers.cloudflare.com/workers/configuration/compatibility-flags/ ,
  https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- `enable_ctx_exports`: "Default as of 2025-11-17", disable flag `disable_ctx_exports`. Verified in
  the smoke test: with the flag still listed wrangler prints
  `[WARNING] ... The compatibility flag enable_ctx_exports became the default as of 2025-11-17 so
  does not need to be specified anymore.` Source: compatibility-flags page + smoke test.
- With `nodejs_compat` still listed and date 2026-09-02 the Worker started without any warning.
  The precise reason (fact-check correction): wrangler >= 4.122.0 explicitly strips a redundant
  `nodejs_compat` / `nodejs_compat_v2` before starting workerd, because workerd "rejects a
  compatibility flag that its compatibility date enables by default" (workers-sdk PR #15148,
  CHANGELOG 4.122.0). `enable_ctx_exports` is NOT stripped, which is why that one still produces
  the warning above. Whether the production upload also tolerates the redundant `nodejs_compat`
  flag is UNVERIFIED locally; it rests on the docs' statement "Existing projects do not need to
  remove these flags". Simply omit it.
- Other flags worth knowing (all opt-in, no default date): `enable_request_signal` (Request.signal
  on incoming requests), `global_fetch_strictly_public`. Source: compatibility-flags page.
- Note from the runtime `context` docs: `ctx.exports` "contains a Service Binding for each
  top-level export extending `WorkerEntrypoint`" and "for each top-level export extending
  `DurableObject` and configured with storage via migration, `ctx.exports` contains a Durable Object
  namespace binding". Verified in the smoke test: `ctx.exports.Projections.hello()` and
  `ctx.exports.Player.get(...)` both worked with no `services` binding and no flag.
  Source: https://developers.cloudflare.com/workers/runtime-apis/context/

### 5. Durable Objects: `durable_objects.bindings`, `exports` (new) vs `migrations` (legacy)

- Binding shape (schema `DurableObjectBindings`): `{ name, class_name, script_name?, environment? }`;
  `name` and `class_name` required. `durable_objects` is non-inheritable ("must be specified in
  every named environment"). Source: local schema; configuration page.
- Declarative `exports` (schema `Exports` -> `DurableObjectExport`): a map keyed by class name;
  `{"type": "durable-object", "storage": "sqlite" | "legacy-kv", "state"?: "created"}` for live
  classes, plus states `deleted`, `renamed` (+`renamed_to`), `transferred` (+`transferred_to`),
  `expecting-transfer` (+`storage`, `transfer_from`). `container` may reference a `containers[]`
  entry (requires sqlite). Schema text: "Durable Object exports are mutually exclusive with
  `migrations` at the wrangler config layer." Docs: "`migrations` is the legacy imperative
  configuration for managing Durable Object class lifecycle. For new Workers, prefer the
  declarative exports field. `migrations` and `exports` are mutually exclusive." and "Once a Worker
  has been deployed with `exports`, subsequent deploys cannot return to the legacy `migrations`
  array." "A class that appears only in your code is ignored until you declare it in `exports`;
  Cloudflare does not provision a namespace implicitly."
  Sources: https://developers.cloudflare.com/workers/wrangler/configuration/ ,
  https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ ,
  changelog post https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/
  ("Existing Workers using the legacy migrations array continue to work unchanged."),
  wrangler CHANGELOG 4.107.0 (introduced `exports`; "Local development (`wrangler dev`, `vite dev`
  ...) reads Durable Object SQLite storage settings from the new `exports` field";
  "`@cloudflare/vitest-pool-workers` also picks up Durable Object configuration from `exports`";
  "`wrangler types` is also aware of `exports`").
- Verified: the smoke Worker used `exports` and `wrangler dev` created
  `.wrangler/state/v3/do/crosscut-smoke-Player` and `ctx.storage.sql` worked; `wrangler types`
  emitted `Cloudflare.GlobalProps.durableNamespaces: "Player"`. The installed
  @cloudflare/vitest-pool-workers 0.22.0 contains `validateDurableObjectExport` / `"durable-object"`
  handling, so the core-package test harness accepts `exports` too (not executed here: UNVERIFIED
  end-to-end in the pool, but supported per CHANGELOG 4.107).
- Legacy `migrations` (schema `DurableObjectMigration`): `{ tag, new_classes?, new_sqlite_classes?,
  renamed_classes?: [{from,to}], deleted_classes? }`. "Migration tags are treated like unique
  names"; "Each migration can only be applied once per environment"; `new_classes` (KV backend) is
  unavailable on the Free plan. The DO Getting Started guide now shows `exports`; the
  create-cloudflare 2.72.4 `hello-world-durable-object` templates still emit
  `migrations: [{ tag: "v1", new_sqlite_classes: [...] }]` (inspected from the npm tarball).
  Sources: https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/ ,
  https://developers.cloudflare.com/durable-objects/get-started/ , local C3 tarball.
- Wrangler validation message (bundle): "`migrations` and `exports` are mutually exclusive. Choose
  one or the other to declare your Durable Object lifecycle, but not both."

### 6. Durable Objects on the Free plan; limits

- Pricing page: "Workers Free plan can only create and access SQLite-backed Durable Objects" and
  "SQLite storage backend is recommended for all new Durable Object classes." Free plan daily
  limits: 100,000 requests/day, 13,000 GB-s/day, 5 GB total SQLite storage, 5 million rows
  read/day, 100,000 rows written/day. Paid: 1M requests included then $0.15/M; 400,000 GB-s
  included; 25B rows read, 50M rows written, 5 GB-month included.
  Source: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Limits page: SQLite storage per object 1 GB on Free (10 GB Paid), 100 classes per account on
  Free (500 Paid), key+value 2 MB, 30 s CPU per request, alarm handler wall-time 15 minutes.
  Source: https://developers.cloudflare.com/durable-objects/platform/limits/
- The Workers plan page adds: Free = 100,000 requests/day, 10 ms CPU per invocation; Paid =
  "minimum charge of $5 USD per month"; D1 Free = 5M rows read/day, 100k rows written/day, 5 GB;
  KV Free = 100k reads/day, 1k writes/day, 1 GB; Workers Logs Free = 200k events/day, 3 days.
  Source: https://developers.cloudflare.com/workers/platform/pricing/
- Limits page: cron triggers per account: 5 (Free) / 250 (Paid); Workers per account 100 / 500;
  compressed script size 3 MB / 10 MB. Source: https://developers.cloudflare.com/workers/platform/limits/

### 7. D1: `d1_databases` and CLI

- Schema: `{ binding, database_name, database_id ("not required"), preview_database_id?,
  migrations_table? (default 'd1_migrations'), migrations_dir? (default './migrations'),
  migrations_pattern? (default `${migrations_dir}/*.sql`), remote? }`. Non-inheritable.
  Source: local schema; https://developers.cloudflare.com/d1/reference/migrations/
- Local dev accepts any placeholder id (verified with `"database_id": "local-crosscut"`); the real
  UUID comes from `wrangler d1 create crosscut` ("This command acts on remote D1 Databases";
  flags `--location weur|eeur|apac|oc|wnam|enam`, `--jurisdiction eu|fedramp|us`, `--binding`,
  `--update-config`, `--use-remote`). Source: `wrangler d1 create --help` 4.128.0.
- `wrangler d1 migrations create <database> <message>` -> `migrations/0001_<message>.sql`
  (verified: `0001_create_players.sql`).
- `wrangler d1 migrations apply <database> [--local|--remote|--preview] [--persist-to]` (help text:
  `--persist-to` requires `--local`); without a flag it executed "on local database crosscut
  (local-crosscut) from .wrangler/state/v3/d1" and printed "Resource location: local / Use --remote
  if you want to access the remote instance". (The line "To execute on your remote database, add a
  --remote flag" is printed by `d1 execute`, not by `migrations apply` -- fact-check attribution
  fix.) Help text: in CI the
  confirmation is skipped; "If applying a migration results in an error, this migration will be
  rolled back". `wrangler d1 migrations list` shows unapplied files. Local default since 3.33.0
  (CHANGELOG: "commands now default `--local` to `true`"). Source: `--help` + smoke run.
- `wrangler d1 execute <database> (--command "..." | --file x.sql) [--local|--remote|--preview]
  [--json] [-y] [--persist-to]`; "You must provide either --command or --file". Verified `--local
  --file seed.sql` and `--local --command`. Source: `--help` + smoke run;
  https://developers.cloudflare.com/workers/wrangler/commands/d1/
- Migrations doc: "call `PRAGMA defer_foreign_keys = true` before making changes that would
  violate foreign keys". Source: https://developers.cloudflare.com/d1/reference/migrations/

### 8. KV: `kv_namespaces` and CLI

- Schema: `{ binding (required), id, preview_id ("used during wrangler dev"), remote? }`. Local dev
  ignores `id` content (verified with `"id": "local-cache"`). Docs: `preview_id` is "required for
  `wrangler dev --remote`" only. Non-inheritable.
  Sources: local schema; https://developers.cloudflare.com/workers/wrangler/configuration/ ;
  https://developers.cloudflare.com/kv/concepts/kv-bindings/
- `wrangler kv namespace create <namespace> [--preview] [--update-config] [--binding] [--use-remote]`;
  `wrangler kv key put|get --binding CACHE key [value] [--local|--remote]` -- default is local
  (verified: "Resource location: local. Use --remote if you want to access the remote instance").
  The `kv:namespace` colon syntax is gone (`wrangler kv:namespace list` -> "Unknown argument").
  Sources: `--help`; https://developers.cloudflare.com/workers/wrangler/commands/kv/

### 9. Cron triggers

- Config: `"triggers": { "crons": ["0 0 * * *"] }`; set `"crons": []` to remove all; leave the key
  out to preserve existing ones. Five-field syntax with `L`, `W`, `#` extensions; "Cron Triggers
  execute on UTC time." Deploys with `wrangler deploy`; propagation "up to 15 minutes".
  Handler: `scheduled(controller, env, ctx)` with `controller.cron`, `controller.scheduledTime`,
  `controller.noRetry()`. Local test: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`
  (append `&time=<ms>` to override). Source: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Verified: with `wrangler dev --test-scheduled`, both `GET /__scheduled?cron=0+0+*+*+*` ("Ran
  scheduled event") and `GET /cdn-cgi/handler/scheduled?cron=0+0+*+*+*` ("ok") invoked the handler
  and logged `controller.cron`. `triggers` is inheritable by environments.
- `wrangler deploy --triggers/--schedule "<cron>"` can override from the CLI; `wrangler triggers
  deploy` is experimental and only needed after `wrangler versions upload`. Source: `--help`.

### 10. vars, secrets, .dev.vars

- `vars` is a map of string or JSON values, non-inheritable. Verified: `wrangler types` turns them
  into literal unions (`APP_ENV: "production" | "dev"`) unless `--strict-vars=false`.
- Secrets docs: "Put secrets for use in local development in either a `.dev.vars` file or a `.env`
  file, in the same directory as the Wrangler configuration file." "Choose to use either `.dev.vars`
  or `.env` but not both." Per-environment: `.dev.vars.<environment-name>` / `.env.<environment-name>`;
  `.env` precedence `.env.<env>.local` > `.env.local` > `.env.<env>` > `.env`. Add `.dev.vars*` and
  `.env*` to `.gitignore` (wrangler itself adds `.dev.vars*` and `!.dev.vars.example`).
  Source: https://developers.cloudflare.com/workers/configuration/secrets/
- Verified: `.dev.vars` containing `SECRET=...` appeared as `env.SECRET` ("Using secrets defined in
  .dev.vars"). Global flag `--env-file <path>` (repeatable) is available on every command.
- Production: `wrangler secret put <KEY> [--name] [--env]` (value from prompt/stdin),
  `wrangler secret bulk [file]` (JSON `{"k":"v"}` or .env format, up to 100, `null` deletes),
  `wrangler secret list|delete`, or `wrangler deploy --secrets-file .env.production` ("Applies
  additively with secrets from previous deployments - omitted secrets will not be deleted",
  since 4.74.0). "Note that secrets are never deleted by deployments." Source: `--help`; CHANGELOG.
- `wrangler dev --remote` does not support secrets or environment variables from the remote side
  (development-testing page lists them as unsupported for remote bindings).

### 11. observability

- Schema `Observability`: `enabled`, `head_sampling_rate` (0-1, default 1), `redact_query_string`
  (new in 4.128.0), `logs: { enabled, head_sampling_rate, invocation_logs, persist (default true),
  destinations }`, `traces` (added 4.35.0). Docs: "All newly created Workers will come with the
  observability setting enabled by default"; disable invocation logs with
  `"observability": {"logs": {"invocation_logs": false}}`. Workers Logs "is included in both the
  Free and Paid Workers plans" (200k events/day, 3-day retention on Free; 7 days Paid; 256 KB max
  log). `observability` is inheritable. Sources: local schema; CHANGELOG 4.128.0;
  https://developers.cloudflare.com/workers/observability/logs/workers-logs/

### 12. Environments (`env.production`)

- Docs: Worker name becomes `<top-level-name>-<environment-name>`; commands take `-e/--env` or
  `CLOUDFLARE_ENV`. Inheritable keys: `name`, `main`, `compatibility_date`, `compatibility_flags`,
  `workers_dev`, `preview_urls`, `route(s)`, `tsconfig`, `triggers`, `rules`, `build`, `minify`,
  `keep_names`, `logpush`, `limits`, `observability`, `assets`, `exports`, `migrations`,
  `placement`. Non-inheritable (repeat per env): `define`, `vars`, `durable_objects`,
  `kv_namespaces`, `r2_buckets`, `services`, `queues`, `workflows`, `tail_consumers`, secrets, and
  (per the bundle: `ratelimits: notInheritable(...)`) `ratelimits`. Top-level only: `keep_vars`,
  `send_metrics`, `dependencies_instrumentation`, `site`.
  Sources: https://developers.cloudflare.com/workers/wrangler/environments/ ,
  https://developers.cloudflare.com/workers/wrangler/configuration/#environments , local bundle.
- Verified warning on `wrangler deploy` without `--env` when `env.production` exists: "Multiple
  environments are defined in the Wrangler configuration file, but no target environment was
  specified ... pass an empty string to the flag to target such environment. For example
  `--env=""`."
- `wrangler types --env production` generates `Env` for that environment only; without `--env`
  it emits a union `Env` plus `Cloudflare.ProductionEnv` (verified).

### 13. Rate limiting binding

- Docs: "You must use version 4.36.0 or later of the Wrangler CLI." Config:
  `"ratelimits": [{ "name": "MY_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 100,
  "period": 60 } }]`; `period` must be 10 or 60 (schema enum); `namespace_id` is a string
  containing a positive integer unique in the account; runtime
  `const { success } = await env.MY_RATE_LIMITER.limit({ key })`; limits are "local to the
  Cloudflare location that your Worker runs in". Source:
  https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ ; local schema.
- The schema keeps `unsafe.bindings[]` generic (name/type/dev.plugin); the bundle converts
  `ratelimits` entries to `type: "ratelimit"` internally -- treat `unsafe.bindings` as legacy.
- Local support: bindings-per-env page lists Rate Limiting with a check for "Local simulations"
  and as unsupported for remote bindings. Verified in the smoke test (limit 2 / 10 s: two
  `success:true`, third `success:false`; state under `.wrangler/state/v3/ratelimit`).
  Source: https://developers.cloudflare.com/workers/local-development/bindings-per-env/
- Free-plan availability of the binding is not stated anywhere I could find: UNVERIFIED
  [UNVERIFIED]. Fact-check re-checked the rate-limit API page, the Workers pricing page and the
  GA changelog (https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/);
  all three are silent on plan availability.
  `wrangler types` types it as `RateLimit` with `limit(options: RateLimitOptions):
  Promise<RateLimitOutcome>`.

### 14. Smoke test (what was actually executed)

Config: `compatibility_date` 2026-09-02, flags `["nodejs_compat","enable_ctx_exports"]`, `exports`
Player (sqlite), D1 + KV with placeholder ids, `ratelimits`, `triggers.crons`, `vars`, `env.production`,
`.dev.vars`. Command: `wrangler dev --port 8799 --ip 127.0.0.1 --test-scheduled`. Results: DO SQL
storage, `ctx.exports` loopback to a `WorkerEntrypoint` and to the DO namespace, D1 query, KV
put/get, `node:buffer`, `vars`, `.dev.vars` secret, rate limiter, both scheduled URLs -- all OK;
one warning about `enable_ctx_exports` being default. `wrangler types` and `wrangler types
--check`, `wrangler deploy --dry-run [--env production]`, `d1 migrations create/list/apply`,
`d1 execute --local --command/--file`, `kv key put/get` all ran offline without a login.

### 15. `wrangler dev` flags (4.128.0 `--help`)

`--ip` (no default shown in `--help`; the "localhost" default comes from the `dev.ip` schema
default), `--port`, `--inspector-port`, `--inspector-ip`, `--local-protocol
http|https`, `--https-key-path`, `--https-cert-path`, `--upstream-protocol`, `--host`,
`--local-upstream`, `--var k:v`, `--define`, `--alias`, `--tsconfig`, `-r/--remote` ("Run on the
global Cloudflare network with access to production resources", default false), `-l/--local`
("Run locally with remote bindings disabled"), `--minify`, `--persist-to` ("defaults to
.wrangler/state"), `--live-reload`, `--test-scheduled`, `--log-level debug|info|log|warn|error|none`,
`--show-interactive-dev-session`, `--types` (regenerate types on start), `--tunnel` /
`--tunnel-name` (expose via Cloudflare Tunnel), `--compatibility-date`, `--compatibility-flags`,
`--latest`, `--assets`, `--no-bundle`, `--name`, `--routes`. Global flags on every command:
`-c/--config`, `--cwd`, `-e/--env`, `--env-file`, `--profile`, `--install-skills`.
The `dev` config block mirrors these: `dev.ip` (default "localhost"), `dev.port` (8787),
`dev.inspector_port` (9229), `dev.local_protocol`, `dev.upstream_protocol`, `dev.host`.
Source: `wrangler dev --help`; local schema `RawDevConfig`.
Local state: "By default, both Wrangler and the Vite plugin store local binding data in the same
location: the `.wrangler/state` folder"; "You need to specify [`--persist-to`] every time you run
the `dev` command" and on other commands that touch local data.
Source: https://developers.cloudflare.com/workers/local-development/local-data/
Remote bindings: the current key is `"remote": true` on a binding (not `experimental_remote`);
"Unsupported for remote: Durable Objects, Workflows, Environment Variables, Secrets, Static Assets,
Version Metadata, Analytics Engine, Hyperdrive, Rate Limiting".
Source: https://developers.cloudflare.com/workers/development-testing/
Local Explorer: "press `e` in your terminal during `wrangler dev`" or open `/cdn-cgi/explorer`;
needs Wrangler 4.118+; browses KV, R2, D1 (SQL), SQLite DOs, Workflows. Citation note (fact-check):
the docs attribute the `/cdn-cgi/explorer` URL to the Vite plugin and the `e` keypress to Wrangler,
but `wrangler dev` 4.128.0 does serve `/cdn-cgi/explorer` (verified). Wrangler dev also prints a
Local Explorer API at `/cdn-cgi/local/explorer/api` when it detects an AI agent (verified: 4.128
printed that URL on start). Source: https://developers.cloudflare.com/workers/local-development/local-explorer/

### 16. `wrangler types`

- `wrangler types [path]` (default `worker-configuration.d.ts`), `--env-interface` (default
  "Env"), `--include-runtime` (default true), `--include-env` (default true), `--strict-vars`
  (default true), `--check`, `-e/--env`. Docs: "We recommend you use `wrangler types` to generate
  runtime types, rather than using the `@cloudflare/workers-types` package"; "There are no plans to
  stop publishing the `@cloudflare/workers-types` package, which will still be the recommended way
  to type libraries and shared packages"; tsconfig `"types": ["./worker-configuration.d.ts"]`
  (add `"node"` if you use Node APIs). Verified generated header: `// Runtime types generated with
  workerd@1.20260831.1 2026-09-02 enable_ctx_exports,nodejs_compat`, and `Cloudflare.GlobalProps
  { mainModule; durableNamespaces }`, `Cloudflare.Env`, `NodeJS.ProcessEnv` for string vars.
  Source: https://developers.cloudflare.com/workers/languages/typescript/ ; `--help`; smoke test.

### 17. `wrangler deploy`, first deploy, `wrangler tail`

- `wrangler deploy [path]` flags: `--env`, `--name`, `--dry-run` ("Compile a project and run checks
  without actually uploading"), `--outdir`, `--outfile`, `--minify`, `--upload-source-maps`,
  `--keep-vars` (default false: "Wrangler will delete all vars before setting those found in the
  Wrangler configuration"), `--var`, `--define`, `--compatibility-date`, `--compatibility-flags`,
  `--latest`, `--secrets-file`, `--strict`, `--triggers/--schedule`, `--routes`, `--domains`,
  `--tag`, `--message`, `--assets`, `--no-bundle`, `--metafile`, `--logpush`, `--autoconfig`
  (default true). Source: `--help`.
- Auth: `wrangler login` (OAuth in browser; `--browser false`, `--scopes`, `--use-keyring`,
  `--device` for headless, callback on `localhost:8976`) or env vars `CLOUDFLARE_API_TOKEN` +
  `CLOUDFLARE_ACCOUNT_ID` for CI. `CLOUDFLARE_ENV` selects the environment; `WRANGLER_SEND_METRICS`,
  `WRANGLER_LOG`, `WRANGLER_LOG_PATH`, `NODE_ENV` also honoured.
  Sources: `--help`; https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- workers.dev: "All Workers are assigned a `workers.dev` route ... `<YOUR_WORKER_NAME>.<YOUR_SUBDOMAIN>.workers.dev`";
  `workers_dev` defaults to true; wrangler prompts "Would you like to register a workers.dev
  subdomain now?" on first deploy if none exists (bundle string; Get Started guide: "Wrangler will
  prompt you during the publish process to set one up").
  Sources: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ ,
  https://developers.cloudflare.com/workers/get-started/guide/ , local bundle.
- `wrangler tail [worker] --format json|pretty --status ok|error|canceled --method --header
  --sampling-rate --search --ip [self] --version-id [--env]`; "A maximum of 10 clients can view a
  Worker's logs at one time"; high traffic enters sampling mode. Free-plan availability of `tail`
  is not stated (UNVERIFIED) [UNVERIFIED] -- neither the real-time-logs page nor the pricing page
  states plan availability for real-time logs; only persisted Workers Logs are explicitly on Free.
  Sources: `--help`; https://developers.cloudflare.com/workers/observability/logs/real-time-logs/
- `wrangler versions upload` / `versions deploy` exist for gradual rollouts; `wrangler rollback`,
  `wrangler deployments`, `wrangler delete [name] [--env] [--dry-run]`, `wrangler check startup`.
- Caveat if the team ever uses `wrangler versions upload` with `exports` (CHANGELOG 4.107.0): a
  `durable_objects.bindings` entry for a class declared only in `exports` on the same
  `versions upload` is rejected (error 100406). Either stage the class via `ctx.exports.X` first
  (no binding) or use plain `wrangler deploy`. Multi-version percentage deploys whose versions
  disagree on `exports` are also rejected server-side.

### 18. Assets binding (for a later Expo web export)

- Schema `Assets`: `directory`, `binding`, `html_handling` (`auto-trailing-slash` |
  `force-trailing-slash` | `drop-trailing-slash` | `none`), `not_found_handling`
  (`single-page-application` | `404-page` | `none`; default UNVERIFIED -- neither config-schema.json
  nor the static-assets binding page states one), `run_worker_first` (boolean or
  glob array; "Matches will be routed to the User Worker, and matches to negative rules will go to
  the Asset Worker"). With the default `run_worker_first = false`, static assets match first and
  the Worker only runs when no asset matches. `assets` is inheritable. `.assetsignore` uses
  `.gitignore` format. Sources: local schema;
  https://developers.cloudflare.com/workers/static-assets/binding/

### 19. Deprecations and removals (Wrangler v4)

- v4 migration guide: Node 16 unsupported; removed `wrangler version`, `wrangler publish`,
  `wrangler generate`, `wrangler pages publish`; removed `--legacy-assets`/`legacy_assets`,
  `--node-compat`/`node_compat`, `usage_model` ("no longer any effect"), `getBindingsProxy()`;
  "Commands now default to local mode" (KV/R2/D1 need `--remote` for production); the guide says
  "esbuild 0.24" but wrangler 4.128.0 actually ships esbuild 0.28.1 (fact-check: the guide's
  version is stale; the wildcard `import('./data/' + kind + '.json')` bundles-all-matching-files
  behaviour still applies).
  Source: https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/
- Deprecations page: `usage_model`, `build.upload`, Workers Sites ("migrating to Workers Static
  Assets"), Service Environments via `legacy_env` (use Wrangler Environments).
  Source: https://developers.cloudflare.com/workers/wrangler/deprecations/
- Verified in 4.128.0: `wrangler publish` and `wrangler kv:namespace` -> "Unknown argument";
  bundle message: "The \"node_compat\" field is no longer supported as of Wrangler v4. Instead, use
  the `nodejs_compat` compatibility flag."
- `experimental_remote` -> `remote` (4.20.x era); `--x-remote-bindings` flag no longer needed.
- Testing package rename: docs now use `@cloudflare/vitest-plugin` (1.1.3 on npm, created
  2026-08-20; peer `vitest ^4.1.0`); "The package API and Vitest configuration are unchanged";
  codemod `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`; types path
  `@cloudflare/vitest-plugin/types`. `@cloudflare/vitest-pool-workers` 0.22.0 is not marked
  deprecated on npm and still works (the core package's 8 tests pass on it).
  Source: https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/ ; `npm view`.
- Experimental `cloudflare.config.ts` (since 4.100) exists but is opt-in and experimental: ignore
  for Crosscut. Correction (fact-check, claim E1 refuted): `defineWorker` is imported from
  `wrangler/experimental-config` (`import { defineWorker, bindings } from
  "wrangler/experimental-config"`), NOT from `@cloudflare/config`. `@cloudflare/config` (0.10.0 on
  npm) is an internal package marked "not yet stable enough for external use". Source: CHANGELOG
  4.100.0; `wrangler-dist/experimental-config.mjs` in wrangler 4.128.0 exports `{ bindings,
  defineSettings, defineWorker, defineWranglerConfig, exports, triggers }`; `npm view
  @cloudflare/config`.
- Wrangler 4.94+ may prompt to install "Cloudflare skills" for AI agents; 4.126 stopped auto-prompting;
  set `WRANGLER_SEND_METRICS=false` / `--install-skills=false` in CI as needed.

## Recommendation for Crosscut

1. One Worker `workers/gateway` (name `crosscut`), `wrangler.jsonc` only, `$schema` pointed at
   `node_modules/wrangler/config-schema.json`, `compatibility_date: "2026-09-02"`, no
   `compatibility_flags` (delete `nodejs_compat` and `enable_ctx_exports` from the core-package
   snippet; keep `enable_request_signal` out unless needed).
2. Declare every aggregate with the declarative `exports` map (`storage: "sqlite"`); keep
   `durable_objects.bindings` for the `env.X` namespaces the Hono routes use, and rely on
   `ctx.exports.Projections` (loopback) for the Projections entrypoint -- no `services` binding.
   Use `exports` from day one; do not start with `migrations` and switch later (allowed, but the
   reverse is not). If the team prefers the battle-tested legacy array (as in packages/core tests),
   that is also fine -- just never mix both in one config.
3. Repeat the non-inheritable blocks (`vars`, `durable_objects`, `d1_databases`, `kv_namespaces`,
   `ratelimits`) inside `env.production`, and always deploy with `--env production`. Use the
   top-level environment for local dev only (placeholder ids are fine locally).
4. D1: one database `crosscut`; migrations in `workers/gateway/migrations/NNNN_*.sql` via
   `wrangler d1 migrations create crosscut <msg>`; `wrangler d1 migrations apply crosscut` (local)
   in the dev loop and `... --remote --env production` in the deploy script; feed the same folder to
   the Vitest pool through `readD1Migrations("./migrations")` as the core package does.
5. Daily drop: `triggers.crons: ["0 0 * * *"]` (UTC midnight) with a `scheduled()` export that
   calls the Drops module directly (in-process call, no queue). Because crons are UTC, compute
   "today" in the handler from `controller.scheduledTime`; if the product needs local-midnight
   drops per user, drive them from Durable Object alarms instead of a cron. Free plan allows 5 crons.
6. Rate limiting: `ratelimits` binding(s) `RL_HINT` / `RL_WHEEL` etc. (period 10 or 60) in front of
   token-spending routes; remember they are per-colo approximations, so the authoritative check is
   still the aggregate's own state. Verify the binding exists on the Free plan before relying on it
   at launch (open question, [UNVERIFIED]).
7. Observability: `"observability": { "enabled": true, "head_sampling_rate": 1 }`; consider
   `"logs": {"invocation_logs": false}` later to save the 200k/day Free-plan budget.
8. Dev loop: `wrangler dev --ip 0.0.0.0 --port 8787` (phone on LAN), `.dev.vars` for secrets,
   `wrangler types` after every config change (add `wrangler types --check` to CI), tsconfig `types:
   ["./worker-configuration.d.ts"]` for the gateway package (keep `@cloudflare/workers-types` only
   in `packages/core`). Skip `wrangler dev --remote` entirely (no DO/ratelimit/secret support).
9. First deploy checklist (free plan is enough): `wrangler login` -> `wrangler d1 create crosscut`
   (paste `database_id` into `env.production`) -> `wrangler kv namespace create CACHE` (paste id)
   -> `wrangler d1 migrations apply crosscut --remote --env production` -> `wrangler secret put
   <KEY> --env production` (or `--secrets-file`) -> `wrangler deploy --env production` (accept the
   workers.dev subdomain prompt) -> `wrangler tail --env production --format pretty` (Free-plan
   availability of `tail` is [UNVERIFIED]; fall back to the Workers Logs dashboard, which is on Free).
10. Pin `wrangler` to `4.128.0` in the workspace, keep `pnpm-workspace.yaml` `allowBuilds: { esbuild:
    true, workerd: true }` (pnpm 11; npm latest is 11.25.0, the doc's 11.24.0 pin is fine), and plan
    to rename `@cloudflare/vitest-pool-workers` ->
    `@cloudflare/vitest-plugin` (drop-in) when the core package is next touched.

## Code sketches

### workers/gateway/wrangler.jsonc

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "crosscut",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-02",
  // nodejs_compat (default >= 2026-08-04) and enable_ctx_exports (default >= 2025-11-17) are implied.
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "triggers": { "crons": ["0 0 * * *"] },              // daily drop, UTC midnight

  // Durable Object aggregates: declarative lifecycle (mutually exclusive with "migrations").
  "exports": {
    "Player":      { "type": "durable-object", "storage": "sqlite" },
    "PuzzleStats": { "type": "durable-object", "storage": "sqlite" },
    "Leaderboard": { "type": "durable-object", "storage": "sqlite" }
  },
  // Projections / Drops / Economy are WorkerEntrypoint exports reached via ctx.exports.<Name>.

  "durable_objects": { "bindings": [
    { "name": "PLAYER",      "class_name": "Player" },
    { "name": "PUZZLE",      "class_name": "PuzzleStats" },
    { "name": "LEADERBOARD", "class_name": "Leaderboard" }
  ]},
  "d1_databases":  [{ "binding": "DB",    "database_name": "crosscut", "database_id": "local-dev" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "local-dev" }],
  "ratelimits": [
    { "name": "RL_HINT",  "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } },
    { "name": "RL_WHEEL", "namespace_id": "1002", "simple": { "limit": 5,  "period": 60 } }
  ],
  "vars": { "APP_ENV": "dev", "DROP_TZ": "UTC" },
  "dev": { "port": 8787 },

  "env": {
    "production": {
      // inherited: name (-> "crosscut-production"), main, compatibility_date, triggers, observability, exports
      "vars": { "APP_ENV": "production", "DROP_TZ": "UTC" },
      "durable_objects": { "bindings": [
        { "name": "PLAYER",      "class_name": "Player" },
        { "name": "PUZZLE",      "class_name": "PuzzleStats" },
        { "name": "LEADERBOARD", "class_name": "Leaderboard" }
      ]},
      "d1_databases":  [{ "binding": "DB",    "database_name": "crosscut", "database_id": "<uuid from wrangler d1 create>" }],
      "kv_namespaces": [{ "binding": "CACHE", "id": "<id from wrangler kv namespace create>" }],
      "ratelimits": [
        { "name": "RL_HINT",  "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } },
        { "name": "RL_WHEEL", "namespace_id": "1002", "simple": { "limit": 5,  "period": 60 } }
      ]
    }
  }
}
```

Legacy alternative for the DO block (only if you decide against `exports`):

```jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Player", "PuzzleStats", "Leaderboard"] }]
```

### src/index.ts skeleton (fetch + scheduled + exports)

```ts
import { Hono } from "hono";
export { Player } from "./player/aggregate";
export { PuzzleStats } from "./puzzle/aggregate";
export { Leaderboard } from "./leaderboard/aggregate";
export { Projections } from "./projections";       // WorkerEntrypoint, reached via ctx.exports.Projections
export { Drops } from "./drops/entrypoint";         // WorkerEntrypoint

const app = new Hono<{ Bindings: Env }>();
app.post("/hints", async (c) => {
  const { success } = await c.env.RL_HINT.limit({ key: c.get("userId") });
  if (!success) return c.json({ error: "rate_limited" }, 429);
  // ...
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    // cron "0 0 * * *" fires in UTC; controller.scheduledTime is the scheduled epoch ms
    const day = new Date(controller.scheduledTime).toISOString().slice(0, 10);
    ctx.waitUntil(ctx.exports.Drops.publishDaily(day)); // in-process module call, no queue
  },
} satisfies ExportedHandler<Env>;
```

### tsconfig.json (gateway)

```jsonc
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler",
    "types": ["./worker-configuration.d.ts"],   // from `wrangler types`; add "node" if you import node:* APIs
    "strict": true, "noEmit": true, "skipLibCheck": true, "isolatedModules": true
  },
  "include": ["src", "test", "worker-configuration.d.ts"]
}
```

### package.json scripts

```jsonc
{
  "scripts": {
    "dev":            "wrangler dev --ip 0.0.0.0 --port 8787",
    "dev:cron":       "wrangler dev --test-scheduled",
    "types":          "wrangler types",
    "typecheck":      "wrangler types --check && tsc --noEmit",
    "db:migrate":     "wrangler d1 migrations apply crosscut",
    "db:migrate:prod":"wrangler d1 migrations apply crosscut --remote --env production",
    "db:new":         "wrangler d1 migrations create crosscut",
    "db:seed":        "wrangler d1 execute crosscut --local --file ./seed/dev.sql",
    "deploy":         "wrangler deploy --env production",
    "tail":           "wrangler tail --env production --format pretty",
    "test":           "vitest run"
  }
}
```

### Local commands used in the dev loop (all verified offline)

```sh
wrangler d1 migrations create crosscut create_player_state   # -> migrations/0001_create_player_state.sql
wrangler d1 migrations apply crosscut                         # local by default (.wrangler/state/v3/d1)
wrangler d1 execute crosscut --local --command "SELECT count(*) FROM player_state"
wrangler kv key put --binding CACHE drop:2026-09-02 '{"puzzleId":"en-mini-1"}'   # local by default
wrangler dev --test-scheduled &
curl "http://localhost:8787/__scheduled?cron=0+0+*+*+*"
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+0+*+*+*"
```

### .dev.vars / production secrets

```sh
# workers/gateway/.dev.vars   (gitignored; or .dev.vars.production for `wrangler dev --env production`)
BETTER_AUTH_SECRET=dev-only
APPLE_CLIENT_ID=...
# production
printf '%s' "$SECRET" | wrangler secret put BETTER_AUTH_SECRET --env production
wrangler deploy --env production --secrets-file .env.production   # additive, JSON or dotenv
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | wrangler.jsonc is the recommended config format; TOML still supported; JSON-only features exist | https://developers.cloudflare.com/workers/wrangler/configuration/ | high | confirmed |
| C2 | wrangler 4.128.0 is npm latest (published 2026-09-01), bundles workerd 1.20260831.1, requires Node >= 22 | `npm view wrangler@4.128.0` | high | confirmed |
| C3 | Wrangler 4.128's built-in default compatibility date is 2026-08-31; workerd accepts dates up to 7 days past its release; 2026-09-02 works locally | local bundle grep `DEFAULT_COMPAT_DATE`; CHANGELOG 4.124.0; smoke test | high | confirmed |
| C4 | nodejs_compat and nodejs_compat_v2 are enabled by default for compatibility dates >= 2026-08-04; opt out with both no_nodejs_compat and no_nodejs_compat_v2 | https://developers.cloudflare.com/workers/runtime-apis/nodejs/ ; compatibility-flags page; CHANGELOG 4.122.0 | high | confirmed |
| C5 | enable_ctx_exports is default as of 2025-11-17; wrangler 4.128 warns if it is still listed | https://developers.cloudflare.com/workers/configuration/compatibility-flags/ ; smoke test warning | high | confirmed |
| C6 | Declarative `exports` map replaces the `migrations` array; they are mutually exclusive; once deployed with exports you cannot return to migrations; docs prefer exports for new Workers | https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ ; https://developers.cloudflare.com/workers/wrangler/configuration/ ; local schema | high | confirmed |
| C7 | `exports` is honoured by wrangler dev, wrangler types and the Vitest pool (added in wrangler 4.107.0) | CHANGELOG 4.107.0; smoke test (dev + types); pool 0.22 source contains durable-object export validation | medium | confirmed |
| C8 | SQLite-backed Durable Objects are available on the Workers Free plan (only SQLite); Free limits 100k DO req/day, 5 GB storage, 5M rows read, 100k rows written | https://developers.cloudflare.com/durable-objects/platform/pricing/ ; https://developers.cloudflare.com/workers/platform/pricing/ | high | confirmed |
| C9 | Rate limiting uses top-level `ratelimits` (name, namespace_id, simple.limit, simple.period in {10,60}); needs wrangler >= 4.36.0; simulated locally in wrangler dev; non-inheritable | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ ; local schema; bindings-per-env page; smoke test | high | confirmed |
| C10 | Rate limiting binding is available on the Free plan [UNVERIFIED] | not found in docs | low | unverifiable |
| C11 | `triggers.crons` deploys with `wrangler deploy`; crons run in UTC; local test via `--test-scheduled` + `/__scheduled` or `/cdn-cgi/handler/scheduled`; Free plan allows 5 cron triggers per account | https://developers.cloudflare.com/workers/configuration/cron-triggers/ ; https://developers.cloudflare.com/workers/platform/limits/ ; smoke test | high | confirmed |
| C12 | D1 CLI (`d1 execute`, `d1 migrations apply/list`) and `kv key put/get` default to local; `--remote` targets production; `d1 create` is always remote | `wrangler --help` 4.128.0; smoke run output; CHANGELOG 3.33.0; v3->v4 migration page | high | confirmed |
| C13 | `d1 migrations create` names files `NNNN_<message>.sql` in `./migrations` (configurable via migrations_dir/migrations_pattern; table default d1_migrations) | `--help`; local schema; https://developers.cloudflare.com/d1/reference/migrations/ | high | confirmed |
| C14 | `.dev.vars` or `.env` (not both) supply local secrets; `.dev.vars.<env>` per environment; `wrangler secret put KEY`, `secret bulk`, and `deploy --secrets-file` (additive) for production | https://developers.cloudflare.com/workers/configuration/secrets/ ; `--help`; smoke test | high | confirmed |
| C15 | Non-inheritable env keys: vars, durable_objects, kv_namespaces, d1_databases, r2_buckets, services, queues, workflows, tail_consumers, secrets, ratelimits; deploying without --env when environments exist prints a warning; env Worker name is `<name>-<env>` | https://developers.cloudflare.com/workers/wrangler/environments/ ; configuration page; local bundle; smoke `deploy --dry-run` | high | confirmed |
| C16 | `wrangler types` generates worker-configuration.d.ts with Env, Cloudflare.Env, per-env interfaces, GlobalProps.durableNamespaces and runtime types; flags --env-interface, --include-runtime, --include-env, --strict-vars, --check; recommended over @cloudflare/workers-types for the app Worker | https://developers.cloudflare.com/workers/languages/typescript/ ; `--help`; smoke test | high | confirmed |
| C17 | `wrangler dev` flags: --ip, --port, --persist-to (default .wrangler/state), --remote, --local, --test-scheduled, --tunnel, --types, --live-reload, --log-level, --local-protocol; state under .wrangler/state/v3/{d1,do,kv,ratelimit,...} | `wrangler dev --help`; https://developers.cloudflare.com/workers/local-development/local-data/ ; smoke test | high | confirmed |
| C18 | `wrangler dev --remote` / per-binding `remote: true` do not support Durable Objects, rate limiting, secrets, vars or assets; the key is `remote`, not `experimental_remote` | https://developers.cloudflare.com/workers/development-testing/ ; local schema | high | confirmed |
| C19 | Observability config: enabled, head_sampling_rate, logs.{enabled, invocation_logs, head_sampling_rate, persist, destinations}, traces, redact_query_string (4.128); Workers Logs free tier 200k events/day, 3-day retention | local schema; CHANGELOG 4.128.0; https://developers.cloudflare.com/workers/observability/logs/workers-logs/ | high | confirmed |
| C20 | `wrangler publish`, `kv:namespace` colon syntax, `node_compat`/`--node-compat`, `usage_model`, `wrangler generate` are removed in v4; Workers Sites and legacy_env deprecated | https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/ ; deprecations page; verified "Unknown argument" in 4.128.0 | high | confirmed |
| C21 | First deploy needs a Cloudflare account + `wrangler login` (or CLOUDFLARE_API_TOKEN/ACCOUNT_ID); wrangler prompts to register a workers.dev subdomain; no paid plan required for this stack | get-started guide; system-environment-variables page; local bundle prompt string; DO pricing page | high | confirmed |
| C22 | `wrangler tail` flags: --format, --status, --method, --header, --sampling-rate, --search, --ip, --version-id; max 10 concurrent tail clients | `--help`; https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ | high | confirmed |
| C23 | `wrangler tail` (real-time logs) works on the Free plan [UNVERIFIED] | not stated in docs | low | unverifiable |
| C24 | Assets config keys: directory, binding, html_handling, not_found_handling (single-page-application/404-page/none), run_worker_first (bool or globs); assets are served before the Worker by default | local schema; https://developers.cloudflare.com/workers/static-assets/binding/ | high | confirmed |
| C25 | @cloudflare/vitest-pool-workers has been renamed @cloudflare/vitest-plugin (1.1.3) with an unchanged API; pool-workers 0.22.0 still works and is not marked deprecated on npm | https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/ ; `npm view` | high | confirmed |
| C26 | Production upload tolerates a redundant `nodejs_compat` flag with a date >= 2026-08-04 | inferred from local run only | low | confirmed |
| C27 | Local Explorer: press `e` in wrangler dev or open /cdn-cgi/explorer; inspects KV, R2, D1, SQLite DOs; Wrangler 4.118+ | https://developers.cloudflare.com/workers/local-development/local-explorer/ ; smoke test banner | high | confirmed |

## Open questions

1. Is the Rate Limiting binding usable on the Workers Free plan? [UNVERIFIED] Nothing in the docs
   says either way -- the GA changelog (2025-09-19), the rate-limit API page and the pricing page
   are all silent (re-confirmed by fact-check); verify on the first deploy of the Free-plan account
   (a deploy error would surface it).
2. Does the production API reject or silently accept a redundant `nodejs_compat` /
   `enable_ctx_exports` flag alongside a 2026-09-02 date? Local workerd accepted both; the safe
   move is to omit them, which the docs recommend anyway.
3. `exports` end-to-end inside `@cloudflare/vitest-pool-workers` 0.22 (or `@cloudflare/vitest-plugin`
   1.1.3) was not executed here; CHANGELOG 4.107 says it is supported and the pool source handles
   it. Confirm by switching the core-package test config to `exports` once, before the gateway
   depends on it.
4. Should Crosscut adopt `exports` (recommended for new Workers, one-way door) or keep the legacy
   `migrations` array the core package already tests? This document recommends `exports`, but the
   decision should be recorded in `docs/` because it cannot be reversed after the first deploy.
5. Daily drop timezone policy: a single UTC cron vs. per-user local-midnight drops (DO alarms).
   The product spec only says "daily drop"; this affects whether `triggers.crons` is enough.
6. Whether to move the test toolchain to `@cloudflare/vitest-plugin` now (drop-in rename) or stay
   on `vitest-pool-workers` 0.22 until it is marked deprecated on npm.
7. Free-plan headroom: 100k Worker requests/day and 100k DO requests/day shared across all users
   (each command is >= 1 Worker request + 1 DO request + a projection write). Decide the DAU at
   which the $5 Paid plan is switched on before launch.

## Fact-check log

Fact-check applied 2026-09-02 against wrangler 4.128.0 (local package: config-schema.json, `--help`,
`wrangler-dist/experimental-config.mjs`), the workers-sdk CHANGELOG, `npm view`, and the
developers.cloudflare.com pages cited per row. C-ids are the rows of the Claims table above; E-ids
are extra claims lifted from the Findings text by the fact-checker.

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://developers.cloudflare.com/workers/wrangler/configuration/ |
| C2 | confirmed | `npm view wrangler@4.128.0` |
| C3 | confirmed | local bundle `DEFAULT_COMPAT_DATE`; CHANGELOG 4.124.0; smoke test |
| C4 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/nodejs/ ; compatibility-flags page; CHANGELOG 4.122.0 |
| C5 | confirmed | https://developers.cloudflare.com/workers/configuration/compatibility-flags/ ; smoke test warning |
| C6 | confirmed | https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ ; configuration page; local schema |
| C7 | confirmed | CHANGELOG 4.107.0; smoke test; vitest-pool-workers 0.22 source |
| C8 | confirmed | https://developers.cloudflare.com/durable-objects/platform/pricing/ ; https://developers.cloudflare.com/workers/platform/pricing/ |
| C9 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ ; local schema; bindings-per-env page; smoke test |
| C10 | unverifiable | Not stated on https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ , https://developers.cloudflare.com/workers/platform/pricing/ , or https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/ |
| C11 | confirmed | https://developers.cloudflare.com/workers/configuration/cron-triggers/ ; https://developers.cloudflare.com/workers/platform/limits/ ; smoke test |
| C12 | confirmed | `wrangler --help` 4.128.0; smoke run; CHANGELOG 3.33.0; v3->v4 migration page (attribution of the "add a --remote flag" line corrected to `d1 execute`, see Finding 7) |
| C13 | confirmed | `--help`; local schema; https://developers.cloudflare.com/d1/reference/migrations/ |
| C14 | confirmed | https://developers.cloudflare.com/workers/configuration/secrets/ ; `--help`; smoke test |
| C15 | confirmed | https://developers.cloudflare.com/workers/wrangler/environments/ ; configuration page; local bundle; smoke `deploy --dry-run` |
| C16 | confirmed | https://developers.cloudflare.com/workers/languages/typescript/ ; `--help`; smoke test |
| C17 | confirmed | `wrangler dev --help`; https://developers.cloudflare.com/workers/local-development/local-data/ ; smoke test (`--ip` default comes from the `dev.ip` schema default, not `--help`) |
| C18 | confirmed | https://developers.cloudflare.com/workers/development-testing/ ; local schema |
| C19 | confirmed | local schema; CHANGELOG 4.128.0; https://developers.cloudflare.com/workers/observability/logs/workers-logs/ |
| C20 | confirmed | https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/ ; deprecations page; "Unknown argument" in 4.128.0 |
| C21 | confirmed | get-started guide; system-environment-variables page; local bundle prompt string; DO pricing page |
| C22 | confirmed | `--help`; https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ |
| C23 | unverifiable | Neither https://developers.cloudflare.com/workers/observability/logs/real-time-logs/ nor https://developers.cloudflare.com/workers/platform/pricing/ states plan availability for real-time logs (only Workers Logs is explicitly on Free) |
| C24 | confirmed | local schema; https://developers.cloudflare.com/workers/static-assets/binding/ (the `not_found_handling` default stated in Finding 18 is unverified, neither source gives one) |
| C25 | confirmed | https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/ ; `npm view` |
| C26 | confirmed | compatibility-flags docs: "Existing projects do not need to remove these flags"; wrangler >= 4.122.0 strips redundant `nodejs_compat` locally (PR #15148) |
| C27 | confirmed | https://developers.cloudflare.com/workers/local-development/local-explorer/ ; `wrangler dev` 4.128.0 serves `/cdn-cgi/explorer` (verified); citation attribution loosened, see Finding 15 |
| E1 | refuted | Claim "cloudflare.config.ts uses `defineWorker` from `@cloudflare/config`". Correction: `defineWorker` is imported from `wrangler/experimental-config`; `@cloudflare/config` 0.10.0 is internal ("not yet stable enough for external use"). Source: CHANGELOG 4.100.0; wrangler-4.128.0/wrangler-dist/experimental-config.mjs; `npm view @cloudflare/config` |
| E2 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E3 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E4 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E5 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E6 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E7 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E8 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E9 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E10 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E11 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E12 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E13 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E14 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |
| E15 | confirmed | fact-checker extra claim (Findings text); source per the cited Finding |

Additional corrections applied to the prose (no claim id): Finding 4 (why `nodejs_compat` produced
no local warning: wrangler >= 4.122.0 strips it, PR #15148), Finding 7 (`--persist-to` requires
`--local`; message attribution), Finding 15 (`--ip` default source; Local Explorer citation;
`/cdn-cgi/local/explorer/api`), Finding 17 (`versions upload` + `exports` error 100406, CHANGELOG
4.107.0), Finding 18 (`not_found_handling` default unverified), Finding 19 (esbuild 0.28.1 in
4.128.0, not 0.24; `defineWorker` import path), header toolchain note (pnpm 11.25.0, workerd
1.20260902.1 on npm).
