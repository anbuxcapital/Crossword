## 3. Event bus

### Envelope

Every domain event is a plain JSON object validated by Zod and delivered by the in-process dispatcher:

```typescript
interface Envelope<T extends string, P> {
  id: string;              // uuid v4, minted by the producing aggregate to ensure
                           // deterministic re-delivery: (type, aggregate.id, aggregate.version) → same id
  type: T;                 // "<module>.<pastTenseFact>", e.g. "solve.finished"
  v: 1;                    // payload schema version for evolution
  occurredAt: string;      // ISO 8601 timestamp (z.iso.datetime() seconds required)
  actor: {kind:"user", userId:string} | {kind:"system", reason:string};
  correlationId: string;   // per inbound HTTP request; alarm redelivery reuses it
  causationId: string;     // event or command id that triggered this (tracing, cycle detection)
  aggregate: {
    kind: string;          // "user", "puzzle_stats"
    id: string;            // user id, puzzle id, etc.
    version: number;       // aggregate version at commit; subscribers use for de-dup when id table pruned
  };
  payload: P;              // domain-specific fields; plain JSON only (structured-clone-safe over RPC)
}
```

### Registry and defineEvent()

**[DECIDED HERE]** Each module's `contract.ts` exports `defineEvent(type, v, payloadSchema)` returning a Zod object schema. The composition root (`app/wiring.ts`) composes all of them into a single discriminated union, validated on every dispatch:

```typescript
// modules/<m>/contract.ts
export const SolveFinished = defineEvent("solve.finished", 1, z.strictObject({
  userId: z.string(),
  puzzleId: z.string(),
  solveId: z.string(),
  lang: z.string(),
  dropDate: z.string(),
  solveTimeMs: z.int().min(0),
  secLeft: z.int().min(0),
  par: z.int(),
  hintsUsed: z.int().min(0),
  firstSolve: z.boolean(),
  suspicious: z.boolean(),
  tokensEarned: z.int().min(0),
  starsEarned: z.int().min(0),
  dayKey: z.string(),
  streak: z.int().min(0),
  streakExtended: z.boolean(),
}));

// app/wiring.ts
export const DomainEvent = z.discriminatedUnion("type", [
  SolveFinished, CollectionsCompleted, SocialLikeToggled, /* ... all 18 events */
]);
export type DomainEvent = z.infer<typeof DomainEvent>;
export type EventOf<T extends DomainEvent["type"]> = Extract<DomainEvent, {type: T}>;
```

### Subscriptions and handlers

**[DECIDED HERE]** A subscriber is a handler that reacts to an event published by another module. Handlers are registered once at module evaluation in the composition root:

```typescript
interface Subscription<T extends DomainEvent["type"] = any> {
  name: string;              // "collections.onSolveFinished" — stable, used for per-handler ack
  type: T;                   // the event type this handler consumes
  mode: "critical" | "background";  // delivery semantics
  handle(event: EventOf<T>, ctx: DispatchContext): Promise<void | any>;
}

interface DispatchContext {
  env: Env;                  // wrangler bindings
  exec: ExecutionContext | null;   // null when running from a DO alarm; needed for ctx.exec.waitUntil
  actor: {kind:"user", userId:string} | {kind:"system", reason:string};
  correlationId: string;
  now: () => Date;           // injected clock
  depth: number;             // event causation depth (loop guard)
  seen: Set<string>;         // `type:aggregate.kind:aggregate.id:aggregate.version` per request
  publish(events: DomainEvent[]): Promise<void>;  // emit follow-on events
}

type HandlerTable = ReadonlyMap<DomainEvent["type"], readonly Subscription[]>;
```

### Dispatch algorithm

**[DECIDED HERE]** The gateway calls `dispatch(table, events[], ctx)` immediately after a command commits. Ordering and error semantics are:

1. **Validate** each event: `DomainEvent.safeParse()` rejects parse failures (logged, acked to avoid loops).
2. **Critical handlers**: iterate in registration order (wiring order is an API); await each handler; wrap in try/catch; one failure never blocks the next; record outcomes.
3. **Background handlers**: wrap each in `ctx.exec.waitUntil(p.catch(log))` if `ctx.exec` exists (no-op in DO alarms; recovers via alarm-path dispatch instead).
4. **Follow-on events** (if a handler calls `ctx.publish(events)`): dispatch with `depth + 1`, `causationId = parent.id`. Guards: `MAX_DEPTH = 4`, `MAX_EVENTS_PER_REQUEST = 64`, per-request `seen` set prevents re-entrancy of exact same fact.
5. **Ack**: after critical handlers, the gateway calls `stub.ackEvents([{eventId, handlers: [successful names]}])` to delete outbox rows for handlers that succeeded. Rows with `remaining` handlers stay armed for retry.

Response status is still 200 if the command committed and handlers failed; command failure (`DomainError`) is distinct and maps to 422.

### DispatchReport

```typescript
interface DispatchReport {
  eventId: string;
  outcomes: Array<{handler: string; ok: boolean; ms: number; error?: {name, message}}>;
  reason?: "invalid" | "loop-guard";  // if validation or depth/count guard triggered
}
```

The HTTP response surface: only successful critical handler names (so clients know "yes, collection was claimed") and failed handler names are logged. Background handler results are not returned.

### Idempotency per handler kind

**[DECIDED HERE]** Every handler must be idempotent on `event.id`:

