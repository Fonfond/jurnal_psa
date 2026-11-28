export type UUID = string;
export type Hlc = string;
export type IsoDateTime = string;

export type Role = 'worker' | 'supervisor' | 'admin' | 'auditor';
export type UserStatus = 'active' | 'blocked' | 'deactivated';
export type DeviceStatus = 'active' | 'revoked';

/** Authentication provider: dev-only credentials or corporate OIDC. */
export type AuthProviderKind = 'dev' | 'oidc';

/** Electronic-signature adapter kind. `none` keeps MVP behaviour (OQ-04). */
export type SignatureKind = 'none' | 'simple' | 'qualified';
export type SignatureStatus = 'valid' | 'invalid' | 'revoked';
export type SignatureEntityType = 'journal_review' | 'entry' | 'shift' | 'export';

export interface SignatureRecord {
  id: UUID;
  entity_type: SignatureEntityType;
  entity_id: UUID;
  entity_version: number;
  content_hash: string;
  kind: Exclude<SignatureKind, 'none'>;
  algorithm: string;
  /** base64url HMAC for `simple`; base64 CMS for `qualified`. */
  value: string;
  key_id: string | null;
  certificate_serial: string | null;
  certificate_subject: string | null;
  signer_id: UUID;
  signed_at: IsoDateTime;
  status: SignatureStatus;
  metadata: Record<string, unknown> | null;
  /** Human-readable legal caveat; simple signature is not КЭП. */
  legal_note: string;
}

export interface AuthConfigResponse {
  auth_provider: AuthProviderKind;
  dev_login_enabled: boolean;
  oidc: {
    display_name: string;
    authorize_url: string;
  } | null;
  signature: {
    provider: SignatureKind;
    algorithm: string | null;
    auto_sign: boolean;
    legal_note: string;
  };
}

export interface DeviceRegistrationInput {
  /** Stable client installation id (survives re-registration). */
  install_id: string;
  name?: string;
  platform?: string;
  app_version?: string;
  fingerprint?: string;
  /** Ask the server to rotate the device key (client lost its copy). */
  rotate_key?: boolean;
}

export interface RegisteredDevice {
  id: UUID;
  user_id?: UUID;
  install_id: string | null;
  name: string | null;
  platform: string | null;
  app_version: string | null;
  status: DeviceStatus;
  device_key_set?: boolean;
  created_at?: IsoDateTime;
  registered_at?: IsoDateTime;
  last_seen_at?: IsoDateTime;
  revoked_at?: IsoDateTime | null;
}

export interface DeviceRegistrationResponse {
  device: RegisteredDevice;
  /** Returned only when the key was created or rotated; store it on the device. */
  device_key?: string;
}

export type PermitStatus = 'draft' | 'active' | 'suspended' | 'closed' | 'annulled';
export type PermitType = 'permit_to_work' | 'order' | 'other';
export type PermitBindingStatus = 'linked' | 'unresolved' | 'not_found' | 'not_required';

export type EntryStatus = 'active' | 'deleted';
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'conflict' | 'error';
export type InputMethod = 'voice' | 'manual';
export type AsrEngine = 'on_device' | 'web_speech';
export type PerformedAtSource = 'device_auto' | 'manual' | 'server_corrected';
export type RevisionSource = 'client' | 'server' | 'conflict_resolution';
export type OpType = 'create' | 'update' | 'delete';
export type OpStatus = 'pending' | 'in_flight' | 'dead';
export type ChangeOp = 'upsert' | 'delete';

// Journal-domain types aligned with operational-log rules (letter 42-6/35-ЭТ).
export type JournalEventType =
  | 'work'
  | 'command'
  | 'switching'
  | 'grounding'
  | 'incident'
  | 'other';

export interface CommandEventData {
  issued_by: string;
  received_at?: IsoDateTime | null;
  executed_at?: IsoDateTime | null;
  refusal_reason?: string | null;
}

export interface SwitchingOperation {
  /** open/close — коммутационный аппарат, check — проверка, measure — измерение. */
  operation: 'open' | 'close' | 'check' | 'measure' | 'other';
  device: string;
  from_state?: string | null;
  to_state?: string | null;
  note?: string | null;
}

