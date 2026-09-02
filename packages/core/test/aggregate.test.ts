import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { aggregateStub } from "../src";

const counter = (id: string) => aggregateStub(env.COUNTER, "counter", id);

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM counters WHERE id = ?").bind(id).first();
}

async function setFail(on: boolean) {
  if (on) {
    await env.DB.prepare("INSERT OR REPLACE INTO test_flags (key, value) VALUES ('fail', '1')").run();
  } else {
    await env.DB.prepare("DELETE FROM test_flags WHERE key = 'fail'").run();
  }
}

describe("Aggregate", () => {
  it("projects the current state on every commit", async () => {
    const c = counter("a");
    const created = await c.init("a");
    expect(created).toMatchObject({ id: "a", version: 1, projected: true, state: { count: 0 } });
    expect(await row("a")).toMatchObject({ id: "a", version: 1, count: 0, label: "" });

    const snap = await c.increment(3);
    expect(snap).toMatchObject({ version: 2, projected: true, state: { count: 3 } });
    expect(await row("a")).toMatchObject({ version: 2, count: 3 });

    await c.rename("three");
    expect(await row("a")).toMatchObject({ version: 3, count: 3, label: "three" });
  });

  it("init is idempotent and refuses a different id", async () => {
    const c = counter("b");
    await c.init("b");
    await c.increment();
    const again = await c.init("b");
    expect(again.version).toBe(2);
    await expect(async () => { await c.init("other"); }).rejects.toThrow(/already initialized/);
  });

  it("rejects commands before init", async () => {
    // Wrap stub calls in an async function: awaiting the RPC promise inside it means the
    // rejection is handled exactly once (see the note in vitest.config.ts).
    await expect(async () => { await counter("nope").increment(); }).rejects.toThrow(/init\(id\)/);
    await expect(async () => { await counter("nope").snapshot(); }).rejects.toThrow(/init\(id\)/);
  });

  it("does not bump the version for a no-op commit", async () => {
    const c = counter("c");
    await c.init("c");
    const snap = await c.rename(""); // label is already ""
    expect(snap.version).toBe(1);
    expect(await row("c")).toMatchObject({ version: 1 });
  });

  it("never lets an older projection overwrite a newer row", async () => {
    const c = counter("d");
    await c.init("d");
    // Simulate D1 already holding a newer version (e.g. an out-of-order flush).
    await env.DB
      .prepare("UPDATE counters SET version = 99, count = 42 WHERE id = ?")
      .bind("d")
      .run();
    await c.increment(); // version 2 < 99, must be ignored by the upsert
    expect(await row("d")).toMatchObject({ version: 99, count: 42 });
    // reproject() forces a rewrite only for equal versions, so 99 still wins here.
    await c.reproject();
    expect(await row("d")).toMatchObject({ version: 99, count: 42 });
  });

  it("retries a failed projection through an alarm", async () => {
    await setFail(true);
    const c = counter("e");
    const created = await c.init("e");
    expect(created.projected).toBe(false); // state committed, projection pending
    expect(await row("e")).toBeNull();

    const bumped = await c.increment(5);
    expect(bumped).toMatchObject({ version: 2, projected: false });

    await setFail(false);
    const ran = await runDurableObjectAlarm(c);
    expect(ran).toBe(true);
    expect(await row("e")).toMatchObject({ version: 2, count: 5 });
    expect((await c.snapshot()).projected).toBe(true);
    // Alarm was cleared once the projection caught up.
    expect(await runDurableObjectAlarm(c)).toBe(false);
  });

  it("survives eviction with a pending flush and catches up on the next alarm", async () => {
    await setFail(true);
    const c = counter("g");
    await c.init("g");
    await c.increment(7);
    expect(await row("g")).toBeNull();

    // Tear down the in-memory instance; the constructor must reload version/projected
    // from SQLite and keep a retry alarm scheduled.
    await evictDurableObject(c);
    await setFail(false);

    expect(await runDurableObjectAlarm(c)).toBe(true);
    expect(await row("g")).toMatchObject({ version: 2, count: 7 });
    expect(await c.snapshot()).toMatchObject({ id: "g", version: 2, projected: true });
  });

  it("reproject rewrites a row with the same version (projection rebuilds)", async () => {
    const c = counter("f");
    await c.init("f");
    await c.increment(2);
    // Pretend a column was wiped by a migration; version is unchanged.
    await env.DB.prepare("UPDATE counters SET count = 0 WHERE id = ?").bind("f").run();
    expect(await row("f")).toMatchObject({ version: 2, count: 0 });
    await c.reproject();
    expect(await row("f")).toMatchObject({ version: 2, count: 2 });
  });
});
