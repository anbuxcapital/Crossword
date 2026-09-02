# Orchestrator notes for the ARCHITECTURE.md assembly (2026-09-02)

These override the section drafts where they conflict. Research README.md and glossary.md remain
the primary sources; the drafts in `section-*.md` are inputs, not decisions.

## Keep v1 simple (README wins over draft creep)

1. **No `processed_events` table in v1.** README: "processed_events not needed in v1 because no
   handler moves money". Handlers are idempotent by construction: `player.claimCollection` is
   idempotent by `collectionId` (in `collectionsClaimed`), `PuzzleStats.recordSolve` counters are
   approximate by design (a replay may over-count `solved` by one; acceptable, healed by a
   nightly recount if ever needed), `player_solves` uses `INSERT OR IGNORE`. Mention
   `processed_events` only in the outbox upgrade path.
2. **Core changes are exactly these four** (from README "Composition with Aggregate /
   Projections" + section-02 where it refines them):
   - `projectionFingerprint(state)` hook: session-only commits (`submitWord`, progress, pause,
     resume, hints) must not flush to D1; the fingerprint excludes `session` (and `presence`-like
     memory). When fingerprints are equal, mark `projected = version` and skip the flush.
   - `Projections.apply(kind, id, version, state, force, attachments?)` + per-projection
     `extra?(state, meta, attachments) => D1PreparedStatement[]`, all statements in ONE
     `DB.batch` (used for `player_solves` rows and the `economy_ledger` projection rows).
   - `flushAttachments()` / `onFlushed(attachments)` hooks on `Aggregate` (ledger watermark).
   - Snapshot-size guard in `#persist` (warn > 256 KiB, throw > 1 MiB).
   The existing base class already re-arms its own retry alarm on a failed flush
   (`flush()` → `#scheduleRetry()` → `setAlarm`); do NOT describe a "cap at 6" change — just
   state that the alarm handler keeps re-arming its own retry because platform retries stop
   after 6. No app-level alarms in v1.
3. **Event family for the solving module is `solve.*`** (`solve.started`, `solve.paused`,
   `solve.resumed`, `solve.hintUsed`, `solve.finished`). Never `solving.finished`.
4. **Device attestation is v2.** No `/attest` route, no `attest.ts`, no `attest_keys` in v1
   (mention once in §11 "Deliberately not built").
5. **`economy_ledger` (D1 projection of the in-object ledger) is accepted** as a glossary
   addition (owning module `economy`, migration `0004_economy.sql`), fed by the `player`
   projection's `extra()` statements. Add it to glossary.md section 3 if missing.
6. **Type names introduced by drafts that are fine to keep** (add to glossary section 7/8 as
   "types"): `SolveSession`, `SolveResult`, `CompletionRecord`, `DispatchContext`,
   `HandlerTable`, `EventOf<T>`, `DispatchReport`, `Envelope`, DTO names from §6.
7. **Notifications prefs**: keep the README shape `notifications: "enabled" | "declined" |
   "skipped"` in v1; per-kind toggles are a v2 refinement (note it in §11).
8. **Rate limit `RL_CHECK`** (30/60 s per solveId) is accepted.
9. **Three crons** (`0 * * * *`, `*/5 * * * *`, `0 6 * * *`) as in README.
10. Every table, endpoint, event, command and file used in any section must appear in
    glossary.md; add missing ones there rather than renaming in the sections.

## Consistency checks the assembler must perform

- §2 state fields ↔ §5 projection columns ↔ §6 DTO fields (same names, same types).
- §3 event catalog ↔ events used in §4 flows ↔ glossary section 4.
- §6 endpoints ↔ glossary section 5 (45 rows; #32 attest marked v2) ↔ §4 flows ↔ §8 smoke test.
- §7 file tree ↔ every file named in §8 and §9 ↔ glossary section 7.
- §9 wrangler.jsonc bindings (USER, PUZZLE_STATS, DB, RL_*) ↔ §2 env binding names ↔ §7.

## Conflict rulings (orchestrator, 2026-09-02, after the README gap integration)

The README gap integration rewrote parts of docs/research/README.md more aggressively than
intended. For ARCHITECTURE.md the precedence is now: **these notes > glossary.md > the
assembled sections > README.md**. Specific rulings:

11. **Solve session is stateful in the User DO** (§0 draft, glossary §2). Therefore there is
    NO `lockProof` and NO client-supplied `locked` on the wire. `POST /v1/solves/:solveId/words`
    body = `{ questionIndex: int ≥ 0, word: string }`. Remove `lockProof` and `WordsBody.locked`
    everywhere (§4, §6, glossary conflict #6 → rewrite it to say "locked is server-owned; the
    client sends only questionIndex + word").
12. **`POST /v1/solves/:solveId/progress` is removed** (nothing for the client to report once
    locks are server-owned). Renumber nothing — just mark glossary endpoint #23 as "removed —
    superseded by server-owned locks" and delete it from §6/§4/§8.
13. **Autocheck**: `POST /v1/solves/:solveId/autocheck { on: boolean }` toggles autocheck in the
    session and returns `{ autocheck, ticket, ticketExpiresAt }` (a check ticket, HMAC over
    solveId+expiry, CHECK_TICKET_TTL 10 min, at most CHECK_TICKETS_PER_SOLVE renewals via the
    same route). `POST /v1/solves/:solveId/check { ticket, cells: [{ r, c, ch }] }` → `{
    wrongCells: [r, c][] }`, RL_CHECK, 403 `bad_ticket` / `autocheck_off`. Add the autocheck
    route to the glossary endpoint table if missing.
14. **Finishing is inline**: when the last question locks, `/words` returns `finished: true`
    and `result: SolveResult` (rewards applied in the same `submitWord` commit — one DO
    round-trip). `POST /v1/solves/:solveId/finish` stays as an idempotent no-body endpoint that
    returns the cached `session.lastResult` (or the completion record) — 409 `NOT_FINISHED` if
    questions remain. No grid in any request body; the grid never leaves the server.
15. **Notifications in v1**: `UserState.prefs.notifications: "enabled" | "declined" | "skipped"`
    and `pushTokens: string[]` (README's original shape). Tables: only
    `notifications_reminders_sent`. No `notifications_push_tokens`, no `notifications_sent`,
    no per-kind toggles, no `utc_offset_min` (keep `local_day_ends_at` on `player_state`) in v1.
    Push delivery design stays in gap-push-notifications-delivery.md as the v2 plan.
16. **Events**: `solve.finished` carries `streakExtended`; there is no separate
    `player.streakExtended` event. `economy` subscribes to nothing (collections calls
    `player.claimCollection` directly through the player port).
17. **Tables in v1** are exactly: content_puzzles, content_puzzle_secrets, content_daily_drops,
    content_collections, content_collection_puzzles, content_meta, player_state, player_solves,
    social_puzzle_stats, leaderboard_week, economy_purchases, economy_ledger,
    notifications_reminders_sent. Nothing else (attest_keys is v2).
18. **Idempotency keys**: `POST /wallet/purchases`, `POST /billing/plan` and
    `POST /wheel/:wheelId/spin` take `idempotencyKey`; a replay returns the stored result with
    `replayed: true`; a key reuse with a different payload → 409 `IDEMPOTENCY_MISMATCH`.
