import { describe, expect, it } from 'vitest';
import {
  entryPayloadSchema,
  hlcSchema,
  loginSchema,
  syncPushSchema,
  validateEventData,
} from './schemas';
import { ABBREVIATIONS, findAbbreviation } from './abbreviations';
import { SEED_UUIDS } from './ids';

const H = '1795000000000:00001:seed0001';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    performed_at: '2026-11-20T08:00:00.000Z',
    performed_tz_offset_min: 180,
    work_type_id: SEED_UUIDS.workTypePermit,
    site_id: SEED_UUIDS.siteWorkshop,
    permit_id: SEED_UUIDS.permitActive,
    text: 'Заменён автоматический выключатель в распределительном щите',
    input_method: 'manual',
    ...overrides,
  };
}

describe('entryPayloadSchema', () => {
  it('accepts a valid manual entry', () => {
    const result = entryPayloadSchema.safeParse(payload());
    expect(result.success).toBe(true);
  });

  it('rejects a short text', () => {
    const result = entryPayloadSchema.safeParse(payload({ text: 'мало' }));
    expect(result.success).toBe(false);
  });

  it('requires asr_engine for voice input', () => {
    const result = entryPayloadSchema.safeParse(
      payload({ input_method: 'voice' }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'asr_engine')).toBe(
        true,
      );
    }
  });

  it('requires a risk reason when the flag is set', () => {
    const result = entryPayloadSchema.safeParse(
      payload({ permit_risk_flag: true }),
    );
    expect(result.success).toBe(false);
  });

  it('forbids permit_id together with permit_number_raw', () => {
    const result = entryPayloadSchema.safeParse(
      payload({ permit_number_raw: 'НД-999/2026' }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts structured command event data', () => {
    const result = entryPayloadSchema.safeParse(
      payload({
        event_type: 'command',
        event_data: { issued_by: 'НСЭ Иванов', executed_at: '2026-11-20T08:03:00.000Z' },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects incomplete grounding event data', () => {
    const result = entryPayloadSchema.safeParse(
      payload({
        event_type: 'grounding',
        event_data: { action: 'applied' },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts the structured 757 switching form with operations and checks', () => {
    const result = entryPayloadSchema.safeParse(
      payload({
        event_type: 'switching',
        event_data: {
          order_no: 'БЛ-757/2026-14',
          order_date: '2026-11-25',
          responsible: 'Петров П.П.',
          operations: [
            {
              operation: 'open',
              device: 'Выключатель Q1',
              from_state: 'включено',
              to_state: 'отключено',
            },
            {
              operation: 'close',
              device: 'Заземляющие ножи QS2',
              from_state: 'отключено',
              to_state: 'включено',
            },
          ],
          checks: [
            { check: 'Проверено отсутствие напряжения', passed: true },
            { check: 'Ножи в крайнем положении', passed: true, note: 'визуально' },
          ],
          executed_at: '2026-11-25T07:50:00.000Z',
          points: 'РУ-10 кВ, яч. 5',
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects empty switching data and unknown operations', () => {
    const empty = entryPayloadSchema.safeParse(
      payload({
        event_type: 'switching',
        event_data: { order_no: 'БЛ-1' },
      }),
    );
    expect(empty.success).toBe(false);

    const unknown = entryPayloadSchema.safeParse(
      payload({
        event_type: 'switching',
        event_data: {
          operations: [{ operation: 'explode', device: 'Q1' }],
        },
      }),
    );
    expect(unknown.success).toBe(false);
  });

  it('keeps the legacy free-text switching payload valid', () => {
    const result = entryPayloadSchema.safeParse(
      payload({
        event_type: 'switching',
        event_data: {
          sequence: 'Отключить Q1, включить заземляющие ножи',
          points: 'РУ-10 кВ',
        },
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe('journal abbreviations', () => {
  it('contains the normative abbreviation reference and lookup', () => {
    expect(ABBREVIATIONS.length).toBeGreaterThan(50);
    expect(findAbbreviation('З/З')?.full).toContain('переносное');
  });

  it('validates event data per type', () => {
    expect(
      validateEventData('grounding', {
        action: 'applied',
        grounding_type: 'portable',
        point: 'КЛ-10 кВ, яч. 5',
        count: 1,
      }).success,
    ).toBe(true);
  });
});

describe('syncPushSchema', () => {
  const op = {
    op_id: SEED_UUIDS.entry1,
    entity_type: 'entry' as const,
    entity_id: SEED_UUIDS.entry1,
    op_type: 'create' as const,
    base_version: null,
    hlc: H,
    client_time: '2026-11-20T08:05:00.000Z',
    payload: payload(),
    field_clocks: { text: H },
  };

  it('accepts a valid batch', () => {
    const result = syncPushSchema.safeParse({
      device_id: SEED_UUIDS.deviceWorker,
      app_version: '0.1.0',
      ops: [op],
    });
    expect(result.success).toBe(true);
  });

  it('rejects more than 50 operations', () => {
    const result = syncPushSchema.safeParse({
      device_id: SEED_UUIDS.deviceWorker,
      app_version: '0.1.0',
      ops: Array.from({ length: 51 }, () => op),
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid HLC', () => {
    const result = syncPushSchema.safeParse({
      device_id: SEED_UUIDS.deviceWorker,
      app_version: '0.1.0',
      ops: [{ ...op, hlc: 'bad' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('other schemas', () => {
  it('validates HLC', () => {
    expect(hlcSchema.safeParse(H).success).toBe(true);
    expect(hlcSchema.safeParse('1:2:3').success).toBe(false);
  });

  it('validates login', () => {
    expect(
      loginSchema.safeParse({ email: 'worker@logbook.local', password: 'Logbook!2026' })
        .success,
    ).toBe(true);
    expect(loginSchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(
      false,
    );
  });
});