export interface SwitchingCheck {
  check: string;
  passed: boolean;
  note?: string | null;
}

export interface SwitchingEventData {
  order_no?: string | null;
  order_date?: string | null;
  responsible?: string | null;
  /** Legacy free-text sequence; new clients send `operations`. */
  sequence?: string | SwitchingOperation[] | null;
  operations?: SwitchingOperation[];
  checks?: SwitchingCheck[];
  executed_at?: IsoDateTime | null;
  points?: string | null;
}

export interface GroundingEventData {
  /** applied = установка, removed = снятие */
  action: 'applied' | 'removed';
  /** portable = переносное З/З, fixed = заземляющие ножи ЗН */
  grounding_type: 'portable' | 'fixed';
  point: string;
  count?: number;
  tool_number?: string | null;
}

export type GroundingState = 'applied' | 'removed';

/** Registry row derived from `grounding` events (JRN-06). */
export interface Grounding {
  id: UUID;
  journal_id: UUID;
  site_id: UUID | null;
  point: string;
  grounding_type: 'portable' | 'fixed';
  tool_number: string | null;
  count: number;
  state: GroundingState;
  applied_entry_id: UUID | null;
  applied_by: UUID | null;
  applied_at: IsoDateTime | null;
  removed_entry_id: UUID | null;
  removed_by: UUID | null;
  removed_at: IsoDateTime | null;
  version: number;
  created_at_server?: IsoDateTime;
  updated_at_server?: IsoDateTime;
  applied_by_name?: string | null;
  removed_by_name?: string | null;
  site_name?: string | null;
}

export interface IncidentEventData {
  severity: 'minor' | 'major' | 'critical';
  cause?: string | null;
  actions?: string | null;
}

export interface OtherEventData {
  description?: string | null;
}

export type JournalEventData =
  | CommandEventData
  | SwitchingEventData
  | GroundingEventData
  | IncidentEventData
  | OtherEventData;


export interface Department {
  id: UUID;
  code: string;
  name: string;
  parent_id: UUID | null;
  active: boolean;
}

export interface User {
  id: UUID;
  external_id: string;
  full_name: string;
  personnel_no: string | null;
  email: string | null;
  phone: string | null;
  role: Role;
  department_id: UUID;
  position: string | null;
  status: UserStatus;
}

export interface Device {
  id: UUID;
  user_id: UUID;
  name: string | null;
  platform: string | null;
  app_version: string | null;
  status: DeviceStatus;
}

export interface WorkType {
  id: UUID;
  code: string;
  name: string;
  requires_permit: boolean;
  requires_site: boolean;
  default_template_id: UUID | null;
  active: boolean;
  sort_order: number;
}

export interface Site {
  id: UUID;
  code: string;
  name: string;
  parent_id: UUID | null;
  active: boolean;
}

export interface Template {
  id: UUID;
  work_type_id: UUID;
  text: string;
  tags: string[];
  active: boolean;
  sort_order: number;
}

export interface CorrectionReason {
  id: UUID;
  code: string;
  name: string;
  applies_to: 'performed_at' | 'delete' | 'edit';
  active: boolean;
}

export interface Permit {
  id: UUID;
  source_id: string;
  external_id: string;
  number: string;
  number_norm: string;
  year: number;
  type: PermitType;
  status: PermitStatus;
  valid_from: IsoDateTime;
  valid_to: IsoDateTime;
  site_id: UUID;
  work_description: string;
  responsible_user_id: UUID;
  external_url: string | null;
  pdf_url: string | null;
  pdf_hash: string | null;
  pdf_size_bytes: number | null;
  /** OQ-03 metadata: when the PDF was generated and where it came from. */
  pdf_generated_at?: IsoDateTime | null;
  pdf_source?: 'generated' | 'external' | 'none';
  updated_at_external: IsoDateTime;
  version: number;
  is_deleted: boolean;
}

/** Per-journal access grant (ADR-24 / JRN-03). */
export type JournalAccessLevel = 'read' | 'write' | 'manage';

