## 9. Local dev & deploy

### Prerequisites

- **Node 26** (pnpm 11 minimum requirement is ≥ 22; verified on 26.8.1)
- **pnpm 11.24** (`npm install -g pnpm@11.24` or `corepack enable`)
- **wrangler 4.128.0** (pinned in workspace `devDependencies`)
- **No Cloudflare login required locally** (only at first deploy). `.dev.vars` holds secrets; offline commands (type-check, test, local dev) need none.

### Configuration files

#### workers/gateway/wrangler.jsonc

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "crosscut",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-02",
  // nodejs_compat (default ≥ 2026-08-04) and enable_ctx_exports (default ≥ 2025-11-17) are implied.
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "triggers": { "crons": ["0 * * * *", "*/5 * * * *", "0 6 * * *"] },

  "exports": {
    "User":        { "type": "durable-object", "storage": "sqlite" },
    "PuzzleStats": { "type": "durable-object", "storage": "sqlite" }
  },

  "durable_objects": { "bindings": [
    { "name": "USER",        "class_name": "User" },
    { "name": "PUZZLE_STATS", "class_name": "PuzzleStats" }
  ]},
  "d1_databases":  [{ "binding": "DB", "database_name": "crosscut", "database_id": "local-dev" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "local-dev" }],
  "ratelimits": [
    { "name": "RL_BOOT",  "namespace_id": "1001", "simple": { "limit": 10,  "period": 60 } },
    { "name": "RL_USER",  "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } },
    { "name": "RL_SPEND", "namespace_id": "1003", "simple": { "limit": 20,  "period": 60 } },
    { "name": "RL_CHECK", "namespace_id": "1004", "simple": { "limit": 30,  "period": 60 } }
  ],
  "vars": { "APP_ENV": "dev" },
  "dev": { "port": 8787 },

  "env": {
    "production": {
      "vars": { "APP_ENV": "production" },
      "durable_objects": { "bindings": [
        { "name": "USER",        "class_name": "User" },
        { "name": "PUZZLE_STATS", "class_name": "PuzzleStats" }
      ]},
      "d1_databases":  [{ "binding": "DB", "database_name": "crosscut", "database_id": "<UUID from wrangler d1 create>" }],
      "kv_namespaces": [{ "binding": "CACHE", "id": "<id from wrangler kv namespace create>" }],
      "ratelimits": [
        { "name": "RL_BOOT",  "namespace_id": "1001", "simple": { "limit": 10,  "period": 60 } },
        { "name": "RL_USER",  "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } },
        { "name": "RL_SPEND", "namespace_id": "1003", "simple": { "limit": 20,  "period": 60 } },
        { "name": "RL_CHECK", "namespace_id": "1004", "simple": { "limit": 30,  "period": 60 } }
      ]
    }
  }
}
```

#### workers/gateway/package.json (scripts section)

```json
{
  "scripts": {
    "dev":            "wrangler dev --ip 0.0.0.0 --port 8787",
    "types":          "wrangler types",
    "typecheck":      "wrangler types --check && tsc --noEmit",
    "test":           "vitest run",
    "migrate:local":  "wrangler d1 migrations apply crosscut --local",
    "seed:local":     "wrangler d1 execute crosscut --local --file ./seed/0001_content.sql",
    "deploy":         "wrangler deploy --env production",
    "tail":           "wrangler tail --env production --format pretty"
  },
  "devEngines": { "packageManager": "pnpm@11.24" },
  "devDependencies": {
    "wrangler": "^4.128.0",
    "@cloudflare/vitest-plugin": "^1.1.3",
    "vitest": "4.1.11",
    "typescript": "^7.0.2"
  }
}
```

#### pnpm-workspace.yaml (root)

```yaml
packages:
  - "workers/*"
  - "packages/*"
allowBuilds:
  esbuild: true
  workerd: true
catalog:
  zod: ^4.5.4
  hono: ^4.13.5
  typescript: ^7.0.2
```

#### turbo.json (root)

```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "tasks": {
    "types":     { "inputs": ["wrangler.jsonc", "src/**/*.ts"], "outputs": ["worker-configuration.d.ts"] },
    "typecheck": { "dependsOn": ["types", "^typecheck"] },
    "test":      { "dependsOn": ["types"], "inputs": ["$TURBO_DEFAULT$"], "outputs": ["coverage/**"] },
    "dev":       { "cache": false, "persistent": true },
    "migrate:local": { "cache": false },
    "seed:local":    { "cache": false }
  }
}
```

#### .dev.vars.example

```
DEVICE_TOKEN_KEYS={"active":"2026-09","keys":{"2026-09":"<32+ random bytes, base64url>"}}
CONTENT_ADMIN_TOKEN=<bearer token for POST /admin/content/import>
```

Generate random keys locally (Node):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Local dev loop

Run these commands in order. Each step depends on the previous; `pnpm install` must run first after cloning.

```bash
# 1. Install workspace dependencies (runs once after clone; ~10 s with cache)
pnpm install

# 2. Generate worker types from wrangler.jsonc (required after any config change)
pnpm --filter gateway types

# 3. Apply D1 migrations to local database
pnpm --filter gateway migrate:local

# 4. Seed with four prototype puzzles + collections (one-time)
pnpm --filter gateway seed:local

# 5. Start development server (continues running; Ctrl+C to stop)
pnpm dev

# 6. In another terminal, run HTTP smoke test
curl http://localhost:8787/healthz
# Expected: 200 { "ok": true }

