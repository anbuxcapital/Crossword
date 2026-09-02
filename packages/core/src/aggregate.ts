import { DurableObject } from "cloudflare:workers";
import { NotInitializedError } from "./errors";

/** What every command returns: the authoritative state right after the commit. */
export interface Snapshot<State> {
  id: string;
  version: number;
  state: State;
  /** True when the D1 projection is known to be at this version or newer. */
  projected: boolean;
}

/**
 * Structural type of the projections target: a `Service<YourProjections>` service-binding stub,
 * or the loopback stub `ctx.exports.Projections` (same Worker, no binding needed).
 */
export interface ProjectionsBinding {
  apply(
    kind: string,
    id: string,
    version: number,
    state: unknown,
    force?: boolean,
  ): Promise<unknown>;
}

export interface AggregateEnv {
  /** Optional: only needed when the Projections entrypoint lives in a different Worker. */
  PROJECTIONS?: ProjectionsBinding;
}

/** One step of an object-local schema migration (extra tables inside the object's SQLite). */
export type SchemaMigration = (sql: SqlStorage) => void;

/**
 * "await": commands resolve after the projection is written to D1 (default; read-your-writes on lists).
 * "background": commands resolve as soon as the object's own SQLite is updated.
 */
export type FlushMode = "await" | "background";

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Base class for a Durable Object that owns the *current state* of one entity.
 *
 * - State is a plain JSON value stored as a single snapshot row in the object's SQLite.
 * - Every commit bumps a monotonic `version` and pushes the snapshot to the `Projections`
 *   entrypoint, which upserts a row in D1 (the read model / registry).
 * - `version > projected` is the only "outbox". A failed push schedules an alarm and retries
 *   with exponential backoff. No event log, no queue, nothing subscribes to anything.
 *
 * Subclasses provide `kind`, `initial()`, and command methods that call `commit()`.
 */
export abstract class Aggregate<
  State,
  Env extends object = AggregateEnv,
