import { WorkerEntrypoint } from "cloudflare:workers";

export type SqlValue = string | number | boolean | null | undefined;

export interface ProjectionDef<State = unknown> {
  /** Matches `Aggregate.kind`. */
  kind: string;
  /** D1 table. Must have `id TEXT PRIMARY KEY`, `version INTEGER`, `updated_at INTEGER`. */
  table: string;
  /** Map aggregate state to columns. `id`, `version` and `updated_at` are added automatically. */
  columns: (state: State, meta: { id: string; version: number }) => Record<string, SqlValue>;
}

export function defineProjection<State>(def: ProjectionDef<State>): ProjectionDef<State> {
  return def;
}

export interface ProjectionsEnv {
  DB: D1Database;
}

/**
 * The one module that writes to D1 on behalf of aggregates.
 * Expose it as a named entrypoint and bind it as `PROJECTIONS` in the Worker that hosts your
 * aggregates. Subclass it once per app and register a projection per aggregate kind.
 */
export abstract class ProjectionsBase<
  Env extends ProjectionsEnv = ProjectionsEnv,
> extends WorkerEntrypoint<Env> {
  protected abstract projections(): ProjectionDef<any>[];

  /**
   * Upsert the projection row for one aggregate. Idempotent and safe to replay out of order:
   * an existing row is only overwritten by a newer version (or an equal one when `force`).
   */
  async apply(
    kind: string,
    id: string,
    version: number,
    state: unknown,
    force = false,
  ): Promise<void> {
    const def = this.projections().find((p) => p.kind === kind);
    if (!def) throw new Error(`No projection registered for kind "${kind}"`);

    const row: Record<string, SqlValue> = {
      id,
      version,
      ...def.columns(state, { id, version }),
      updated_at: Date.now(),
    };
    const { sql, params } = versionedUpsert(def.table, row, force);
    await this.env.DB.prepare(sql).bind(...params).run();
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid SQL identifier "${name}"`);
}

function toParam(value: SqlValue): string | number | null {
  if (value === true) return 1;
  if (value === false) return 0;
  return value ?? null;
}

/**
 * Build `INSERT ... ON CONFLICT(id) DO UPDATE ... WHERE excluded.version > table.version`.
 * Exported so apps can reuse it for hand-written projections.
 */
export function versionedUpsert(
  table: string,
  row: Record<string, SqlValue>,
  force = false,
): { sql: string; params: Array<string | number | null> } {
  assertIdentifier(table);
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  for (const c of cols) assertIdentifier(c);
  if (!cols.includes("id") || !cols.includes("version")) {
    throw new Error("projection row must include id and version");
  }

  const placeholders = cols.map(() => "?").join(", ");
  const updates = cols
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const compare = force ? ">=" : ">";

  const sql =
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates} ` +
    `WHERE excluded.version ${compare} ${table}.version`;
  return { sql, params: cols.map((c) => toParam(row[c])) };
}
