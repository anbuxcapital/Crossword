# Token/star ledger storage, purchase idempotency and DO↔D1 economy reconciliation

Slug: `gap-wallet-ledger-and-idempotency` · researched 2026-09-02 · status: proposal for M3 (economy endpoints, Wallet screen)

Inputs read: design handoff README (§14 Wallet, §Interactions "Fortune wheel", §13 Solved earnings card), `prototype-logic.js` (L137 solve rewards, L183-195 `spinWheel`/`spendTokens`, L434-437 packs), `concepts.md` §3/§5/§12, `core-package.md`, `packages/core/src/{aggregate,projections}.ts` + `test/aggregate.test.ts`, `docs/research/README.md` §Domain model / §API surface (economy table) / §Risks, `durable-objects-d1-domain.md` F1-F8, R2, R3, R13, `domain-spec-extraction.md` event catalogue (`tokens.granted/spent`, `stars.granted` → "ledger (sync)"), `in-process-event-bus.md` R6, `identity-auth-v1.md` (`tokenVersion`, merge).

---

## Summary

1. **The gap is real and blocks M3.** `GET /wallet` promises `ledger:[{at,delta,kind,reason,ref}]` and `POST /wallet/purchases` promises a `ledgerEntry`, but the consolidated `UserState` only has `wallet:{tokens,stars}` and a bare `ledgerSeq`; the `wallet_ledger` D1 table from the event catalogue was dropped; `creditPurchase(purchaseId)` / `spinWheel({ idempotencyKey })` have nowhere to remember a key; and `POST /me/reconcile` only re-drives fan-out. Nothing today can answer "why is my balance 269?" or safely absorb a retried purchase.

2. **Decision (1) — where entries live: a `ledger` table inside the `User` Durable Object, written in the same `transactionSync` as the state row; D1 `economy_ledger` is a derived, rebuildable fact table fed by the projection flush; no ledger ring inside `UserState`.** SQLite-backed objects give a real relational table with indexes, `transactionSync` rolls the whole commit back on throw, and per-object storage is 10 GB with a 2 MB per-row cap — a 150-byte ledger row is nothing, whereas every entry kept in the JSON snapshot is `structuredClone`d and re-serialised on every commit and pushed to D1 on every flush (F1, F3, F4). The DO table is pruned to the newest 1,000 rows behind a **checkpoint row** (balances at the prune boundary), so the invariant `wallet = checkpoint + Σ delta(seq > checkpoint.seq)` survives truncation. Pending rows reach D1 through a `ledger_projected_seq` watermark — the same "version > projected is the outbox" idea the core already uses — attached to the existing flush and inserted with `INSERT OR IGNORE` on `(user_id, seq)`, so alarm retries and `reproject()` can never duplicate a fact (F5, F6, F7).

