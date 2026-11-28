import Dexie, { type Table } from 'dexie';
import {
  DEFAULT_JOURNAL_ID,
  type ConflictRecord,
  type CorrectionReason,
  type Department,
  type EntryRevision,
  type Grounding,
  type Hlc,
  type EntryAttachment,
  type Journal,
  type JournalEntry,
  type JournalReview,
  type OutboxOperation,
  type Permit,
  type Shift,
  type Site,
  type Template,
  type WorkType,
} from '@logbook/shared';

export interface ClientJournalEntry extends JournalEntry {
  /** Client-only per-field clocks; never sent as part of the entry itself. */
  field_clocks?: Record<string, Hlc>;
}

export interface EntryWorkerRow {
  entry_id: string;
  user_id: string;
}

/** Local attachment row: metadata + PDF blob until the server upload succeeds. */
export interface AttachmentRow extends EntryAttachment {
  blob?: Blob;
  created_at_local?: string;
  server_id?: string;
  deleted_at?: string | null;
  last_error?: string | null;
}

export interface DraftRow {
  id: string;
  user_id: string;
  entry_id: string | null;
  payload: Record<string, unknown>;
  updated_at: string;
  device_id: string;
}

export interface SyncStateRow {
  key: string;
  cursor: number;
  last_success_at: string | null;
  last_attempt_at: string | null;
  server_time_offset_ms: number;
}

export interface MetaRow {
  key: string;
  value: string;
}

/**
 * Supervisor offline cache window for one journal (ADR-16, SYN-02).
 * One row per journal inside the per-user database.
 */
export interface SupervisorCacheRow {
  journal_id: string;
  user_id: string;
  window_from: string;
  window_to: string;
  entries: number;
  bytes: number;
  updated_at: string;
}

/** Legacy shared database name; user data now lives in per-user databases. */
export const LEGACY_DB_NAME = 'logbook';

/** Declared Dexie schema version (ADR-18 migrations compare against it). */
export const CLIENT_SCHEMA_VERSION = 6;

/**
 * Client-side source of truth (ADR-01).
 * Store names and indexes follow 05_Модель_данных, §4.2.
 *
 * Since the offline-platform step the schema is opened per user:
 * `logbook:user:<user_id>` (see db/user-db.ts). `LEGACY_DB_NAME` is only kept
 * for the one-time adoption of pre-existing single-database installs.
 */
export class LogbookDatabase extends Dexie {
  entries!: Table<ClientJournalEntry, string>;
  revisions!: Table<EntryRevision, string>;
  entry_workers!: Table<EntryWorkerRow, [string, string]>;
  permits!: Table<Permit, string>;
  dict_work_types!: Table<WorkType, string>;
  dict_sites!: Table<Site, string>;
  dict_templates!: Table<Template, string>;
  dict_reasons!: Table<CorrectionReason, string>;
  dict_departments!: Table<Department, string>;
  outbox!: Table<OutboxOperation, string>;
  conflicts!: Table<ConflictRecord, string>;
  drafts!: Table<DraftRow, string>;
  sync_state!: Table<SyncStateRow, string>;
  meta!: Table<MetaRow, string>;
  journal_reviews!: Table<JournalReview, string>;
  /** Journal catalogue and effective access level for the current user. */
  journals!: Table<Journal, string>;
  /** Supervisor cache bookkeeping per journal (ADR-16). */
  supervisor_cache!: Table<SupervisorCacheRow, string>;
  /** Shift handovers (JRN-02): local cache and pending outbox operations. */
  shifts!: Table<Shift, string>;
  /** Grounding registry cache (JRN-06), derived from grounding events. */
  groundings!: Table<Grounding, string>;
  /** Paper-permit scans (PDF blob stays local until uploaded). */
  attachments!: Table<AttachmentRow, string>;

