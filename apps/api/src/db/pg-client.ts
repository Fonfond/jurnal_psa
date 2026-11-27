import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import type { SqlClient, SqlResult } from './sql-client';

export interface PgTlsOptions {
  rejectUnauthorized: boolean;
  ca?: string;
}

export interface PgClientOptions {
  max?: number;
  ssl?: PgTlsOptions;
}

export class PgSqlClient implements SqlClient {
  private readonly pool: Pool;

  constructor(connectionString: string, options: PgClientOptions = {}) {
    this.pool = new Pool({
      connectionString,
      max: options.max ?? 10,
      ...(options.ssl ? { ssl: options.ssl } : {}),
    });
  }

  /** Reads a PEM CA bundle for `DATABASE_SSL_MODE=verify-full`. */
  static loadCa(caPath: string): string {
    return readFileSync(caPath, 'utf8');
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<SqlResult<T>> {
    const result = await this.pool.query(text, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async advisoryXactLock(key: string): Promise<void> {
    await this.pool.query('select pg_advisory_xact_lock(hashtext($1))', [key]);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    const tx: SqlClient = {
      query: async <R = Record<string, unknown>>(text: string, params: unknown[] = []) => {
        const result = await connection.query(text, params);
        return { rows: result.rows as R[], rowCount: result.rowCount ?? result.rows.length };
      },
      exec: async (sql: string) => {
        await connection.query(sql);
      },
      advisoryXactLock: async (key: string) => {
        await connection.query('select pg_advisory_xact_lock(hashtext($1))', [key]);
      },
      transaction: (nested) => nested(tx),
      close: async () => undefined,
    };

    try {
      await connection.query('BEGIN');
      const result = await fn(tx);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