3. **Decision (2) — idempotency: a second in-object table `idempotency(key, op, request_hash, result, created_at)`,** written in the same transaction as the ledger row and the state. Keys are namespaced (`purchase:<purchaseId>`, `wheel:<wheelId>:<idempotencyKey>`, `hint:<sessionId>:<idempotencyKey>`, `claim:<collectionId>`). A duplicate with the same request hash returns the **stored result** (`replayed: true`, original `ledgerEntry`, *current* balances) without a commit; the same key with different parameters is `DomainError("IDEMPOTENCY_MISMATCH")` → 409 (Stripe's rule, F9). Purchase keys are kept forever (they are also the D1 `economy_purchases` primary key); other keys are pruned after 30 days by the commit that inserts, at most once per local day.

4. **Decision (3) — invariant and repair:** `User.verifyLedger()` (pure read, one DO hop) recomputes `expected = checkpoint + Σ delta` per kind, checks the per-kind running-balance chain and `ledgerSeq === MAX(seq)`, and returns drift. `User.repairLedger({ trust: "ledger" | "state", now })` either rewrites `wallet` to the ledger total (audit note in `ledger_meta`) or appends signed `adjust` entries so the ledger meets the wallet — history is never edited. An admin route `POST /admin/users/:id/economy/audit` additionally cross-checks D1 facts (`player_solves`, `economy_purchases`, claimed collections, `economy_ledger` row counts) and only *reports* drift, because D1 is derived. `POST /me/reconcile` gains a `ledger` step (re-flush pending rows, verify).

5. **Decision (4) — receipts later:** `economy_purchases` becomes `id = "<provider>:<external transaction id>"` (`mock:<idempotencyKey>` in v1, `revenuecat:<transaction_id>` later, `apple:<transactionId>` if App Store Server Notifications are ever consumed directly) plus `provider`, `provider_event_id`, `product_id`, `pack_id`, `tokens`, `price`, `currency`, `store`, `environment`, `status`, `ledger_seq`, `raw_json`. The ledger entry shape is unchanged: `reason: "purchase" | "refund"`, `ref = purchaseId`. RevenueCat's consumable event is `NON_RENEWING_PURCHASE` (their own sample product is literally `"2100_tokens"`), refunds arrive as `CANCELLATION`, and they retry up to 5 times with the same `event.id`, so the route must be idempotent — which `creditPurchase` already is by `purchaseId` (F10, F11).

6. **Decisions (5) and (6)** — exact Zod 4 schemas for `/wallet`, `/wallet/purchases`, `/wheel/:id/spin` and the `LedgerEntry` DTO are in *Code sketches*; six workerd tests (hint debit + ledger row atomic, duplicate purchase credits once, prune keeps the invariant, failed flush + alarm never duplicates D1 facts, mismatch → 409, repair) are sketched with `cloudflare:test` helpers (F8).

7. **Core changes needed (adds to R13):** (5) `commitTx(mutate)` — `commit` variant that runs `#persist` **and** subclass side-effect statements inside one `transactionSync`, restoring in-memory state if the transaction throws; (6) `flush()` passes an `attachments` value (from an overridable `flushAttachments()`) to `Projections.apply(..., force, attachments)` and calls `onFlushed(attachments)` on success; (7) `ProjectionDef.extra(state, meta, attachments)` returns statements batched atomically with the upsert (this is R13.2 with an extra argument).

Everything below marked **UNVERIFIED** could not be read from a primary source today; the *Claims* table carries confidence per statement.

---

## Findings

### F1. SQLite-backed DO storage: tables, transactions, write coalescing
- `ctx.storage.sql.exec(query, ...bindings)` returns a `SqlStorageCursor` with `next()`, `toArray()`, `one()` ("returns single row or throws if zero/multiple rows"), `raw()`, and properties `columnNames`, `rowsRead`, `rowsWritten`; multiple semicolon-separated statements are allowed (bindings apply to the last). `ctx.storage.sql.databaseSize` is "The current SQLite database size in bytes." Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- `transactionSync(callback)`: "Invokes `callback()` wrapped in a transaction, and returns its result." "If `callback()` throws an exception, the transaction will be rolled back." The callback must be synchronous. `sql.exec()` "cannot execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`." Source: same page. Installed typings agree: `transactionSync<T>(closure: () => T): T` (`@cloudflare/workers-types` 5.20260901.1, `index.d.ts` L778).
- Write coalescing: "If you invoke `put()` (or `delete()`) multiple times without performing any `await` in the meantime, the operations will automatically be combined and submitted atomically." The state page adds: "SQLite storage operations are synchronous and do not yield the event loop, so they execute atomically" and "Output gates hold outgoing network messages until pending storage writes complete". Sources: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ , https://developers.cloudflare.com/durable-objects/api/state/ , https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Consequence: the base class's single synchronous `UPDATE aggregate …` plus our `INSERT INTO ledger …` and `INSERT INTO idempotency …` with no `await` between them would already be atomic by coalescing; wrapping them in `transactionSync` makes the rollback-on-throw explicit and lets a `CHECK`/`UNIQUE` failure in a side table abort the state write too. `waitUntil` "has no effect in Durable Objects" (state page) — nothing in the commit path may rely on it.
- The synchronous KV API (`ctx.storage.kv`) stores in a hidden `__cf_kv` table and is billed as rows read/written like SQL — no reason to use it for the ledger. Source: sqlite-storage-api page.
- Point-in-time recovery exists for SQLite-backed objects ("restore … to any point in the past 30 days") and the typings expose `getCurrentBookmark()`, `getBookmarkForTime()`, `onNextSessionRestoreBookmark()` (`index.d.ts` L779-781). Relevant to repair: a PITR restore of one user object can reintroduce drift between the DO and D1 facts — which is exactly what the audit route detects. Sources: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ (PITR sentence), installed typings.

### F2. Best-practice guidance on storage layout
- "SQLite storage is the recommended storage backend for new Durable Objects. It provides a familiar SQL API for relational queries, indexes, transactions, and better performance than the legacy key-value storage." "Creating new namespaces with the key-value storage backend is no longer supported for accounts without an existing key-value-backed namespace." Sources: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ , https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/
- "Indexes dramatically improve read performance for frequently-filtered columns. The cost is slightly more storage and marginally slower writes." Keep in-memory class properties for caching only ("Lost on eviction or crash"); persist first. Source: rules page.
- Input gates: "Storage operations block new events while executing"; read-modify-write inside a command is safe. Source: rules page. This is why an idempotency check → ledger insert → state write sequence inside one command cannot race with a concurrent retry of the same request: the second request waits behind the first and then sees the stored key.
- The page does not compare "one JSON blob" against tables; the 100 KB snapshot figure in `docs/research/README.md` is a **project rule** (structuredClone + JSON.stringify per commit, JSON pushed to D1 per flush), not a Cloudflare limit. The platform limits are in F3.

### F3. DO limits and costs that bound the design
- SQLite-backed objects: storage per object "10 GB"; per account unlimited (Paid) / "5GB" (Free); "Key and value combined cannot exceed 2 MB"; "Maximum string, BLOB or table row size" "2 MB"; "Maximum number of columns per table" "100"; "Maximum number of rows per table" unlimited; "Maximum SQL statement length" "100 KB"; "Maximum bound parameters per query" "100"; a soft limit of 1,000 requests per second per object; CPU per request 30 s default. Source: https://developers.cloudflare.com/durable-objects/platform/limits/
- Pricing (Paid): rows read "First 25 billion / month included + $0.001 / million rows"; rows written "First 50 million / month included + $1.00 / million rows"; stored data "5 GB-month, + $0.20/ GB-month". Free: 5 M rows read/day, 100,000 rows written/day, 5 GB. `setAlarm()` counts as one row written; deletes are counted as rows written; KV operations are metered as rows. SQLite storage billing was enabled January 2026. Source: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Arithmetic for Crosscut (assumptions from `durable-objects-d1-domain.md` R12): per DAU per day ≈ 1 solve (2-3 ledger rows), 0.5 hints, 1 wheel spin ⇒ ≈ 3.5-4.5 ledger rows + the same number of index rows + 1 idempotency row ≈ 10 DO rows written/DAU/day. 50k DAU ⇒ ≈ 15 M rows/month, inside the 50 M included together with the ≈ 10 M R12 already counts. Storage: a ledger row ≈ 150 B, 1,000 retained rows ≈ 150 KB/user ⇒ 1 M users ≈ 150 GB ⇒ ≈ $29/month at scale; negligible at launch. `GET /wallet` reads ≤ 50 ledger rows + 1 state row per call.

### F4. Why not a ring inside `UserState`
- `Aggregate.commit()` does `structuredClone(state)` then `JSON.stringify` twice (`#persist`: once for the write, once for the equality check) and re-parses; every flush ships the entire JSON to `Projections.apply` and D1 (`packages/core/src/aggregate.ts` L131-133, L246-258). A 50-entry ring at ≈ 130 B/entry is ≈ 6.5 KB copied and serialised on **every** command — including likes and presence-unrelated commits that do not touch the wallet — and every projected row would carry it as a column or be discarded. A table row is written once and read only by `/wallet`.
- A ring also has to answer "what happened before the ring" — it cannot, without a checkpoint, and the checkpoint is exactly the mechanism proposed for the table; so the ring adds cost without removing the need for the invariant machinery.
- The remaining argument for a ring (deliver facts to D1 through `state`) is answered by the watermark attachment in F6 without bloating the snapshot.

### F5. D1 batch atomicity and fact-table idempotency
- `D1Database::batch(statements)`: "If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence." No documented cap on statements per batch; per-statement limits (100 KB, 100 bound parameters) "apply to each individual statement contained within a batch statement." `D1Result.meta` exposes `rows_read`, `rows_written`, `changes`, `last_row_id`. Sources: https://developers.cloudflare.com/d1/worker-api/d1-database/ , https://developers.cloudflare.com/d1/platform/limits/
- `INSERT OR IGNORE`: "the IGNORE resolution algorithm skips the one row that contains the constraint violation and continues processing … No error is returned for uniqueness, NOT NULL, and UNIQUE constraint errors" (but "works like ABORT for foreign key constraint errors"). Source: https://www.sqlite.org/lang_conflict.html — this is SQLite semantics; D1's SQL page lists FTS5/JSON/math extensions and PRAGMAs but "makes no mention" of `INSERT OR IGNORE`, UPSERT or `RETURNING` (https://developers.cloudflare.com/d1/sql-api/sql-statements/). The consolidated README already accepts this as U1 for `player_solves`; the ledger adds no new dependency beyond it. Production smoke test at M6 covers both.
- Consequence: the projection batch `[versionedUpsert(player_state), INSERT OR IGNORE player_solves…, INSERT OR IGNORE economy_ledger…]` is one transaction; a stale/duplicate flush skips the state row via the version guard and skips existing facts via the PK — no duplicates, no partial writes.

### F6. Delivery of ledger facts to D1: the watermark attachment
- The core has one outbox concept: `version > projected` (`aggregate.ts` L58-62, `flush()` L146-171). The alarm retry is at-least-once ("Alarms have guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws"; "Retries are performed using exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed"; "If you call `setAlarm` when there is already one scheduled, it will override the existing alarm"). Source: https://developers.cloudflare.com/durable-objects/api/alarms/
- Applying the same idea to the ledger: keep `ledger_projected_seq` in a `ledger_meta` row; at flush time read `SELECT … FROM ledger WHERE seq > ? ORDER BY seq LIMIT 200` synchronously (before any `await`, per F1's cursor guidance), send the rows as an `attachments` argument alongside the state, and on success advance the watermark to the highest seq **sent** (not the current max — new rows can be inserted by other requests while the flush awaits, because input gates open at `await`). If the flush fails, the watermark is untouched and the alarm retry re-sends the same rows; `INSERT OR IGNORE` makes the re-send harmless (F5).
- Because the base class flushes only when `version > projected`, a ledger row always accompanies a version bump (every ledger entry changes `ledgerSeq`), so there is never a pending ledger row without a pending flush — no separate scheduling is required.
- D1 rows written per flush for the ledger: ≈ 1 + index rows per fact — included in the R12 budget for 50k DAU with room to spare (F3 numbers).

### F7. Prune without losing the invariant
- SQLite's `DELETE … ORDER BY … LIMIT` exists only when compiled with `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`; the page does not say whether workerd's SQLite enables it. Source: https://www.sqlite.org/lang_delete.html — **UNVERIFIED** for workerd; the sketches avoid it and prune with `DELETE FROM ledger WHERE seq <= ?` where `? = ledgerSeq − RETAIN`.
- Before deleting, fold the deleted rows into the checkpoint: `checkpoint = { seq: boundary, tokens: balance_after of the last deleted tokens row (or previous checkpoint.tokens), stars: likewise }`. Since each row stores `balance` (balance after the entry), the checkpoint is a single `SELECT balance FROM ledger WHERE kind=? AND seq<=? ORDER BY seq DESC LIMIT 1` per kind — no summation. Deletes are billed as rows written (F3), so prune in blocks (when `ledgerSeq − checkpoint.seq > RETAIN + 200`) rather than one row per commit.

### F8. Test harness facts
- `cloudflare:test` exports `runInDurableObject(stub, (instance, state) => …)` ("temporarily replaces your Durable Object's fetch() handler with callback, then sends a request to it"), `runDurableObjectAlarm(stub): Promise<boolean>` ("Returns true if an alarm ran; false otherwise"), `evictDurableObject(stub)` ("tearing down its instance to reset in-memory state"), `listDurableObjectIds(ns)`, `applyD1Migrations(db, migrations, table = "d1_migrations")`; `env` from `cloudflare:workers`. Source: https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ — the same helpers the copied core tests already use (`test/aggregate.test.ts`).
- `runInDurableObject` gives the test the real `instance` and `state.storage.sql`, so a test can count `ledger` rows inside the object without adding a debug RPC method. Pinned versions verified with `npm view`: `@cloudflare/vitest-pool-workers@0.22.0`, `@cloudflare/workers-types@5.20260902.1`, `zod@4.5.4`, `hono@4.13.5`, `@hono/zod-validator@0.9.1` (peers `zod ^3.25.0 || ^4.0.0`, `hono >=4.11.2`).

### F9. Prior art for idempotency keys (Stripe)
- "Stripe's idempotency works by saving the resulting status code and body of the first request made for any given idempotency key, regardless of whether it succeeds or fails. Subsequent requests with the same key return the same result." Keys "are up to 255 characters long"; "You can remove keys from the system automatically after they're at least 24 hours old"; "The idempotency layer compares incoming parameters to those of the original request and errors if they're not the same to prevent accidental misuse." Results are saved "only after the execution of an endpoint begins" (validation failures are not saved). Source: https://docs.stripe.com/api/idempotent_requests
- Adopted rules: store result only for commands that reached the aggregate; compare a request hash; mismatch → error; keys ≤ 128 chars (UUID recommended); retention longer than Stripe's 24 h because mobile clients retry after days offline (30 days; purchases forever).

### F10. RevenueCat webhook contract
- Delivery: "RevenueCat will send `POST` requests to your server, in which the body will be a JSON representation of the notification." A "200 status code" is required; otherwise "RevenueCat will retry later (up to 5 times) with an increasing delay (5, 10, 20, 40, and 80 minutes)"; the server must respond within "60s". Authorization: a header value set in the dashboard, plus HMAC-SHA256 signing via `X-RevenueCat-Webhook-Signature: t=<unix_timestamp>,v1=<hmac_sha256_hex>` over `"<timestamp>.<raw_json_body>"`. Idempotency: "best effort for 'at least one delivery'"; "your application may receive a webhook for the same event more than once"; "guard against duplicated events by making your webhook processing idempotent" using the event `id`. Source: https://www.revenuecat.com/docs/integrations/webhooks
- Envelope `{ "api_version": "1.0", "event": { … } }`. Common fields include `id` ("Unique event identifier (reused on retries)"), `type`, `event_timestamp_ms`, `app_id`, `app_user_id`, `original_app_user_id`, `aliases`, `product_id`, `transaction_id`, `original_transaction_id`, `purchased_at_ms`, `expiration_at_ms`, `store` (APP_STORE, PLAY_STORE, …), `environment` (SANDBOX/PRODUCTION), `price` (USD), `currency`, `price_in_purchased_currency`, `entitlement_ids`, `presented_offering_id`, `period_type`, `country_code`, `is_family_share`, `offer_code`, `tax_percentage`, `commission_percentage`, `renewal_number`. Event types include `INITIAL_PURCHASE`, `RENEWAL`, `CANCELLATION` ("Subscription or non-renewing purchase canceled or refunded"), `UNCANCELLATION`, `NON_RENEWING_PURCHASE` ("A customer has made a purchase that won't auto-renew"), `EXPIRATION`, `BILLING_ISSUE`, `PRODUCT_CHANGE`, `REFUND_REVERSED`, `TEST`, `TRANSFER`, `VIRTUAL_CURRENCY_TRANSACTION`. Source: https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
- Sample `NON_RENEWING_PURCHASE` event: `product_id: "2100_tokens"`, `transaction_id: "123456789012345"`, `original_transaction_id` equal to it, `expiration_at_ms: null`, `store: "APP_STORE"`, `environment: "PRODUCTION"`, `price: 25.487`, `currency: "CAD"`, `price_in_purchased_currency: 32.99`, `app_user_id`, `aliases`, `id: "12345678-…"`. `CANCELLATION` samples carry `cancel_reason` (`UNSUBSCRIBE`, `CUSTOMER_SUPPORT`, …). Source: https://www.revenuecat.com/docs/integrations/webhooks/sample-events
- Not on the pages read: whether a refund of a consumable arrives as `CANCELLATION` with a refund-type `cancel_reason` in every store, and whether `transaction_id` is unique per consumable purchase on Play Store (**UNVERIFIED**; design keys on `<provider>:<transaction_id>` and falls back to `event.id` if `transaction_id` is missing).

### F11. Apple App Store Server Notifications / StoreKit 2 (for a direct-Apple path)
- `responseBodyV2DecodedPayload` fields: `notificationType`, `subtype`, `data`, `summary`, `externalPurchaseToken`, `appData`, `version`, `signedDate`, `notificationUUID`; "`data`, `appData`, `summary`, and `externalPurchaseToken` are mutually exclusive"; `notificationUUID` "is a unique identifier to detect duplicate notifications". Source: https://developer.apple.com/documentation/appstoreservernotifications/responsebodyv2decodedpayload (read via Apple's documentation JSON endpoint).
- `JWSTransactionDecodedPayload` fields include `transactionId`, `originalTransactionId`, `productId`, `purchaseDate`, `quantity`, `type`, `environment`, `appAccountToken`, `revocationDate`, `price`, `currency`, `storefront`, `transactionReason`, plus `bundleId`, `expiresDate`, `inAppOwnershipType`, `revocationReason`, `signedDate`, `webOrderLineItemId` and others; all optional in the schema. Source: https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload (JSON endpoint).
- The `notificationType` value list (e.g. `ONE_TIME_CHARGE`, `REFUND`, `CONSUMPTION_REQUEST`) and the `type` enum values (`Consumable`, …) were **not** read from a primary page today — **UNVERIFIED**. `appAccountToken` is the natural place to carry Crosscut's `userId` (UUID) if the direct path is ever built; RevenueCat remains the v1+ plan per `concepts.md` §5.

### F12. What the existing docs already fix, and what changes here
- R3 says `creditPurchase`/`setPlan` are "idempotent by `purchaseId` (keep the last ~50 ids in state, or dedupe against a D1 `purchases` table before calling)". Both halves are replaced: ids move to the in-object `idempotency` table (unbounded for purchases, transactional with the credit), and the D1 `economy_purchases` row is written **by the projection** (attachment) after the credit, never as a pre-check — a pre-check in D1 is a TOCTOU window and a second source of truth.
- R2/README `UserState.ledgerSeq` stays and becomes precise: the seq of the newest ledger entry; it bumps once per **entry** (a solve with time bonus + 10 stars + 2 no-hint stars bumps by 3).
- `wheel.lastSpinDay` stays as the business rule (one free spin per local day); the idempotency row makes the response replayable (same `prizeIndex`) — the business rule alone would make a retry a 422 `ALREADY_SPUN`, which the client cannot tell apart from "someone else spun".
- Event catalogue rows `tokens.granted/spent`, `stars.granted` → "ledger (sync)" are satisfied *inside* the command (the ledger is written in the same transaction as the wallet), so no event consumer is needed for correctness; `economy.*` events stay analytics-only.

---

## Recommendation for Crosscut

### R1. Storage layout (decision 1)

| Store | Content | Written by | Consistency | Retention |
|---|---|---|---|---|
| `UserState.wallet` + `ledgerSeq` (snapshot) | current balances, seq of newest entry | every wallet command | strong | forever |
| DO table `ledger` | one row per balance change (`seq, at, kind, delta, balance, reason, ref, op_key, meta`) | same `transactionSync` as the state row | strong | newest 1,000 rows (`LEDGER_RETAIN`), older rows folded into `ledger_meta.checkpoint` |
| DO table `idempotency` | key → op, request hash, stored result, seq range | same transaction | strong | purchases forever; others 30 days |
| DO table `ledger_meta` | `checkpoint {seq,tokens,stars}`, `projected_seq`, `last_prune_day`, `repairs[]` | commands / flush | strong | forever |
| D1 `economy_ledger` | append-only copy of ledger rows, PK `(user_id, seq)` | projection `extra` statements (attachment), `INSERT OR IGNORE` | eventual (ms; minutes while a flush is failing) | forever (analytics, fleet audit) |
| D1 `economy_purchases` | one row per purchase (mock now, receipts later) | projection `extra` from the `purchase` ledger attachment | eventual | forever |

Rejected: **ring in `UserState`** (F4 — per-commit clone/serialise cost, ships with every projection, still needs a checkpoint); **D1 as the only ledger** (a D1 write cannot be in the DO transaction; a failed flush would leave a balance with no fact until the alarm catches up, and `GET /wallet` would be eventually consistent right after a purchase — the one screen where that is unacceptable); **`ctx.storage.kv`** (same billing, no indexes, no `SUM`).

Snapshot budget: this proposal adds **zero bytes** to `UserState` beyond the existing `wallet` and `ledgerSeq`. The real snapshot growth risk remains `completions` (≈ 130 B per solved puzzle, ≈ 47 KB after a year of daily solves) — outside this topic, but the 256 KiB warn / 1 MiB throw guard (R13.3) should land with M2.

### R2. Ledger entry semantics

- `kind`: `"tokens" | "stars"`. `delta`: signed integer, never 0 (a 0-prize wheel spin records no entry; the idempotency row still stores the result). `balance`: balance **after** the entry, so the chain check and the checkpoint need no summation.
- `reason` (closed enum, the Wallet screen groups by it): `solve` (time bonus tokens; +10 stars), `no_hint_bonus` (+2 stars), `hint` (−20/−40/−100), `wheel` (+prize), `collection` (+reward), `purchase` (+pack tokens), `refund` (−pack tokens, floored at the current balance, shortfall in `meta`), `adjust` (repair/support), `merge` (v2 account merge: the absorbed device user's balance arrives as one entry per kind with `ref = deviceUserId`).
- `ref`: the business key — `solveId` for `solve`/`no_hint_bonus`, `"<sessionId>:<q>:<hintKind>"` for `hint`, `wheelId` for `wheel`, `collectionId`, `purchaseId`, `deviceUserId`, or the admin note id for `adjust`. `op_key`: the idempotency key that produced the entry (nullable for `solve`, which is idempotent by `sessionId`).
- Ordering: `seq` is total order within the user; `at` is the command's explicit `now` (all commands already take `now`), never `Date.now()` inside the object.
- Stars can never go negative or be spent: `spend` paths are token-only by construction (`spendForHint` writes `kind: "tokens"`); a `CHECK (kind <> 'stars' OR delta >= 0 OR reason IN ('adjust','merge'))` guards the table.

### R3. Idempotency store (decision 2)

| Command | key | request hash over | stored result | duplicate returns |
|---|---|---|---|---|
| `creditPurchase({ purchaseId, packId, tokens, source })` | `purchase:<purchaseId>` | `packId, tokens, source` | `{ entry }` | `{ replayed: true, ledgerEntry: entry, balances: current }` |
| `spinWheel({ wheelId, idempotencyKey, now })` | `wheel:<wheelId>:<idempotencyKey>` | `wheelId` | `{ prizeIndex, prize, entry\|null }` | same prize, `replayed: true` — *and* a different `idempotencyKey` for the same `wheelId` after a spin is `ALREADY_SPUN` (422) via `wheel.lastSpinDay` |
| `spendForHint({ sessionId, q, kind, idempotencyKey, now })` | `hint:<sessionId>:<idempotencyKey>` | `sessionId, q, kind` | `{ entry }` | `{ replayed: true, ledgerEntry, balances }`; the gateway then re-derives the hint content deterministically (same `q`, same secret) so the client gets the same options/letter/word |
| `claimCollection({ collectionId, memberIds, reward })` | `claim:<collectionId>` (natural key; no client key) | `reward` | `{ entry }` | `{ replayed: true, claimed: true, reward }` — `collectionsClaimed` stays as the fast business check |
| `finishSolve` | none — idempotent by `sessionId` (`session === null` after finish → returns the completion record) | — | — | existing behaviour |

Rules:
1. The key lookup, the ledger insert, the idempotency insert and the state write all happen inside one `commitTx` (R6) — a concurrent duplicate is serialised by the input gate and finds the row.
2. Same key + different hash → `DomainError("IDEMPOTENCY_MISMATCH")`; `app.onError` maps it to **409** (`{ error: { code: "IDEMPOTENCY_MISMATCH" } }`). The Hono middleware for `DomainError` currently maps everything to 422; add the one name→status exception.
3. A duplicate **does not commit** (no version bump, no flush) — it is a read.
4. `idempotencyKey` format: `z.uuid()` for client keys; server-side keys (`purchaseId` from a provider) up to 128 chars, `[A-Za-z0-9:_.-]`.
5. Pruning: `DELETE FROM idempotency WHERE op <> 'purchase' AND created_at < ?` runs inside the first wallet commit of a new local day (`ledger_meta.last_prune_day`), together with the ledger prune (R4). Purchases are never pruned (they double as the receipt registry and are needed for refunds).
6. Results are stored as JSON ≤ 2 KB; the row also stores `first_seq`/`last_seq` so an audit can find which entries a key produced.

### R4. Retention and the checkpoint (bounded table, invariant intact)

- `LEDGER_RETAIN = 1000`, `PRUNE_SLACK = 200`. When `ledgerSeq − checkpoint.seq > RETAIN + SLACK` at the start of a wallet commit: `boundary = ledgerSeq − RETAIN`; read `balance` of the newest row `≤ boundary` per kind (fallback to the old checkpoint value when a kind has no rows in the range); write `checkpoint = { seq: boundary, tokens, stars, at: now }`; `DELETE FROM ledger WHERE seq <= boundary`. Never prune rows above `projected_seq` (they have not reached D1 yet) — `boundary = min(boundary, projected_seq)`.
- With ≈ 4 entries/day for an every-day player, 1,000 rows ≈ 8 months of history in the object; D1 `economy_ledger` keeps the rest. `GET /wallet` returns the newest 50 and `ledgerTruncated: true` when older rows exist in D1 (a v2 `GET /wallet/ledger?before=<seq>` can page from D1).
- Storage per user stays ≈ 150–200 KB regardless of lifetime; `ctx.storage.sql.databaseSize` is exposed in the audit response for observability.

### R5. Invariant, verify, repair, audit (decision 3)

Invariants (checked by `verifyLedger()`; each violation is a named code):
- `I1 BALANCE`: `wallet.tokens === checkpoint.tokens + Σ delta(kind='tokens', seq > checkpoint.seq)`; same for stars.
- `I2 CHAIN`: for each kind, walking rows ascending from the checkpoint, `prevBalance + delta === balance` for every row.
- `I3 SEQ`: `ledgerSeq === MAX(seq)` (or `checkpoint.seq` when the table is empty) and no gaps in `seq` above the checkpoint.
- `I4 NON_NEGATIVE`: every `balance >= 0`.
- `I5 KEYS`: every `idempotency.first_seq..last_seq` range (for rows above the checkpoint) exists in `ledger`, and every ledger row with a non-null `op_key` has its idempotency row (unless pruned by age — reported as `info`, not `error`).

`repairLedger({ trust, now, note })`:
- `trust: "ledger"` (default for `I1` drift caused by state corruption, PITR, or a bad deploy): set `wallet` to the ledger totals, `ledgerSeq` to `MAX(seq)`, append `{ at, note, before, after }` to `ledger_meta.repairs`. No ledger row is added — the ledger already says what the balance is.
- `trust: "state"` (when the ledger is the damaged side — e.g. a bug skipped an entry — and the user-visible balance must stand): append one `adjust` entry per drifting kind with `delta = wallet − expected`, `ref = note id`; the chain is re-anchored at the new entry.
- Both are single `commitTx` commits and are themselves idempotent (a second call finds no drift and is a no-op). Chain breaks (`I2`) inside retained rows cannot be "fixed" without rewriting history; `repair` refuses and reports — an operator decides.

Fleet/admin audit (D1 is derived; only reports):
- `POST /admin/users/:id/economy/audit` → `{ verify: VerifyReport, d1: { solves: { tokens, stars, count } vs ledger reason∈{solve,no_hint_bonus}, purchases: { credited, count } vs ledger reason='purchase', collections: claimed ids vs ledger reason='collection', ledgerRows: { d1: n, doPending: m } }, databaseSize }`. Differences in `solves`/`purchases`/`collections` mean a **fact row is missing or extra in D1** (fan-out or flush gap) — fix by `reproject()`/`flushLedger()`; differences in `verify` mean the **object itself** is inconsistent — fix by `repairLedger`.
- `POST /admin/economy/audit-all` pages `player_state` ids (10–20 concurrent, per `core-package.md` §5) and writes a report to `content_meta` (`key = "economy_audit:<day>"`); optionally scheduled weekly by the existing cron handler.
- `POST /me/reconcile` (already specified) adds a `ledger` step: `flush()` if `projected_seq < ledgerSeq`, then `verifyLedger()`; `repaired` gains `"ledger_projection"` when rows were pushed. It never repairs balances (that stays admin-only).

### R6. Core changes (adds R13.5–R13.7 to `durable-objects-d1-domain.md`)

5. `protected commitTx(mutate: (state, tx: CommitTx) => State)` — like `commit`, but `#persist(next)` and the `tx.exec` statements queued by `mutate` run inside one `ctx.storage.transactionSync`; if anything throws, the transaction rolls back **and** the in-memory `#state/#version` are restored. A no-op state with queued side effects is a programming error (throw). `commit` stays as is.
6. `flush()` calls `protected flushAttachments(): unknown` (default `undefined`) synchronously before the `await`, passes it as the 6th argument to `apply(kind, id, version, state, force, attachments)`, and after success calls `protected onFlushed(attachments)`.
7. `ProjectionDef.extra?: (state, meta, attachments) => D1PreparedStatement[]`; `ProjectionsBase.apply` runs `DB.batch([upsert, ...extra])` when `extra` returns statements (R13.2 with the attachment argument; `player_solves` keeps using `state`).

These are additive; the 8 existing core tests are unchanged. Two base-class tests to add: "commitTx rolls back the state row when a side-effect statement throws" and "attachments reach `apply` and `onFlushed` only runs on success".

### R7. API and DTO decisions (decision 5, details in sketches)

- `GET /wallet` → `{ balances, ledgerSeq, packs, hintCosts, ledger: LedgerEntry[] (≤50, newest first), ledgerTruncated }` from one DO call `User.walletView(50)`; packs/hintCosts are constants in `packages/shared`.
- `POST /wallet/purchases { packId, idempotencyKey }` → `{ balances, ledgerEntry, purchaseId, replayed }`; v1 `purchaseId = "mock:" + idempotencyKey`. The D1 `economy_purchases` row is written by the projection from the `purchase` attachment (never by the route).
- `POST /wheel/:wheelId/spin { idempotencyKey }` → `{ wheelId, prizeIndex, prize, prizes, balances, ledgerEntry: LedgerEntry | null, replayed }`; 422 `ALREADY_SPUN`; 409 `IDEMPOTENCY_MISMATCH`.
- Hint routes gain `idempotencyKey: z.uuid()` in the body; the 402 stays `{ error: { code: "INSUFFICIENT_TOKENS", balance, cost } }`.
- `POST /collections/:id/claim` unchanged externally; gains `replayed`.

### R8. Receipts later (decision 4)

- `economy_purchases` final shape (migration `0004_economy.sql`, below): `id` = `"<provider>:<external id>"`; `provider ∈ mock|revenuecat|apple|stripe`; `provider_event_id` (RC `event.id` / Apple `notificationUUID`, for support lookups); `product_id` (store SKU, e.g. `tokens_550`); `pack_id`; `tokens`; `price`, `currency`, `store`, `environment`; `status ∈ credited|refunded`; `ledger_seq`; `refund_ledger_seq`; `raw_json`; `purchased_at`, `created_at`. v1 rows have `provider='mock'`, `price = the catalogue price`, `environment='MOCK'`.
- Route `POST /webhooks/revenuecat` (later): verify the dashboard `Authorization` value **and** the HMAC signature (F10); `zValidator` on `{ api_version: "1.0", event: RCEvent }` where `RCEvent` is a **loose** discriminated union on `type` (unknown types → 200, logged); `NON_RENEWING_PURCHASE` with a `product_id` in the pack catalogue → `creditPurchase({ purchaseId: "revenuecat:" + transaction_id, packId, tokens, source: { provider: "revenuecat", eventId, productId, price, currency, store, environment, purchasedAt } })`; `CANCELLATION` whose `transaction_id` matches a credited pack → `refundPurchase({ purchaseId })` (ledger `refund`, floored at the balance); `INITIAL_PURCHASE/RENEWAL/EXPIRATION/PRODUCT_CHANGE` → `setPlan` (already specified). `app_user_id` must equal Crosscut's `userId` — set `Purchases.logIn(userId)` on the client; treat `aliases` as an alternate lookup. Always 200 on duplicates (the aggregate replays); non-200 only for signature failure or a transient DO error so RevenueCat retries.
- The ledger shape does not change: a receipt-backed purchase is the same `reason: "purchase"` entry with a different `ref` prefix; the wallet UI does not care where the tokens came from.

---

## Code sketches

Illustrative, not final. Paths follow the consolidated README (`workers/gateway/src/modules/...`, `packages/core`, `packages/shared`).

### S1. Core additions (`packages/core/src/aggregate.ts`)

```ts
export interface CommitTx {
  /** Queue a statement to run in the same SQLite transaction as the state row. */
  exec(query: string, ...bindings: unknown[]): void;
}

// inside class Aggregate
protected async commitTx(mutate: (state: State, tx: CommitTx) => State): Promise<Snapshot<State>> {
  this.#requireInit();
  const queued: Array<[string, unknown[]]> = [];
  const tx: CommitTx = { exec: (q, ...b) => { queued.push([q, b]); } };
  const next = mutate(structuredClone(this.#state as State), tx);

  const prevState = this.#state, prevVersion = this.#version;
  try {
    this.ctx.storage.transactionSync(() => {
      const changed = this.#persist(next);              // UPDATE aggregate ... (sync)
      if (!changed && queued.length) throw new Error(`${this.kind}: side effects on a no-op commit`);
      for (const [q, b] of queued) this.sql.exec(q, ...b);
    });
  } catch (err) {
    this.#state = prevState; this.#version = prevVersion; // rolled back on disk; mirror it in memory
    throw err;
  }
  await this.#flushAfterCommit();
  return this.snapshot();
}

/** Extra facts to ship with the next projection (read synchronously, before any await). */
protected flushAttachments(): unknown { return undefined; }
/** Called after a successful apply() with the attachments that were sent. */
protected onFlushed(_attachments: unknown): void {}

async flush(force = false): Promise<boolean> {
  if (this.#id === null || this.#state === null) return true;
  if (!force && this.#version <= this.#projected) return true;
  const id = this.#id, version = this.#version, state = this.#state;
  const attachments = this.flushAttachments();
  try {
    await this.resolveProjections().apply(this.kind, id, version, state, force, attachments);
  } catch (err) { /* unchanged: warn + scheduleRetry */ return false; }
  this.onFlushed(attachments);
  /* unchanged: advance projected, deleteAlarm */
  return true;
}
```

`ProjectionsBinding.apply` gains `attachments?: unknown`; `ProjectionDef.extra?: (state, meta, attachments) => D1PreparedStatement[]`; `ProjectionsBase.apply` becomes:

```ts
const upsert = this.env.DB.prepare(sql).bind(...params);
const extra = def.extra?.(state, { id, version }, attachments) ?? [];
if (extra.length === 0) await upsert.run();
else await this.env.DB.batch([upsert, ...extra]);   // one transaction (F5)
```

### S2. In-object schema (`workers/gateway/src/modules/player/internal/user.do.ts`)

```ts
protected schemaMigrations() {
  return [
    (sql) => sql.exec(`
      CREATE TABLE ledger (
        seq     INTEGER PRIMARY KEY,
        at      INTEGER NOT NULL,
        kind    TEXT    NOT NULL CHECK (kind IN ('tokens','stars')),
        delta   INTEGER NOT NULL CHECK (delta <> 0),
        balance INTEGER NOT NULL CHECK (balance >= 0),
        reason  TEXT    NOT NULL,
        ref     TEXT    NOT NULL,
        op_key  TEXT,
        meta    TEXT,
        CHECK (kind <> 'stars' OR delta >= 0 OR reason IN ('adjust','merge'))
      );
      CREATE INDEX ledger_kind_seq ON ledger (kind, seq);
      CREATE TABLE idempotency (
        key          TEXT PRIMARY KEY,
        op           TEXT    NOT NULL,
        request_hash TEXT    NOT NULL,
        first_seq    INTEGER,
        last_seq     INTEGER,
        result       TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idempotency_created ON idempotency (op, created_at);
      CREATE TABLE ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO ledger_meta VALUES
        ('checkpoint', '{"seq":0,"tokens":0,"stars":0,"at":0}'),
        ('projected_seq', '0'),
        ('last_prune_day', '""'),
        ('repairs', '[]');
    `),
  ];
}
```

### S3. The wallet slice: append, idempotency, prune

```ts
const LEDGER_RETAIN = 1000, PRUNE_SLACK = 200, KEY_TTL_MS = 30 * 86_400_000;

type LedgerKind = "tokens" | "stars";
type LedgerReason = "solve" | "no_hint_bonus" | "hint" | "wheel" | "collection" | "purchase" | "refund" | "adjust" | "merge";
export interface LedgerEntry { seq: number; at: number; kind: LedgerKind; delta: number; balance: number;
  reason: LedgerReason; ref: string; opKey?: string; meta?: Record<string, string | number | boolean> }

/** Apply one balance change to `s` and queue its ledger row. Returns the entry. */
function appendEntry(s: UserState, tx: CommitTx, e: Omit<LedgerEntry, "seq" | "balance">): LedgerEntry {
  const next = s.wallet[e.kind] + e.delta;
  if (next < 0) throw new DomainError("INSUFFICIENT_TOKENS");
  s.wallet[e.kind] = next;
  const entry: LedgerEntry = { ...e, seq: ++s.ledgerSeq, balance: next };
  tx.exec(
    "INSERT INTO ledger (seq, at, kind, delta, balance, reason, ref, op_key, meta) VALUES (?,?,?,?,?,?,?,?,?)",
    entry.seq, entry.at, entry.kind, entry.delta, entry.balance, entry.reason, entry.ref,
    entry.opKey ?? null, entry.meta ? JSON.stringify(entry.meta) : null,
  );
  return entry;
}

/** Look up a stored result. Same key + same hash → replay; same key + different hash → 409. */
#recall<T>(key: string, hash: string): T | null {
  const rows = this.sql.exec("SELECT request_hash, result FROM idempotency WHERE key = ?", key).toArray();
  if (rows.length === 0) return null;
  if (rows[0].request_hash !== hash) throw new DomainError("IDEMPOTENCY_MISMATCH");
  return JSON.parse(rows[0].result as string) as T;
}

function remember(tx: CommitTx, key: string, op: string, hash: string, seqs: number[], result: unknown, now: number) {
  tx.exec(
    "INSERT INTO idempotency (key, op, request_hash, first_seq, last_seq, result, created_at) VALUES (?,?,?,?,?,?,?)",
    key, op, hash, seqs[0] ?? null, seqs.at(-1) ?? null, JSON.stringify(result), now,
  );
}

/** Deterministic hash of the parameters that must not change between retries (sync, no crypto needed). */
const requestHash = (...parts: unknown[]) => JSON.stringify(parts);

// --- commands -------------------------------------------------------------

async creditPurchase(cmd: { purchaseId: string; packId: PackId; tokens: number; source: PurchaseSource; now: number }) {
  const key = `purchase:${cmd.purchaseId}`, hash = requestHash(cmd.packId, cmd.tokens, cmd.source.provider);
  const hit = this.#recall<{ entry: LedgerEntry }>(key, hash);
  if (hit) return { replayed: true, entry: hit.entry, snapshot: this.snapshot() };
  let entry!: LedgerEntry;
  const snap = await this.commitTx((s, tx) => {
    this.#maybePrune(s, tx, cmd.now);
    entry = appendEntry(s, tx, { at: cmd.now, kind: "tokens", delta: cmd.tokens, reason: "purchase",
      ref: cmd.purchaseId, opKey: key, meta: { packId: cmd.packId, provider: cmd.source.provider } });
    remember(tx, key, "purchase", hash, [entry.seq], { entry, source: cmd.source }, cmd.now);
    return s;
  });
  return { replayed: false, entry, snapshot: snap };
}

async spendForHint(cmd: { sessionId: string; q: number; kind: "fifty" | "letter" | "word"; idempotencyKey: string; now: number }) {
  const key = `hint:${cmd.sessionId}:${cmd.idempotencyKey}`, hash = requestHash(cmd.sessionId, cmd.q, cmd.kind);
  const hit = this.#recall<{ entry: LedgerEntry }>(key, hash);
  if (hit) return { replayed: true, entry: hit.entry, snapshot: this.snapshot() };
  const cost = HINT_COST[cmd.kind];                       // { fifty: 20, letter: 40, word: 100 }
  let entry!: LedgerEntry;
  const snap = await this.commitTx((s, tx) => {
    if (!s.session || s.session.id !== cmd.sessionId) throw new DomainError("NO_ACTIVE_SESSION");
    if (s.wallet.tokens < cost) throw new DomainError("INSUFFICIENT_TOKENS");   // gateway → 402 { balance, cost }
    this.#maybePrune(s, tx, cmd.now);
    entry = appendEntry(s, tx, { at: cmd.now, kind: "tokens", delta: -cost, reason: "hint",
      ref: `${cmd.sessionId}:${cmd.q}:${cmd.kind}`, opKey: key });
    s.session.hintsUsed += 1;
    s.session.hintLog.push({ q: cmd.q, kind: cmd.kind, cost, at: cmd.now });
    s.hints.total += 1; s.hints.tokensSpent += cost;
    remember(tx, key, "hint", hash, [entry.seq], { entry }, cmd.now);
    return s;
  });
  return { replayed: false, entry, snapshot: snap };
}

async spinWheel(cmd: { wheelId: string; idempotencyKey: string; now: number }) {
  const key = `wheel:${cmd.wheelId}:${cmd.idempotencyKey}`, hash = requestHash(cmd.wheelId);
  const hit = this.#recall<SpinResult>(key, hash);
  if (hit) return { replayed: true, ...hit, snapshot: this.snapshot() };
  const today = dayKey(cmd.now, this.snapshot().state.tz);
  if (cmd.wheelId !== `${today}:base`) throw new DomainError("WHEEL_NOT_AVAILABLE");
  const prizeIndex = randomIndex(WHEEL_PRIZES.length);      // crypto.getRandomValues, outside the mutate
  const prize = WHEEL_PRIZES[prizeIndex];                    // [50, 10, 0, 25, 5, 15]
  let result!: SpinResult;
  const snap = await this.commitTx((s, tx) => {
    if (s.wheel.lastSpinDay === today) throw new DomainError("ALREADY_SPUN");
    this.#maybePrune(s, tx, cmd.now);
    const entry = prize > 0
      ? appendEntry(s, tx, { at: cmd.now, kind: "tokens", delta: prize, reason: "wheel", ref: cmd.wheelId, opKey: key })
      : null;
    s.wheel = { lastSpinDay: today, lastPrize: prize, lastIndex: prizeIndex };
    result = { prizeIndex, prize, entry };
    remember(tx, key, "wheel", hash, entry ? [entry.seq] : [], result, cmd.now);
    return s;
  });
  return { replayed: false, ...result, snapshot: snap };
}

// finishSolve: inside its existing commit (now commitTx) — three entries, one version bump
//   if (tokens > 0) appendEntry(s, tx, { at: now, kind: "tokens", delta: tokens, reason: "solve", ref: session.id });
//   if (!replay)   appendEntry(s, tx, { at: now, kind: "stars",  delta: 10,     reason: "solve", ref: session.id });
//   if (!replay && session.hintsUsed === 0) appendEntry(s, tx, { at: now, kind: "stars", delta: 2, reason: "no_hint_bonus", ref: session.id });

#maybePrune(s: UserState, tx: CommitTx, now: number) {
  const cp = this.#meta<Checkpoint>("checkpoint");
  const projected = this.#meta<number>("projected_seq");
  if (s.ledgerSeq - cp.seq > LEDGER_RETAIN + PRUNE_SLACK) {
    const boundary = Math.min(s.ledgerSeq - LEDGER_RETAIN, projected);   // never drop rows D1 has not seen
    if (boundary > cp.seq) {
      const last = (kind: LedgerKind) => this.sql
        .exec("SELECT balance FROM ledger WHERE kind = ? AND seq <= ? ORDER BY seq DESC LIMIT 1", kind, boundary)
        .toArray()[0]?.balance as number | undefined;
      const next: Checkpoint = { seq: boundary, tokens: last("tokens") ?? cp.tokens, stars: last("stars") ?? cp.stars, at: now };
      tx.exec("UPDATE ledger_meta SET value = ? WHERE key = 'checkpoint'", JSON.stringify(next));
      tx.exec("DELETE FROM ledger WHERE seq <= ?", boundary);
    }
  }
  const today = dayKey(now, s.tz);
  if (this.#meta<string>("last_prune_day") !== today) {
    tx.exec("DELETE FROM idempotency WHERE op <> 'purchase' AND created_at < ?", now - KEY_TTL_MS);
    tx.exec("UPDATE ledger_meta SET value = ? WHERE key = 'last_prune_day'", JSON.stringify(today));
  }
}
```

### S4. Flushing ledger facts to D1 (watermark attachment)

```ts
// User (aggregate) -----------------------------------------------------------
protected override flushAttachments() {
  const from = this.#meta<number>("projected_seq");
  const rows = this.sql
    .exec("SELECT seq, at, kind, delta, balance, reason, ref, op_key, meta FROM ledger WHERE seq > ? ORDER BY seq LIMIT 200", from)
    .toArray();                                            // consumed synchronously (F1)
  const purchases = rows.filter((r) => r.reason === "purchase" || r.reason === "refund")
    .map((r) => this.sql.exec("SELECT result FROM idempotency WHERE key = ?", r.op_key).toArray()[0]?.result);
  return rows.length ? { ledger: rows, purchases, upTo: rows.at(-1)!.seq as number } : undefined;
}
protected override onFlushed(att: unknown) {
  const a = att as { upTo: number } | undefined;
  if (a) this.sql.exec("UPDATE ledger_meta SET value = ? WHERE key = 'projected_seq'", String(a.upTo));
}

// Projections ------------------------------------------------------------------
defineProjection<UserState>({
  kind: "user",
  table: "player_state",
  columns: (s) => ({ /* unchanged */ }),
  extra: (s, { id }, att) => {
    const stmts = newestSolves(s, id);                     // R13.2, unchanged
    const a = att as { ledger: LedgerRow[]; purchases: (string | undefined)[] } | undefined;
    for (const r of a?.ledger ?? []) {
      stmts.push(DB.prepare(
        "INSERT OR IGNORE INTO economy_ledger (user_id, seq, at, kind, delta, balance, reason, ref, op_key, meta) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(id, r.seq, r.at, r.kind, r.delta, r.balance, r.reason, r.ref, r.op_key, r.meta));
      if (r.reason === "purchase") stmts.push(purchaseRow(id, r, a!.purchases));  // INSERT OR IGNORE INTO economy_purchases …
      if (r.reason === "refund")  stmts.push(DB.prepare("UPDATE economy_purchases SET status='refunded', refund_ledger_seq=? WHERE id=? AND user_id=?").bind(r.seq, r.ref, id));
    }
    return stmts;                                          // batched with the versioned upsert (S1)
  },
});
```

Note the guard in `#maybePrune` (`boundary ≤ projected_seq`): if D1 is unreachable for a long time the object keeps more than 1,000 rows rather than losing facts; the audit route reports `doPending`.

### S5. D1 migration `0004_economy.sql`

```sql
CREATE TABLE economy_ledger (
  user_id  TEXT    NOT NULL,
  seq      INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  kind     TEXT    NOT NULL,           -- tokens | stars
  delta    INTEGER NOT NULL,
  balance  INTEGER NOT NULL,           -- balance after the entry
  reason   TEXT    NOT NULL,           -- solve | no_hint_bonus | hint | wheel | collection | purchase | refund | adjust | merge
  ref      TEXT    NOT NULL,
  op_key   TEXT,
  meta     TEXT,
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX economy_ledger_reason_at ON economy_ledger (reason, at);       -- sinks/sources per day

CREATE TABLE economy_purchases (
  id                TEXT PRIMARY KEY,     -- "<provider>:<external id>"; v1 "mock:<idempotencyKey>"
  user_id           TEXT    NOT NULL,
  provider          TEXT    NOT NULL,     -- mock | revenuecat | apple | stripe
  provider_event_id TEXT,                 -- RC event.id / Apple notificationUUID
  product_id        TEXT    NOT NULL,     -- store SKU (tokens_120 | tokens_550 | tokens_1400)
  pack_id           TEXT    NOT NULL,
  tokens            INTEGER NOT NULL,
  price             REAL,
  currency          TEXT,
  store             TEXT,                 -- APP_STORE | PLAY_STORE | STRIPE | MOCK
  environment       TEXT,                 -- PRODUCTION | SANDBOX | MOCK
  status            TEXT    NOT NULL DEFAULT 'credited',   -- credited | refunded
  ledger_seq        INTEGER NOT NULL,
  refund_ledger_seq INTEGER,
  raw_json          TEXT,
  purchased_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX economy_purchases_user ON economy_purchases (user_id, purchased_at DESC);
CREATE INDEX economy_purchases_event ON economy_purchases (provider, provider_event_id);
```

### S6. Verify and repair

```ts
verifyLedger(): VerifyReport {
  const s = this.snapshot().state;
  const cp = this.#meta<Checkpoint>("checkpoint");
  const rows = this.sql.exec("SELECT seq, kind, delta, balance FROM ledger WHERE seq > ? ORDER BY seq", cp.seq).toArray();
  const expected = { tokens: cp.tokens, stars: cp.stars };
  const running = { ...expected };
  const problems: Problem[] = [];
  let prevSeq = cp.seq;
  for (const r of rows) {
    const k = r.kind as LedgerKind;
    if (r.seq !== prevSeq + 1) problems.push({ code: "SEQ_GAP", seq: r.seq as number });
    running[k] += r.delta as number;
    if (running[k] !== r.balance) problems.push({ code: "CHAIN", seq: r.seq as number, kind: k, expected: running[k], actual: r.balance as number });
    if ((r.balance as number) < 0) problems.push({ code: "NEGATIVE", seq: r.seq as number });
    prevSeq = r.seq as number;
  }
  const maxSeq = rows.at(-1)?.seq ?? cp.seq;
  if (s.ledgerSeq !== maxSeq) problems.push({ code: "LEDGER_SEQ", expected: maxSeq, actual: s.ledgerSeq });
  const drift = { tokens: s.wallet.tokens - running.tokens, stars: s.wallet.stars - running.stars };
  if (drift.tokens || drift.stars) problems.push({ code: "BALANCE", drift });
  return { ok: problems.length === 0, checkpoint: cp, expected: running, actual: s.wallet, drift, maxSeq,
           projectedSeq: this.#meta<number>("projected_seq"), rows: rows.length, databaseSize: this.sql.databaseSize, problems };
}

async repairLedger(cmd: { trust: "ledger" | "state"; now: number; note: string }) {
  const report = this.verifyLedger();
  if (report.ok) return { repaired: false, report };
  if (report.problems.some((p) => p.code === "CHAIN" || p.code === "SEQ_GAP")) throw new DomainError("LEDGER_CHAIN_BROKEN");
  const snap = await this.commitTx((s, tx) => {
    if (cmd.trust === "ledger") {
      s.wallet = { ...report.expected }; s.ledgerSeq = report.maxSeq;
      const repairs = this.#meta<unknown[]>("repairs");
      repairs.push({ at: cmd.now, note: cmd.note, before: report.actual, after: report.expected });
      tx.exec("UPDATE ledger_meta SET value = ? WHERE key = 'repairs'", JSON.stringify(repairs));
    } else {
      s.ledgerSeq = report.maxSeq;                       // re-anchor first, then append signed adjustments
      for (const kind of ["tokens", "stars"] as const) {
        const d = report.drift[kind];
        if (d === 0) continue;
        const target = s.wallet[kind]; s.wallet[kind] = report.expected[kind];
        appendEntry(s, tx, { at: cmd.now, kind, delta: target - report.expected[kind], reason: "adjust", ref: cmd.note });
      }
    }
    return s;
  });
  return { repaired: true, report, snapshot: snap };
}
```

### S7. Zod 4 schemas (`packages/shared/src/economy.ts`)

```ts
import { z } from "zod";

export const LedgerKind = z.enum(["tokens", "stars"]);
export const LedgerReason = z.enum(["solve", "no_hint_bonus", "hint", "wheel", "collection", "purchase", "refund", "adjust", "merge"]);

export const LedgerEntry = z.object({
  seq: z.int().positive(),
  at: z.int().nonnegative(),                 // epoch ms (server clock)
  kind: LedgerKind,
  delta: z.int().refine((n) => n !== 0, "delta must be non-zero"),
  balance: z.int().nonnegative(),            // after the entry
  reason: LedgerReason,
  ref: z.string().min(1).max(160),
  opKey: z.string().max(200).optional(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).meta({ ref: "LedgerEntry" });
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const Balances = z.object({ tokens: z.int().nonnegative(), stars: z.int().nonnegative() }).meta({ ref: "Balances" });

export const PackId = z.enum(["pack_120", "pack_550", "pack_1400"]);
export const Pack = z.object({
  id: PackId,
  tokens: z.union([z.literal(120), z.literal(550), z.literal(1400)]),
  priceCents: z.union([z.literal(99), z.literal(399), z.literal(899)]),
  currency: z.literal("USD"),
  badge: z.enum(["popular", "best_value"]).nullable(),
  productId: z.string(),                      // store SKU; "tokens_550"
});
export const PACKS = [
  { id: "pack_120",  tokens: 120,  priceCents: 99,  currency: "USD", badge: null,         productId: "tokens_120"  },
  { id: "pack_550",  tokens: 550,  priceCents: 399, currency: "USD", badge: "popular",    productId: "tokens_550"  },
  { id: "pack_1400", tokens: 1400, priceCents: 899, currency: "USD", badge: "best_value", productId: "tokens_1400" },
] as const satisfies readonly z.infer<typeof Pack>[];

export const HintCosts = z.object({ fifty: z.literal(20), letter: z.literal(40), word: z.literal(100) });

export const WalletResponse = z.object({
  balances: Balances,
  ledgerSeq: z.int().nonnegative(),
  packs: z.array(Pack).length(3),
  hintCosts: HintCosts,
  ledger: z.array(LedgerEntry).max(50),      // newest first
  ledgerTruncated: z.boolean(),              // older entries exist (in D1)
}).meta({ ref: "WalletResponse" });

export const IdempotencyKey = z.uuid();       // client-generated per attempt; keep it for retries

export const PurchaseBody = z.object({ packId: PackId, idempotencyKey: IdempotencyKey }).strict();
export const PurchaseResponse = z.object({
  balances: Balances,
  ledgerEntry: LedgerEntry,
  purchaseId: z.string(),                    // "mock:<idempotencyKey>" in v1
  replayed: z.boolean(),
}).meta({ ref: "PurchaseResponse" });

export const WHEEL_PRIZES = [50, 10, 0, 25, 5, 15] as const;
export const WheelId = z.string().regex(/^\d{4}-\d{2}-\d{2}:base$/, "wheelId is <dayKey>:base");
export const SpinParams = z.object({ wheelId: WheelId });
export const SpinBody = z.object({ idempotencyKey: IdempotencyKey }).strict();
export const SpinResponse = z.object({
  wheelId: WheelId,
  prizeIndex: z.int().min(0).max(5),
  prize: z.union([z.literal(50), z.literal(10), z.literal(0), z.literal(25), z.literal(5), z.literal(15)]),
  prizes: z.tuple([z.literal(50), z.literal(10), z.literal(0), z.literal(25), z.literal(5), z.literal(15)]),
  balances: Balances,
  ledgerEntry: LedgerEntry.nullable(),       // null when prize === 0
  replayed: z.boolean(),
}).meta({ ref: "SpinResponse" });

// Hint bodies gain the key (all three routes)
export const HintBody = z.object({ questionIndex: z.int().nonnegative(), idempotencyKey: IdempotencyKey }).strict();

// Errors (subset of the shared error envelope)
export const EconomyErrorCode = z.enum(["INSUFFICIENT_TOKENS", "ALREADY_SPUN", "WHEEL_NOT_AVAILABLE", "IDEMPOTENCY_MISMATCH", "NO_ACTIVE_SESSION"]);
```

Route wiring (Hono 4.13 + `@hono/zod-validator` 0.9.1):

```ts
wallet.get("/", async (c) => {
  const view = await user(c).walletView(50);              // { balances, ledgerSeq, ledger, ledgerTruncated }
  return c.json(WalletResponse.parse({ ...view, packs: PACKS, hintCosts: { fifty: 20, letter: 40, word: 100 } }));
});
wallet.post("/purchases", zValidator("json", PurchaseBody), async (c) => {
  const { packId, idempotencyKey } = c.req.valid("json");
  const pack = PACKS.find((p) => p.id === packId)!;
  const r = await user(c).creditPurchase({ purchaseId: `mock:${idempotencyKey}`, packId, tokens: pack.tokens,
    source: { provider: "mock", productId: pack.productId, price: pack.priceCents / 100, currency: "USD", store: "MOCK", environment: "MOCK", purchasedAt: Date.now() },
    now: Date.now() });
  return c.json({ balances: r.snapshot.state.wallet, ledgerEntry: r.entry, purchaseId: `mock:${idempotencyKey}`, replayed: r.replayed }, r.replayed ? 200 : 201);
});
// app.onError: DomainError "IDEMPOTENCY_MISMATCH" → 409; "INSUFFICIENT_TOKENS" → 402 { balance, cost }; other DomainError → 422
```

### S8. Webhook slot for RevenueCat (later; shapes from F10)

```ts
const RCEvent = z.object({
  id: z.string(), type: z.string(), app_user_id: z.string(), event_timestamp_ms: z.int(),
  product_id: z.string().optional(), transaction_id: z.string().nullable().optional(),
  original_transaction_id: z.string().nullable().optional(), purchased_at_ms: z.int().optional(),
  store: z.string().optional(), environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
  price: z.number().nullable().optional(), currency: z.string().nullable().optional(),
  cancel_reason: z.string().optional(), aliases: z.array(z.string()).optional(),
}).loose();                                                // unknown fields tolerated
const RCWebhook = z.object({ api_version: z.literal("1.0"), event: RCEvent });

webhooks.post("/revenuecat", verifyRevenueCat, zValidator("json", RCWebhook), async (c) => {
  const { event } = c.req.valid("json");
  const userId = event.app_user_id;                        // Purchases.logIn(userId) on the client
  const pack = event.product_id ? PACKS.find((p) => p.productId === event.product_id) : undefined;
  if (event.type === "NON_RENEWING_PURCHASE" && pack) {
    await aggregateStub(c.env.USER, "user", userId).creditPurchase({
      purchaseId: `revenuecat:${event.transaction_id ?? event.id}`, packId: pack.id, tokens: pack.tokens,
      source: { provider: "revenuecat", eventId: event.id, productId: pack.productId, price: event.price ?? null,
                currency: event.currency ?? null, store: event.store ?? null, environment: event.environment ?? null,
                purchasedAt: event.purchased_at_ms ?? event.event_timestamp_ms }, now: Date.now() });
  } else if (event.type === "CANCELLATION" && pack && event.transaction_id) {
    await aggregateStub(c.env.USER, "user", userId).refundPurchase({ purchaseId: `revenuecat:${event.transaction_id}`, now: Date.now() });
  } // INITIAL_PURCHASE / RENEWAL / EXPIRATION / PRODUCT_CHANGE → setPlan (billing module); everything else → 200
  return c.body(null, 200);                                 // duplicates replay inside the aggregate
});
```

### S9. workerd tests (`workers/gateway/test/economy.test.ts`)

```ts
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { aggregateStub } from "@app/core";
import type { User } from "../src/modules/player/internal/user.do";

const user = (id: string) => aggregateStub(env.USER, "user", id);
const NOW = Date.UTC(2026, 8, 2, 12);
const ledgerRows = (stub: DurableObjectStub<User>) =>
  runInDurableObject(stub, (_i, state) => state.storage.sql.exec("SELECT * FROM ledger ORDER BY seq").toArray());
const d1Ledger = (id: string) =>
  env.DB.prepare("SELECT seq, delta, reason FROM economy_ledger WHERE user_id = ? ORDER BY seq").bind(id).all();

async function seeded(id: string, tokens = 100) {
  const u = user(id); await u.init(id);
  await u.creditPurchase({ purchaseId: `seed:${id}`, packId: "pack_120", tokens, source: MOCK, now: NOW });
  return u;
}

describe("wallet ledger", () => {
  it("debits a hint and writes the ledger row in one commit", async () => {
    const u = await seeded("h1");
    const { session } = (await u.startSolve({ puzzleId: "en-mini-0001", parSec: 300, now: NOW })).state;
    const r = await u.spendForHint({ sessionId: session!.id, q: 0, kind: "fifty", idempotencyKey: KEY1, now: NOW + 1000 });
    expect(r.entry).toMatchObject({ kind: "tokens", delta: -20, balance: 80, reason: "hint", seq: 2 });
    expect(r.snapshot.state.wallet.tokens).toBe(80);
    expect(await ledgerRows(u)).toHaveLength(2);
    // a rejected debit writes nothing: neither state nor ledger
    await expect(async () => { await u.spendForHint({ sessionId: session!.id, q: 1, kind: "word", idempotencyKey: KEY2, now: NOW + 2000 }); })
      .rejects.toThrow(/INSUFFICIENT_TOKENS/);
    expect(await ledgerRows(u)).toHaveLength(2);
    expect((await u.snapshot()).state.wallet.tokens).toBe(80);
  });

  it("credits a duplicate purchase key exactly once and replays the entry", async () => {
    const u = user("p1"); await u.init("p1");
    const cmd = { purchaseId: "mock:k-1", packId: "pack_550" as const, tokens: 550, source: MOCK, now: NOW };
    const a = await u.creditPurchase(cmd);
    const b = await u.creditPurchase({ ...cmd, now: NOW + 5000 });       // retry
    expect(a.replayed).toBe(false); expect(b.replayed).toBe(true);
    expect(b.entry).toEqual(a.entry);
    expect(b.snapshot.version).toBe(a.snapshot.version);                 // no commit on replay
    expect(b.snapshot.state.wallet.tokens).toBe(550);
    expect(await ledgerRows(u)).toHaveLength(1);
    // same key, different pack → mismatch
    await expect(async () => { await u.creditPurchase({ ...cmd, packId: "pack_120", tokens: 120 }); }).rejects.toThrow(/IDEMPOTENCY_MISMATCH/);
  });

  it("prunes the ledger behind a checkpoint and keeps the balance invariant", async () => {
    const u = user("r1"); await u.init("r1");
    await runInDurableObject(u, async (instance: User) => {
      for (let i = 0; i < 1300; i++)                                    // direct calls: no RPC per iteration
        await instance.creditPurchase({ purchaseId: `mock:${i}`, packId: "pack_120", tokens: 1, source: MOCK, now: NOW + i });
    });
    const rows = await ledgerRows(u);
    expect(rows.length).toBeLessThanOrEqual(1000 + 200);
    const report = await u.verifyLedger();
    expect(report.ok).toBe(true);
    expect(report.checkpoint.seq).toBeGreaterThan(0);
    expect(report.expected.tokens).toBe(1300);
    expect((await u.snapshot()).state.wallet.tokens).toBe(1300);
    expect((await d1Ledger("r1")).results).toHaveLength(1300);          // D1 keeps everything
  });

  it("never duplicates D1 ledger facts across a failed flush, alarm retry, eviction and reproject", async () => {
    await setFail(true);                                                 // Projections.apply throws (core test hook)
    const u = user("f1"); await u.init("f1");
    await u.creditPurchase({ purchaseId: "mock:f", packId: "pack_120", tokens: 120, source: MOCK, now: NOW });
    expect((await d1Ledger("f1")).results).toHaveLength(0);
    await evictDurableObject(u);
    await setFail(false);
    expect(await runDurableObjectAlarm(u)).toBe(true);
    expect((await d1Ledger("f1")).results).toHaveLength(1);
    expect(await runDurableObjectAlarm(u)).toBe(false);                  // nothing pending
    await u.reproject();                                                 // forced re-send of the same facts
    expect((await d1Ledger("f1")).results).toHaveLength(1);              // INSERT OR IGNORE
    expect((await u.verifyLedger()).projectedSeq).toBe(1);
  });

  it("spins once per wheel and replays the same prize for the same key", async () => {
    const u = user("w1"); await u.init("w1");
    const wheelId = "2026-09-02:base";
    const a = await u.spinWheel({ wheelId, idempotencyKey: KEY1, now: NOW });
    const b = await u.spinWheel({ wheelId, idempotencyKey: KEY1, now: NOW + 100 });
    expect(b).toMatchObject({ replayed: true, prizeIndex: a.prizeIndex, prize: a.prize });
    await expect(async () => { await u.spinWheel({ wheelId, idempotencyKey: KEY2, now: NOW + 200 }); }).rejects.toThrow(/ALREADY_SPUN/);
    expect((await ledgerRows(u)).length).toBe(a.prize > 0 ? 1 : 0);
  });

  it("repairLedger detects and fixes state drift, in both trust modes", async () => {
    const u = await seeded("d1", 100);
    await runInDurableObject(u, (_i, state) =>
      state.storage.sql.exec("UPDATE aggregate SET state = json_set(state, '$.wallet.tokens', 250) WHERE key = 1"));
    await evictDurableObject(u);                                         // reload the tampered snapshot
    expect((await u.verifyLedger()).drift).toEqual({ tokens: 150, stars: 0 });
    const fixed = await u.repairLedger({ trust: "state", now: NOW + 1, note: "support#42" });
    expect(fixed.repaired).toBe(true);
    expect((await ledgerRows(u)).at(-1)).toMatchObject({ reason: "adjust", delta: 150, balance: 250 });
    expect((await u.verifyLedger()).ok).toBe(true);
  });
});
```

The `setFail` hook is the same `test_flags` switch the core fixture uses; `json_set` is SQLite's JSON1 (available in DO SQLite — **UNVERIFIED** for workerd's build; if absent, tamper through `instance` by re-persisting a modified state via a test-only method).

---

## Claims

| id | claim | source | confidence |
|---|---|---|---|
| C1 | `ctx.storage.transactionSync(callback)` wraps the callback in a transaction and rolls back if it throws; the callback must be synchronous; `sql.exec` cannot run `BEGIN`/`SAVEPOINT` | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ; typings L778 | high |
| C2 | Writes with no intervening `await` are submitted atomically; SQLite storage ops are synchronous and execute atomically; output gates hold responses until writes are durable | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ; https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ | high |
| C3 | `SqlStorageCursor` exposes `toArray()`, `one()`, `raw()`, `rowsRead`, `rowsWritten`; `sql.databaseSize` is the DB size in bytes | https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ ; typings L3845-3873 | high |
| C4 | SQLite-backed DO limits: 10 GB per object, 2 MB max row/string/BLOB, 2 MB key+value, 100 columns, unlimited rows, 100 KB statement, 100 bound parameters, ~1,000 rps soft limit | https://developers.cloudflare.com/durable-objects/platform/limits/ | high |
| C5 | DO SQLite billing (Paid): 25 B rows read + $0.001/M, 50 M rows written + $1.00/M, 5 GB-month + $0.20/GB; deletes and `setAlarm()` count as rows written; Free 100k writes/day | https://developers.cloudflare.com/durable-objects/platform/pricing/ | high |
| C6 | `waitUntil` has no effect in Durable Objects; `ctx.exports` holds loopback bindings | https://developers.cloudflare.com/durable-objects/api/state/ | high |
| C7 | Alarms are at-least-once, retried on throw with exponential backoff from 2 s up to 6 retries; one alarm per object; `setAlarm` overrides a pending alarm; handler gets `retryCount`/`isRetry` | https://developers.cloudflare.com/durable-objects/api/alarms/ ; typings `AlarmInvocationInfo` | high |
| C8 | `D1Database.batch()` is a transaction: a failing statement aborts/rolls back the whole sequence; per-statement limits apply inside a batch; no documented cap on statements per batch | https://developers.cloudflare.com/d1/worker-api/d1-database/ ; https://developers.cloudflare.com/d1/platform/limits/ | high |
| C9 | `INSERT OR IGNORE` silently skips rows violating UNIQUE/PRIMARY KEY/NOT NULL and continues; it behaves like ABORT for foreign-key violations | https://www.sqlite.org/lang_conflict.html | high |
| C10 | D1's SQL docs do not mention `INSERT OR IGNORE`, UPSERT or `RETURNING`; production behaviour rests on the local-engine verification already recorded as U1 | https://developers.cloudflare.com/d1/sql-api/sql-statements/ ; docs/research/README.md U1 | medium |
| C11 | `DELETE … ORDER BY … LIMIT` requires `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`; whether workerd enables it is unknown (design avoids it) | https://www.sqlite.org/lang_delete.html | medium (UNVERIFIED for workerd) |
| C12 | SQLite is the recommended DO backend; new KV-backed namespaces are no longer supported without an existing one; indexes speed reads at a small write cost; in-memory properties are cache only | https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ ; https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/ | high |
| C13 | PITR can restore a SQLite-backed object to any point in the past 30 days; `getCurrentBookmark`/`getBookmarkForTime`/`onNextSessionRestoreBookmark` exist in the typings | https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/ ; typings L779-781 | high |
| C14 | `cloudflare:test` provides `runInDurableObject(stub, (instance, state) => …)`, `runDurableObjectAlarm(stub) → boolean`, `evictDurableObject`, `listDurableObjectIds`, `applyD1Migrations`; `env` from `cloudflare:workers` | https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ | high |
| C15 | Stripe idempotency: first response is stored and replayed for the same key; keys ≤ 255 chars; pruned after ≥ 24 h; same key with different parameters errors; results saved only once execution begins | https://docs.stripe.com/api/idempotent_requests | high |
| C16 | RevenueCat webhooks: POST JSON, 200 required, up to 5 retries (5/10/20/40/80 min), 60 s timeout, dashboard Authorization header + HMAC `X-RevenueCat-Webhook-Signature: t=…,v1=…` over `"<timestamp>.<raw body>"`, at-least-once with duplicate `event.id` | https://www.revenuecat.com/docs/integrations/webhooks | high |
| C17 | RevenueCat envelope `{ api_version: "1.0", event }`; event fields include `id`, `type`, `app_user_id`, `original_app_user_id`, `aliases`, `product_id`, `transaction_id`, `original_transaction_id`, `purchased_at_ms`, `store`, `environment`, `price`, `currency`, `price_in_purchased_currency`; types include `NON_RENEWING_PURCHASE` ("won't auto-renew"), `CANCELLATION` ("or refunded"), `INITIAL_PURCHASE`, `RENEWAL`, `EXPIRATION`, `TEST`, `TRANSFER` | https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields | high |
| C18 | RevenueCat's `NON_RENEWING_PURCHASE` sample carries `product_id: "2100_tokens"`, `transaction_id`, `expiration_at_ms: null`, `store: "APP_STORE"`, `price`/`currency`/`price_in_purchased_currency`; `CANCELLATION` samples carry `cancel_reason` | https://www.revenuecat.com/docs/integrations/webhooks/sample-events | high |
| C19 | Apple `responseBodyV2DecodedPayload` has `notificationType`, `subtype`, `data`, `summary`, `externalPurchaseToken`, `appData`, `version`, `signedDate`, `notificationUUID` (duplicate detection); `JWSTransactionDecodedPayload` has `transactionId`, `originalTransactionId`, `productId`, `purchaseDate`, `quantity`, `type`, `environment`, `appAccountToken`, `revocationDate`, `price`, `currency`, `storefront`, `transactionReason` | https://developer.apple.com/documentation/appstoreservernotifications/responsebodyv2decodedpayload ; https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload (JSON endpoints) | medium |
| C20 | Apple `notificationType` values (`ONE_TIME_CHARGE`, `REFUND`, `CONSUMPTION_REQUEST`) and `type` enum values were not read from a primary page | — | low (UNVERIFIED) |
| C21 | Whether RevenueCat delivers consumable refunds as `CANCELLATION` for every store, and whether `transaction_id` is unique per consumable purchase on Play, was not confirmed on the pages read | — | low (UNVERIFIED) |
| C22 | zod 4.5.4: `z.int()` restricts to the safe-integer range; `z.uuid()`, `z.iso.datetime()`, `z.enum`, `z.literal`, `z.discriminatedUnion`, `.strict()`, `.nonnegative()`, `.min()`, `z.record(key, value)`, `z.infer` as used in S7 | https://zod.dev/api ; `npm view zod@4.5.4` | high |
| C23 | `@hono/zod-validator@0.9.1` peers: `zod ^3.25.0 \|\| ^4.0.0`, `hono >=4.11.2`; pinned versions resolve on npm (`hono 4.13.5`, `@cloudflare/vitest-pool-workers 0.22.0`, `@cloudflare/workers-types 5.20260902.1`) | `npm view` 2026-09-02 | high |
| C24 | `Aggregate.commit` clones and JSON-serialises the whole state per commit and ships the whole JSON per flush, so ledger entries in state cost on every command; `flush` only runs when `version > projected`; `versionedUpsert` guards with `excluded.version > table.version` | /Users/peter/Projects/IOSApp/packages/core/src/aggregate.ts L131-133, L146-171, L246-258; projections.ts L104-125 | high |
| C25 | SQLite's `json_set` availability inside workerd's DO SQLite build was not verified (test S9 fallback noted) | — | low (UNVERIFIED) |

---

## Open questions

1. **Refund below balance.** When a refunded pack's tokens were already spent, the sketch floors the `refund` debit at the current balance and records the shortfall in `meta`. Alternative: allow a negative token balance (blocks hints until repaid). Product call; affects `CHECK (balance >= 0)`.
2. **Retention numbers.** `LEDGER_RETAIN = 1000` and 30-day idempotency TTL are guesses tuned for ≈ 8 months of daily play and offline retries; confirm against the Wallet screen (shows 50) and the client's retry policy (TanStack Query mutations retried across app restarts?).
3. **Hint replay contract.** A replayed `spendForHint` returns the original ledger entry; the gateway must regenerate identical hint content (same decoy pair, same revealed cell) from `(secret, q, kind)` deterministically — the 50/50 decoy picker must be seeded (e.g. by `sessionId:q`) rather than random. Belongs to the solving-module spec.
4. **D1 `INSERT OR IGNORE` / UPSERT in production** (U1) now also carries the ledger; the M6 production smoke test should insert one duplicate `economy_ledger` row on purpose.
5. **`json_set` and `DELETE … LIMIT` in workerd's SQLite** (C11, C25) — quick probe at M0 alongside the core tests.
6. **RevenueCat `app_user_id` identity.** Using Crosscut's `userId` as the RC app user id requires `Purchases.logIn(userId)` after bootstrap and a decision for the v2 device→account merge (RC `TRANSFER` events vs re-login); `aliases` lookup is the fallback. Also confirm which store(s) surface consumable refunds as `CANCELLATION` (C21).
7. **Merge (v2)** writes one `merge` entry per kind on the absorbing user; should the absorbed user's ledger rows be copied into the account's D1 `economy_ledger` (re-keyed) for audit continuity, or is the `ref = deviceUserId` pointer enough?
8. **Fleet audit cadence and cost.** Weekly `audit-all` is one DO request per user (F3: 1 M included/month) — trivial to 100k users; decide whether the report goes to `content_meta` or to Workers Logs only.
9. **File naming.** The task brief names the deliverable both `gap-wallet-ledger-and-idempotency.md` (slug) and `wallet-ledger-and-idempotency.md`; this file uses the slug. Rename on merge if the index expects the other.
