import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from '../common/public.decorator';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: SqlClient) {}

  @Get()
  async check(): Promise<{
    status: string;
    db: string;
    latency_ms: number;
    server_time: string;
    version: string;
  }> {
    const startedAt = Date.now();
    await this.db.query('select 1');
    return {
      status: 'ok',
      db: 'ok',
      latency_ms: Date.now() - startedAt,
      server_time: new Date().toISOString(),
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }
}
