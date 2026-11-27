import { describe, expect, it } from 'vitest';
import { SEED_UUIDS } from './ids';
import { isUuid, uuidv7 } from './ids';

describe('uuidv7', () => {
  it('generates valid version 7 UUIDs', () => {
    const id = uuidv7(1795000000000);
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is time ordered by prefix', () => {
    const early = uuidv7(1_000_000_000_000);
    const late = uuidv7(1_795_000_000_000);
    expect(early.slice(0, 8) < late.slice(0, 8)).toBe(true);
  });

  it('keeps seed identifiers valid', () => {
    for (const id of Object.values(SEED_UUIDS)) {
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe('7');
    }
  });
});
