import { Inject, Injectable } from '@nestjs/common';
import { DomainError, normalizeSiteName, uuidv7 } from '@logbook/shared';
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
  ): Promise<Record<string, unknown>> {    const definition = TABLES[name];
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

  async unresolvedSites(): Promise<{
    items: Array<{ site_name_raw: string; normalized_name: string; count: number }>;
  }> {
    const [entries, ignored] = await Promise.all([
      this.db.query<{ site_name_raw: string }>(
        `select site_name_raw from journal_entries
          where status = 'active'
            and site_name_raw is not null
            and site_binding_status in ('unresolved', 'not_found')`,
      ),
      this.db.query<{ normalized_name: string }>(
        'select normalized_name from site_raw_ignores',
      ),
    ]);
    const ignoredNames = new Set(ignored.rows.map((row) => row.normalized_name));
    const grouped = new Map<
      string,
      { site_name_raw: string; normalized_name: string; count: number }
    >();
    for (const row of entries.rows) {
      const normalized = normalizeSiteName(row.site_name_raw);
      if (ignoredNames.has(normalized)) continue;
      const current = grouped.get(normalized) ?? {
        site_name_raw: row.site_name_raw,
        normalized_name: normalized,
        count: 0,
      };
      current.count += 1;
      grouped.set(normalized, current);
    }
    return { items: [...grouped.values()].sort((left, right) => right.count - left.count) };
  }

  private async bindRawTx(
    tx: SqlClient,
    actor: AuthUser,
    raw: string,
    siteId: string,
    meta: RequestMeta,
  ): Promise<number> {
    const normalized = normalizeSiteName(raw);
    const entries = await tx.query<{ id: string; site_name_raw: string }>(
      `select id, site_name_raw from journal_entries
        where status = 'active' and site_name_raw is not null`,
    );
    const ids = entries.rows
      .filter((row) => normalizeSiteName(row.site_name_raw) === normalized)
      .map((row) => row.id);
    if (ids.length > 0) {
      await tx.query(
        `update journal_entries
            set site_id = $1,
                site_binding_status = 'linked',
                updated_at_server = now()
          where id = any($2::uuid[])`,
        [siteId, ids],
      );
    }
    await this.audit.record(tx, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'site.bind_from_raw',
      entityType: 'site',
      entityId: siteId,
      after: { site_name_raw: raw, normalized_name: normalized, entries: ids.length },
      source: 'server',
      ...meta,
    });
    return ids.length;
  }

  async bindSiteFromRaw(
    actor: AuthUser,
    raw: string,
    siteId: string,
    meta: RequestMeta,
  ): Promise<{ updated_entries: number }> {
    const site = await this.db.query<{ id: string; name: string; active: boolean }>(
      'select id, name, active from sites where id = $1',
      [siteId],
    );
    if (!site.rows[0]?.active) {
      throw new DomainError('E-NOT-01', 'Объект не найден в справочнике');
    }
    const updated = await this.db.transaction((tx) =>
      this.bindRawTx(tx, actor, raw, siteId, meta),
    );
    return { updated_entries: updated };
  }

  async createSiteFromRaw(
    actor: AuthUser,
    body: { name: string; code?: string },
    meta: RequestMeta,
  ): Promise<Record<string, unknown>> {
    const name = body.name.trim();
    if (name.length < 2 || name.length > 120) {
      throw new DomainError('E-VAL-01', 'Название объекта: 2–120 символов');
    }
    const code = (body.code?.trim() || `RAW-${uuidv7().slice(-8)}`).toUpperCase();
    if (!/^[A-Z0-9_-]{2,32}$/.test(code)) {
      throw new DomainError('E-VAL-01', 'Код объекта: 2–32 символа A-Z/0-9/-/_');
    }
    const id = uuidv7();
    const result = await this.db.transaction(async (tx) => {
      const existing = await tx.query('select id from sites where code = $1', [code]);
      if (existing.rows[0]) {
        throw new DomainError('E-VAL-01', 'Объект с таким кодом уже существует');
      }
      const site = await tx.query(
        `insert into sites (id, code, name, active)
         values ($1, $2, $3, true) returning *`,
        [id, code, name],
      );
      const updated = await this.bindRawTx(tx, actor, name, id, meta);
      await this.audit.record(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'site.create_from_raw',
        entityType: 'site',
        entityId: id,
        after: { name, code, updated_entries: updated },
        source: 'server',
        ...meta,
      });
      return { site: site.rows[0], updated_entries: updated };
    });
    return result;
  }

  async ignoreRaw(
    actor: AuthUser,
    raw: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const display = raw.trim();
    if (display.length < 2 || display.length > 120) {
      throw new DomainError('E-VAL-01', 'Название объекта: 2–120 символов');
    }
    const normalized = normalizeSiteName(display);
    await this.db.query(
      `insert into site_raw_ignores (normalized_name, display_name, ignored_by)
       values ($1, $2, $3)
       on conflict (normalized_name) do update
         set display_name = excluded.display_name,
             ignored_by = excluded.ignored_by,
             ignored_at = now()`,
      [normalized, display, actor.id],
    );
    await this.audit.record(this.db, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'site.ignore_raw',
      entityType: 'site',
      entityId: null,
      after: { site_name_raw: display, normalized_name: normalized },
      source: 'server',
      ...meta,
    });
    return { ok: true };
  }
}
