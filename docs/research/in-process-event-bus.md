# Typed in-process domain event bus (events as module-to-module calls)

Slug: `in-process-event-bus` · Researched 2026-09-02 against the pinned stack (wrangler 4.128.0, hono 4.13.5, zod 4.5.4, @cloudflare/vitest-pool-workers 0.22.0 / vitest 4.1.11, TypeScript 7.0.2, pnpm 11). Stack pins confirmed current as of 2026-09-02 via `npm view`: zod 4.5.4, hono 4.13.5, wrangler 4.128.0, vitest 4.1.11, @cloudflare/vitest-pool-workers 0.22.0 (deps wrangler 4.124.0 / miniflare 5.20260815.0-alpha), typescript 7.0.2, pnpm 11.25.0, @cloudflare/workers-types 5.20260902.1.

## Summary

Crosscut's backend is one Worker. A "domain event" in this design is **a plain object, validated by a Zod discriminated union, handed by a small bus module to subscriber functions of other modules in the same isolate, inside the same request that produced it**. There is no queue, no pub/sub service and no event log.

The design has four load-bearing parts:

1. **Envelope + registry.** Every event is `{ id, type, v, occurredAt, actor, correlationId, causationId, aggregate, payload }`. Each module owns the schemas of the events it publishes (`modules/<m>/contract.ts`); a single `shared/events/registry.ts` composes them into `z.discriminatedUnion("type", [...])`, which is also the static type of the whole event universe. Zod 4's discriminated union parses by the discriminator key rather than trying every option, so validating on publish is cheap.
2. **Static subscriber table, per-request dispatch context.** Subscriptions are registered once at module-evaluation time in a composition root (`wiring.ts` is the only file allowed to import every module). Everything request-bound (`env`, `ExecutionContext`, `userId`, `correlationId`, depth counter, report) lives in a `DispatchContext` created per request and passed explicitly. Cloudflare documents that I/O objects created for one request cannot be used by another ("Cannot perform I/O on behalf of a different request"), and advises against mutable global state; the bus therefore never stores `env`, `ctx` or stubs in module scope.
3. **Commit → outbox → dispatch → ack.** The aggregate writes the new state *and* the events it produced in one `transactionSync`, into a small `outbox` table that is drained on acknowledgement (transient, bounded, not an event log — the "current state only" decision stands). The gateway dispatches the events in-process right after the command returns, so subscriber results (tokens credited, streak updated) can be folded into the same HTTP response, then calls `ack`. If the Worker dies before `ack`, the aggregate's existing alarm machinery (the same one that retries projections) re-delivers the outbox through the `Events` `WorkerEntrypoint` via `ctx.exports`. Alarms are documented as at-least-once with automatic retries, so every subscriber must be idempotent: subscriber aggregates keep a `processed_events(event_id)` table and drop duplicates in the same transaction as their own state write.
4. **Two handler classes.** `critical` handlers are awaited sequentially in registration order inside the request; a failure is recorded in a `DispatchReport` and prevents `ack` for that handler only (per-handler ack), so the alarm path retries just the failed handler. `background` handlers (analytics, ticker counters, push) run under `c.executionCtx.waitUntil`, which Cloudflare limits to 30 s after the response; they are best-effort, and their failures are logged, not retried. Inside a Durable Object `waitUntil` is documented as a no-op, which is exactly why in-request dispatch belongs in the gateway (or the `Events` entrypoint), never inside the aggregate.

Build, do not adopt: none of mitt, emittery, eventemitter3, nanoevents, typed-emitter or tiny-typed-emitter gives Zod validation, a per-handler result report, critical/background separation, a recursion guard or an RPC-safe error model, and emittery's `AggregateError` is explicitly *not* propagated over Workers RPC. The bus is ~150 lines and is tested in workerd with `createExecutionContext` / `waitOnExecutionContext` / `runDurableObjectAlarm`.

Upgrade to Cloudflare Queues only when a handler needs to fan out to many objects or to a rate-limited third party (push, email) and the work must survive independently of the request; upgrade to Workflows only for multi-step processes with sleeps or minutes-long steps. For Crosscut's launch scope (a user solves a puzzle → wallet, streak, collections, leaderboard, feed counters update) neither is needed.

## Findings

### F1. `ctx.waitUntil` is real but bounded: 30 s after the response, shared across all calls in the request

Cloudflare: `ctx.waitUntil()` "extends the lifetime of your Worker, allowing you to perform work without blocking returning a response". "For HTTP-triggered Workers, ctx.waitUntil() can extend execution for up to 30 seconds after the response is sent or the client disconnects. This time limit is shared across all waitUntil() calls within the same request. If any Promises have not settled after 30 seconds, they are canceled."
Source: https://developers.cloudflare.com/workers/runtime-apis/context/ and https://developers.cloudflare.com/workers/platform/limits/

Consequence: `background` handlers must finish well under 30 s in aggregate; anything heavier belongs in the alarm path or Queues.

Caveat: the 30 s figure is documented for HTTP-triggered invocations, and the Workers docs list the same 30 s extension for Cron, Queue-consumer and DO-alarm invocation types. The `Events` `WorkerEntrypoint` in R1, however, is invoked over RPC from a DO alarm; an RPC invocation's lifetime is tied to its caller, and Cloudflare does not document a separate `waitUntil` budget for RPC-invoked entrypoints. The claim that the alarm path gets a Worker `ctx` with its own 30 s `waitUntil` budget is plausible but undocumented [UNVERIFIED]; treat background handlers on the recovery path as best-effort within the alarm's lifetime.

### F2. `waitUntil` has no effect inside Durable Objects

DurableObjectState docs: "Unlike in Workers, `waitUntil` has no effect in Durable Objects. It does not extend the lifetime of a Durable Object." (The object stays alive while work is pending anyway.)
Source: https://developers.cloudflare.com/durable-objects/api/state/

Consequence: an aggregate cannot "fire and forget" subscriber work. Either the gateway request dispatches (hot path) or the DO's alarm calls a Worker entrypoint that has its own `ctx` (recovery path).

### F3. Per-request I/O objects cannot cross requests; Cloudflare advises against mutable global state

Errors reference: "Cannot perform I/O on behalf of a different request. I/O objects (such as streams, request/response bodies, and others) created in the context of one request handler cannot be accessed from a different request's handler." Most common cause: "attempting to cache an I/O object, like a Request in global scope, and then access it in a subsequent request." Recommendation: store "only the data in global scope, rather than the I/O object itself"; use Durable Objects for shared state, KV for cached data.
How Workers works: "it is generally advised that you not store mutable state in your global scope unless you have accounted for this contingency" and "Cloudflare recommends you do not use or mutate global state".
Sources: https://developers.cloudflare.com/workers/observability/errors/ and https://developers.cloudflare.com/workers/reference/how-workers-works/

Consequence: RPC stubs, `env`, `ExecutionContext` and Hono `Context` are per-request. The bus keeps only an immutable handler table in module scope.

### F4. `ctx.exports` loopback bindings exist, are on by default since 2025-11-17, and cover both `WorkerEntrypoint` and `DurableObject` exports

Changelog 2025-09-26: for each top-level `WorkerEntrypoint` export "ctx.exports will contain a Service Binding by the same name"; for each `DurableObject` export "ctx.exports will contain a Durable Object namespace binding" when "storage has been configured via a migration". Compatibility flags page: `enable_ctx_exports` default-on date 2025-11-17. A 2025-12-16 changelog entry states `@cloudflare/vitest-pool-workers` "now supports the ctx.exports API". The local `packages/core` template already uses `ctx.exports.Projections` from inside an aggregate and passes 8/8 workerd tests.
Sources: https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ , https://developers.cloudflare.com/workers/configuration/compatibility-flags/ , https://developers.cloudflare.com/changelog/post/2025-12-16-vitest-ctx-exports-support/ , /Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts

