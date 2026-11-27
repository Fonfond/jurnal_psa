import type { Request } from 'express';
import type { Role } from '@logbook/shared';

export interface AuthUser {
  id: string;
  role: Role;
  departmentId: string;
  fullName: string;
  email: string | null;
  sessionId: string;
  sessionExpiresAt: string;
}

export interface RequestMeta {
  requestId?: string;
  ip?: string;
  userAgent?: string;
  appVersion?: string;
  /** x-device-key header, verified against devices.device_key_hash. */
  deviceKey?: string;
}

export interface AppRequest extends Request {
  user?: AuthUser;
  requestId?: string;
}
