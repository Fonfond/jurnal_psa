export interface SqlResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Minimal SQL client abstraction. Production uses pg.Pool, local/test uses PGlite.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<SqlResult<T>>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  /**
   * PostgreSQL transaction-scoped advisory lock. Used to serialize the audit
   * hash-chain per stream (read-last-seq + insert is racy across connections).
   * Absent on PGlite (single connection in local/test) — callers must guard.
   */
  advisoryXactLock?(key: string): Promise<void>;
  close(): Promise<void>;
}