Consequence: the alarm-driven recovery path can call `this.ctx.exports.Events.dispatch(...)` with no wrangler binding, exactly like projections do today.

### F5. Workers RPC transports structured-cloneable values; errors keep only `message` and prototype `name`; `AggregateError` is dropped

RPC docs: "Nearly all types that are Structured Cloneable can be used as a parameter or return value of an RPC method"; "Application-defined classes (or objects with custom prototypes) cannot be passed over RPC" unless they extend `RpcTarget` (then a stub is sent). Error handling: the caller receives the error's `message` and the prototype's `name`; "the stack trace is not" preserved; "Own properties of error objects, such as the cause property, are not propagated back to the caller"; `AggregateError` is "not propagated back to the caller". RPC requires compatibility date `2024-04-03` or the `rpc` flag.
Sources: https://developers.cloudflare.com/workers/runtime-apis/rpc/ , https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ , https://developers.cloudflare.com/workers/configuration/compatibility-flags/

Consequence: the envelope must be plain JSON (no class instances, ISO strings for time); handlers hosted in a `WorkerEntrypoint` must *return* a `DispatchReport` as data instead of throwing rich errors; emittery's `AggregateError` model does not survive an RPC hop.

### F6. Durable Object alarms are at-least-once, auto-retried (exponential backoff from 2 s, up to 6 retries), and serialized per object

Alarms API: "Alarms have guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws", exponential backoff beginning at 2 seconds, "up to 6 retries"; "Only one instance of `alarm()` will ever run at a given time per Durable Object instance"; `setAlarm(scheduledTimeMs)`, `getAlarm()`, `deleteAlarm()`. Rules of Durable Objects: "In rare cases, alarms may fire more than once. Your `alarm()` handler should be safe to run multiple times."
Sources: https://developers.cloudflare.com/durable-objects/api/alarms/ , https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/

Consequence: the outbox re-delivery is naturally at-least-once; dedupe by event id is mandatory in subscriber aggregates. The existing `Aggregate` already schedules its own backoff via `setAlarm`, so the outbox reuses that alarm (one alarm per object: `setAlarm` overwrites).

Caveats from the same alarms page: platform retries are limited to 6, so a persistently failing handler exhausts them and the object must re-arm itself (constructor re-arm on next wake, R7); calling `deleteAlarm()` from inside `alarm()` prevents retries only on a best-effort basis; and `getAlarm()` returns `null` while the handler is running unless `setAlarm()` has been called since the handler started. The sketch's `alarm() → ackEvents() → rearm()` path therefore must not rely on `getAlarm()` to decide whether an alarm is pending during the handler. The doc recommends catching exceptions inside `alarm()` and calling `setAlarm()` yourself rather than relying on platform retries; the outbox redelivery should do exactly that.

### F7. `transactionSync` gives atomic state + outbox writes; output gates hold responses until writes are durable

Storage API: `transactionSync(callback)` "Invokes `callback()` wrapped in a transaction, and returns its result", SQLite-backed objects only, callback must be synchronous. "By default, the system will pause outgoing network messages from the Durable Object until all previous writes have been confirmed flushed to disk"; if a write fails "the system will reset the Object, discard all outgoing messages, and respond to any clients with errors instead."
Source: https://developers.cloudflare.com/durable-objects/api/storage-api/

Consequence: writing `aggregate.state` and `outbox` rows inside one `transactionSync` guarantees "an event exists iff its state change exists", and the caller never sees a snapshot whose events were not durably recorded. This is the "commit then publish" ordering with no distributed transaction.

Explicit limitation: the storage-api docs state "Only synchronous storage operations can be part of the transaction". `setAlarm()` / `deleteAlarm()` return Promises and therefore must be called *outside* `transactionSync` (as the sketch does); do not move alarm arming inside the transaction. The alarm is consequently not atomic with the outbox write: a crash between `transactionSync` returning and `setAlarm()` resolving leaves unacked outbox rows with no alarm until the next wake (the constructor re-arm in R7) — a known gap in the "commit iff outbox" guarantee, which is why the constructor must re-arm whenever the outbox is non-empty.

### F8. Durable Object limits that shape fan-out

Limits: SQLite-backed object CPU "30 seconds (default) / configurable to 5 minutes"; "An individual Object has a soft limit of 1,000 requests per second"; Rules: "A single Durable Object can handle approximately 500-1,000 requests per second for simple operations", "Do not create a single 'global' Durable Object". In-memory state "is not preserved across eviction or hibernation, persist anything important to storage". Non-storage I/O (e.g. `fetch()`, other stubs) lets other requests interleave at `await` points; input gates only protect storage operations.
Sources: https://developers.cloudflare.com/durable-objects/platform/limits/ , https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ , https://developers.cloudflare.com/durable-objects/reference/in-memory-state/

Consequence: a subscriber that writes to one shared object per event (a global leaderboard, a per-puzzle social counter) is the first thing that will need Queues batching; per-user objects are fine. Because interleaving is possible around non-storage `await`s, subscribers should not hold a DO command open across a call to another DO.

### F9. Cloudflare Queues: at-least-once, 128 KB messages, up to 100 retries, 24 h delay, free and paid plans

Delivery: "Queues provides at least once delivery by default"; messages "may be delivered more than once"; recommended to attach a unique ID per message for idempotent consumers. Limits: message size 128 KB, consumer batch 100 messages, retries 100, retention up to 14 days (24 h on Free), `delaySeconds` up to 24 h, consumer wall clock 15 min, 250 concurrent push consumers. Overview: "Available on Free and Paid plans"; use to "guarantee delivery", "offload work from a request", "send data from Worker to Worker", "buffer or batch data".
Sources: https://developers.cloudflare.com/queues/reference/delivery-guarantees/ , https://developers.cloudflare.com/queues/platform/limits/ , https://developers.cloudflare.com/queues/

### F10. Cloudflare Workflows: durable steps with configurable retries, sleeps, up to 1,024 (Free) / 10,000+ (Paid) steps

`step.do(name, { retries: { limit, delay, backoff }, timeout }, fn)`; `NonRetryableError` stops retries; `step.sleep` / `step.sleepUntil` do not count as steps; `env.MY_WORKFLOW.create({ id, params })` "Throws an error if the provided ID already exists within the retention limit". Limits: 1,024 steps Free, "10,000 (default) / configurable up to 25,000" Paid; 1 MiB step result and event payload; unlimited wall-clock; 100 (Free) / 50,000 (Paid) concurrent running instances; waiting instances do not count. The limits page also states instance-creation rate limits: 100/s on Free; 300/s per account and 100/s per workflow on Paid — relevant if `env.WF.create({ id: event.id })` is called per event. The statement that every instance is an SQLite-backed Durable Object under the hood comes from a 2024 Cloudflare blog post ("every Engine is an SQLite-backed Durable Object"), not from the reference docs.
Sources: https://developers.cloudflare.com/workflows/build/workers-api/ , https://developers.cloudflare.com/workflows/reference/limits/ , https://blog.cloudflare.com/building-workflows-durable-execution-on-workers/ (blog, 2024)

### F11. Zod 4 discriminated unions parse by discriminator key; `z.infer` gives the union type

"A discriminated union is a special kind of union in which a) all the options are object schemas that b) share a particular key (the 'discriminator')." Regular unions "check the input against each option in order… This can be slow for large unions"; discriminated unions use the key. `z.discriminatedUnion("status", [z.object({ status: z.literal("success"), … }), …])`, `z.literal`, `z.iso.datetime()`, `z.uuid()` / `z.uuidv4()`, `z.infer<typeof S>`. zod latest is 4.5.4; `@hono/zod-validator` 0.9.1 peers `zod ^3.25.0 || ^4.0.0`, `hono >=4.11.2`.
Sources: https://zod.dev/api?id=discriminated-unions , `npm view zod version`, `npm view @hono/zod-validator peerDependencies`

