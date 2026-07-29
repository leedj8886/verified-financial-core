import { createRequire } from "node:module";

export interface SqliteRunResult {
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...parameters: unknown[]): SqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T>(callback: () => T): () => T;
  close(): void;
}

interface DatabaseConstructor<T> {
  new(path: string): T;
}

interface BetterSqliteStatement {
  run(...parameters: unknown[]): SqliteRunResult;
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

interface BetterSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): BetterSqliteStatement;
  transaction<T>(callback: () => T): () => T;
  close(): void;
}

interface BunSqliteStatement {
  run(...parameters: unknown[]): {
    lastInsertRowid: number | bigint;
  };
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

interface BunSqliteDatabase {
  exec(sql: string): void;
  query(sql: string): BunSqliteStatement;
  transaction<T>(callback: () => T): () => T;
  close(): void;
}

function isBunRuntime(): boolean {
  return typeof (process.versions as Record<string, string | undefined>)["bun"]
    === "string";
}

export function openSqliteDatabase(path: string): SqliteDatabase {
  const require = createRequire(import.meta.url);
  if (isBunRuntime()) {
    const bunSqliteModuleId = "bun:sqlite";
    const module = require(bunSqliteModuleId) as {
      Database: DatabaseConstructor<BunSqliteDatabase>;
    };
    const database = new module.Database(path);
    return {
      exec(sql) {
        database.exec(sql);
      },
      prepare(sql) {
        const statement = database.query(sql);
        return {
          run(...parameters) {
            return statement.run(...parameters);
          },
          get(...parameters) {
            return statement.get(...parameters) ?? undefined;
          },
          all(...parameters) {
            return statement.all(...parameters);
          },
        };
      },
      transaction(callback) {
        return database.transaction(callback);
      },
      close() {
        database.close();
      },
    };
  }

  const module = require("better-sqlite3") as
    | DatabaseConstructor<BetterSqliteDatabase>
    | { default: DatabaseConstructor<BetterSqliteDatabase> };
  const Database = "default" in module ? module.default : module;
  const database = new Database(path);
  return {
    exec(sql) {
      database.exec(sql);
    },
    prepare(sql) {
      return database.prepare(sql);
    },
    transaction(callback) {
      return database.transaction(callback);
    },
    close() {
      database.close();
    },
  };
}