# 7. Optional: watch tests as you edit
pnpm --filter gateway vitest
```

**To expose to a phone on the LAN,** the `dev` script already binds `--ip 0.0.0.0`. From your phone:
- Find your Mac's LAN IP: `ifconfig | grep inet | grep -v 127`
- Navigate to `http://<your-ip>:8787/healthz` in the phone's browser or via curl

**To reset local state** (nuke the local D1 and Durable Objects):
```bash
rm -rf workers/gateway/.wrangler/state
pnpm --filter gateway migrate:local seed:local
```

**Expected outputs:**
- `migrate:local`: "Executing on local database crosscut (…) from .wrangler/state/v3/d1" → applied 5 migrations
- `seed:local`: one `INSERT` per puzzle; "Executed 1 statement" ×4
- `pnpm dev`: starts `wrangler dev` on port 8787; press `e` to open the Local Explorer for D1/KV inspection

### Crons and scheduled handlers

Three cron schedules defined in `wrangler.jsonc` under `triggers.crons`:

| schedule | handler | runs | functions | idempotency |
|----------|---------|------|-----------|-------------|
| `0 * * * *` | UTC hourly | Fill daily drops 3 days ahead per language; init PuzzleStats objects | `ensureDrops`, `initPuzzleStats` | Re-running fills only missing rows; safe to repeat |
| `*/5 * * * *` | Every 5 minutes UTC | Materialise weekly leaderboard from `player_solves` rows (exclude `suspicious`) | `materialiseWeek` | Re-running overwrites; rows keyed by `(week, userId)` so duplicates merge |
| `0 6 * * *` | 06:00 UTC | Alert if pool depth < 14 unpublished puzzles per language | Pool status check; logs to Workers Logs | Side-effect-free check; safe to repeat |

**Test locally** (with `wrangler dev` running):
```bash
# Test the hourly cron
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"

# Test the leaderboard cron
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"

# Test the alert cron
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+6+*+*+*"

# Expected: HTTP 200, logs printed to terminal
```

All crons must be **idempotent**: a scheduled invocation that throws or times out is silently lost until the next tick (no retry, no alert). Because `ensureDrops` is the only writer of `daily_drops` rows, if it fails for hours, users will see stale drops. [DECIDED HERE: set up monitoring (Workers Logs dashboard, or a separate alert cron) to check that `daily_drops` has rows for today + 3 days per language].

### First-deploy checklist

1. **Log in to Cloudflare**
   ```bash
   wrangler login
   # Opens OAuth flow in browser; callback to localhost:8976
   ```

2. **Create D1 database**
   ```bash
   wrangler d1 create crosscut --env production
   # Output includes database_id (a UUID)
   ```

3. **Update wrangler.jsonc `env.production.d1_databases[0].database_id`** with the UUID from step 2

4. **Create KV namespace** (if using cache binding)
   ```bash
   wrangler kv namespace create CACHE
   # Output includes the namespace id
   ```

5. **Update wrangler.jsonc `env.production.kv_namespaces[0].id`** with the id from step 4

6. **Apply migrations to production**
   ```bash
   pnpm --filter gateway run migrate:local  # First verify locally
   wrangler d1 migrations apply crosscut --remote --env production
   ```

7. **Set secrets in production** (read from `.dev.vars` and set on Cloudflare)
   ```bash
   wrangler secret put DEVICE_TOKEN_KEYS --env production
   # Paste the JSON from .dev.vars; prompted interactively
   
   wrangler secret put CONTENT_ADMIN_TOKEN --env production
   ```

8. **Deploy the Worker**
   ```bash
   wrangler deploy --env production
   # Prompted to register a workers.dev subdomain (do it; it's free)
   # Deployment URL: https://crosscut-production.<your-subdomain>.workers.dev
   ```

9. **Stream logs and verify**
   ```bash
   wrangler tail --env production --format pretty
   # In another terminal, test the production endpoint
   curl https://crosscut-production.<your-subdomain>.workers.dev/healthz
   ```

**⚠ Critical: never mix exports and migrations.** Once deployed with `exports`, subsequent deployments with `migrations` are rejected. Commit to `exports` from day one.

### DEVICE_TOKEN_KEYS rotation runbook

The `DEVICE_TOKEN_KEYS` secret holds a keyring: one active key, plus old keys for at least 30 days after rotation. Tokens expire after 365 days; the refresh endpoint accepts tokens up to 30 days past expiry. So keep a key for ≥ 60 days (refresh window + grace).

**When to rotate:** on a schedule (e.g. monthly) or after a suspected compromise.

**Rotation steps:**

1. **Generate a new key** (Node, locally)
   ```bash
   node -e "console.log(JSON.stringify({active:'2026-10',keys:{'2026-10':'<new-base64>','2026-09':'<old-base64>'}}))"
   ```

2. **Update the secret in production**
   ```bash
   wrangler secret put DEVICE_TOKEN_KEYS --env production
   # Paste the new JSON
   ```

3. **Verify** (tokens signed with the new key work; old key still verifies)
   ```bash
   # Next POST /v1/session/refresh will mint a token with the new key
   # Tokens signed before the rotation still verify via the old key for 30+ days
   ```

4. **[DECIDED HERE: after 60 days, remove the old key]** (breaking change: old tokens fail to verify → 401 → client re-bootstraps as new user)
   ```bash
   # Update the secret again, keeping only the active key
   ```

Track rotation dates in a `CHANGELOG.md` or operator runbook so no key is dropped prematurely.