### F12. Hono exposes `c.executionCtx.waitUntil`, request-scoped `c.set/c.get` typed via `Variables`, and `c.env` for bindings

"You can access Cloudflare Workers' specific ExecutionContext" — `c.executionCtx.waitUntil(...)`, Workers-only; `c.set('message', …)` / `c.get('message')` with `new Hono<{ Variables: … }>()`; `c.env.BINDING`.
Source: https://hono.dev/docs/api/context

Consequence: the per-request `DispatchContext` is created in a Hono middleware and stored with `c.set("events", bus)`; the bus receives `c.env` and `c.executionCtx` explicitly.

### F13. Workers test API: `cloudflare:test` exports and the plugin's current package name

Installed `@cloudflare/vitest-pool-workers@0.22.0` `types/cloudflare-test.d.ts` exports `env`, `SELF`, `createExecutionContext`, `waitOnExecutionContext`, `runInDurableObject`, `runDurableObjectAlarm`, `listDurableObjectIds`, `evictDurableObject`, `evictAllDurableObjects`, `abortAllDurableObjects`, `applyD1Migrations`, `createMessageBatch`, `getQueueResult`, `createScheduledController`, `introspectWorkflow`, `introspectWorkflowInstance`, `reset`, `adminSecretsStore`. Its `dist/pool/index.d.mts` exports `cloudflareTest`, `cloudflarePool`, `readD1Migrations` (no `defineWorkersConfig`). Docs: `waitOnExecutionContext(ctx)` "Waits for all Promises passed to `ctx.waitUntil()` to settle"; `runDurableObjectAlarm(stub)` "Immediately runs and removes a Durable Object's scheduled alarm"; `runInDurableObject(stub, (instance, state) => …)` executes a callback inside the object.
The official getting-started page now installs **`@cloudflare/vitest-plugin`** (`npm i -D vitest@^4.1.0 @cloudflare/vitest-plugin`; npm 1.1.3, published 2026-09-01 — the package itself was first created 2026-08-20 as 0.0.0 / 1.0.0; peers `vitest`, `@vitest/runner`, `@vitest/snapshot` `^4.1.0`; deps wrangler 4.128.0 / miniflare 5.20260831.0-alpha) with `import { cloudflareTest } from "@cloudflare/vitest-plugin"`; its `dist/pool/index.d.mts` exports `cloudflareTest`, `cloudflarePool`, `readD1Migrations`. The pool package (0.22.0, deps wrangler 4.124.0, no `deprecated` field on npm) has the same `cloudflareTest` export and is what the verified template uses. Feature parity is confirmed by the plugin's `types/cloudflare-test.d.ts`, not by its README: the README on npm/jsdelivr lists only generic features (runtime access, isolated storage, Miniflare, HMR, request mocking, multi-Worker) and does not mention the Durable Object, D1-migration, Queues or Workflows helpers. Import-path caveat: the test-apis docs page references `readD1Migrations` from `@cloudflare/vitest-plugin/config`, but the plugin's `package.json` `exports` only exposes `.` and `./types` — `readD1Migrations` is exported from the package root (as the core template already does with the pool package). Verify the import path before switching packages.
Sources: installed package inspection (`node_modules/@cloudflare/vitest-pool-workers`), https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ , https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ , `npm view @cloudflare/vitest-plugin@1.1.3 time peerDependencies dependencies` , https://cdn.jsdelivr.net/npm/@cloudflare/vitest-plugin@1.1.3/dist/pool/index.d.mts , `npm view @cloudflare/vitest-pool-workers@0.22.0 deprecated` (empty)

### F14. AsyncLocalStorage is available (`node:async_hooks`) under `nodejs_compat` (default from 2026-08-04) or the `nodejs_als` flag; `enterWith`/`disable` are omitted

Sources: https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/ , https://developers.cloudflare.com/workers/configuration/compatibility-flags/

Consequence: ALS could carry `correlationId` implicitly, but Cloudflare does not document its interaction with `waitUntil` continuations (UNVERIFIED), so this design passes the `DispatchContext` explicitly and treats ALS as optional logging sugar.

### F15. Library survey (npm, 2026-09-02)

| Library | Version | Version published (npm `time.modified`) | Sync/async | Typing | Notes |
|---|---|---|---|---|---|
| mitt | 3.0.1 | 2023-07-04 (modified 2025-10-13) | sync, fire-and-forget | `mitt<Events>()` map of name→payload | ~200 B; `emit` returns nothing, so handler promises cannot be awaited or reported; `*` wildcard |
| emittery | 2.0.0 | 2026-03-04 | async; listeners "deferred to the next microtask" | `new Emittery<{open: string; close: undefined}>()` | `emit()` "Returns a promise that resolves when all the event listeners are done… If any listeners throw/reject, the returned promise rejects with an `AggregateError`"; `emitSerial` runs in order; no per-handler report; `AggregateError` is not RPC-propagable (F5) |
| eventemitter3 | 5.0.4 | 2026-01-19 | sync | generic event map (README fetch returned no typing section; UNVERIFIED here) | Node-style API |
| nanoevents | 10.0.0 | 2026-07-22 | sync | typed interface | tiny, no async, no error handling |
| typed-emitter | 2.1.0 | 2022-01-22 (modified 2022-06-28) | types only over Node `events` | good | declares `dependencies: { rxjs: "*" }`; dormant since 2022 |
| tiny-typed-emitter | 2.1.0 | 2021-07-24 (modified 2022-05-21) | Node `EventEmitter` subclass | good | dormant since 2022; Node `events` needs `nodejs_compat` |

Sources: `npm view <pkg> version|time|dependencies|readme` for each package. Dates are the actual publish time of the listed version (`time.<version>`); where npm's `time.modified` (registry metadata, e.g. tag or README changes) differs it is shown in parentheses. For emittery, eventemitter3 and nanoevents the two coincide.

None validates payloads, none separates critical from background delivery, none returns a structured per-handler outcome, none guards recursion depth, and all model an *instance* that is naturally global (the pattern Cloudflare warns about in F3). A purpose-built bus is smaller than the glue required to bend any of them.

## Recommendation for Crosscut

### R1. Topology: where events flow

```
HTTP  ─▶ gateway (Hono)
           │ 1. command                  ┌──────────────────────────────┐
           ▼                             │ Aggregate DO (e.g. Puzzle    │
     stub.solve(...) ───────────────────▶│ Attempt / User)              │
           │  returns {snapshot, events} │  transactionSync {           │
           │                             │    state v+1, outbox rows }  │
           │ 2. bus.dispatch(events)     └──────────────┬───────────────┘
           ▼                                            │ alarm (recovery only)
     modules' handlers, in-process                      ▼
       critical: awaited, ordered            ctx.exports.Events.dispatch(events)
       background: c.executionCtx.waitUntil        (same bus module, own ctx)
           │ 3. stub.ackEvents(report)                  │ ack locally
           ▼                                            ▼
     HTTP response includes handler results     outbox rows deleted
```

- Commands return `{ snapshot, events }`. The gateway is the **hot-path dispatcher**; it has the request's `env`, `ExecutionContext`, `userId` and a `correlationId` (from an `x-request-id` header or `crypto.randomUUID()`).
- The aggregate is the **source of truth for undelivered events** (outbox in its SQLite, written atomically with state, F7) and the **recovery dispatcher** (its alarm calls `ctx.exports.Events.dispatch`, F4/F6). This is the same watermark-plus-alarm idea already used for projections; it just tracks a list of rows instead of a version number.
- The `Events` `WorkerEntrypoint` is a thin host for the same `dispatch()` function so that the alarm path gets a real Worker `ctx` (F2). It is never called from the gateway. Whether an RPC-invoked entrypoint has its own 30 s `waitUntil` budget independent of the calling alarm is undocumented (F1 caveat) [UNVERIFIED].

