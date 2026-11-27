import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { loadEnv } from '../config/env';
import { RetentionAlertService } from './retention-alert.service';
import { parseScheduleUtc, nextScheduledRun } from './retention-schedule';
import { RetentionService } from './retention.service';

/**
 * REP-05: daily in-process retention scheduler.
 * - disabled in test runs (timer must not leak into specs) and when
 *   RETENTION_SCHEDULER_ENABLED=false (external cron/systemd timer);
 * - idempotent per UTC day (retention_runs unique partial index);
 * - failures/stale runs produce persisted alerts + optional webhook.
 */
@Injectable()
export class RetentionSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('RetentionScheduler');
  private timer: NodeJS.Timeout | null = null;
  private plannedAt: Date | null = null;

  constructor(
    private readonly retention: RetentionService,
    private readonly alerts: RetentionAlertService,
  ) {}

  onApplicationBootstrap(): void {
    const env = loadEnv();
    if (!env.RETENTION_SCHEDULER_ENABLED || env.NODE_ENV === 'test') {
      return;
    }
    this.scheduleNext();
    void this.checkOverdue().catch((error: unknown) => {
      this.logger.error(
        `overdue check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): {
    enabled: boolean;
    schedule_utc: string;
    next_run_at: string | null;
  } {
    const env = loadEnv();
    return {
      enabled: env.RETENTION_SCHEDULER_ENABLED,
      schedule_utc: env.RETENTION_SCHEDULE_UTC,
      next_run_at: this.plannedAt?.toISOString() ?? null,
    };
  }

  /** Runs the daily job now (admin endpoint / tests). Idempotent per day. */
  async runNow(nowInput?: string): Promise<Record<string, unknown>> {
    const now = nowInput ? new Date(nowInput) : new Date();
    if (Number.isNaN(now.getTime())) {
      throw new Error('Некорректное время запуска планировщика');
    }
    return this.retention.runScheduled(now.toISOString());
  }

  /** Alert when the last successful run is older than RETENTION_OVERDUE_HOURS. */
  async checkOverdue(now = new Date()): Promise<boolean> {
    const env = loadEnv();
    const last = await this.retention.latestSuccessfulRun();
    const lastAt = last?.run_at ? new Date(last.run_at).getTime() : null;
    const overdueMs = env.RETENTION_OVERDUE_HOURS * 60 * 60 * 1000;
    if (lastAt !== null && now.getTime() - lastAt <= overdueMs) {
      return false;
    }
    await this.alerts.raise(
      'run_overdue',
      'critical',
      lastAt === null
        ? 'Retention ещё ни разу не выполнялся успешно'
        : `Последний успешный retention-run старше ${env.RETENTION_OVERDUE_HOURS} ч`,
      {
        last_success_at: last?.run_at ?? null,
        overdue_hours: env.RETENTION_OVERDUE_HOURS,
      },
    );
    return true;
  }

  private scheduleNext(): void {
    const env = loadEnv();
    const { hour, minute } = parseScheduleUtc(env.RETENTION_SCHEDULE_UTC);
    this.plannedAt = nextScheduledRun(new Date(), hour, minute);
    const delay = Math.max(1000, this.plannedAt.getTime() - Date.now());
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    // Do not keep the Node process alive in scripts/tests.
    this.timer.unref?.();
    this.logger.log(
      `Retention scheduler planned at ${this.plannedAt.toISOString()} (${env.RETENTION_SCHEDULE_UTC} UTC)`,
    );
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.runNow();
      if (result.skipped) {
        this.logger.log(`Retention run skipped: ${String(result.reason ?? 'already ran')}`);
      } else {
        this.logger.log(`Retention run completed: ${String(result.id)}`);
      }
    } catch (error) {
      this.logger.error(
        `Retention scheduler tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.scheduleNext();
    }
  }
}
