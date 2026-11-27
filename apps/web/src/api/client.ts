import type {
  AuthConfigResponse,
  Journal,
  ConflictRecord,
  DeviceRegistrationInput,
  DeviceRegistrationResponse,
  Grounding,
  JournalEntry,
  JournalReview,
  Shift,
  SignatureRecord,
  SyncPushRequest,
  SyncPushResponse,
} from '@logbook/shared';
import type {
  ChangesResponse,
  ConflictsResponse,
  DeviceRow,
  EntriesResponse,
  GroundingsResponse,
  JournalsResponse,
  LoginResponse,
  MeResponse,
  PermitsResponse,
  PermitPdfLink,
  ReviewsResponse,
  ShiftsResponse,
  AdminDepartment,
  AdminDevicesResponse,
  AdminUser,
  AdminUsersResponse,
  ArchiveRow,
  AuditEventRow,
  AuditVerifyResult,
  BackupManifest,
  ExportJobResult,
  ExportJobRow,
  ExportUrlResponse,
  JournalMember,
  PermitImportHistoryRow,
  PermitImportResult,
  RetentionStatus,
  SnapshotResponse,
} from './types';
import { setPersistedCsrfToken } from '../db/repositories';

const BASE = (import.meta.env.VITE_API_URL ?? '/v1').replace(/\/+$/, '');

let csrfFallback = '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string>;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: Record<string, string>,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.requestId = requestId;
  }
}