> extends DurableObject<Env> {
  /** Must match a projection registered in the Projections entrypoint. */
  abstract readonly kind: string;

  /** Initial state for a newly created aggregate. Must be plain JSON. */
  protected abstract initial(id: string): State;

  /** Override in a subclass to change when commands resolve. */
  protected flushMode: FlushMode = "await";

  #id: string | null = null;
  #state: State | null = null;
  #version = 0;
  #projected = 0;
  #retries = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The SQLite API is synchronous, so setup completes before any RPC method can run.
    this.#migrate();
    this.#load();
    // Safety net: a flush was pending when this object was last evicted.
    if (this.#version > this.#projected) void this.#scheduleRetry();
  }

  /**
   * Optional migrations for extra tables inside the object. Applied in order, once per object,
   * tracked by index. Must be a method (not an arrow-function field): it runs from the base
   * constructor, before subclass field initializers.
   */
  protected schemaMigrations(): SchemaMigration[] {
    return [];
  }

  /**
   * Create the aggregate. Idempotent: calling it again with the same id is a no-op that
   * returns the current snapshot. The first projection is also what registers the id in D1.
   */
  async init(id: string): Promise<Snapshot<State>> {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("init(id): id must be a non-empty string");
    }
    if (this.#id !== null) {
      if (this.#id !== id) {
        throw new Error(`${this.kind} aggregate is already initialized as "${this.#id}"`);
      }
      return this.snapshot();
    }
    const first = this.initial(id);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE aggregate SET id = ? WHERE key = 1", id);
      this.#persist(first);
    });
    this.#id = id;
    await this.#flushAfterCommit();
    return this.snapshot();
  }

  isInitialized(): boolean {
    return this.#id !== null;
  }

  /** Strongly consistent read of the current state. */
  snapshot(): Snapshot<State> {
    this.#requireInit();
    return {
      id: this.#id as string,
      version: this.#version,
      state: this.#state as State,
      projected: this.#projected >= this.#version,
    };
  }

  /**
   * Run a command. `mutate` receives a clone of the current state and returns the next state.
   * Returning an equal state is a no-op (no version bump, no projection), which makes
   * naturally idempotent commands (e.g. webhook replays) free.
   */
  protected async commit(mutate: (state: State) => State): Promise<Snapshot<State>> {
    this.#requireInit();
    const next = mutate(structuredClone(this.#state as State));
    this.#persist(next);
    await this.#flushAfterCommit();
    return this.snapshot();
  }

  /**
   * Push the latest snapshot to D1 if it is newer than what was last projected.
   * Returns true when the projection is up to date afterwards.
   */
  async flush(force = false): Promise<boolean> {
    if (this.#id === null || this.#state === null) return true;
    if (!force && this.#version <= this.#projected) return true;

    const id = this.#id;
    const version = this.#version;
    const state = this.#state;
    try {
      await this.resolveProjections().apply(this.kind, id, version, state, force);
    } catch (err) {
      console.warn(
        `[${this.kind}:${id}] projection v${version} failed: ${(err as Error)?.message ?? err}`,
      );
      await this.#scheduleRetry();
      return false;
    }

    this.#retries = 0;
    if (version > this.#projected) {
      this.#projected = version;
      this.sql.exec("UPDATE aggregate SET projected = ? WHERE key = 1", version);
    }
    if (this.#version <= this.#projected) await this.ctx.storage.deleteAlarm();
    return true;
  }

  /**
   * Re-push the current snapshot even if D1 already has this version
   * (used to rebuild a projection after adding columns).
   */
  async reproject(): Promise<boolean> {
    this.#requireInit();
    this.#projected = 0;
    this.sql.exec("UPDATE aggregate SET projected = 0 WHERE key = 1");
    return this.flush(true);
  }

  /** Alarm handler: retry a pending flush. */
  async alarm(): Promise<void> {
    await this.flush();
  }

  /** The object's SQLite handle, for subclasses with extra tables. */
  protected get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /**
   * Where snapshots are pushed. Resolution order:
   *  1. `env.PROJECTIONS` — a service binding (Projections lives in another Worker, or you
   *     prefer explicit wiring);
   *  2. `ctx.exports.Projections` — the loopback stub for a `Projections` class exported from
   *     this same Worker (requires the `enable_ctx_exports` compatibility flag).
   * Override to change the lookup.
   */
  protected resolveProjections(): ProjectionsBinding {
    const bound = (this.env as AggregateEnv).PROJECTIONS;
    if (bound) return bound;
    const loopback = (this.ctx.exports as Record<string, unknown> | undefined)?.Projections;
    if (loopback) return loopback as ProjectionsBinding;
    throw new Error(
      `${this.kind}: no projections target. Bind PROJECTIONS to the Projections entrypoint, ` +
        "or export a `Projections` class from this Worker and enable `enable_ctx_exports`.",
    );
  }

  // ---------------------------------------------------------------- internals

  #requireInit(): void {
    if (this.#id === null) throw new NotInitializedError(this.kind);
  }

  /** Write the next state if it differs from the current one. Synchronous. */
  #persist(next: State): boolean {
    const json = JSON.stringify(next);
    if (typeof json !== "string") {
      throw new TypeError(`${this.kind}: state must be JSON-serializable`);
    }
    if (this.#state !== null && json === JSON.stringify(this.#state)) return false;

    const version = this.#version + 1;
    this.sql.exec("UPDATE aggregate SET version = ?, state = ? WHERE key = 1", version, json);
    // Re-parse so in-memory state matches what was stored (drops undefined, Dates become strings).
    this.#state = JSON.parse(json) as State;
    this.#version = version;
    return true;
  }

  async #flushAfterCommit(): Promise<void> {
    if (this.#version <= this.#projected) return;
    if (this.flushMode === "await") {
      await this.flush();
    } else {
      this.ctx.waitUntil(this.flush());
    }
  }

  #scheduleRetry(): Promise<void> {
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.#retries);
    this.#retries = Math.min(this.#retries + 1, 10);
    return this.ctx.storage.setAlarm(Date.now() + delay);
  }

  #migrate(): void {
    const sql = this.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS aggregate (
        key            INTEGER PRIMARY KEY CHECK (key = 1),
        id             TEXT,
        version        INTEGER NOT NULL DEFAULT 0,
        projected      INTEGER NOT NULL DEFAULT 0,
        schema_version INTEGER NOT NULL DEFAULT 0,
        state          TEXT
      )
    `);
    sql.exec("INSERT OR IGNORE INTO aggregate (key) VALUES (1)");

    const steps = this.schemaMigrations();
    let applied = Number(sql.exec("SELECT schema_version FROM aggregate WHERE key = 1").one().schema_version);
    while (applied < steps.length) {
      const step = steps[applied];
      const next = applied + 1;
      this.ctx.storage.transactionSync(() => {
        step(sql);
        sql.exec("UPDATE aggregate SET schema_version = ? WHERE key = 1", next);
      });
      applied = next;
    }
  }

  #load(): void {
    const row = this.sql
      .exec("SELECT id, version, projected, state FROM aggregate WHERE key = 1")
      .one();
    this.#id = (row.id as string | null) ?? null;
    this.#version = Number(row.version);
    this.#projected = Number(row.projected);
    this.#state = row.state == null ? null : (JSON.parse(row.state as string) as State);
  }
}
