import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "./fixtures/worker";

// `env` (from "cloudflare:workers") is typed as Cloudflare.Env. In an app, `wrangler types`
// generates this declaration; the test-suite declares it by hand from the fixture worker.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