export interface Journal {
  id: UUID;
  /** Stable human-readable key used in exports and reviews (`main`). */
  journal_key: string;
  name: string;
  description: string | null;
  active: boolean;
  sort_order: number;
  created_at?: IsoDateTime;
  /** Effective level for the requesting user; absent in admin listings. */
  access_level?: JournalAccessLevel;
}

export interface JournalMember {
  journal_id: UUID;
  user_id: UUID;
  access_level: JournalAccessLevel;
  granted_at?: IsoDateTime;
  full_name?: string;
  email?: string | null;
}

export interface JournalEntry {
  id: UUID;
  author_id: UUID;
  performed_at: IsoDateTime;
  performed_tz_offset_min: number;
  performed_at_source: PerformedAtSource;
  performed_at_reason_id: UUID | null;
  performed_at_comment: string | null;
  shift_date: string | null;
  work_type_id: UUID;
  site_id: UUID | null;
  permit_id: UUID | null;
  permit_number_raw: string | null;
  permit_binding_status: PermitBindingStatus;
  permit_status_at_sync: PermitStatus | null;
  permit_risk_flag: boolean;
  permit_risk_reason: string | null;
  text: string;
  comment: string | null;
  input_method: InputMethod;
  asr_engine: AsrEngine | null;
  asr_confidence: number | null;
  offline_created: boolean;
  status: EntryStatus;
  sync_status?: SyncStatus;
  version: number;
  hlc: Hlc;
  created_at_client: IsoDateTime;
  created_at_server: IsoDateTime | null;
  updated_at_client: IsoDateTime;
  updated_at_server: IsoDateTime | null;
  deleted_at: IsoDateTime | null;
  deleted_by: UUID | null;
  delete_reason_id: UUID | null;
  device_id: UUID | null;
  revision_no: number;
  last_op_id: UUID | null;
  verified_at: IsoDateTime | null;
  verified_by: UUID | null;
  unverified_at: IsoDateTime | null;
  unverified_by: UUID | null;
  /** Journal-domain fields (optional for backward-compatible old payloads). */
  event_type?: JournalEventType;
  event_data?: JournalEventData | null;
  /** Owning journal; old offline rows and payloads default to `main`. */
  journal_id?: UUID | null;
  /** Sequence inside the owning journal (independent per journal). */
  journal_seq?: number | null;
  late_entry?: boolean;
}

export interface JournalReview {
  id: UUID;
  journal_key: string;
  /** Owning journal; old rows default to `main`. */
  journal_id?: UUID | null;
  period_start: string;
  period_end: string;
  reviewer_id: UUID;
  reviewed_at: IsoDateTime;
  entries_count: number;
  remarks: string | null;
  content_hash: string;
}

// Shift handover (JRN-02): two-sided acceptance of an operational shift.
export type ShiftStatus = 'handed_over' | 'accepted' | 'rejected' | 'cancelled';

export interface Shift {
  id: UUID;
  journal_id: UUID;
  /** Date of the shift start (OQ-19). */
  shift_date: string;
  period_start: IsoDateTime;
  period_end: IsoDateTime;
  status: ShiftStatus;
  handed_over_by: UUID;
  handed_over_by_name?: string | null;
  handed_over_at: IsoDateTime;
  handover_comment: string;
  accepted_by: UUID | null;
  accepted_by_name?: string | null;
  accepted_at: IsoDateTime | null;
  acceptance_comment: string | null;
  rejected_by: UUID | null;
  rejected_by_name?: string | null;
  rejected_at: IsoDateTime | null;
  rejection_reason: string | null;
  /** Snapshot of the entries covered by the handover. */
  entries_count: number;
  entries_hash: string;
  content_hash: string;
  version: number;
  hlc: Hlc;
  created_at_client: IsoDateTime;
  created_at_server: IsoDateTime | null;
  updated_at_client: IsoDateTime;
  updated_at_server: IsoDateTime | null;
  device_id: UUID | null;
  last_op_id: UUID | null;
  /** Client-only sync state (not returned by the server). */
  sync_status?: SyncStatus;
  sync_error?: string | null;
  signatures?: SignatureRecord[];
}

