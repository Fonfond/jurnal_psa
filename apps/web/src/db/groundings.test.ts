import { beforeEach, describe, expect, it } from 'vitest';
import type { Grounding } from '@logbook/shared';
import { applyChanges } from './repositories';
import { db } from './schema';

function grounding(overrides: Partial<Grounding> = {}): Grounding {
  return {
    id: '01930000-0000-7000-8000-000000001201',
    journal_id: '01930000-0000-7000-8000-000000001001',
    site_id: '01930000-0000-7000-8000-000000000402',
    point: 'КЛ-10 кВ, яч. 5',
    grounding_type: 'portable',
    tool_number: 'T-1',
    count: 1,
    state: 'applied',
    applied_entry_id: '01930000-0000-7000-8000-000000000801',
    applied_by: '01930000-0000-7000-8000-000000000101',
    applied_at: '2026-11-25T08:10:00.000Z',
    removed_entry_id: null,
    removed_by: null,
    removed_at: null,
    version: 1,
    applied_by_name: 'Иванов Иван Иванович',
    site_name: 'Площадка А',
    ...overrides,
  };
}

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
});

describe('grounding registry cache (JRN-06)', () => {
  it('caches grounding registry changes from sync', async () => {
    const applied = grounding();
    const count = await applyChanges([
      {
        seq: 1,
        entity_type: 'grounding',
        op: 'upsert',
        entity: applied as unknown as Record<string, unknown>,
      },
    ]);
    expect(count).toBe(1);

    const stored = await db.groundings.get(applied.id);
    expect(stored).toMatchObject({
      state: 'applied',
      point: 'КЛ-10 кВ, яч. 5',
      tool_number: 'T-1',
      applied_by_name: 'Иванов Иван Иванович',
    });

    // A later removal replaces the cached row.
    await applyChanges([
      {
        seq: 2,
        entity_type: 'grounding',
        op: 'upsert',
        entity: grounding({
          state: 'removed',
          removed_entry_id: '01930000-0000-7000-8000-000000000802',
          removed_by: '01930000-0000-7000-8000-000000000101',
          removed_at: '2026-11-25T09:30:00.000Z',
          version: 2,
        }) as unknown as Record<string, unknown>,
      },
    ]);
    const removed = await db.groundings.get(applied.id);
    expect(removed?.state).toBe('removed');
    expect(removed?.version).toBe(2);
    expect(await db.groundings.count()).toBe(1);
  });
});
