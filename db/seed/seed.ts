import { hashSync } from 'bcryptjs';
import {
  DEMO_ENTRIES,
  DEMO_PERMIT_PARTICIPANTS,
  DEMO_PERMITS,
  SEED_DEPARTMENTS,
  SEED_DEVICES,
  SEED_DICTIONARY_VERSIONS,
  SEED_ENTRIES,
  SEED_JOURNALS,
  SEED_PERMIT_PARTICIPANTS,
  SEED_PERMITS,
  SEED_REASONS,
  SEED_SITES,
  SEED_TEMPLATES,
  SEED_TIMESTAMPS,
  SEED_USERS,
  SEED_WORK_TYPES,
} from '@logbook/shared';

interface SeedClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface SeedSummary {
  users: number;
  entries: number;
  permits: number;
}

export interface SeedOptions {
  /**
   * Test/demo fixtures (3 permits and 5 synthetic entries).  The local demo
   * seed disables them by default: the operator imports real permits and
   * creates real journal records.  Unit/integration tests keep them enabled
   * for deterministic assertions.
   */
  demoData?: boolean;
  /** test = deterministic 3/5 fixtures; electrical = domain demo 6/9. */
  demoProfile?: 'test' | 'electrical';
}

function arrayLiteral(values: readonly string[]): string {
  return `{${values.join(',')}}`;
}

/**
 * Deterministic seed. Safe to run repeatedly: existing rows are kept.
 * IDs and HLC values come from @logbook/shared/seed-data.
 */