/** Sync payload for a shift create (= handover) operation. */
export interface ShiftHandoverInput {
  journal_id: UUID;
  shift_date: string;
  period_start: IsoDateTime;
  period_end: IsoDateTime;
  handover_comment: string;
}

/** Sync payload for an acceptance/rejection operation. */
export interface ShiftActionInput {
  action: 'accept' | 'reject';
  comment?: string | null;
  rejection_reason?: string | null;
}

export type AttachmentKind = 'permit_scan';
export type AttachmentStatus = 'local' | 'uploading' | 'uploaded' | 'error';

/**
 * A scanned paper permit attached to a journal entry. The binary PDF is stored
 * in Object Storage, never in PostgreSQL; this row is metadata only.
 */
export interface EntryAttachment {
  id: UUID;
  entry_id: UUID;
  kind: AttachmentKind;
  mime_type: 'application/pdf';
  pages: number;
  sha256: string;
  size_bytes: number;
  status: AttachmentStatus;
  created_by: UUID;
  created_at: IsoDateTime;
  /** Short-lived API URL returned by the metadata/list endpoint. */
  url?: string;
  expires_at?: IsoDateTime;
}

export interface AttachmentSignedUrl {
  url: string;
  expires_at: IsoDateTime;
  expires_in: number;
}

export interface OutboxOperation {
  op_id: UUID;
  user_id: UUID;
  device_id: UUID;
  entity_type: 'entry' | 'shift' | 'attachment';
  entity_id: UUID;
  op_type: OpType;
  payload: Record<string, unknown>;
  field_clocks: Record<string, Hlc>;
  base_version: number | null;
  hlc: Hlc;
  created_at: IsoDateTime;
  attempts: number;
  next_attempt_at: IsoDateTime | null;
  last_error_code: string | null;
  last_error_message: string | null;
  status: OpStatus;
  sent_at: IsoDateTime | null;
  ack_at: IsoDateTime | null;
}

export interface EntryRevision {
  id: UUID;
  entry_id: UUID;
  revision_no: number;
  changed_by: UUID;
  changed_at: IsoDateTime;
  source: RevisionSource;
  hlc: Hlc;
  base_version: number;
  result_version: number;
  diff: Record<string, { before: unknown; after: unknown }>;
  reason_id: UUID | null;
  reason_comment: string | null;
}

export interface ConflictRecord {
  id: UUID;
  entry_id: UUID;
  field: string;
  local_value: unknown;
  remote_value: unknown;
  local_hlc: Hlc;
  remote_hlc: Hlc;
  resolution: 'local' | 'remote' | 'manual' | 'pending';
  resolved_by: UUID | null;
  resolved_at: IsoDateTime | null;
}

export interface ChangeLogEntry {
  seq: number;
  entity_type: 'entry' | 'permit' | 'shift' | 'grounding';
  entity_id: UUID;
  op: ChangeOp;
  version: number | null;
  changed_at: IsoDateTime;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    request_id?: string;
  };
}

export interface SyncPushOp {
  op_id: UUID;
  entity_type: 'entry' | 'shift';
  entity_id: UUID;
  op_type: OpType;
  base_version: number | null;
  hlc: Hlc;
  client_time: IsoDateTime;
  payload: Record<string, unknown>;
  field_clocks?: Record<string, Hlc>;
}

export interface SyncPushRequest {
  device_id: UUID;
  app_version: string;
  ops: SyncPushOp[];
}

export interface SyncPushResult {
  op_id: UUID;
  status: 'applied' | 'duplicate' | 'conflict' | 'rejected';
  version: number | null;
  duplicate: boolean;
  merged_entry: JournalEntry | null;
  /** Current server shift for `entity_type = shift` conflict/applied results. */
  merged_shift?: Shift | null;
  resolution: Record<string, 'local' | 'remote' | 'manual'> | null;
  conflicts: Array<{ field: string; reason: string; local_hlc: string; remote_hlc: string }> | null;
  error: { code: string; message: string; fields?: Record<string, string> } | null;
}

export interface SyncPushResponse {
  server_time: IsoDateTime;
  results: SyncPushResult[];
}
