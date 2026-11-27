import { describe, expect, it } from 'vitest';
import {
  compareHlc,
  formatHlc,
  isHlc,
  maxHlc,
  nextHlc,
  parseHlc,
} from './hlc';

const H1 = '1795000000000:00001:seed0001';
const H2 = '1795000000000:00002:seed0001';
const H3 = '1795000000001:00000:seed0001';

describe('HLC', () => {
  it('formats fixed-width 13:5:8', () => {
    expect(formatHlc(1795000000000, 1, 'seed0001')).toBe(H1);
    expect(H1).toHaveLength(28);
  });

  it('parses parts', () => {
    expect(parseHlc(H1)).toEqual({
      physical: 1795000000000,
      counter: 1,
      node: 'seed0001',
    });
  });

  it('orders lexicographically and chronologically', () => {
    expect(compareHlc(H1, H2)).toBe(-1);
    expect(compareHlc(H2, H3)).toBe(-1);
    expect(compareHlc(H3, H1)).toBe(1);
    expect(compareHlc(H1, H1)).toBe(0);
    expect([H3, H1, H2].sort(compareHlc)).toEqual([H1, H2, H3]);
  });

  it('increments the counter for equal physical time', () => {
    expect(nextHlc(H1, 1795000000000, 'seed0001')).toBe(H2);
  });

  it('moves physical time forward when clock jumps ahead', () => {
    expect(nextHlc(H1, 1795000009999, 'seed0001')).toBe(
      '1795000009999:00000:seed0001',
    );
  });

  it('never moves backwards when clock is behind', () => {
    expect(nextHlc(H3, 1000, 'seed0001')).toBe('1795000000001:00001:seed0001');
  });

  it('validates and finds max', () => {
    expect(isHlc(H1)).toBe(true);
    expect(isHlc('bad')).toBe(false);
    expect(isHlc('1795000000000:1:seed0001')).toBe(false);
    expect(maxHlc([H1, null, H2, H3])).toBe(H3);
  });

  it('throws on invalid input', () => {
    expect(() => parseHlc('nope')).toThrow();
    expect(() => formatHlc(1, 1, 'short')).toThrow();
  });
});
