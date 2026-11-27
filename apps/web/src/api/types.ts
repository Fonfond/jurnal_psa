import type {
  ConflictRecord,
  DeviceRegistrationInput,
  DeviceRegistrationResponse,
  Grounding,
  Journal,
  JournalEntry,
  JournalReview,
  Permit,
  Role,
  Shift,
  SignatureRecord,
  SyncPushResponse,
  UserStatus,
} from '@logbook/shared';

export type { DeviceRegistrationInput, DeviceRegistrationResponse, SignatureRecord };

/** Public signature adapter state from `/v1/me` and `/v1/auth/config`. */
export interface SignatureInfo {
  provider: 'none' | 'simple' | 'qualified';
  algorithm: string | null;
  auto_sign: boolean;
  legal_note: string;
}

export interface ApiUser {
  id: string;
  full_name: string;
  role: Role;
  department: { id: string; name: string };
  status: UserStatus;
  email: string | null;
}

export interface ApiSession {
  offline_valid_until: string;
  refresh_expires_at: string;
  device_id?: string | null;
}

export interface LoginResponse {
  auth_provider?: 'dev' | 'oidc';
  user: ApiUser;
  session: ApiSession;
  csrf_token: string;
}

export interface MeResponse {
  user: ApiUser;
  session: ApiSession;
  auth?: { provider: 'dev' | 'oidc' };
  signature?: SignatureInfo;
  /** ADR-14: returned for the separate admin origin (cookie is not readable). */
  csrf_token?: string | null;
  features: {
    voice: boolean;
    web_speech: boolean;
    attachments: boolean;
    supervisor_cache: boolean;
    device_registration?: boolean;
  };
}

/* ------------------------------------------------------------------ admin */