  constructor(name = LEGACY_DB_NAME) {
    super(name);
    this.version(1).stores({
      entries: 'id, author_id, performed_at, permit_id, sync_status, status',
      revisions: 'id, entry_id, revision_no',
      entry_workers: '[entry_id+user_id], entry_id, user_id',
      permits: 'id, number_norm, status, valid_to, site_id',
      dict_work_types: 'id, code, active',
      dict_sites: 'id, code, active',
      dict_templates: 'id, work_type_id, active',
      dict_reasons: 'id, code, applies_to, active',
      dict_departments: 'id, code, active',
      outbox: 'op_id, status, next_attempt_at, entity_id',
      conflicts: 'id, entry_id, resolution',
      drafts: 'id, user_id, updated_at',
      sync_state: 'key',
      meta: 'key',
    });
    this.version(2).stores({
      entries: 'id, author_id, performed_at, permit_id, sync_status, status, event_type',
      revisions: 'id, entry_id, revision_no',
      entry_workers: '[entry_id+user_id], entry_id, user_id',
      permits: 'id, number_norm, status, valid_to, site_id',
      dict_work_types: 'id, code, active',
      dict_sites: 'id, code, active',
      dict_templates: 'id, work_type_id, active',
      dict_reasons: 'id, code, applies_to, active',
      dict_departments: 'id, code, active',
      outbox: 'op_id, status, next_attempt_at, entity_id',
      conflicts: 'id, entry_id, resolution',
      drafts: 'id, user_id, updated_at',
      sync_state: 'key',
      meta: 'key',
      journal_reviews: 'id, period_start, period_end, reviewer_id, journal_key',
    });
    // v3: multi-journal (JRN-03). Old local data is attached to `main` and
    // keeps working; the journal catalogue is added as an offline store.
    this.version(3)
      .stores({
        entries:
          'id, author_id, performed_at, permit_id, sync_status, status, event_type, journal_id',
        revisions: 'id, entry_id, revision_no',
        entry_workers: '[entry_id+user_id], entry_id, user_id',
        permits: 'id, number_norm, status, valid_to, site_id',
        dict_work_types: 'id, code, active',
        dict_sites: 'id, code, active',
        dict_templates: 'id, work_type_id, active',
        dict_reasons: 'id, code, applies_to, active',
        dict_departments: 'id, code, active',
        outbox: 'op_id, status, next_attempt_at, entity_id',
        conflicts: 'id, entry_id, resolution',
        drafts: 'id, user_id, updated_at',
        sync_state: 'key',
        meta: 'key',
        journal_reviews: 'id, period_start, period_end, reviewer_id, journal_key, journal_id',
        journals: 'id, journal_key, active, sort_order',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table('entries')
          .toCollection()
          .modify((row: { journal_id?: string | null }) => {
            if (!row.journal_id) {
              row.journal_id = DEFAULT_JOURNAL_ID;
            }
          });
        await transaction
          .table('journal_reviews')
          .toCollection()
          .modify((row: { journal_id?: string | null }) => {
            if (!row.journal_id) {
              row.journal_id = DEFAULT_JOURNAL_ID;
            }
          });
      });
    // v4: offline platform (SYN-02/SYN-04). The supervisor cache window is
    // persisted per journal and entries gain a compound index for
    // journal-scoped cache eviction. Rows written by older clients are
    // normalised so every local row has a journal and a sync status.
    this.version(4)
      .stores({
        entries:
          'id, author_id, performed_at, permit_id, sync_status, status, event_type, journal_id, [journal_id+performed_at]',
        supervisor_cache: 'journal_id, user_id, updated_at',
        shifts:
          'id, journal_id, shift_date, status, handed_over_by, accepted_by, sync_status',
      })
      .upgrade(async (transaction) => {
        await transaction
          .table('entries')
          .toCollection()
          .modify(
            (row: {
              journal_id?: string | null;
              sync_status?: string | null;
            }) => {
              if (!row.journal_id) {
                row.journal_id = DEFAULT_JOURNAL_ID;
              }
              if (!row.sync_status) {
                row.sync_status = 'synced';
              }
            },
          );
      });
    // v5: grounding registry cache (JRN-06). Server-derived from grounding
    // events; the client keeps it for offline filters and the registry screen.
    this.version(5).stores({
      groundings:
        'id, journal_id, site_id, state, point, grounding_type, updated_at_server',
    });
    // v6: one paper-permit scan per entry; the PDF is a Blob in IndexedDB.
    this.version(6).stores({
      attachments: 'id, entry_id, kind, status, sha256, created_at_local',
    });
  }
}

/**
 * Database handle registry. The app keeps exactly one user database open;
 * repositories and screens reach it through the `db` proxy so every local
 * read/write is scoped to the signed-in account (SYN-02).
 */
let activeDatabase: LogbookDatabase = new LogbookDatabase();

export function getDb(): LogbookDatabase {
  return activeDatabase;
}

/** Swap the active user database. Returns the previous handle for closing. */
export function setActiveDatabase(next: LogbookDatabase): LogbookDatabase {
  const previous = activeDatabase;
  activeDatabase = next;
  return previous;
}

export const db: LogbookDatabase = new Proxy({} as LogbookDatabase, {
  get(_target, property) {
    const value = Reflect.get(activeDatabase as unknown as object, property);
    return typeof value === 'function' ? value.bind(activeDatabase) : value;
  },
  has(_target, property) {
    return property in activeDatabase;
  },
});

export const DB_NAME = LEGACY_DB_NAME;