export function getCookie(name: string): string {
  if (typeof document === 'undefined') {
    return '';
  }
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`),
  );
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

export function setCsrfToken(token: string): void {
  csrfFallback = token;
  // The service worker cannot read page memory; a persisted copy lets a
  // Background Sync flush after the tab was closed send X-CSRF-Token.
  void setPersistedCsrfToken(token).catch(() => undefined);
}

export function getCsrfToken(): string {
  return getCookie('lb_csrf') || csrfFallback;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);

  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (UNSAFE_METHODS.has(method)) {
    const csrf = getCsrfToken();
    if (csrf) {
      headers.set('X-CSRF-Token', csrf);
    }
  }

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      method,
      headers,
      credentials: 'include',
    });
  } catch {
    throw new ApiError(
      0,
      'E-NET-01',
      'Нет соединения с сервером. Данные сохранены локально.',
    );
  }

  const raw = await response.text();
  let data: unknown = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const body = data as
      | {
          error?: {
            code?: string;
            message?: string;
            fields?: Record<string, string>;
            request_id?: string;
          };
        }
      | null;
    const error = new ApiError(
      response.status,
      body?.error?.code ?? 'E-SRV-01',
      body?.error?.message ?? `Ошибка ${response.status}`,
      body?.error?.fields,
      body?.error?.request_id,
    );

    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('logbook:unauthorized'));
    }
    throw error;
  }

  return data as T;
}

function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const result = search.toString();
  return result ? `?${result}` : '';
}

export const api = {
  async login(email: string, password: string): Promise<LoginResponse> {
    const result = await request<LoginResponse>('/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setCsrfToken(result.csrf_token);
    return result;
  },

  /** Public auth metadata: provider (dev|oidc), signature adapter, caveats. */
  authConfig(): Promise<AuthConfigResponse> {
    return request<AuthConfigResponse>('/auth/config');
  },

  /** Browser redirect target for OIDC Authorization Code + PKCE. */
  authorizeUrl(redirectAfter = '/'): string {
    return `${BASE}/auth/authorize${query({ redirect_after: redirectAfter })}`;
  },

  async logout(): Promise<void> {
    await request('/auth/logout', { method: 'POST' });
    setCsrfToken('');
  },

  async me(): Promise<MeResponse> {
    const response = await request<MeResponse>('/me');
    // ADR-14: the admin SPA lives on a separate origin and cannot read the
    // CSRF cookie of the API origin, so the token comes back in the profile.
    if (response.csrf_token) {
      setCsrfToken(response.csrf_token);
    }
    return response;
  },

  devices(): Promise<{ items: DeviceRow[] }> {
    return request<{ items: DeviceRow[] }>('/devices');
  },

  /** Idempotent registration by install_id; returns a device key once. */
  registerDevice(
    input: DeviceRegistrationInput,
  ): Promise<DeviceRegistrationResponse> {
    return request<DeviceRegistrationResponse>('/devices', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  entries(params: {
    limit?: number;
    cursor?: string;
    status?: string;
    author_id?: string;
    permit_id?: string;
    journal_id?: string;
    from?: string;
    to?: string;
  } = {}): Promise<EntriesResponse> {
    return request<EntriesResponse>(`/entries${query(params)}`);
  },

  journals(): Promise<JournalsResponse> {
    return request<JournalsResponse>('/journals');
  },

  /** Shift handovers cached for offline acceptance (JRN-02). */
  shifts(params: {
    journal_id?: string;
    status?: string;
    from?: string;
    to?: string;
    limit?: number;
  } = {}): Promise<ShiftsResponse> {
    return request<ShiftsResponse>(`/shifts${query(params)}`);
  },

  shift(id: string): Promise<Shift & { signatures?: unknown[] }> {
    return request(`/shifts/${id}`);
  },

  /** Grounding registry cache (JRN-06). */
  groundings(params: {
    journal_id?: string;
    site_id?: string;
    state?: string;
    limit?: number;
  } = {}): Promise<GroundingsResponse> {
    return request<GroundingsResponse>(`/groundings${query(params)}`);
  },

  grounding(id: string): Promise<Grounding> {
    return request(`/groundings/${id}`);
  },

  entry(
    id: string,
  ): Promise<JournalEntry & { revisions?: unknown[]; signatures?: SignatureRecord[] }> {
    return request(`/entries/${id}`);
  },

  push(body: SyncPushRequest, deviceKey?: string): Promise<SyncPushResponse> {
    return request<SyncPushResponse>('/sync/push', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: deviceKey ? { 'X-Device-Key': deviceKey } : undefined,
    });
  },

  changes(sinceSeq: number, limit = 200): Promise<ChangesResponse> {
    return request<ChangesResponse>(
      `/sync/changes${query({ since_seq: sinceSeq, limit })}`,
    );
  },

  snapshot(): Promise<SnapshotResponse> {
    return request<SnapshotResponse>('/dictionaries/snapshot');
  },

  permits(params: { limit?: number; status?: string } = {}): Promise<PermitsResponse> {
    return request<PermitsResponse>(`/permits${query(params)}`);
  },

  verify(id: string): Promise<JournalEntry & { signature?: SignatureRecord | null }> {
    return request(`/entries/${id}/verify`, { method: 'POST' });
  },

  unverify(id: string, comment?: string): Promise<JournalEntry> {
    return request<JournalEntry>(`/entries/${id}/unverify`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    });
  },

  /** Manual entry visa signature through the configured ЭП adapter (OQ-04). */
  signEntry(id: string, reason?: string): Promise<SignatureRecord> {
    return request<SignatureRecord>(`/entries/${id}/sign`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  restore(id: string): Promise<JournalEntry> {
    return request<JournalEntry>(`/entries/${id}/restore`, { method: 'POST' });
  },

  conflicts(): Promise<ConflictsResponse> {
    return request<ConflictsResponse>('/conflicts');
  },

  async resolveConflict(
    id: string,
    body: {
      resolution: 'local' | 'remote' | 'manual';
      values?: Record<string, unknown>;
      comment?: string;
    },
  ): Promise<{ id: string; resolution: string; entry_version: number }> {
    return request(`/conflicts/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  async permitPdfUrl(id: string): Promise<PermitPdfLink> {
    return request<PermitPdfLink>(`/permits/${id}/pdf-url`, { method: 'POST' });
  },

  async deleteDevice(id: string): Promise<void> {
    await request(`/devices/${id}`, { method: 'DELETE' });
  },

  async reviews(params: {
    from?: string;
    to?: string;
    journal_id?: string;
    limit?: number;
  } = {}): Promise<ReviewsResponse> {
    return request<ReviewsResponse>(`/journal/reviews${query(params)}`);
  },

  async createReview(body: {
    journal_id?: string;
    period_start: string;
    period_end: string;
    remarks?: string;
  }): Promise<JournalReview & { signature?: SignatureRecord | null }> {
    return request('/journal/reviews', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** Manual review signature through the configured ЭП adapter (OQ-04). */
  signReview(id: string, reason?: string): Promise<SignatureRecord> {
    return request<SignatureRecord>(`/journal/reviews/${id}/sign`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  reviewSignatures(id: string): Promise<{ items: SignatureRecord[] }> {
    return request<{ items: SignatureRecord[] }>(
      `/journal/reviews/${id}/signatures`,
    );
  },

  async exportJournalCsv(
    from?: string,
    to?: string,
    journalId?: string,
  ): Promise<Blob> {
    const response = await fetch(
      `${BASE}/journal/export${query({ from, to, journal_id: journalId, format: 'csv' })}`,
      { credentials: 'include' },
    );
    if (!response.ok) {
      const raw = await response.text();
      type ErrorPayload = { error?: { code?: string; message?: string } };
      let body: ErrorPayload | null = null;
      try {
        body = JSON.parse(raw) as ErrorPayload;
      } catch {
        body = null;
      }
      throw new ApiError(
        response.status,
        body?.error?.code ?? 'E-SRV-01',
        body?.error?.message ?? `Ошибка ${response.status}`,
      );
    }
    return response.blob();
  },

  /* --------------------------------------------------------------- admin */

  adminUsers(
    params: {
      search?: string;
      role?: string;
      status?: string;
      department_id?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<AdminUsersResponse> {
    return request<AdminUsersResponse>(`/admin/users${query(params)}`);
  },

  adminCreateUser(body: {
    email: string;
    full_name: string;
    role: string;
    department_id: string;
    position?: string;
  }): Promise<AdminUser> {
    return request<AdminUser>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  adminPatchUser(
    id: string,
    body: {
      full_name?: string;
      role?: string;
      department_id?: string;
      status?: string;
      position?: string;
    },
  ): Promise<AdminUser> {
    return request<AdminUser>(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  adminRevokeSessions(id: string): Promise<{ ok: true; revoked: number }> {
    return request(`/admin/users/${id}/revoke-sessions`, { method: 'POST' });
  },

  adminDepartments(): Promise<{ items: AdminDepartment[] }> {
    return request<{ items: AdminDepartment[] }>('/admin/departments');
  },

  adminDevices(
    params: { search?: string; status?: string; limit?: number; offset?: number } = {},
  ): Promise<AdminDevicesResponse> {
    return request<AdminDevicesResponse>(`/admin/devices${query(params)}`);
  },

  adminRevokeDevice(
    id: string,
  ): Promise<{ ok: true; revoked_sessions: number }> {
    return request(`/admin/devices/${id}`, { method: 'DELETE' });
  },

  audit(params: {
    action?: string;
    entity_type?: string;
    entity_id?: string;
    from?: string;
    to?: string;
    limit?: number;
  } = {}): Promise<{ items: AuditEventRow[] }> {
    return request<{ items: AuditEventRow[] }>(`/audit${query(params)}`);
  },

  /* retention / archive / backup (t7 contract, JRN-04/ADM-04) */

  retention(): Promise<RetentionStatus> {
    return request<RetentionStatus>('/admin/retention');
  },

  retentionRun(now?: string): Promise<{
    id: string;
    report: Record<string, unknown>;
    audit_verification: AuditVerifyResult;
  }> {
    return request('/admin/retention/run', {
      method: 'POST',
      body: JSON.stringify(now ? { now } : {}),
    });
  },

  retentionArchive(body: {
    journal_id?: string;
    from?: string;
    to?: string;
  }): Promise<{
    archive_id: string;
    export: ExportJobResult;
    manifest: Record<string, unknown>;
    immutable: true;
  }> {
    return request('/admin/retention/archive', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  retentionArchives(): Promise<{ items: ArchiveRow[] }> {
    return request<{ items: ArchiveRow[] }>('/admin/retention/archives');
  },

  auditVerify(): Promise<AuditVerifyResult> {
    return request<AuditVerifyResult>('/admin/audit/verify');
  },

  backupManifest(): Promise<BackupManifest> {
    return request<BackupManifest>('/admin/backup/manifest');
  },

  backupCheckpoint(label?: string): Promise<{
    id: string;
    label: string | null;
    manifest_hash: string;
    created_at: string;
    manifest: Record<string, unknown>;
  }> {
    return request('/admin/backup/checkpoint', {
      method: 'POST',
      body: JSON.stringify(label ? { label } : {}),
    });
  },

  exports(
    params: { type?: string; status?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: ExportJobRow[]; total: number }> {
    return request(`/admin/exports${query(params)}`);
  },

  createExport(body: {
    journal_id?: string;
    from?: string;
    to?: string;
  }): Promise<ExportJobResult> {
    return request<ExportJobResult>('/admin/exports', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  exportJob(id: string): Promise<ExportJobResult> {
    return request<ExportJobResult>(`/admin/exports/${id}`);
  },

  exportUrl(
    id: string,
    format: 'pdf' | 'csv',
  ): Promise<ExportUrlResponse> {
    return request<ExportUrlResponse>(`/admin/exports/${id}/url`, {
      method: 'POST',
      body: JSON.stringify({ format }),
    });
  },

  /* journals directory (t3 endpoints used by the admin SPA) */

  journalMembers(id: string): Promise<{ items: JournalMember[] }> {
    return request<{ items: JournalMember[] }>(`/admin/journals/${id}/members`);
  },

  createJournal(body: {
    journal_key: string;
    name: string;
    description?: string | null;
    sort_order?: number;
    active?: boolean;
  }): Promise<Journal> {
    return request<Journal>('/admin/journals', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  patchJournal(
    id: string,
    body: {
      name?: string;
      description?: string | null;
      sort_order?: number;
      active?: boolean;
    },
  ): Promise<Journal> {
    return request<Journal>(`/admin/journals/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  grantJournal(
    id: string,
    userId: string,
    accessLevel: 'read' | 'write' | 'manage',
  ): Promise<Record<string, unknown>> {
    return request(`/admin/journals/${id}/members/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ access_level: accessLevel }),
    });
  },

  async revokeJournalGrant(id: string, userId: string): Promise<void> {
    await request(`/admin/journals/${id}/members/${userId}`, {
      method: 'DELETE',
    });
  },

  /* permit import (t6 endpoints) */

  adminImports(): Promise<{ items: PermitImportHistoryRow[] }> {
    return request<{ items: PermitImportHistoryRow[] }>('/admin/imports');
  },

  adminImportPermits(body: {
    source_id?: string;
    csv?: string;
    records?: Array<Record<string, unknown>>;
  }): Promise<PermitImportResult> {
    return request<PermitImportResult>('/admin/permits/import', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
};

export type ApiClient = typeof api;

export type { ConflictRecord };
