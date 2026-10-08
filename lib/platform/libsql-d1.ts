import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types';

type LibsqlValue = unknown;

interface LibsqlRow {
  [index: number]: LibsqlValue;
  [column: string]: LibsqlValue;
}

interface LibsqlResult {
  columns: string[];
  rows: LibsqlRow[];
  rowsAffected: number;
  lastInsertRowid?: bigint | number | null;
}

interface LibsqlStatement {
  sql: string;
  args: LibsqlValue[];
}

interface LibsqlClientMethods {
  execute(statement: LibsqlStatement): Promise<LibsqlResult>;
  batch(
    statements: LibsqlStatement[],
    mode?: 'deferred' | 'read' | 'write',
  ): Promise<LibsqlResult[]>;
}

export interface LibsqlD1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

const libsqlDatabases = new WeakSet<object>();

/** Trusted runtime capability, never inferred from caller-controlled properties. */
export function isLibsqlD1Database(value: unknown): value is LibsqlD1Database {
  return (
    typeof value === 'object' && value !== null && libsqlDatabases.has(value)
  );
}

function asClient(value: unknown): LibsqlClientMethods {
  if (!value || typeof value !== 'object')
    throw new TypeError('libSQL client is required');
  const candidate = value as { execute?: unknown; batch?: unknown };
  if (
    typeof candidate.execute !== 'function' ||
    typeof candidate.batch !== 'function'
  ) {
    throw new TypeError('libSQL client must provide execute and batch');
  }
  return value as LibsqlClientMethods;
}

function rowValues(result: LibsqlResult, row: LibsqlRow): unknown[] {
  return result.columns.map((_column, index) => row[index]);
}

function rowObject(
  result: LibsqlResult,
  row: LibsqlRow,
): Record<string, unknown> {
  return Object.fromEntries(
    result.columns.map((column, index) => [column, row[index]]),
  );
}

function lastRowId(value: LibsqlResult['lastInsertRowid']): number {
  if (value === undefined || value === null) return 0;
  return Number(value);
}

function d1Result<T>(
  result: LibsqlResult,
  startedAt: number,
  rows: T[],
): D1Result<T> {
  const changes = Number.isFinite(result.rowsAffected)
    ? result.rowsAffected
    : 0;
  return {
    success: true,
    results: rows,
    meta: {
      duration: Math.max(0, Date.now() - startedAt),
      size_after: 0,
      rows_read: result.rows.length,
      rows_written: changes,
      last_row_id: lastRowId(result.lastInsertRowid),
      changed_db: changes > 0,
      changes,
    },
  };
}

class LibsqlD1PreparedStatement implements D1PreparedStatement {
  private readonly client: LibsqlClientMethods;
  private readonly query: string;
  private values: LibsqlValue[] = [];

  constructor(client: LibsqlClientMethods, query: string) {
    this.client = client;
    this.query = query;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = [...values];
    return this;
  }

  private statementFor(client: LibsqlClientMethods): LibsqlStatement {
    if (this.client !== client)
      throw new TypeError(
        'D1 batch statements must use the same libSQL client',
      );
    return { sql: this.query, args: [...this.values] };
  }

  private async execute(): Promise<{
    result: LibsqlResult;
    startedAt: number;
  }> {
    const startedAt = Date.now();
    const result = await this.client.execute(this.statementFor(this.client));
    return { result, startedAt };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = unknown>(columnName: string): Promise<T | null>;
  async first<T>(columnName?: string): Promise<T | null> {
    const { result } = await this.execute();
    const row = result.rows[0];
    if (!row) return null;
    if (columnName !== undefined) {
      const index = result.columns.indexOf(columnName);
      return (index < 0 ? null : row[index]) as T | null;
    }
    return rowObject(result, row) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const { result, startedAt } = await this.execute();
    return d1Result(
      result,
      startedAt,
      result.rows.map((row) => rowObject(result, row) as T),
    );
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const { result, startedAt } = await this.execute();
    return d1Result<T>(result, startedAt, []);
  }

  async raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    const { result } = await this.execute();
    const rows = result.rows.map((row) => rowValues(result, row));
    if (options?.columnNames === true)
      return [result.columns.slice(), ...rows] as [string[], ...T[]];
    return rows as T[];
  }

  statementForBatch(client: LibsqlClientMethods): LibsqlStatement {
    return this.statementFor(client);
  }
}

export function createLibsqlD1Database(client: unknown): LibsqlD1Database {
  const methods = asClient(client);
  const database: LibsqlD1Database = {
    prepare(query: string): D1PreparedStatement {
      if (typeof query !== 'string')
        throw new TypeError('D1 queries must be strings');
      return new LibsqlD1PreparedStatement(methods, query);
    },
    async batch<T = unknown>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      if (!Array.isArray(statements))
        throw new TypeError('D1 batch statements must be an array');
      const prepared = statements.map((statement) => {
        if (!(statement instanceof LibsqlD1PreparedStatement)) {
          throw new TypeError(
            'D1 batch statements must come from this adapter',
          );
        }
        return statement.statementForBatch(methods);
      });
      if (prepared.length === 0) return [];
      const startedAt = Date.now();
      const results = await methods.batch(prepared, 'write');
      return results.map((result) =>
        d1Result(
          result,
          startedAt,
          result.rows.map((row) => rowObject(result, row) as T),
        ),
      );
    },
  };
  libsqlDatabases.add(database);
  return database;
}

export const createLibsqlD1 = createLibsqlD1Database;
