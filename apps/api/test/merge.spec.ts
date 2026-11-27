import { formatHlc } from '@logbook/shared';
import {
  decideMerge,
  type MergeableEntry,
  validateMergedEntry,
} from '../src/sync/merge';

const H1 = formatHlc(1795000000000, 1, 'test0001');
const H2 = formatHlc(1795000000000, 2, 'test0001');
const H3 = formatHlc(1795000000000, 3, 'test0001');
const H4 = formatHlc(1795000000000, 4, 'test0001');

function entry(overrides: Partial<MergeableEntry> = {}): MergeableEntry {
  return {
    id: '01930000-0000-7000-8000-000000000801',
    author_id: '01930000-0000-7000-8000-000000000101',
    version: 1,
    hlc: H1,
    verified_at: null,
    status: 'active',
    text: 'Исходный текст записи',
    comment: null,
    performed_tz_offset_min: 180,
    input_method: 'manual',
    permit_id: null,
    permit_number_raw: null,
    permit_binding_status: 'not_required',
    permit_risk_flag: false,
    permit_risk_reason: null,
    field_clocks: { text: H1 },
    ...overrides,
  };
}

function operation(payload: Record<string, unknown>, hlc: string, clocks: Record<string, string>) {
  return {
    op_type: 'update' as const,
    hlc,
    field_clocks: clocks,
    payload,
    client_time: '2026-11-23T12:00:00.000Z',
  };
}

describe('decideMerge (C-01…C-12)', () => {
  it('C-01 applies changes to different fields', () => {
    const result = decideMerge(
      entry(),
      operation(
        { text: 'Новый текст записи', comment: 'Комментарий' },
        H2,
        { text: H2, comment: H2 },
      ),
      { id: 'another-user', role: 'worker' },
    );

    expect(Object.keys(result.applied).sort()).toEqual(['comment', 'text']);
    expect(result.conflicts).toHaveLength(0);
    expect(result.blocked).toBe(false);
    expect(result.fieldClocks.text).toBe(H2);
  });

  it('keeps the newer server field and records an older conflict', () => {
    const result = decideMerge(
      entry({ field_clocks: { text: H3 } }),
      operation({ text: 'Старый текст' }, H2, { text: H2 }),
      { id: 'another-user', role: 'worker' },
    );

    expect(result.applied).toEqual({});
    expect(result.conflicts[0]).toMatchObject({
      field: 'text',
      reason: 'older_change',
    });
  });

  it('C-03 blocks an author edit of a verified entry', () => {
    const result = decideMerge(
      entry({ verified_at: '2026-11-23T10:00:00.000Z' }),
      operation({ text: 'Правка после проверки' }, H3, { text: H3 }),
      { id: '01930000-0000-7000-8000-000000000101', role: 'worker' },
    );

    expect(result.applied).toEqual({});
    expect(result.blocked).toBe(true);
    expect(result.conflicts[0]).toMatchObject({
      field: 'text',
      reason: 'verified_entry',
    });
  });

  it('uses server state on equal clocks', () => {
    const result = decideMerge(
      entry({ field_clocks: { text: H2 } }),
      operation({ text: 'Другой текст' }, H2, { text: H2 }),
      { id: 'another-user', role: 'supervisor' },
    );

    expect(result.applied).toEqual({});
    expect(result.conflicts[0]?.reason).toBe('equal_clock');
  });

  it('marks deleted entries as blocked', () => {
    const result = decideMerge(
      entry({ status: 'deleted' }),
      operation({ text: 'Новый текст' }, H2, { text: H2 }),
      { id: 'another-user', role: 'admin' },
    );

    expect(result.blocked).toBe(true);
  });

  it('C-08 blocks a manual time change without consent', () => {
    const result = decideMerge(
      entry({
        performed_at_source: 'server_corrected',
        performed_at: '2026-11-23T10:00:00.000Z',
        field_clocks: { performed_at: H3 },
      }),
      operation(
        { performed_at: '2026-11-23T11:00:00.000Z' },
        H4,
        { performed_at: H4 },
      ),
      { id: 'another-user', role: 'worker' },
    );

    expect(result.applied).toEqual({});
    expect(result.conflicts[0]).toMatchObject({
      field: 'performed_at',
      reason: 'server_correction_requires_consent',
    });
  });

  it('C-08 applies a manual time change with explicit consent', () => {
    const result = decideMerge(
      entry({
        performed_at_source: 'server_corrected',
        performed_at: '2026-11-23T10:00:00.000Z',
        field_clocks: { performed_at: H3 },
      }),
      operation(
        {
          performed_at: '2026-11-23T11:00:00.000Z',
          accept_server_time: true,
        },
        H4,
        { performed_at: H4 },
      ),
      { id: 'another-user', role: 'worker' },
    );

    expect(result.applied.performed_at).toEqual({
      before: '2026-11-23T10:00:00.000Z',
      after: '2026-11-23T11:00:00.000Z',
    });
    expect(result.applied.performed_at_source.after).toBe('manual');
    expect(result.conflicts).toHaveLength(0);
  });
});

describe('validateMergedEntry (C-10)', () => {
  it('accepts a valid candidate', () => {
    expect(validateMergedEntry(entry())).toEqual([]);
  });

  it('rejects permit_id together with permit_number_raw', () => {
    expect(
      validateMergedEntry(
        entry({
          permit_id: '01930000-0000-7000-8000-000000000701',
          permit_number_raw: 'НД-1',
          permit_binding_status: 'linked',
        }),
      ),
    ).toContain('permit_id_and_number_raw_are_exclusive');
  });

  it('rejects risk flag without a reason', () => {
    expect(
      validateMergedEntry(entry({ permit_risk_flag: true, permit_risk_reason: null })),
    ).toContain('risk_requires_reason');
  });
});