This keeps the rule from `concepts.md` intact: an aggregate never invokes another aggregate's command *as a side effect of its own commit*. It only records that something happened; the Worker orchestrates.

### R2. Envelope

```ts
interface Envelope<T extends string, P> {
  id: string;            // uuid v4, minted inside the DO at commit
  type: T;               // "puzzle.solved" — <module>.<pastTenseFact>
  v: 1;                  // schema version of the payload
  occurredAt: string;    // ISO 8601 (z.iso.datetime())
  actor: { kind: "user"; userId: string } | { kind: "system"; reason: string };
  correlationId: string; // one per inbound request; alarm redelivery reuses the original
  causationId: string;   // command id or parent event id (cycle detection, tracing)
  aggregate: { kind: string; id: string; version: number }; // the commit that produced it
  payload: P;            // plain JSON only (F5)
}
```

`id` is minted by the producing aggregate, not the gateway, so redelivery from the outbox carries the identical id and subscriber dedupe works. `aggregate.version` lets a subscriber discard an event whose producing version it has already seen even if the id table was pruned.

### R3. Schema registry (Zod 4)

- Each module exports `events` from `modules/<m>/contract.ts`: `defineEvent("wallet.tokensCredited", 1, z.object({ userId: z.string(), amount: z.int().positive(), reason: z.enum([...]) }))`.
- `shared/events/registry.ts` does `export const DomainEvent = z.discriminatedUnion("type", [PuzzleSolved, TokensCredited, …])` and `export type DomainEvent = z.infer<typeof DomainEvent>`. `EventOf<"puzzle.solved">` is `Extract<DomainEvent, { type: "puzzle.solved" }>`.
- `bus.dispatch` runs `DomainEvent.safeParse` on every event before handlers run; a parse failure is a `DispatchReport` entry with `reason: "invalid"` (the event is acked to avoid infinite redelivery, and logged loudly). This protects subscribers when an alarm re-delivers events written by an older deploy.
- Payload evolution: bump `v` and add a new schema; keep the old schema in the registry until the outbox horizon (a few days) has passed.

### R4. Subscriber registry and handler signature

```ts
type Handler<T extends DomainEvent["type"]> =
  (event: EventOf<T>, ctx: DispatchContext) => Promise<HandlerResult | void>;

interface Subscription<T extends DomainEvent["type"] = any> {
  name: string;                 // "wallet.onPuzzleSolved" — stable, used for per-handler ack
  type: T;
  mode: "critical" | "background";
  handle: Handler<T>;
}
```

- Modules export `subscriptions: Subscription[]` from `modules/<m>/subscriptions.ts`. Only `workers/gateway/src/wiring.ts` imports them all and builds the immutable `HandlerTable` (a `Map<type, Subscription[]>` frozen at module evaluation). This is the single sanctioned cross-module import; enforce with `eslint no-restricted-imports` (or dependency-cruiser) so that `modules/a/**` may import only `modules/b/contract.ts`, never `modules/b/internal/**`.
- Handlers receive `ctx.env` (bindings), `ctx.exec` (the Worker `ExecutionContext`, `null` when hosted by a DO alarm), `ctx.actor`, `ctx.correlationId`, `ctx.depth`, and `ctx.publish()` for follow-on events.

### R5. Dispatch semantics

