# Core package: Aggregate + Projections

How the reusable code (`packages/core` in the IOSApp repo) implements the pattern described in
`concepts.md`.

- `Aggregate<State, Env>` — a Durable Object that owns the current state of one entity, versions
  every commit, and pushes the snapshot to D1 with alarm-based retries.
- `ProjectionsBase<Env>` — a `WorkerEntrypoint` that upserts projection rows with a version guard.
- `aggregateStub(ns, kind, id)` — get an object's stub by public id.
- `DomainError` — throw from commands for business-rule violations.

Tested inside the real Workers runtime (`pnpm test`): projection on commit, idempotent `init`,
no-op commits, stale-version guard, failed flush → alarm retry, eviction recovery, forced rebuild.

## 1. Define an aggregate

```ts
// workers/gateway/src/user.ts
import { Aggregate, DomainError } from "@app/core";

export interface UserState {
  pro: boolean;
  pushTokens: string[];
}

export class User extends Aggregate<UserState, Env> {
  readonly kind = "user";

  protected initial(): UserState {
    return { pro: false, pushTokens: [] };
  }

  addPushToken(token: string) {
    // Returning an equal state is a no-op: calling this twice bumps nothing.
    return this.commit((s) =>
      s.pushTokens.includes(token) ? s : { ...s, pushTokens: [...s.pushTokens, token] },
    );
  }

  setPro(pro: boolean) {
    return this.commit((s) => ({ ...s, pro }));
  }

  spend(credits: number) {
    return this.commit((s) => {
      if (credits <= 0) throw new DomainError("credits must be positive");
      return { ...s };
    });
  }
}
```

Rules: `kind` must match a registered projection; state must be plain JSON; `commit()` receives
a clone of the current state and returns the next one; every public method is callable over RPC.

## 2. Register a projection

```ts
// workers/gateway/src/projections.ts
import { ProjectionsBase, defineProjection } from "@app/core";
import type { UserState } from "./user";

export class Projections extends ProjectionsBase<Env> {
  protected projections() {
    return [
      defineProjection<UserState>({
        kind: "user",
        table: "user_state",
        columns: (s) => ({ pro: s.pro, push_token_count: s.pushTokens.length }),
      }),
    ];
  }
}
```

The D1 table must have `id TEXT PRIMARY KEY`, `version INTEGER`, `updated_at INTEGER` plus your
columns (booleans are stored as 0/1):

```sql
-- migrations/0002_user_state.sql
CREATE TABLE user_state (
  id               TEXT PRIMARY KEY,
  version          INTEGER NOT NULL,
  pro              INTEGER NOT NULL DEFAULT 0,
  push_token_count INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX user_state_pro ON user_state (pro);
```

## 3. Wire it up

Export both classes from the Worker's main module and declare the object:

```ts
// workers/gateway/src/index.ts
export { User } from "./user";
export { Projections } from "./projections";
export default app; // Hono
```

```jsonc
// workers/gateway/wrangler.jsonc
{
  "name": "gateway",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-27",
  "compatibility_flags": ["nodejs_compat", "enable_ctx_exports"],
  "observability": { "enabled": true },
  "durable_objects": { "bindings": [{ "name": "USER", "class_name": "User" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["User"] }],
  "d1_databases": [{ "binding": "DB", "database_name": "app", "database_id": "<id>" }],
  "assets": { "directory": "../../apps/app/dist", "binding": "ASSETS" }
}
```

How an aggregate finds `Projections`:

1. `env.PROJECTIONS` if such a binding exists — use this when `Projections` lives in another
   Worker: `"services": [{ "binding": "PROJECTIONS", "service": "projections", "entrypoint": "Projections" }]`.
2. Otherwise `ctx.exports.Projections` — the loopback stub for a `Projections` class exported from
   the same Worker. Needs the `enable_ctx_exports` flag; no binding required.

Override `resolveProjections()` to change the lookup. Run `wrangler types` after editing config.

## 4. Call it from the gateway

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { aggregateStub } from "@app/core";

const app = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

app.post("/me/push-token", zValidator("json", z.object({ token: z.string() })), async (c) => {
  const user = aggregateStub(c.env.USER, "user", c.get("userId"));
  const snap = await user.addPushToken(c.req.valid("json").token);
  return c.json(snap); // { id, version, state, projected }
});

app.get("/admin/pro-users", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id FROM user_state WHERE pro = 1").all();
  return c.json(results);
});

app.onError((err, c) => {
  if (err.name === "DomainError") return c.json({ error: err.message }, 422);
  if (err.name === "NotInitializedError") return c.json({ error: "not found" }, 404);
  throw err;
});
```

Create the object once, when the entity is born (e.g. in Better Auth's `user.create.after` hook):

```ts
await aggregateStub(env.USER, "user", user.id).init(user.id);
```

`init` is idempotent. Commands before `init` throw `NotInitializedError`.

## 5. Rebuilding a projection

Projection tables are disposable. After adding a column:

```ts
// one-off admin route or script
const { results } = await env.DB.prepare("SELECT id FROM user_state").all<{ id: string }>();
for (const { id } of results) {
  await aggregateStub(env.USER, "user", id).reproject(); // forces a rewrite at the same version
}
```

Batch with modest concurrency (10–20) — each call is one object request.

## 6. Per-object tables (optional)

If an aggregate needs its own relational data inside the object (e.g. a match's move history),
declare migrations; they run once per object, in order:

```ts
protected schemaMigrations() {
  return [
    (sql) => sql.exec("CREATE TABLE moves (n INTEGER PRIMARY KEY, move TEXT NOT NULL)"),
  ];
}
```

Use `this.sql` inside commands. `schemaMigrations` must be a method, not an arrow-function field.

## 7. Testing your aggregates

Copy `test/wrangler.jsonc`, `test/setup.ts`, `test/env.d.ts` and `vitest.config.ts` from
`packages/core` into your Worker package, point them at your migrations, and write tests against
real bindings:

```ts
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";

const user = aggregateStub(env.USER, "user", "u1");
await user.init("u1");
await user.setPro(true);
expect(await env.DB.prepare("SELECT pro FROM user_state WHERE id = 'u1'").first()).toMatchObject({ pro: 1 });
```

- `runDurableObjectAlarm(stub)` runs a scheduled retry immediately.
- `evictDurableObject(stub)` tears down the instance to test reload-from-storage paths.
- Assert failures as `await expect(async () => { await user.spend(-1); }).rejects.toThrow()` —
  the async wrapper makes the RPC rejection handled exactly once.
- `vitest.config.ts` filters one known harness duplicate: the pool re-reports errors thrown across
  its in-isolate RPC wrapper even though the caller handled them.

## Files in `packages/core`

```
src/aggregate.ts     Aggregate base class (snapshot, version/projected watermarks, flush, alarm, migrations)
src/projections.ts   ProjectionsBase + versionedUpsert()
src/stub.ts          aggregateStub()
src/errors.ts        DomainError, NotInitializedError
test/                fixture Worker (Counter aggregate), D1 migration, 8 runtime tests
```

Toolchain pinned at scaffold time: wrangler 4.127, @cloudflare/vitest-pool-workers 0.22 (Vitest 4.1),
@cloudflare/workers-types 5, TypeScript 7. The test config uses `compatibility_date` 2025-09-01,
a date the bundled runtime is guaranteed to know; use today's date in real Workers.
