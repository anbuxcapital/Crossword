import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./test/wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./test/fixtures/migrations"),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    onUnhandledError(error) {
      // An error thrown by an RPC method (Durable Object stub / ctx.exports) reaches the caller
      // as a serialized copy, but the pool's in-isolate RPC wrapper also re-reports the original
      // as an "unhandled rejection". That local copy is a duplicate of something the caller
      // already handled, so ignore it. The caller-side copy (`remote: true`) is never ignored.
      const e = error as { stack?: string; remote?: boolean } | undefined;
      const viaPoolRpcWrapper = String(e?.stack ?? "").includes(
        "vitest-pool-workers/dist/worker/lib/cloudflare/test-internal",
      );
      if (viaPoolRpcWrapper && e?.remote !== true) return false;
    },
  },
});