export interface AdminUser {
  id: string;
  external_id: string | null;
  full_name: string;
  email: string | null;
  role: Role;
  department_id: string | null;
  department_name: string | null;
  position: string | null;
  status: UserStatus;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface AdminDepartment {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface AdminDevice extends DeviceRow {
  user_id?: string;
  user_name: string | null;
  user_email: string | null;
}

export interface AdminUsersResponse {
  items: AdminUser[];
  total: number;
}

export interface AdminDevicesResponse {
  items: AdminDevice[];
  total: number;
}

export interface AuditEventRow {
  id: string;
  occurred_at: string;
  actor_id: string;
  actor_role: Role;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  source: string;
  hash?: string;
}

export interface RetentionRun {
  id: string;
  run_at: string;
  actor_id?: string | null;
  policy_years: number;
  cutoff: string;
  audit_ok: boolean;
  streams_checked: number;
  report?: Record<string, unknown>;
  created_at?: string;
}

export interface BackupCheckpoint {
  id: string;
  created_at: string;
  label: string | null;
  manifest_hash: string;
}

export interface ArchiveRow {
  id: string;
  export_job_id: string;
  journal_id: string;
  period_from: string;
  period_to: string;
  entries_count: number;
  pdf_sha256: string;
  csv_sha256: string;
  created_at: string;
  journal_key?: string;
  journal_name?: string;
}

export interface RetentionStatus {
  policy_years: number;
  cutoff: string;
  policy?: {
    years: number;
    cutoff: string;
    protected_until_cutoff?: string;
    worm_exports?: boolean;
  };
  journal_entries: {
    total: number;
    active?: number;
    deleted: number;
    before_cutoff: number;
    oldest: string | null;
    newest: string | null;
  };
  entries?: RetentionStatus['journal_entries'];
  exports?: Record<string, number>;
  archives?: number;
  audit?: {
    streams: number;
    heads: Array<{
      stream: string;
      stream_seq: number;
      hash: string;
      occurred_at: string;
    }>;
  };
  runs: RetentionRun[];
  checkpoints: BackupCheckpoint[];
  latest_run: RetentionRun | null;
  generated_at?: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  streams_checked: number;
  events_checked: number;
  broken: Array<{ stream: string; stream_seq: number; reason: string }>;
}

export interface BackupManifest {
  schema: string;
  generated_at: string;
  retention: { years: number; cutoff: string };
  tables: Record<string, number>;
  audit: { heads: Array<Record<string, unknown>> };
  exports: Array<Record<string, unknown>>;
  manifest_hash: string;
}

export interface ExportJobRow {
  id: string;
  user_id?: string;
  type: string;
  status: string;
  journal_id?: string | null;
  file_sha256: string | null;
  file_size_bytes: number | null;
  csv_sha256: string | null;
  csv_size_bytes: number | null;
  signature_id?: string | null;
  generated_at?: string | null;
  expires_at?: string | null;
  worm: boolean;
  download_count: number;
}

export interface ExportJobResult extends ExportJobRow {
  from?: string;
  to?: string;
  entries_count?: number;
  manifest?: Record<string, unknown>;
  manifest_hash?: string;
  signature?: SignatureRecord;
}

export interface ExportUrlResponse {
  id: string;
  format: 'pdf' | 'csv';
  url: string;
  expires_at: string;
  hash: string;
  worm: boolean;
}

export interface JournalMember {
  journal_id: string;
  user_id: string;
  access_level: 'read' | 'write' | 'manage';
  granted_at: string;
  full_name: string;
  email: string | null;
}

export interface PermitImportResult {
  imported?: number;
  updated?: number;
  skipped?: number;
  errors?: Array<{ row: number; message: string }>;
  source_id?: string;
  adapter?: string;
}

export interface PermitImportHistoryRow {
  id: string;
  occurred_at: string;
  actor_role: string;
  action: string;
  after: Record<string, unknown>;
}

export interface EntriesResponse {
  items: JournalEntry[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface PermitsResponse {
  items: Permit[];
  next_cursor: string | null;
}

/** Signed permit PDF link (OQ-03). */
export interface PermitPdfLink {
  permit_id: string;
  url: string;
  expires_at: string;
  source: 'generated' | 'external';
  hash: string | null;
  size_bytes: number | null;
  external_url: string | null;
  deep_link: string | null;
  pdf_url: string | null;
}

export interface DictSection<T> {
  version: number;
  items: T[];
}

export interface SnapshotResponse {
  snapshot_id: string;
  work_types: DictSection<import('@logbook/shared').WorkType>;
  sites: DictSection<import('@logbook/shared').Site>;
  templates: DictSection<import('@logbook/shared').Template>;
  reasons: DictSection<import('@logbook/shared').CorrectionReason>;
  departments: DictSection<import('@logbook/shared').Department>;
  /** Multi-journal catalogue (optional for older API builds). */
  journals?: DictSection<Journal>;
}

export interface JournalsResponse {
  items: Journal[];
}

export interface ShiftsResponse {
  items: Shift[];
}

export interface GroundingsResponse {
  items: Grounding[];
}

export interface ChangeItem {
  seq: number;
  entity_type: 'entry' | 'permit' | 'shift' | 'grounding';
  op: 'upsert' | 'delete';
  entity?: Record<string, unknown>;
  entity_id?: string;
  version?: number;
  deleted_at?: string | null;
}

export interface ChangesResponse {
  next_seq: number;
  has_more: boolean;
  changes: ChangeItem[];
}

export interface DeviceRow {
  id: string;
  install_id?: string | null;
  name: string | null;
  platform: string | null;
  app_version: string | null;
  status: string;
  device_key_set?: boolean;
  created_at?: string;
  registered_at?: string;
  revoked_at?: string | null;
  last_seen_at?: string;
}

export interface ConflictsResponse {
  items: ConflictRecord[];
}

export interface ReviewsResponse {
  items: JournalReview[];
}

export type PushResponse = SyncPushResponse;
export type Entry = JournalEntry;