export async function seedDatabase(
  client: SeedClient,
  password: string,
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const demoData = options.demoData ?? true;
  const demoProfile = options.demoProfile ?? 'test';
  const permits = demoProfile === 'electrical' ? DEMO_PERMITS : SEED_PERMITS;
  const participants =
    demoProfile === 'electrical'
      ? DEMO_PERMIT_PARTICIPANTS
      : SEED_PERMIT_PARTICIPANTS;
  const entries = demoProfile === 'electrical' ? DEMO_ENTRIES : SEED_ENTRIES;
  const passwordHash = hashSync(password, 10);

  for (const [index, department] of SEED_DEPARTMENTS.entries()) {
    await client.query(
      `insert into departments (id, code, name, parent_id)
       values ($1, $2, $3, $4)
       on conflict (id) do nothing`,
      [
        department.id,
        department.code,
        department.name,
        index === 0 ? null : department.parent_id,
      ],
    );
  }

  for (const user of SEED_USERS) {
    await client.query(
      `insert into users
         (id, external_id, full_name, personnel_no, email, phone, role, department_id, position, status)
       values
         ($1, $2, $3, $4, $5, $6, $7::user_role_enum, $8, $9, $10::user_status_enum)
       on conflict (id) do nothing`,
      [
        user.id,
        user.external_id,
        user.full_name,
        user.personnel_no,
        user.email,
        user.phone,
        user.role,
        user.department_id,
        user.position,
        user.status,
      ],
    );
  }

  for (const user of SEED_USERS) {
    await client.query(
      `insert into user_credentials (user_id, password_hash)
       values ($1, $2)
       on conflict (user_id) do nothing`,
      [user.id, passwordHash],
    );
  }

  for (const device of SEED_DEVICES) {
    await client.query(
      `insert into devices (id, user_id, name, platform, app_version)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing`,
      [device.id, device.user_id, device.name, device.platform, device.app_version],
    );
  }

  for (const workType of SEED_WORK_TYPES) {
    await client.query(
      `insert into work_types
         (id, code, name, requires_permit, requires_site, default_template_id, active, sort_order)
       values ($1, $2, $3, $4, $5, null, true, $6)
       on conflict (id) do nothing`,
      [
        workType.id,
        workType.code,
        workType.name,
        workType.requires_permit,
        workType.requires_site,
        workType.sort_order,
      ],
    );
  }

  for (const site of SEED_SITES) {
    await client.query(
      `insert into sites (id, code, name, parent_id)
       values ($1, $2, $3, $4)
       on conflict (id) do nothing`,
      [site.id, site.code, site.name, site.parent_id],
    );
  }

  for (const template of SEED_TEMPLATES) {
    await client.query(
      `insert into templates (id, work_type_id, text, tags, active, sort_order)
       values ($1, $2, $3, $4::text[], true, $5)
       on conflict (id) do nothing`,
      [
        template.id,
        template.work_type_id,
        template.text,
        arrayLiteral(template.tags),
        template.sort_order,
      ],
    );
  }

  await client.query(
    'update work_types set default_template_id = $1 where id = $2',
    [SEED_TEMPLATES[0].id, SEED_WORK_TYPES[0].id],
  );
  await client.query(
    'update work_types set default_template_id = $1 where id = $2',
    [SEED_TEMPLATES[1].id, SEED_WORK_TYPES[1].id],
  );

  for (const reason of SEED_REASONS) {
    await client.query(
      `insert into correction_reasons (id, code, name, applies_to)
       values ($1, $2, $3, $4::correction_applies_to_enum)
       on conflict (id) do nothing`,
      [reason.id, reason.code, reason.name, reason.applies_to],
    );
  }

  if (demoData) {
    for (const permit of permits) {
      await client.query(
      `insert into permits
         (id, source_id, external_id, number, number_norm, year, type, status,
          valid_from, valid_to, site_id, work_description, responsible_user_id,
          external_url, updated_at_external, version)
       values
         ($1, $2, $3, $4, $5, $6, $7::permit_type_enum, $8::permit_status_enum,
          $9, $10, $11, $12, $13, $14, $9, 1)
       on conflict (id) do nothing`,
      [
        permit.id,
        permit.source_id,
        permit.external_id,
        permit.number,
        permit.number_norm,
        permit.year,
        permit.type,
        permit.status,
        permit.valid_from,
        permit.valid_to,
        permit.site_id,
        permit.work_description,
        permit.responsible_user_id,
        permit.external_url,
      ],
    );
  }

  for (const participant of participants) {
    await client.query(
      `insert into permit_participants (permit_id, user_id, role_in_permit)
       values ($1, $2, $3)
       on conflict (permit_id, user_id) do nothing`,
      [participant.permit_id, participant.user_id, participant.role_in_permit],
    );
  }
  }

  for (const version of SEED_DICTIONARY_VERSIONS) {
    await client.query(
      `insert into dictionary_versions (name, version, updated_at)
       values ($1, $2, '2026-11-20T00:00:00.000Z')
       on conflict (name) do nothing`,
      [version.name, version.version],
    );
  }

  for (const journal of SEED_JOURNALS) {
    await client.query(
      `insert into journals (id, journal_key, name, description, active, sort_order)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do nothing`,
      [
        journal.id,
        journal.journal_key,
        journal.name,
        journal.description,
        journal.active,
        journal.sort_order,
      ],
    );
    await client.query(
      `insert into journal_counters (journal_id, last_seq)
       values ($1, 0)
       on conflict (journal_id) do nothing`,
      [journal.id],
    );
  }

  if (demoData) {
    const siteColumns = await client.query<{ count: string }>(
      `select count(*)::text as count from information_schema.columns
        where table_name = 'journal_entries'
          and column_name in ('site_name_raw', 'site_binding_status')`,
    );
    const hasSiteRaw = Number(siteColumns.rows[0]?.count ?? 0) === 2;
    for (const entry of entries) {
      await client.query(
      `insert into journal_entries
         (id, author_id, performed_at, performed_tz_offset_min, performed_at_source,
          performed_at_reason_id, performed_at_comment, shift_date, work_type_id, site_id,
          permit_id, permit_number_raw, permit_binding_status, permit_status_at_sync,
          permit_risk_flag, permit_risk_reason, "text", comment, input_method, asr_engine,
          asr_confidence, offline_created, status, version, hlc, created_at_client,
          created_at_server, updated_at_client, updated_at_server, deleted_at, deleted_by,
          delete_reason_id, device_id, revision_no, verified_at, verified_by, late_entry
          ${hasSiteRaw ? ', site_name_raw, site_binding_status' : ''})
       values
         ($1, $2, $3, $4, $5::performed_source_enum,
          $6, $7, $8, $9, $10,
          $11, $12, $13::binding_status_enum, $14::permit_status_enum,
          $15, $16, $17, $18, $19::input_method_enum, $20::asr_engine_enum,
          $21, $22, $23::entry_status_enum, 1, $24, $25,
          $26, $27, $28, $29, $30,
          $31, $32, 0, $33, $34, $35
          ${hasSiteRaw ? ', null, $36::binding_status_enum' : ''})
       on conflict (id) do nothing`,
      [
        entry.id,
        entry.author_id,
        entry.performed_at,
        entry.performed_tz_offset_min,
        entry.performed_at_source,
        entry.performed_at_reason_id,
        entry.performed_at_comment,
        entry.shift_date,
        entry.work_type_id,
        entry.site_id,
        entry.permit_id,
        entry.permit_number_raw,
        entry.permit_binding_status,
        entry.permit_status_at_sync,
        entry.permit_risk_flag,
        entry.permit_risk_reason,
        entry.text,
        entry.comment,
        entry.input_method,
        entry.asr_engine,
        entry.asr_confidence,
        entry.offline_created,
        entry.status,
        entry.hlc,
        entry.created_at_client,
        SEED_TIMESTAMPS.server,
        entry.updated_at_client,
        SEED_TIMESTAMPS.server,
        entry.status === 'deleted' ? '2026-11-22T08:00:00.000Z' : null,
        entry.status === 'deleted' ? entry.author_id : null,
        entry.status === 'deleted' ? '01930000-0000-7000-8000-000000000603' : null,
        entry.device_id,
        entry.verified_at,
        entry.verified_by,
        (entry as { late_entry?: boolean }).late_entry ?? false,
        ...(hasSiteRaw ? [entry.site_id ? 'linked' : 'not_required'] : []),
      ],
    );
  }

  await client.query(
    `insert into entry_workers (entry_id, user_id)
     values ($1, $2)
     on conflict (entry_id, user_id) do nothing`,
    [entries[0].id, SEED_USERS[0].id],
  );
  }

  const counts = await client.query<{ users: string; entries: string; permits: string }>(
    `select
       (select count(*) from users)::text as users,
       (select count(*) from journal_entries)::text as entries,
       (select count(*) from permits)::text as permits`,
  );
  const row = counts.rows[0];
  return {
    users: Number(row?.users ?? 0),
    entries: Number(row?.entries ?? 0),
    permits: Number(row?.permits ?? 0),
  };
}

