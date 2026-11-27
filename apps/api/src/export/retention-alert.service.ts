import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '@logbook/shared';
import { loadEnv } from '../config/env';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';

export type RetentionAlertSeverity = 'info' | 'warning' | 'critical';

export interface RetentionAlert {
  id: string;
  created_at: string;
  kind: string;
  severity: RetentionAlertSeverity;
  message: string;
  context: Record<string, unknown>;
  delivered_at: string | null;
  delivery_error: string | null;
}

/**
 * REP-05 alerts: persisted in retention_alerts (admin UI/audit), logged, and
 * optionally delivered to an ops webhook. Alert delivery never rolls back the
 * retention run: a failed webhook is stored in delivery_error.
 */
@Injectable()
export class RetentionAlertService {
  private readonly logger = new Logger('RetentionAlert');

  constructor(@Inject(DB) private readonly db: SqlClient) {}

  async raise(
    kind: string,
    severity: RetentionAlertSeverity,
    message: string,
    context: Record<string, unknown> = {},
  ): Promise<RetentionAlert> {
    const id = uuidv7();
    const created = await this.db.query<RetentionAlert>(
      `insert into retention_alerts (id, kind, severity, message, context)
       values ($1, $2, $3, $4, $5::jsonb)
       returning id, created_at, kind, severity, message, context, delivered_at, delivery_error`,
      [id, kind, severity, message.slice(0, 1000), JSON.stringify(context)],
    );
    if (severity === 'critical') {
      this.logger.error(`${kind}: ${message}`);
    } else {
      this.logger.warn(`${kind}: ${message}`);
    }

    const alert = created.rows[0] as RetentionAlert;
    const env = loadEnv();
    if (!env.RETENTION_ALERT_WEBHOOK_URL) {
      return alert;
    }

    try {
      const response = await fetch(env.RETENTION_ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          source: 'logbook',
          alert,
          context,
        }),
        signal: AbortSignal.timeout(env.RETENTION_ALERT_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const delivered = await this.db.query<RetentionAlert>(
        `update retention_alerts
            set delivered_at = now(), delivery_error = null
          where id = $1
          returning id, created_at, kind, severity, message, context, delivered_at, delivery_error`,
        [id],
      );
      return delivered.rows[0] as RetentionAlert;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`webhook delivery failed (${kind}): ${reason}`);
      const failed = await this.db.query<RetentionAlert>(
        `update retention_alerts
            set delivery_error = $2
          where id = $1
          returning id, created_at, kind, severity, message, context, delivered_at, delivery_error`,
        [id, reason.slice(0, 500)],
      );
      return failed.rows[0] as RetentionAlert;
    }
  }

  async list(limit = 50): Promise<RetentionAlert[]> {
    const result = await this.db.query<RetentionAlert>(
      `select id, created_at, kind, severity, message, context,
              delivered_at, delivery_error
         from retention_alerts
        order by created_at desc
        limit $1`,
      [Math.min(Math.max(limit, 1), 200)],
    );
    return result.rows;
  }

  async countSince(hours: number): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `select count(*)::text as count
         from retention_alerts
        where created_at > now() - ($1::text || ' hours')::interval`,
      [String(hours)],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
