import { normalizePermitNumber, parseCsv } from '../src/permits/permits.service';

describe('permit number normalization', () => {
  it('uppercases and strips spaces and dashes', () => {
    expect(normalizePermitNumber('нд-123 / 2026')).toBe('НД1232026');
  });

  it('maps Latin homoglyphs to Cyrillic', () => {
    expect(normalizePermitNumber('HД-77')).toBe('НД77');
  });
});

describe('CSV parser', () => {
  it('parses quoted fields and commas', () => {
    const rows = parseCsv('a,b\n"1,2",3\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1,2', '3'],
    ]);
  });

  it('parses escaped quotes and CRLF', () => {
    const rows = parseCsv('a,b\r\n"say ""hi""",2\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['say "hi"', '2'],
    ]);
  });
});
