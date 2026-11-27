// Scale fixture for the PostgreSQL 15 acceptance run (QA-06 dataset size).
// Creates 50 departments, 5 000 users, 5 000 devices and 20 000 journal entries.
//
//   DATABASE_URL=postgres://logbook:logbook@127.0.0.1:55432/logbook \
//     node scripts/pg/scale-fixture.mjs
//   ... node scripts/pg/scale-fixture.mjs --clean
//
// Uses the pg driver already present in the repo; SSL certificate verification
// is disabled because the lab uses a self-signed certificate.

import { Pool } from 'pg';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://logbook:logbook@127.0.0.1:55432/logbook';
const clean = process.argv.includes('--clean');
const USERS = Number(process.env.SCALE_USERS ?? 5000);
const ENTRIES = Number(process.env.SCALE_ENTRIES ?? 20000);
const WORK_TYPE = '01930000-0000-7000-8000-000000000302';
const SITE = '01930000-0000-7000-8000-000000000402';
const MAIN_JOURNAL = '01930000-0000-7000-8000-000000001001';

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 4,
});

async function main() {
  const started = Date.now();
  const client = await pool.connect();
  try {
    if (clean) {
      await client.query('begin');
      await client.query(
        `delete from journal_entries where author_id in (select id from users where external_id like 'scale-user-%')`,
      );
      await client.query(
        `delete from devices where user_id in (select id from users where external_id like 'scale-user-%')`,
      );
      await client.query(`delete from users where external_id like 'scale-user-%'`);
      await client.query(`delete from departments where code like 'SCALE-%'`);
      await client.query('commit');
      await client.query('ANALYZE');
      console.log('Scale fixture removed; ANALYZE done');
      return;
    }

    await client.query('begin');
    await client.query(`
      insert into departments (id, code, name)
      select gen_random_uuid(), 'SCALE-' || g, 'Scale department ' || g
        from generate_series(1, 50) g
      on conflict (code) do nothing
    `);
    await client.query(`
      insert into users (id, external_id, full_name, email, role, department_id, status)
      select gen_random_uuid(),
             'scale-user-' || g,
             'Scale User ' || g,
             'scale' || g || '@logbook.local',
             'worker',
             (select id from departments where code like 'SCALE-%' order by code limit 1 offset (g % 50)),
             'active'
        from generate_series(1, $1) g
      on conflict (external_id) do nothing
    `, [USERS]);
    await client.query(`
      insert into devices (id, user_id, name, platform, app_version, install_id)
      select gen_random_uuid(), u.id, 'Scale device ' || u.external_id, 'linux', '0.3.0',
             'scale-install-' || u.external_id
        from users u
       where u.external_id like 'scale-user-%'
      on conflict (user_id, install_id) where install_id is not null do nothing
    `);
    await client.query(`
      with authors as (
        select id, row_number() over (order by external_id) as rn
          from users
         where external_id like 'scale-user-%'
      ), series as (
        select g from generate_series(1, $4) g
      )
      insert into journal_entries
        (id, author_id, performed_at, performed_tz_offset_min, performed_at_source,
         work_type_id, site_id, text, input_method, hlc,
         created_at_client, updated_at_client, journal_id)
      select gen_random_uuid(),
             a.id,
             timestamptz '2026-01-01' + (s.g % 90) * interval '1 day' + (s.g % 86400) * interval '1 second',
             180,
             'manual'::performed_source_enum,
             $1::uuid,
             $2::uuid,
             'Scale journal entry ' || s.g || ' for load testing on PostgreSQL 15',
             'manual',
             (1795000000000 + s.g)::text || ':00001:scale' || lpad((s.g % 1000)::text, 3, '0'),
             now(),
             now(),
             $3::uuid
        from series s
        join authors a on a.rn = 1 + (s.g % $5)
    `, [WORK_TYPE, SITE, MAIN_JOURNAL, ENTRIES, USERS]);
    await client.query('commit');

    // F-01 residual (t32): bulk/scale data arrives AFTER db:seed's ANALYZE.
    // Refresh planner statistics before any cold-load measurement or traffic.
    if (process.env.SCALE_SKIP_ANALYZE !== '1') {
      const analyzeStarted = Date.now();
      await client.query('ANALYZE');
      console.log(`ANALYZE done in ${Date.now() - analyzeStarted} ms`);
    } else {
      console.warn('ANALYZE skipped (SCALE_SKIP_ANALYZE=1): loadtest results are not acceptance evidence');
    }

    const counts = await client.query(`
      select
        (select count(*) from users) as users,
        (select count(*) from devices) as devices,
        (select count(*) from journal_entries) as entries,
        (select count(*) from departments) as departments
    `);
    const durationMs = Date.now() - started;
    const summary = { ...counts.rows[0], fixture_duration_ms: durationMs };
    console.log(JSON.stringify(summary));
    console.log(`Scale fixture OK in ${durationMs} ms`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(`SCALE FIXTURE FAILED: ${error instanceof Error ? error.stack : error}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
