import { Aggregate, ProjectionsBase, defineProjection } from "../../src";

export interface CounterState {
  count: number;
  label: string;
}

export interface Env {
  DB: D1Database;
  COUNTER: DurableObjectNamespace<Counter>;
}

/** A minimal aggregate used by the test-suite. */
export class Counter extends Aggregate<CounterState, Env> {
  readonly kind = "counter";

  protected initial(): CounterState {
    return { count: 0, label: "" };
  }

  increment(by = 1) {
    return this.commit((s) => ({ ...s, count: s.count + by }));
  }

  rename(label: string) {
    return this.commit((s) => ({ ...s, label }));
  }
}

export class Projections extends ProjectionsBase<Env> {
  protected projections() {
    return [
      defineProjection<CounterState>({
        kind: "counter",
        table: "counters",
        columns: (s) => ({ count: s.count, label: s.label }),
      }),
    ];
  }

  /** Test hook: fail while the `fail` flag is set, to exercise alarm retries. */
  override async apply(kind: string, id: string, version: number, state: unknown, force = false) {
    const flag = await this.env.DB
      .prepare("SELECT value FROM test_flags WHERE key = 'fail'")
      .first<{ value: string }>();
    if (flag?.value === "1") throw new Error("simulated projection failure");
    return super.apply(kind, id, version, state, force);
  }
}

export default {
  fetch: () => new Response("core test worker"),
} satisfies ExportedHandler<Env>;
