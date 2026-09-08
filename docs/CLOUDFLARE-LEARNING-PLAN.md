# Build Crosscut with AI and learn Cloudflare

Updated: 2026-09-07. This is the execution and learning companion to
[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md). Product contracts remain in
[ARCHITECTURE.md](ARCHITECTURE.md) and [glossary.md](design/glossary.md).

**Goal:** ship the crossword and Daily Five game with AI doing implementation work,
while Peter learns to explain, operate, change, and debug its Cloudflare backend.
Success is ownership of the system; memorizing SDK syntax is optional.

Use [CLOUDFLARE-MATERIALS.md](CLOUDFLARE-MATERIALS.md) for the checked reading list:
12 focused resources, ordered by when the game needs them, with sections and questions.

Default starting point: comfortable with programming, early in Cloudflare. Stage 0
is already marked closed in ClickUp. Adjust the depth to Peter's demonstrated knowledge.

## What the review found

Reviewed the [implementation list](https://app.clickup.com/2573967/v/l/li/901221185192?pr=90129404485)
(all 61 returned tasks, including subtasks), the [learning parent](https://app.clickup.com/t/869et6zx3)
and its nine children, [ARC-01](https://app.clickup.com/t/869ew47ax), local plans,
the design handoff, and the existing core implementation. This was a document and
source review, not verification of a deployed game or account resources.

| Finding | Consequence and adjustment |
| --- | --- |
| ClickUp already connects IMP-01–08 to Cloudflare learning. | Keep that mapping. Replace duplicate generic exercises with game work wherever useful. |
| The gateway, shared package, content tree, and Expo app are not scaffolded in this checkout. `packages/core` and the design prototype exist. | Start from the actual repository state. A closed setup lesson does not prove this game's Worker is deployed. |
| Daily Five and Feed v2 exist in ClickUp/design; the local architecture still describes stories/ticker and the WP list ends at WP-14. | Complete ARC-01 before affected schemas, player commands, feed, or client implementation. Foundation work can proceed independently. |
| WP-0 includes core behavior changes; WP-1 defines every schema; WP-13 wires everything at the end. | Split work into usable slices. Bring wiring forward and implement shared/core behavior when its first consumer needs it. Preserve module boundaries. |
| WP-0 creates runtime helpers as stubs, while WP-1 explicitly excludes their implementation. | Give WP-0 explicit ownership of working runtime helpers before their consumers land. Avoid a compile-only stub being mistaken for finished behavior. |
| IMP-01 promises `/healthz`, while the local plan uses `/v1/healthz` and initially returns 501. | Standardize the first real route on `/v1/healthz` and wire it in the foundation slice. |
| IMP-02 expects four seeds; WP-3 enumerates five. | Resolve the seed manifest before import; derive counts from the manifest rather than hard-code four. |
| The learning parent says about 13 part-time days and estimates 106 hours; its children total 114 hours including the capstone. | Re-estimate in focused sessions. At two hours per working day, the original learning estimate alone is 57 days, before game scope. |
| Local architecture excludes Expo, while IMP-07 includes it and leaves its repository location open. | Record the client location before scaffolding. Recommendation: `apps/app` here, with only the typed API contract shared with the backend. |

This roadmap changes sequencing, not the final feature set. Daily Five product
decisions and detailed WP-15 ownership remain ARC-01 work; their existence here
does not mean that task is complete. ClickUp descriptions/statuses were not changed
by this local review.

## Work with AI in small sessions

Aim for 60–90 minutes of focused attention. A feature may span several sessions.
Keep one active feature and one new Cloudflare concept at a time.

1. **Recall, 5 minutes:** explain the last request flow without reopening the notes.
2. **Orient, 10 minutes:** AI identifies the relevant files, one platform concept,
   and one or two official documentation sections. Read those sections together.
3. **Predict, 5 minutes:** Peter records one sentence about where state lives, which
   operation commits it, or what a retry should do. AI corrects a misconception briefly.
4. **Build, 35–50 minutes:** AI implements the agreed behavior in a focused diff.
   Explain the boundary or invariant that matters; skip line-by-line narration.
5. **Inspect, 10–15 minutes:** follow a real request, inspect its response and logs,
   and review the relevant persisted state. Use the local environment or a dedicated
   development deployment. Run existing checks appropriate to the change.
6. **Retain, 5 minutes:** Peter compares the prediction with the result and explains
   one decision in their own words. Record the evidence, uncertainty, and next small step.

No new tests or test scripts unless Peter explicitly requests them. Existing suites,
typechecking, build checks, and interactive inspection are appropriate. Older
test-authoring requirements in the WP briefs do not override this agreement.

AI can implement a feature even if Peter has not mastered it yet. Track those as
separate outcomes: **implementation complete** and **understanding to revisit**.
Do not turn every operation into a quiz or block routine implementation on answers.

## Delivery sequence

Each row is a milestone, not a single session. The WP references identify relevant
ownership; they do not require completing every referenced package before proceeding.
Give partial work an explicit remaining-scope note. Include WP-13 wiring in every slice.

| Step | Working game outcome | Cloudflare lesson and Peter's demonstration | Existing work |
| --- | --- | --- | --- |
| 0. Align the design | A consistent Daily Five/Feed v2 contract and recorded client location. | Explain which data belongs in content D1, the User object, and a read projection. Identify the commit that grants a reward. | ARC-01; client-location part of IMP-07. Can run alongside step 1. |
| 1. First game Worker | `/v1/healthz` and `/v1/config` respond locally and on a development URL; request logs are visible. | Trace request → Hono handler → response. Explain bindings, compatibility date, local versus remote execution, and CPU versus elapsed time. | A small part of IMP-01 / WP-0, WP-1, WP-13. |
| 2. Read a real puzzle | Import the agreed seed manifest and retrieve one puzzle's public payload from D1, without answers. | Explain a migration, a prepared query, and why content is relational. Find the row producing the API response. | IMP-02 / WP-3 plus relevant schemas and wiring. |
| 3. Remember a player | Bootstrap a device, read its profile, and persist a preference through the User DO. | Trace identity → DO addressing → durable state → projection. Inspect the existing alarm retry path and evidence from existing recovery checks before changing core hooks. | Parts of IMP-03/04 / WP-4, WP-5; inspect existing core here. |
| 4. Play one crossword | A minimal Expo play screen uses the real API: open seeded puzzle → submit → finish → see reward. | Locate the transaction covering completion, reward, and replay protection. Trace what happens when the client retries after losing a response. | First usable pieces of IMP-04/07 / WP-4, WP-6, WP-7, API client and WP-13. ARC-01 inputs must be resolved. |
| 5. Add Daily Five and today's feed | Six-guess play, resume/archive, and independent progress for both daily games; Feed v2 uses real data. | Explain authoritative guesses versus queryable history. Trace repeat-letter scoring and a retried guess. Explain how stable pagination interacts with shuffle. | IMP-06 / revised WP-11, new WP-15, content/player deltas; relevant IMP-07 screens. |
| 6. Make recovery visible | Daily drops, weekly leaderboard, reminder deduplication, and reconciliation operate through their real entrypoints. | Identify what survives request termination and what must be reconstructed. Read alarm/cron evidence; distinguish a failed projection from a failed game commit. | IMP-05 / WP-10, WP-12, WP-13; relevant WP-2 events. |
| 7. Complete the product | Remaining hints, social, collections, wheel, mock purchase flows, onboarding, Browse/Profile/Wallet, motion and accessibility match the agreed design. | Explain one cross-module request and its failure boundary. Measure feed reads before choosing a cache. | Remaining IMP-03/04/06/07 scope and relevant WP-1/2 contracts. |
| 8. Operate a release candidate | Existing checks pass; builds/deployments are repeatable; logs, secrets, native device behavior, and recovery instructions are reviewable. | Diagnose an unfamiliar request from its ID; identify the environment/database in use; explain code rollback versus persistent-data changes. | IMP-08 plus referenced release work (REL-01; outside the reviewed list). |

Split step 4 into three concrete slices: start/resume and word submission through the
API; atomic finish/reward and retry behavior; then the minimal Expo screen using those
routes. Each may need multiple sessions. Recovery is introduced in step 3; step 6
extends it to scheduled and cross-module consequences.

The first playable loop is step 4. It does not wait for social counters, complete
leaderboards, a full event bus, every schema, all screens, or optional platform labs.
The User object's consistency and retry invariants still belong in that first loop.
If the existing contract requires an unfinished capability, narrow the slice explicitly
or implement that dependency; do not silently replace it with a successful no-op.

For each slice, list: behavior, required contracts, files/modules touched, early
integration work, demonstration, and remaining scope. Retain the WP ownership model
for edits, while allowing read-only tracing across all relevant modules.

## Decisions to learn through the game

- **Content:** why a puzzle's public structure and secret answer data have different
  read paths. The browser and native bundle must not receive the answer as a shortcut.
- **Player state:** how `Aggregate` writes durable state and reports projection status;
  how `ProjectionsBase` writes a queryable view. It is a `WorkerEntrypoint`, not a DO.
- **Rewards:** where a duplicate command is detected and which state changes belong
  in one object-local transaction. Distinguish a domain invariant from a rate limit.
- **Feed:** which parts are public, which are personalized, and which can be stale.
  Begin with D1 reads. Add caching only after measuring a useful improvement.
- **Recovery:** why a successful game command and a temporarily stale leaderboard
  can coexist. Find the repair source before promising that reconciliation heals loss.
- **Deployment:** distinguish code version, generated bindings, secrets, D1 migrations,
  and DO class lifecycle configuration. Record the exact environment for evidence.

## Correct the platform mental models

Checked against official documentation on 2026-09-07. Recheck version-sensitive
facts when implementing; do not replace the repository's dependency versions blindly.

| Existing claim | Verified clarification |
| --- | --- |
| Learning parent always requires `nodejs_compat`; architecture omits it. | With compatibility dates at or after 2026-08-04, Node compatibility is enabled by default. Omit the positive flags in new configs. The architecture's choice for 2026-09-02 is supported. [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) |
| Stage 1 / IMP-01: Workers have no filesystem. | Workers provide a virtual filesystem, including writable request-local `/tmp`; it is not persistent application storage. [Filesystem API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) |
| Architecture: Wrangler no longer supports TOML. | Both TOML and JSON/JSONC are supported; JSONC is recommended for new projects. The architecture wording was corrected. [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) |
| A DO serializes an entire async command automatically. | Requests can interleave across external I/O. Understand input gates and transaction boundaries instead of relying on single-threaded execution alone. [DO rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) |
| Every constructor needs `blockConcurrencyWhile()`. | It protects asynchronous initialization. Existing core initialization uses synchronous SQLite calls; the absence of that wrapper alone does not establish a race. Inspect the actual awaits and mutations. [DO rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/) |
| Stage 2: KV propagation is about 60 seconds; sessions/API keys are general use cases. | Changes may take 60 seconds or longer, and even local visibility is not guaranteed. Use KV only where stale reads are acceptable; immediate revocation or wallet correctness cannot depend on it. [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/) |
| Cron's 15-minute cap is a general compute allowance. | Fifteen minutes is a wall-time ceiling; CPU limits are separate and depend on plan and invocation details. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Stage 7 uses the old Vitest package name. | The current migration guide replaces `@cloudflare/vitest-pool-workers` with `@cloudflare/vitest-plugin`. Inspect the existing setup before migrating its dependencies/configuration. [Migration guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/) |
| The MCP capstone needs a stateful transport to use DO data. | New stateless tools use `createMcpHandler`; they can call domain services that use DOs. `McpAgent` is deprecated. Keep protocol/session state separate from game state. [Remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) |

The two real application DO classes are `User` and `PuzzleStats`. Declarative
`exports` is the documented preference for new DO class configuration; legacy
`migrations` and `exports` cannot be combined. This does not remove D1 SQL migrations.
[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## Optional breadth after the playable loop

These retain the broader learning goal without becoming prerequisites for the game.
Use a bounded development exercise; keep unused resources out of the gateway config.

| Topic | Game-related exercise | When it earns a place |
| --- | --- | --- |
| R2 | Export a puzzle/content bundle and retrieve it. | Once files or exports are useful; no need to store queryable player state there. |
| Queues / Workflows | Explore a content drafting and validation pipeline, and explain duplicate delivery versus orchestration progress. | After the core loop; add production bindings only if the actual pipeline needs them. |
| WebSockets | Explore live puzzle presence and compare it with polling. | Optional after the current presence feature. Treat client hibernation and an upstream socket as separate capabilities. |
| Containers | Try a native puzzle-generation tool if its runtime cannot run in a Worker. | A real runtime requirement, or a clearly separate breadth exercise. |
| Hyperdrive | Connect a development instance of an existing external SQL database. | External database learning; the game's D1 design does not require adding Postgres. |
| MCP capstone | A content-review assistant with read-only tools for puzzle metadata and content-pool status. | After content services exist. Add OAuth/scoped access before exposing private editorial data; keep publishing a separate explicit action. |

Read the current [storage selection guide](https://developers.cloudflare.com/workers/platform/storage-options/)
when choosing a storage exercise, and the [Containers overview](https://developers.cloudflare.com/containers/)
when a native runtime becomes relevant. Do not complete every optional lab before shipping.

## Lightweight progress record

Reuse the existing ClickUp Learn and Feature subtasks. Link one working artifact
to both rather than implement the same exercise twice. Track implementation status
normally; keep understanding as a short note: **need help → can explain → can predict
→ can diagnose/choose**. These are self-assessment cues, not extra approval gates.

Use this short note on an active feature or in a local session note:

```text
Behavior and evidence: [request/log/development URL/commit]
Prediction → observation: [before running → what actually happened]
My explanation: [2–3 sentences in Peter's own words]
Decision: [why this storage/execution primitive fits]
Still unclear: [one item, or none]
Next session: [one concrete behavior or question]
```

Revisit one earlier explanation in the next session and again after a few sessions.
Sometimes start from a log or symptom instead of the original implementation prompt.
AI should give a hint before the complete answer when Peter is actively practicing.

## Reusable AI prompt

```text
Help me implement the next small Crosscut feature and learn its Cloudflare concept.
Read docs/CLOUDFLARE-LEARNING-PLAN.md and the relevant architecture, glossary,
WP sections, and current code. Respect Peter's no-new-tests agreement.

Start with the behavior, current code state, one concept, and a short request-flow map.
Use current official docs for version-sensitive claims. Flag source conflicts.
Give me one prediction question when it would help, while continuing independent work.
Do not block routine work waiting for a quiz answer.

You write the implementation. Keep the change focused, preserve module ownership,
and include the wiring needed to use this feature now. Explain the important invariant
and point to the relevant code. Run appropriate existing checks and show evidence
through the actual request path. Do not create tests or test scripts unless I ask.

End with what works, the files worth reading, what I should be able to explain,
and one short next step. Track implementation and understanding separately.
```

## First sessions

1. Trace the current `packages/core` snapshot → D1 projection flow. Explain what
   survives an object restart, and distinguish the User object from the projection entrypoint.
2. Implement the small foundation slice with AI: gateway, `/v1/healthz`, `/v1/config`,
   generated bindings and logs. Demonstrate locally and on a development deployment
   when account access is available. Complete remaining scaffold work only as needed.
3. Record ARC-01 and client-location decisions, then implement one public puzzle read.

After those sessions, revise effort estimates from actual work. Count the feature work
and its learning time once; linked Learn/Feature tasks reference the same evidence.
No deadline is inferred
from the old 13-day description, and no production readiness is implied by a first deploy.

Claude provided an independent advisory review of this roadmap. Incorporated: smaller
playable-loop slices, early recovery learning, and a recorded prediction versus observation.
Its review used the supplied summary; it did not independently inspect ClickUp or the repository.
For the subsequent materials research, Claude Opus ran at low effort through Herdr,
read this roadmap, and fetched current primary sources. Codex checked the final selection.
