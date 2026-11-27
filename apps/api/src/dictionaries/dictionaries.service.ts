import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@logbook/shared';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, RequestMeta } from '../common/types';
import type { SqlClient } from '../db/sql-client';
import { DB } from '../db/tokens';
import { JournalsService } from '../journals/journals.service';

const TABLES: Record<string, { table: string; fields: string[] }> = {
  work_types: {
    table: 'work_types',
    fields: ['name', 'requires_permit', 'requires_site', 'active', 'sort_order'],
  },
  sites: { table: 'sites', fields: ['name', 'active'] },
  templates: { table: 'templates', fields: ['text', 'active', 'sort_order'] },
  reasons: { table: 'correction_reasons', fields: ['name', 'active'] },
  departments: { table: 'departments', fields: ['name', 'active'] },
};

@Injectable()
export class DictionariesService {
  constructor(
    @Inject(DB) private readonly db: SqlClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(JournalsService) private readonly journals: JournalsService,
  ) {}

  async snapshot(actor: AuthUser): Promise<Record<string, unknown>> {
    const workTypes = await this.db.query('select * from work_types order by sort_order, code');
    const sites = await this.db.query('select * from sites order by code');
    const templates = await this.db.query('select * from templates order by sort_order');
    const reasons = await this.db.query('select * from correction_reasons order by code');
    const departments = await this.db.query('select * from departments order by code');
    // Journals are part of the offline snapshot so the client can filter and
    // label entries by journal without an extra round-trip (JRN-03).
    const journals = await this.journals.list(actor);
    const versions = await this.db.query<{ name: string; version: number }>(
      'select name, version from dictionary_versions',
    );

    const versionOf = (name: string): number =>
      Number(versions.rows.find((row) => row.name === name)?.version ?? 1);

    return {
      snapshot_id: `ds_${new Date().toISOString().slice(0, 10)}`,
      work_types: { version: versionOf('work_types'), items: workTypes.rows },
      sites: { version: versionOf('sites'), items: sites.rows },
      templates: { version: versionOf('templates'), items: templates.rows },
      reasons: { version: versionOf('reasons'), items: reasons.rows },
      departments: { version: versionOf('departments'), items: departments.rows },
      journals: { version: versionOf('journals'), items: journals.items },
    };
  }

  async patch(
    actor: AuthUser,
    name: string,
    body: { items?: Array<Record<string, unknown>> },
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const definition = TABLES[name];
    if (!definition) {
      throw new DomainError('E-VAL-01', 'Неизвестный справочник');
    }

    for (const item of body.items ?? []) {
      const id = item.id;
      if (typeof id !== 'string') {
        throw new DomainError('E-VAL-01', 'У элемента справочника отсутствует id');
      }
      const assignments: string[] = [];
      const params: unknown[] = [];
      for (const field of definition.fields) {
        if (field in item) {
          assignments.push(`${field} = $${params.push(item[field])}`);
        }
      }
      if (assignments.length === 0) {
        continue;
      }
      params.push(id);
      await this.db.query(
        `update ${definition.table} set ${assignments.join(', ')} where id = $${params.length}`,
        params,
      );
    }

    await this.db.query(
      `insert into dictionary_versions (name, version, updated_at)
       values ($1, 1, now())
       on conflict (name) do update set version = dictionary_versions.version + 1, updated_at = now()`,
      [name],
    );

    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'dictionary.update',
      entityType: 'dictionary',
      entityId: null,
      after: { name, items: body.items?.length ?? 0 },
      source: 'server',
      ...meta,
    });

    return this.snapshot(actor);
  }
}
