import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AppRequest } from './types';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison for secrets/tokens of equal length. */
export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

export function randomToken(): string {
  return randomBytes(32).toString('hex');
}

export function newRequestId(): string {
  return `req_${randomUUID()}`;
}

/** Deterministic JSON for hashing (sorted keys, recursive). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function requestContext(req: Request, res: Response, next: () => void): void {
  const header = req.header('x-request-id');
  const requestId =
    header && /^[A-Za-z0-9_-]{8,64}$/.test(header) ? header : newRequestId();
  (req as AppRequest).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}
