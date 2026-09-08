# Cloudflare materials for building Crosscut

Checked live on **2026-09-07**. Claude Opus, running at low effort through Herdr,
researched candidate materials; Codex reviewed the selection against the game plan
and independently checked the primary documentation. Dates below are the pages'
visible last-updated dates, not a promise that every embedded example is current.

Use this alongside [the learning roadmap](CLOUDFLARE-LEARNING-PLAN.md). Read the
specified section when its feature is active, then trace the equivalent code in
Crosscut. AI writes the implementation; Peter uses the question to explain a decision.
Start with items 1–3; item 4 becomes useful as soon as the first request is deployed.

## Read now — the first game Worker

| Material / updated | Read this part | Apply it to Crosscut | Explain afterwards |
| --- | --- | --- | --- |
| **1. [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)** — Sep 4, 2026 | Environments, compatibility date, D1 and Durable Object bindings, DO exports. Skim unrelated products. | Identify what belongs in `wrangler.jsonc` and what changes between development and production. | Which bindings must be declared separately for a named environment? |
| **2. [Local development](https://developers.cloudflare.com/workers/local-development/)** — Aug 20, 2026 | Core concepts, defaults, remote bindings, and remote development. | Distinguish where gateway code executes from which database a binding reaches. | Can locally running code change a remote D1 database, and what config makes that possible? |
| **3. [Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)** — Jul 22, 2026 | What a binding is, the resource-access example, and bindings in global scope. | Trace `env.DB` or a User namespace from config into a handler. The example also previews R2 without requiring a separate lab. | How does the binding give the Worker both an API and access to the resource? |
| **4. [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)** — Aug 11, 2026 | Enabling logs, invocation logs, custom logs, and sampling. | Find the evidence for a `/v1/healthz` request and then a game command. | What does sampling mean when a request's logs are absent? |

Use the [Node compatibility reference](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
for flag decisions: the general best-practices page still shows an explicit
`nodejs_compat` flag, while the dedicated reference documents defaults for dates
at or after 2026-08-04. Check the runtime requirement rather than copying a snippet.

## Read when the corresponding feature is active

| Material / updated | Read this part | Apply it to Crosscut | Explain afterwards |
| --- | --- | --- | --- |
| **5. [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)** — Jun 8, 2026 | Migration files and ordering, Wrangler customizations, foreign-key constraints. | Create the content schema and understand which database records an applied migration. | Why does applying a migration locally leave the deployed database unchanged? |
| **6. [D1 prepared statement methods](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)** — Jun 22, 2026 | `bind()`, `first()`, `all()`, and `run()`. | Follow a puzzle ID from an HTTP request into a parameterized query and a public response. | Which selected columns belong in the response, and which must remain server-side? |
| **7. [Access Durable Objects storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)** — Jul 3, 2026 | SQLite-backed objects, initialization from storage, and the DO SQL versus D1 comparison. | Read its storage example alongside `packages/core/src/aggregate.ts`. Find the durable snapshot and the separate D1 projection. | After a restart, which fields can be reconstructed, and from which store? |
| **8. [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)** — Aug 20, 2026 | Storage/state, input gates, asynchronous interleaving, and appropriate use of `blockConcurrencyWhile()`. | Review one player command's mutation and I/O boundaries before adding rewards. | At which await could another request run, and what protects the invariant? |
| **9. [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)** — Apr 21, 2026 | Background guarantees, `setAlarm`, the alarm handler, retries and constructor interactions. | Trace the existing projection retry path early in the User feature, then revisit it during recovery work. | Does a failed projection mean the committed game result was lost? What wakes the repair? |
| **10. [Single Page Application routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)** — Aug 25, 2026 | Configuration, navigation requests, advanced routing control, and its complete Worker example. | Serve the Expo web export and API together; adapt the example's API prefix to `/v1/*`. | Why might entering an API URL in the browser behave differently from fetching it unless routing is explicit? |

**One worked example to trace:** item 10's configuration plus handler. Predict the
path taken by `/`, a client-side screen URL, `/v1/healthz`, and a missing `/v1/*`
route. Compare with the game's actual responses when that slice is implemented.
This directly supports the planned web export; it is not a separate throwaway app.

For the first storage request, the examples in items 6–7 are smaller and more relevant
than adopting an entire starter repository with unrelated dependencies.

The native app and web export are separate delivery paths in IMP-07: native builds
bundle their UI and call the API, while the web export uses Worker static assets.
The recommendation here preserves both. See the [existing client task](https://app.clickup.com/t/869ew47py).

When diagnosing an actual failure, consult [Errors and exceptions](https://developers.cloudflare.com/workers/observability/errors/)
(Jun 16, 2026): begin with the observed error code or invocation outcome. Keep it
as a lookup reference rather than another page to memorize.

## Optional later — after a playable game

| Material / updated | Read this part | Use only for this purpose | Explain afterwards |
| --- | --- | --- | --- |
| **11. [Build your first Workflow](https://developers.cloudflare.com/workflows/get-started/guide/)** — Aug 25, 2026 | The Workflow implementation, durable steps, sleeping and retries, then instance inspection. | Explore a real puzzle drafting/validation pipeline when it is useful. Keep ordinary game commands in their existing domain path. | Which work is replayed after a failure, and which completed step results are reused? |
| **12. [Build a remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)** — Jul 27, 2026 | Approach comparison, current example selection, and authentication/authorization. | Build read-only editorial tools over existing content services as the capstone. | How can stateless MCP transport call services with durable game state? |

## How to avoid stale material

- Prefer the current product/API reference over a conflicting general tutorial.
  A recent page date does not guarantee every copied snippet was refreshed.
- Item 11 is selected for its Workflow implementation. Its prerequisite text still
  mentions Node 16.17; use the requirements of the selected Wrangler release instead
  of treating that old minimum as a toolchain recommendation.
  [Workflow guide](https://developers.cloudflare.com/workflows/get-started/guide/)
- The MCP guide explicitly warns that its quick-deploy templates still use
  deprecated `McpAgent`. Follow its current-example direction instead.
  [MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- For a new Worker, use the documented DO `exports` approach. Existing examples
  with legacy class `migrations` can teach concepts, but their deployment config
  must be reviewed. D1 SQL migrations are a different mechanism.
  [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- A Workers virtual filesystem exists; request-local `/tmp` is not durable storage.
  Do not retain the old blanket statement that Workers have no filesystem.
  [Filesystem reference](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)
- Compare package APIs with the installed versions before adapting code. The Vitest
  integration package was renamed; that does not mean an older conceptual explanation
  is useless. Follow the [migration guide](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/)
  only when maintaining the existing setup. Peter's no-new-tests agreement still applies.

Recheck the relevant source immediately before changing deployment configuration,
storage lifecycle, authentication, or an SDK integration. Record the selected package
version and compatibility date with the implementation decision.