- **Aggregate commands**: the command itself already de-dupes on `(userId, eventId)` via `processed_events` table checked in `transactionSync` before state changes; `INSERT OR IGNORE` on the processed id; if already seen, return snapshot without mutation.
- **D1 projection writes** (leaderboard rows, social counters): use event id as a natural key in the write (`INSERT OR IGNORE INTO leaderboard_week(event_id, …)`) or a version guard.
- **No money depends on events**. Tokens, stars, and streak changes are inside `User.finishSolve()` or `collections.claimCollection()`, not triggered by events; the event carries already-computed amounts and subscribers only update read models or trigger follow-on events.

### Failure semantics (v1 reconciliation model)

**[DECIDED HERE]** The outbox is a recovery queue, not an event log. It lives in the producing aggregate's SQLite, written atomically with state in one `transactionSync`:

| Failure point | Effect | Recovery | Data loss |
|---|---|---|---|
| Before command commits | nothing | client retries | no |
| After commit, before dispatch | outbox rows exist | aggregate alarm re-delivers through `Events` entrypoint | no |
| During critical dispatch | handlers idempotent on event id | redelivery to all; done ones dedupe | no |
| Handler failure | recorded in report; not acked | alarm retries that handler only (per-handler ack) | no |
| Alarm exhausts 6 retries | handler permanently failed | client `POST /v1/me/reconcile` manually re-drives from User snapshot | no (reconcile is idempotent) |

**Upgrade path (v1 → v2)**: when a background handler becomes money-relevant (e.g., push notifications affect retention metrics used to unlock rewards) or measured loss exceeds tolerance, adopt a DO outbox table with ack-per-handler and alarm-based redelivery. Trigger: a handler in `subscriptions.ts` that calls a rate-limited third party (Expo push, email, RevenueCat) and must survive independently of the request; use Cloudflare Queues or Workflows instead of expanding the event bus.

### Full event catalog (from glossary section 4)

| Type | Payload fields | Producer | Critical subscribers | Background subscribers |
|---|---|---|---|---|
| `identity.userBootstrapped` | userId, installId, platform, appVersion | identity | — | analytics |
| `player.onboarded` | userId, level, topics, lang, plan, notifications, tz | player | — | notifications.scheduleReminderOptIn |
| `player.prefsChanged` | userId, lang?, topics?, tz? | player | — | feed cache bust |
| `solve.started` | userId, puzzleId, solveId, at | solving | — | social.heartbeat (background) |
| `solve.paused` | userId, puzzleId, solveId, at | solving | — | social.leave (background) |
| `solve.resumed` | userId, puzzleId, solveId, at | solving | — | social.heartbeat (background) |
| `solve.hintUsed` | userId, solveId, puzzleId, kind, cost, balance | solving | — | analytics |
| `solve.finished` | userId, puzzleId, solveId, lang, dropDate, solveTimeMs, secLeft, par, hintsUsed, firstSolve, suspicious, tokensEarned, starsEarned, dayKey, streak, streakExtended | solving | collections.checkAndClaim → social.recordSolve | notifications.cancelReminder, analytics |
| `collections.completed` | userId, collectionId, reward, eventRef | collections | collections.unlockDependants | notifications (background) |
| `collections.unlocked` | userId, collectionId | collections | — | feed cache bust |
| `economy.wheelSpun` | userId, wheelId, prizeIndex, prize, balance | economy | — | analytics |
| `economy.packPurchased` | userId, packId, tokens, purchaseId, mocked | economy | — | analytics |
| `economy.planChanged` | userId, plan, expiresAt, purchaseId, mocked | economy | — | analytics |
| `social.likeToggled` | userId, puzzleId, liked | social | social.adjustLikes (PuzzleStats) (critical) | — |
| `social.saveToggled` | userId, puzzleId, saved | social | — | — |

### Module extraction (moving a module to its own Worker)

**[DECIDED HERE]** Because payloads are already `structured-clone`-safe and handlers are thin adapters of commands, extracting a module is mechanical:

1. Create `modules/<name>/entrypoint.ts` as a `WorkerEntrypoint` that re-exports the module's public API, one method per line.
2. Update `wrangler.jsonc`: add the module's Durable Object namespace bindings with `script_name`, add a service binding (`services: [{binding, service, entrypoint}]`), require `compatibility_flags: ["enable_ctx_exports"]`.
3. In `app/modules.ts`, swap the in-process call from `bind(moduleName, ctx)` to `ctx.env.BINDING`.
4. Event subscriptions: for modules still in the gateway, dispatch in-process; for extracted modules, forward events over the service binding or upgrade one subscription to a Queue consumer (if rates or third-party latency demand it).

Caller code is unchanged; the adapter layer (`RpcSafe` type and port pattern) ensures no leakage of RPC details.

### Tests the events module must ship

The `events/` folder has no business logic, only mechanics. Tests cover:

1. **Ordering invariant**: dispatch handler table from `wiring.ts`, emit a sequence of events with inter-dependencies, assert critical handlers run in registration order and follow-on events are queued in depth-first order.
2. **Error isolation**: one critical handler throws; assert the next handler still runs, report documents both, ack omits the failed one.
3. **Loop guard**: emit an event that triggers a follow-on at depth 4; depth 5 is rejected (reason: "loop-guard"); per-request count cap of 64 is tested likewise.
4. **Validation failure**: parse a malformed event; assert it is logged, acked (not retried), report records reason: "invalid".
5. **Background handlers and `ctx.exec.waitUntil`**: use `createExecutionContext` and `waitOnExecutionContext` to assert background promises settle correctly.
6. **Idempotency**: deliver the same envelope twice; assert deduplication works if a subscriber aggregate exists (this is an integration test run through the Hono app, not a unit test of `dispatch()` alone).

---

**Summary: 18 events, 7 producing modules, typed in-process dispatcher, critical-then-background delivery model, per-handler ack, outbox-based recovery, reconcile-driven v1 healing. Extracted modules re-use identical payloads over RPC.**
