import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Db, Row, SqlValue, Statement } from "../env";

const MIGRATIONS = path.join(import.meta.dir, "..", "..", "migrations");

class SqliteStatement implements Statement {
  readonly #db: Database;
  readonly #sql: string;
  readonly #values: SqlValue[];

  constructor(db: Database, sql: string, values: SqlValue[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#values = values;
  }

  bind(...values: SqlValue[]): Statement {
    return new SqliteStatement(this.#db, this.#sql, values);
  }

  // These return promises to match D1, whose calls are asynchronous.
  async first(): Promise<Row | null> {
    await Promise.resolve();
    return this.#db.query<Row, SqlValue[]>(this.#sql).get(...this.#values);
  }

  async all(): Promise<{ results: Row[] }> {
    await Promise.resolve();
    return {
      results: this.#db.query<Row, SqlValue[]>(this.#sql).all(...this.#values),
    };
  }

  async run(): Promise<object> {
    await Promise.resolve();
    return this.#db.query(this.#sql).run(...this.#values);
  }
}

/** An in-memory stand-in for D1 with the real migrations applied. */
export const testDb = (): Db & { sqlite: Database } => {
  const sqlite = new Database(":memory:", { strict: true });
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS).toSorted()) {
    sqlite.run(readFileSync(path.join(MIGRATIONS, file), "utf-8"));
  }
  return {
    batch: async (statements) =>
      await Promise.all(statements.map(async (s) => await s.run())),
    prepare: (sql) => new SqliteStatement(sqlite, sql),
    sqlite,
  };
};
