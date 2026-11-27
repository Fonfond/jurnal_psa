export interface EntryCursor {
  performedAt: string;
  id: string;
}

export function encodeEntryCursor(performedAt: string, id: string): string {
  return Buffer.from(`${performedAt}|${id}`, 'utf8').toString('base64url');
}

export function decodeEntryCursor(cursor?: string): EntryCursor | null {
  if (!cursor) {
    return null;
  }
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) {
      return null;
    }
    const performedAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(Date.parse(performedAt)) || id.length < 10) {
      return null;
    }
    return { performedAt, id };
  } catch {
    return null;
  }
}
