import { PGlite } from '@electric-sql/pglite';
import type { SqlClient, SqlResult } from './sql-client';

export class PgliteSqlClient implements SqlClient {
  private readonly db: PGlite;
  private readonly ready: Promise<unknown>;

  constructor(dataDir?: string) {
    this.db = dataDir ? new PGlite(dataDir) : new PGlite();
    const ready = (this.db as unknown as { waitReady?: Promise<unknown> }).waitReady;
    this.ready = ready ?? Promise.resolve();
  }

  async query<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<SqlResult<T>> {
    await this.ready;
    const result = await this.db.query<T>(text, params as never[]);
    return {
      rows: result.rows,
      rowCount:
        (result as unknown as { affectedRows?: number }).affectedRows ??
        result.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.ready;
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    await this.exec('BEGIN');
    const tx: SqlClient = {
      query: (text, params) => this.query(text, params),
      exec: (sql) => this.exec(sql),
      transaction: (nested) => nested(tx),
      close: async () => undefined,
    };

    try {
      const result = await fn(tx);
      await this.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        await this.exec('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.ready;
    await this.db.close();
  }
}