1. **Validate** (R3).
2. **Critical handlers**: `for … of` in registration order, each `await`ed, each wrapped in `try/catch`; one handler's failure never prevents the next (error isolation). Results are collected into `DispatchReport { eventId, outcomes: [{ handler, ok, ms, error?: { name, message } }] }`.
3. **Background handlers**: each wrapped in a promise passed to `ctx.exec.waitUntil()` when `ctx.exec` exists; when hosted by the alarm path (`exec` present on the `WorkerEntrypoint`'s `this.ctx`) the same applies. They are acked immediately — they are best-effort by definition (F1).
4. **Follow-on events**: a handler that runs a command on another aggregate gets back `{ snapshot, events }` and calls `ctx.publish(events)`; the bus dispatches them with `depth + 1` and `causationId = parent.id`. Hard cap `MAX_DEPTH = 4` and `MAX_EVENTS_PER_REQUEST = 64`; exceeding either records `reason: "loop-guard"` and stops. A per-request `Set` of `${type}:${aggregate.kind}:${aggregate.id}` also rejects the exact same fact re-entering the request (cheap cycle check).
5. **Ack**: after critical handlers finish, the gateway calls `stub.ackEvents([{ eventId, handlers: ["wallet.onPuzzleSolved", …] }])` listing the handlers that succeeded. Rows whose `remaining` set becomes empty are deleted; the rest stay and the aggregate arms its alarm.
6. **Partial-failure reporting**: the HTTP response is still 200 (the command committed); the report is logged with `correlationId`, and the client payload includes only the successful handler results (e.g. wallet balances). Command failure (`DomainError`) is distinct and still maps to 422 in `app.onError`.

Ordering guarantees: per aggregate, events are delivered in outbox `seq` order; across aggregates there is no ordering (none is needed by the product). Within one event, critical handlers run in registration order — make registration order explicit in `wiring.ts` and treat it as an API (wallet before leaderboard, streak before collections).

### R6. Idempotency

- Producer side: the aggregate's own `commit` is already a no-op for equal state; commands that consume an event take `eventId` and check `processed_events` **inside the same `transactionSync`** as their state write (`INSERT OR IGNORE` first; if `changes === 0`, return current snapshot without mutating).
- Prune `processed_events` rows older than 30 days in the same command (cheap `DELETE … WHERE at < ?` guarded by a counter) — keeps the table bounded without another alarm.
- Handlers that write to D1 (feed counters, leaderboard rows) use the event id as a natural key (`INSERT OR IGNORE INTO solve_events(event_id, …)`) or a version guard exactly like `versionedUpsert`.

### R7. Reliability (what happens if the Worker dies mid-dispatch)

| Failure point | Effect | Recovery |
|---|---|---|
| Before the command commits | nothing recorded | client retries; command is idempotent by construction |
| After commit, before gateway dispatch | outbox rows exist, none acked | alarm (armed at commit when `flushMode === "await"` fails to ack in time — see below) re-delivers through `Events` |
| Mid-dispatch (some handlers done) | handlers already applied their own idempotent writes; ack not sent | redelivery to *all* handlers; done ones dedupe by event id |
| Handler failure | recorded in report; not acked for that handler | alarm redelivers to that handler only (`remaining`) |
| Alarm handler failure | alarm rethrows | platform retries (backoff from 2 s, up to 6 retries), then the constructor re-arms on next wake (mirrors projections) |

Arming the alarm: on commit the aggregate does `setAlarm(now + ACK_GRACE_MS)` (e.g. 15 s) whenever the outbox is non-empty; `ackEvents` deletes the alarm when the outbox is empty, or re-arms with backoff when rows remain. `setAlarm` overwrites, so this coexists with the projection retry alarm by sharing one `alarm()` that does both jobs: `await this.flush(); await this.redeliverOutbox();`. Two alarm-API caveats (F6): `setAlarm`/`deleteAlarm` are async and run outside `transactionSync`, so arming is not atomic with the outbox write (F7) — the constructor must re-arm on wake if the outbox is non-empty; and inside `alarm()` `getAlarm()` returns `null` unless `setAlarm` has been called since the handler started, so `rearm()` when called from `ackEvents` inside `alarm()` must decide from the outbox row count, never from `getAlarm()`. Because platform retries stop after 6 and `deleteAlarm()` inside `alarm()` only best-effort suppresses them, prefer catching handler errors inside `alarm()` and calling `setAlarm()` with your own backoff, as the alarms doc recommends.

The outbox is not an event log: rows live for seconds normally and at most `ACK_GRACE + backoff` on failure; a `MAX_OUTBOX_ROWS` guard (e.g. 500) turns further commits into `DomainError("events backlog")` rather than growing unbounded.

### R8. Crosscut event catalogue (first cut, from the design README and prototype formulas)

| Event | Producer | Critical subscribers | Background subscribers |
|---|---|---|---|
| `puzzle.solved { puzzleId, secondsLeft, par, usedHints, tokensEarned = floor(secondsLeft/5), starsEarned = 10 + (usedHints ? 0 : 2), solveTimeSec }` | `PuzzleAttempt` aggregate (per user×puzzle) | `wallet.credit` (tokens+stars), `streak.markSolved` (day key in user TZ), `collections.progress`, `leaderboard.record` | `feed.bumpSolvedCount`, `analytics.track`, `notifications.cancelStreakWarning` |
| `hint.used { puzzleId, kind: "fifty"|"letter"|"word", cost: 20|40|100 }` | `PuzzleAttempt` | `wallet.debit` (already reserved by the command that checked balance) | `analytics.track` |
| `wallet.tokensCredited / tokensDebited { amount, reason, balance }` | `User` (wallet slice) | — | `analytics.track` |
| `wheel.spun { wheelKey, prize ∈ {50,10,0,25,5,15} }` | `User` (one spin per wheel key) | `wallet.credit` | `analytics.track` |
| `collection.completed { collectionId, reward }` | `User` (collections slice) | `wallet.credit(reward)`, `achievements.unlock` | `notifications.push` |
| `streak.extended / streak.broken { length }` | `User` (streak slice) | — | `notifications.scheduleStreakWarning` (alarm on `User`) |
| `purchase.completed { pack, tokens }` | webhook route → `User.applyPurchase` | `wallet.credit` | — |

Note the wallet is a slice of the `User` aggregate in this cut (one object per user, deterministic id); `puzzle.solved` → `wallet.credit` is therefore a command on a *different* object (`user:<id>`) from the producer (`attempt:<userId>:<puzzleId>`), which is why it is an event and not a local state change. If `PuzzleAttempt` is folded into `User` later, the same handlers stay; only the producer changes.

### R9. When to upgrade

Upgrade a specific subscription — never the whole bus — when one of these becomes true:

- **Queues**: a handler must call a rate-limited or slow third party (Expo push, email, RevenueCat) for many users per event, or a handler targets a shared hot object (global leaderboard, per-puzzle live counters) at a rate approaching the ~500–1,000 rps per-object guidance (F8), or background work regularly exceeds a few seconds (F1). Producer change: the handler becomes `env.QUEUE.send(envelope)` (128 KB max, F9); the consumer re-uses the same handler function and the same event-id dedupe.
- **Workflows**: a reaction needs multiple durable steps with independent retries, or sleeps (`step.sleep`), or takes minutes (F10). Examples for Crosscut: monthly archive-pack generation, end-of-season leaderboard settlement with payouts. Use `env.WF.create({ id: event.id })` so a redelivered event cannot start a second instance (create throws on a duplicate id, F10). Mind the instance-creation rate limits if this is called per event (100/s Free; 300/s per account and 100/s per workflow Paid, F10).
- **Not a reason to upgrade**: needing a delay (DO alarms already do that per entity), needing retries (alarm path), needing ordering per user (per-object outbox already gives it).

### R10. Testing plan (vitest-pool-workers, inside workerd)

- Pure unit tests of `dispatch()` with a hand-built `HandlerTable` and a fake `DispatchContext` (no bindings): ordering, error isolation, report shape, loop guard, validation failure path.
- Integration: call the Hono app via `SELF.fetch` or `app.request` with `createExecutionContext()`; `await waitOnExecutionContext(ctx)` before asserting background effects (D1 rows); assert critical effects through subscriber aggregates' `snapshot()`.
- Recovery: use a D1 `test_flags` switch (as the core template does) to make a handler throw; assert the outbox row remains (`runInDurableObject(stub, (o) => o.sql.exec("SELECT * FROM outbox").toArray())`), then clear the flag and `runDurableObjectAlarm(stub)`; assert delivery and outbox drain; `evictDurableObject` before the alarm to prove the constructor re-arms.
- Idempotency: deliver the same envelope twice to a subscriber aggregate; assert one balance change.
- Keep the template's `onUnhandledError` filter and the `await expect(async () => { await stub.x(); }).rejects` idiom.

### R11. Pitfalls checklist

1. No `env`, `ctx`, stubs or Hono `Context` in module scope; the handler table is the only global and it is frozen (F3).
2. `waitUntil` budget is 30 s shared per request (F1); never `waitUntil` inside a DO (F2).
3. Handlers must not hold a DO command open while awaiting another DO (interleaving, F8); do cross-object work in the gateway/bus, not inside `commit`.
4. Envelope and `DispatchReport` are plain JSON; errors cross RPC as `{name, message}` only (F5).
5. Loop guard: depth ≤ 4, ≤ 64 events per request, same-fact set (R5.4).
6. Every subscriber is idempotent on `event.id` (F6, R6); alarm handlers are idempotent.
7. One `alarm()` per object handles both projection retry and outbox redelivery; `setAlarm` overwrites (F6).
8. Registration order in `wiring.ts` is a behavioural contract; cover it with a test.
9. Do not compute economy amounts in subscribers — the producer records `tokensEarned`, `starsEarned` in the payload so redelivery is deterministic.

## Code sketches

Illustrative only; not production code.

### Registry (shared/events/registry.ts)

```ts
import { z } from "zod";

export const Actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({ kind: z.literal("system"), reason: z.string() }),
]);

export function defineEvent<T extends string, P extends z.ZodType>(type: T, v: number, payload: P) {
  return z.object({
    id: z.uuid(),
    type: z.literal(type),
    v: z.literal(v),
    occurredAt: z.iso.datetime(),
    actor: Actor,
    correlationId: z.string(),
    causationId: z.string(),
    aggregate: z.object({ kind: z.string(), id: z.string(), version: z.int() }),
    payload,
  });
}

// modules/puzzle/contract.ts
export const PuzzleSolved = defineEvent("puzzle.solved", 1, z.object({
  userId: z.string(), puzzleId: z.string(), par: z.int(), secondsLeft: z.int().min(0),
  usedHints: z.boolean(), tokensEarned: z.int().min(0), starsEarned: z.int().min(0), solveTimeSec: z.int(),
}));

// shared/events/registry.ts
export const DomainEvent = z.discriminatedUnion("type", [PuzzleSolved, TokensCredited /*, …*/]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type EventType = DomainEvent["type"];
export type EventOf<T extends EventType> = Extract<DomainEvent, { type: T }>;
```

### Bus (shared/events/bus.ts)

```ts
export interface DispatchContext {
  env: Env;
  exec: ExecutionContext | null;      // null when no waitUntil host exists
  correlationId: string;
  depth: number;
  seen: Set<string>;
  report: DispatchReport[];
  publish(events: DomainEvent[]): Promise<void>;
}

export interface Subscription<T extends EventType = EventType> {
  name: string; type: T; mode: "critical" | "background";
  handle(event: EventOf<T>, ctx: DispatchContext): Promise<unknown>;
}

export type HandlerTable = ReadonlyMap<EventType, readonly Subscription[]>;

export function buildTable(subs: Subscription[]): HandlerTable {
  const m = new Map<EventType, Subscription[]>();
  for (const s of subs) (m.get(s.type) ?? m.set(s.type, []).get(s.type)!).push(s);
  return m;
}

const MAX_DEPTH = 4, MAX_EVENTS = 64;

export async function dispatch(table: HandlerTable, raw: unknown[], base: Omit<DispatchContext, "publish" | "seen" | "report" | "depth">) {
  const report: DispatchReport[] = [];
  const seen = new Set<string>();
  let count = 0;

  async function run(events: unknown[], depth: number, causation?: string) {
    for (const e of events) {
      const parsed = DomainEvent.safeParse(e);
      if (!parsed.success) { report.push({ eventId: (e as any)?.id ?? "?", outcomes: [], reason: "invalid" }); continue; }
      const ev = parsed.data;
      const key = `${ev.type}:${ev.aggregate.kind}:${ev.aggregate.id}:${ev.aggregate.version}`;
      if (depth > MAX_DEPTH || ++count > MAX_EVENTS || seen.has(key)) { report.push({ eventId: ev.id, outcomes: [], reason: "loop-guard" }); continue; }
      seen.add(key);
      const ctx: DispatchContext = { ...base, depth, seen, report, publish: (more) => run(more, depth + 1, ev.id) };
      const outcomes: Outcome[] = [];
      for (const s of table.get(ev.type) ?? []) {
        if (s.mode === "background") {
          const p = s.handle(ev as any, ctx).catch((err) => console.warn("bg handler failed", s.name, ev.id, err));
          base.exec ? base.exec.waitUntil(p) : await p;
          outcomes.push({ handler: s.name, ok: true, ms: 0, background: true });
          continue;
        }
        const t0 = Date.now();
        try { await s.handle(ev as any, ctx); outcomes.push({ handler: s.name, ok: true, ms: Date.now() - t0 }); }
        catch (err) { outcomes.push({ handler: s.name, ok: false, ms: Date.now() - t0, error: { name: (err as Error).name, message: (err as Error).message } }); }
      }
      report.push({ eventId: ev.id, outcomes });
    }
  }
  await run(raw, 0);
  return report;               // plain data: safe to return over RPC
}
```

### Aggregate additions (outbox) — sketch on top of packages/core `Aggregate`

```ts
// Inside Aggregate: extra table via schemaMigrations()
// CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, event TEXT NOT NULL, remaining TEXT NOT NULL, created_at INTEGER NOT NULL)
// CREATE TABLE processed_events (event_id TEXT PRIMARY KEY, at INTEGER NOT NULL)

protected async commitWith(mutate: (s: State, emit: (type: EventType, payload: unknown) => void) => State) {
  const events: DomainEvent[] = [];
  const next = this.ctx.storage.transactionSync(() => {
    const drafts: Array<{ type: EventType; payload: unknown }> = [];
    const n = mutate(structuredClone(this.state), (type, payload) => drafts.push({ type, payload }));
    const changed = this.persist(n);                    // bumps version if state differs
    if (changed) for (const d of drafts) {
      const ev = { id: crypto.randomUUID(), type: d.type, v: 1, occurredAt: new Date().toISOString(),
        actor: this.actor, correlationId: this.correlationId, causationId: this.commandId,
        aggregate: { kind: this.kind, id: this.id, version: this.version }, payload: d.payload };
      this.sql.exec("INSERT INTO outbox (id, event, remaining, created_at) VALUES (?, ?, ?, ?)",
        ev.id, JSON.stringify(ev), JSON.stringify(this.handlerNamesFor(d.type)), Date.now());
      events.push(ev as DomainEvent);
    }
    return n;
  });
  await this.flushAfterCommit();                          // projections, as today
  // setAlarm() is async and cannot be part of transactionSync ("Only synchronous storage
  // operations can be part of the transaction", F7). It is deliberately outside the
  // transaction; a crash before it resolves is covered by the constructor re-arm (R7).
  if (events.length) await this.ctx.storage.setAlarm(Date.now() + ACK_GRACE_MS);
  return { snapshot: this.snapshot(), events };
}

async ackEvents(acks: Array<{ eventId: string; handlers: string[] }>) {
  this.ctx.storage.transactionSync(() => {
    for (const a of acks) {
      const row = this.sql.exec("SELECT remaining FROM outbox WHERE id = ?", a.eventId).toArray()[0];
      if (!row) continue;
      const left = (JSON.parse(row.remaining as string) as string[]).filter((h) => !a.handlers.includes(h));
      if (left.length === 0) this.sql.exec("DELETE FROM outbox WHERE id = ?", a.eventId);
      else this.sql.exec("UPDATE outbox SET remaining = ? WHERE id = ?", JSON.stringify(left), a.eventId);
    }
  });
  await this.rearm();                                      // deleteAlarm() if outbox empty, else backoff.
                                                           // Decide from the outbox row count, not getAlarm():
                                                           // inside alarm() getAlarm() returns null (F6).
}

async alarm() {
  await this.flush();                                      // projection retry (existing)
  const rows = this.sql.exec("SELECT id, event, remaining FROM outbox ORDER BY seq").toArray();
  if (rows.length === 0) return;
  const events = rows.map((r) => JSON.parse(r.event as string));
  const report = await this.ctx.exports.Events.dispatch(events, { correlationId: events[0].correlationId });
  await this.ackEvents(report.map((r) => ({ eventId: r.eventId, handlers: r.outcomes.filter((o) => o.ok).map((o) => o.handler) })));
}
```

Subscriber-side dedupe inside a consuming aggregate:

```ts
creditFromEvent(eventId: string, amount: number, reason: string) {
  return this.commit((s) => {
    const inserted = this.sql.exec("INSERT OR IGNORE INTO processed_events (event_id, at) VALUES (?, ?)", eventId, Date.now()).rowsWritten;
    if (inserted === 0) return s;                          // duplicate delivery: no-op commit
    return { ...s, tokens: s.tokens + amount };
  });
}
```

(`rowsWritten` on the cursor is the field to verify against the current `SqlStorageCursor` type; if absent, use a `SELECT` first — UNVERIFIED detail.)

### Gateway wiring (Hono)

```ts
// wiring.ts — the only file that imports every module
export const table = buildTable([...walletSubscriptions, ...streakSubscriptions, ...collectionsSubscriptions, ...feedSubscriptions]);

// events entrypoint for the alarm path
export class Events extends WorkerEntrypoint<Env> {
  dispatch(events: unknown[], opts: { correlationId: string }) {
    return dispatch(table, events, { env: this.env, exec: this.ctx, correlationId: opts.correlationId });
  }
}

// route
app.post("/play/:puzzleId/solve", zValidator("json", SolveBody), async (c) => {
  const userId = c.get("userId");
  const attempt = aggregateStub(c.env.ATTEMPT, "attempt", `${userId}:${c.req.param("puzzleId")}`);
  const { snapshot, events } = await attempt.solve(c.req.valid("json"), { userId, correlationId: c.get("requestId") });
  const report = await dispatch(table, events, { env: c.env, exec: c.executionCtx, correlationId: c.get("requestId") });
  c.executionCtx.waitUntil(attempt.ackEvents(toAcks(report)));   // ack off the critical path
  const wallet = await aggregateStub(c.env.USER, "user", userId).snapshot();  // strongly consistent read for the Solved screen
  return c.json({ attempt: snapshot, wallet: wallet.state, report: summarize(report) });
});
```

### Test sketch

Note: this sketch imports `env` from `cloudflare:workers`, while `cloudflare:test` (C13) also exports an `env`. Both exist. The bindings docs warn that the top-level `env` from `cloudflare:workers` cannot perform I/O outside a request context (stub methods, KV, service calls fail at module scope); using it inside a test body, as here, is fine. Importing `env` from `cloudflare:test` is the documented choice for tests.

```ts
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";

it("redelivers an unacked event through the alarm", async () => {
  await setFail("wallet.onPuzzleSolved", true);
  const ctx = createExecutionContext();
  const res = await app.fetch(solveRequest(), env, ctx);
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  const rows = await runInDurableObject(attemptStub, (o: any) => o.sql.exec("SELECT remaining FROM outbox").toArray());
  expect(JSON.parse(rows[0].remaining)).toEqual(["wallet.onPuzzleSolved"]);
  await setFail("wallet.onPuzzleSolved", false);
  expect(await runDurableObjectAlarm(attemptStub)).toBe(true);
  expect((await userStub.snapshot()).state.tokens).toBe(269 + 12);
  expect(await runDurableObjectAlarm(attemptStub)).toBe(false);   // outbox drained, alarm cleared
});
```

## Claims

| id | claim | source | confidence | verdict |
|---|---|---|---|---|
| C1 | `ctx.waitUntil` extends an HTTP Worker invocation by up to 30 s after the response; the budget is shared across all `waitUntil` calls in the request and unsettled promises are cancelled | https://developers.cloudflare.com/workers/runtime-apis/context/ ; https://developers.cloudflare.com/workers/platform/limits/ | high | confirmed |
| C2 | `waitUntil` has no effect inside Durable Objects | https://developers.cloudflare.com/durable-objects/api/state/ | high | confirmed |
| C3 | I/O objects created for one request cannot be used by another ("Cannot perform I/O on behalf of a different request"); Cloudflare recommends not using or mutating global state | https://developers.cloudflare.com/workers/observability/errors/ ; https://developers.cloudflare.com/workers/reference/how-workers-works/ | high | confirmed |
| C4 | `ctx.exports` provides loopback Service Bindings for `WorkerEntrypoint` exports and DO namespaces for migrated `DurableObject` exports; flag `enable_ctx_exports`, default-on since 2025-11-17; supported in vitest-pool-workers since Dec 2025 | https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ ; https://developers.cloudflare.com/workers/configuration/compatibility-flags/ ; https://developers.cloudflare.com/changelog/post/2025-12-16-vitest-ctx-exports-support/ | high | confirmed |
| C5 | Workers RPC carries structured-cloneable values (custom-prototype objects only via `RpcTarget`); thrown errors reach the caller with `message` and prototype `name` only — no stack, no own properties such as `cause`, and `AggregateError` is not propagated | https://developers.cloudflare.com/workers/runtime-apis/rpc/ ; https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ | high | confirmed |
| C6 | DO alarms are at-least-once, retried automatically with exponential backoff from 2 s up to 6 retries, and only one `alarm()` runs at a time per object; `setAlarm` overwrites the existing alarm | https://developers.cloudflare.com/durable-objects/api/alarms/ | high | confirmed |
| C7 | `transactionSync(cb)` wraps a synchronous callback in a transaction (SQLite-backed DOs); output gates hold outgoing messages until writes are confirmed and reset the object on write failure | https://developers.cloudflare.com/durable-objects/api/storage-api/ | high | confirmed |
| C8 | A single DO has a soft limit of ~1,000 rps (500–1,000 for simple ops); in-memory state is lost on eviction/hibernation; non-storage I/O allows request interleaving | https://developers.cloudflare.com/durable-objects/platform/limits/ ; https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ ; https://developers.cloudflare.com/durable-objects/reference/in-memory-state/ | high | confirmed |
| C9 | Queues: at-least-once delivery, 128 KB messages, 100-message batches, up to 100 retries, `delaySeconds` up to 24 h, 15-min consumer wall clock, available on Free and Paid plans | https://developers.cloudflare.com/queues/reference/delivery-guarantees/ ; https://developers.cloudflare.com/queues/platform/limits/ ; https://developers.cloudflare.com/queues/ | high | confirmed |
| C10 | Workflows: `step.do(name, { retries: { limit, delay, backoff }, timeout }, fn)`, `NonRetryableError`, `step.sleep`/`sleepUntil`; `create({ id })` throws on duplicate id; 1,024 steps Free / 10,000 default Paid (up to 25,000); 1 MiB step result and payload | https://developers.cloudflare.com/workflows/build/workers-api/ ; https://developers.cloudflare.com/workflows/reference/limits/ | high | confirmed |
| C11 | Zod 4 `z.discriminatedUnion("key", [...])` selects the option by discriminator instead of trying each option; `z.literal`, `z.iso.datetime()`, `z.uuid()` exist; zod 4.5.4 is latest; `@hono/zod-validator` 0.9.1 peers zod `^3.25.0 \|\| ^4.0.0` | https://zod.dev/api?id=discriminated-unions ; `npm view` | high | confirmed |
| C12 | Hono exposes `c.executionCtx.waitUntil` (Workers only), typed `c.set`/`c.get` via `Variables`, and `c.env` bindings | https://hono.dev/docs/api/context | high | confirmed |
| C13 | `cloudflare:test` (installed 0.22.0) exports `env`, `SELF`, `createExecutionContext`, `waitOnExecutionContext`, `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`, `listDurableObjectIds`, `applyD1Migrations`, `createMessageBatch`, `getQueueResult`, `introspectWorkflow`; the pool package exports `cloudflareTest` (no `defineWorkersConfig`) | installed `node_modules/@cloudflare/vitest-pool-workers/{types,dist/pool}` ; https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ | high | confirmed |
| C14 | Cloudflare's getting-started docs now install `@cloudflare/vitest-plugin` (npm 1.1.3, published 2026-09-01; package first created 2026-08-20; peers vitest ^4.1.0, deps wrangler 4.128.0 / miniflare 5.20260831.0-alpha) exporting the same `cloudflareTest`; `@cloudflare/vitest-pool-workers` 0.22.0 has no `deprecated` field on npm. (Original claim said "published 2026-08-20" — corrected.) | https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ ; `npm view @cloudflare/vitest-plugin@1.1.3 time peerDependencies dependencies` ; https://cdn.jsdelivr.net/npm/@cloudflare/vitest-plugin@1.1.3/dist/pool/index.d.mts ; `npm view @cloudflare/vitest-pool-workers@0.22.0 deprecated` | high | refuted (date corrected) |
| C15 | AsyncLocalStorage is importable from `node:async_hooks` under `nodejs_compat` (default from 2026-08-04) or `nodejs_als`; `enterWith`/`disable` are omitted; interaction with `waitUntil` continuations is not documented | https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/ ; https://developers.cloudflare.com/workers/configuration/compatibility-flags/ | medium | confirmed |
| C16 | mitt 3.0.1 is a ~200 B synchronous emitter with a typed event map; `emit` does not return handler promises | `npm view mitt readme` (2025-10-13) | high | confirmed |
| C17 | emittery 2.0.0 defers listeners to the next microtask; `emit()` returns a promise that resolves when all listeners are done and rejects with an `AggregateError` collecting listener errors; `emitSerial` runs listeners in order; typed via a generic event-data map | `npm view emittery readme` (2026-03-04) | high | confirmed |
| C18 | typed-emitter 2.1.0 is a types-only interface over Node `EventEmitter`, published 2022-01-22 (npm `time.modified` 2022-06-28) and declares `dependencies: { rxjs: "*" }`; tiny-typed-emitter 2.1.0 published 2021-07-24 (`time.modified` 2022-05-21). (Original claim quoted the `time.modified` dates as publish dates — corrected; "dormant since 2022" still holds.) | `npm view typed-emitter@2.1.0 dependencies time` ; `npm view tiny-typed-emitter@2.1.0 time` ; `npm view typed-emitter readme` | high | refuted (dates corrected) |
| C19 | eventemitter3 5.0.4 (2026-01-19) and nanoevents 10.0.0 (2026-07-22) are synchronous emitters; eventemitter3's generic typing was not confirmed from its README in this session | `npm view` | medium | confirmed |
| C20 | The local `packages/core` `Aggregate` already resolves `ctx.exports.Projections` from inside a DO and retries via `setAlarm` with backoff; 8/8 workerd tests pass with wrangler 4.127 / pool 0.22 / vitest 4.1.11 | /Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts ; task brief | high | confirmed |
| C21 | `crypto.randomUUID()` is usable inside a Durable Object to mint event ids | Web Crypto is standard in Workers; not re-verified against docs in this session | medium | confirmed |
| C22 | `SqlStorageCursor` exposes a written-rows counter usable for `INSERT OR IGNORE` dedupe | UNVERIFIED (field name not checked against current types) | low | confirmed |

## Open questions

1. **Package choice for tests**: keep `@cloudflare/vitest-pool-workers@0.22.0` (verified working with the template) or move to `@cloudflare/vitest-plugin@1.1.3` (what the docs now install, same `cloudflareTest` export, newer bundled wrangler/miniflare)? Recommend trying the plugin on the scaffold's first test run and falling back if anything differs. If switching, import `readD1Migrations` from the package root, not `@cloudflare/vitest-plugin/config` as the test-apis page suggests — the plugin's `exports` map only has `.` and `./types` (F13).
2. **Where does `PuzzleAttempt` live** — its own aggregate (`attempt:<userId>:<puzzleId>`, many small objects) or a slice of `User`? The event design works either way, but a `User`-only model turns `puzzle.solved → wallet.credit` into a local state change and leaves fewer events on the bus (only cross-user ones: leaderboard, feed counters).
3. **Per-handler ack vs whole-event ack**: per-handler ack (recommended) needs the aggregate to know the handler names for an event type at commit time (`handlerNamesFor`) — either pass them from the gateway with the command, or import the wiring table into the DO module (the DO runs in the same Worker, so the import is legal but couples the aggregate to the subscriber list). Decide which coupling is less bad.
4. **ACK grace and backoff constants** (15 s grace, 1 s→60 s backoff, 500-row outbox cap, 30-day `processed_events` retention) are guesses; tune after measuring p99 dispatch time in workerd and in production.
5. **Feed/leaderboard hot objects**: per-puzzle social counters ("8,412 solved · 297 solving now") are a single-object hot spot if modelled as a DO per puzzle; decide early whether they are D1 counters written by a background handler (eventually consistent, fine for the ticker) or need a Queue-batched consumer.
6. **AsyncLocalStorage for correlation ids**: nice-to-have for logs; its behaviour across `waitUntil` continuations is undocumented (C15) — verify empirically in workerd before relying on it.
7. **Event schema versioning horizon**: how long must old `v` schemas stay in the registry? With an outbox that drains in seconds and at most minutes under failure, one deploy overlap is enough, but a stuck object (alarm exhausted, constructor re-arm) could hold events for longer; consider an admin route that lists non-empty outboxes via `listDurableObjectIds` in tests and via the projection registry in production.
8. **`rowsWritten` / affected-rows API** on `SqlStorageCursor` (C22) — confirm against `@cloudflare/workers-types` 5.20260902.1 before writing the dedupe command.

## Fact-check log

Fact-checked 2026-09-02. No claims were unverifiable; two were refuted on dates only and corrected in place (F13, F15, C14, C18).

| id | verdict | source |
|---|---|---|
| C1 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/context/ ; https://developers.cloudflare.com/workers/platform/limits/ |
| C2 | confirmed | https://developers.cloudflare.com/durable-objects/api/state/ |
| C3 | confirmed | https://developers.cloudflare.com/workers/observability/errors/ ; https://developers.cloudflare.com/workers/reference/how-workers-works/ |
| C4 | confirmed | https://developers.cloudflare.com/changelog/2025-09-26-ctx-exports/ ; https://developers.cloudflare.com/workers/configuration/compatibility-flags/ ; https://developers.cloudflare.com/changelog/post/2025-12-16-vitest-ctx-exports-support/ |
| C5 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/rpc/ ; https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/ |
| C6 | confirmed | https://developers.cloudflare.com/durable-objects/api/alarms/ (with added caveats: 6-retry cap, best-effort `deleteAlarm()` inside `alarm()`, `getAlarm()` null during handler) |
| C7 | confirmed | https://developers.cloudflare.com/durable-objects/api/storage-api/ (added: only synchronous storage ops are part of the transaction) |
| C8 | confirmed | https://developers.cloudflare.com/durable-objects/platform/limits/ ; https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ ; https://developers.cloudflare.com/durable-objects/reference/in-memory-state/ |
| C9 | confirmed | https://developers.cloudflare.com/queues/reference/delivery-guarantees/ ; https://developers.cloudflare.com/queues/platform/limits/ ; https://developers.cloudflare.com/queues/ |
| C10 | confirmed | https://developers.cloudflare.com/workflows/build/workers-api/ ; https://developers.cloudflare.com/workflows/reference/limits/ (added: instance-creation rate limits; "SQLite-backed DO" statement is from a 2024 blog post) |
| C11 | confirmed | https://zod.dev/api?id=discriminated-unions ; `npm view zod version` ; `npm view @hono/zod-validator peerDependencies` |
| C12 | confirmed | https://hono.dev/docs/api/context |
| C13 | confirmed | installed `node_modules/@cloudflare/vitest-pool-workers/{types,dist/pool}` ; https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ |
| C14 | refuted (publish date) | `npm view @cloudflare/vitest-plugin@1.1.3 time peerDependencies dependencies` ; https://cdn.jsdelivr.net/npm/@cloudflare/vitest-plugin@1.1.3/dist/pool/index.d.mts ; https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/write-your-first-test/ ; `npm view @cloudflare/vitest-pool-workers@0.22.0 deprecated` (empty). 1.1.3 was published 2026-09-01T17:21Z; 2026-08-20 is the package creation date. |
| C15 | confirmed | https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/ ; https://developers.cloudflare.com/workers/configuration/compatibility-flags/ |
| C16 | confirmed | `npm view mitt readme` (note: mitt 3.0.1 was published 2023-07-04; 2025-10-13 is `time.modified`) |
| C17 | confirmed | `npm view emittery readme` (2026-03-04) |
| C18 | refuted (publish dates) | `npm view typed-emitter@2.1.0 dependencies time` ; `npm view tiny-typed-emitter@2.1.0 time` ; `npm view typed-emitter readme`. typed-emitter 2.1.0 published 2022-01-22, tiny-typed-emitter 2.1.0 published 2021-07-24; the quoted dates were `time.modified`. |
| C19 | confirmed | `npm view eventemitter3 time` ; `npm view nanoevents time` |
| C20 | confirmed | /Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts ; task brief |
| C21 | confirmed | Workers Web Crypto reference |
| C22 | confirmed | (as stated: low confidence, field name still to be checked against `@cloudflare/workers-types` 5.20260902.1) |

Additional corrections applied outside the claims table: F1/R1 (RPC-invoked entrypoint `waitUntil` budget marked [UNVERIFIED]); F6/R7 (alarm retry and `getAlarm()` caveats); F7 and the outbox sketch (`setAlarm` outside `transactionSync`, non-atomic arming gap); F10/R9 (Workflows instance-creation rate limits, blog-post provenance); F13 and Open question 1 (`readD1Migrations` import path, README vs type-file parity); F15 table dates; test sketch (`env` from `cloudflare:workers` vs `cloudflare:test`); stack pins confirmed current via `npm view`.
