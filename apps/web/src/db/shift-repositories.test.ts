import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_JOURNAL_ID, type Shift } from '@logbook/shared';
import type { ApiUser } from '../api/types';
import {
  acceptShiftLocal,
  applyServerShift,
  createShiftLocal,
  getLocalShift,
  listLocalShifts,
  pendingShiftCount,
  rejectShiftLocal,
  resolveShiftConflict,
} from './shift-repositories';
import { db } from './schema';

const outgoing: ApiUser = {
  id: '01930000-0000-7000-8000-000000000102',
  full_name: 'Петров Пётр Петрович',
  role: 'supervisor',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'supervisor@logbook.local',
};

const incoming: ApiUser = {
  id: '01930000-0000-7000-8000-000000000104',
  full_name: 'Смирнов Пётр Ильич',
  role: 'supervisor',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'supervisor2@logbook.local',
};

const handover = {
  journal_id: DEFAULT_JOURNAL_ID,
  shift_date: '2026-11-24',
  period_start: '2026-11-24T05:00:00.000Z',
  period_end: '2026-11-24T17:00:00.000Z',
  handover_comment: 'Смена сдана, журнал проверен, замечаний нет',
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
});

describe('offline shift handover repository (JRN-02)', () => {
  it('creates a handover locally with a pending create operation', async () => {
    const shift = await createShiftLocal(handover, outgoing);

    expect(shift.status).toBe('handed_over');
    expect(shift.journal_id).toBe(DEFAULT_JOURNAL_ID);
    expect(shift.handed_over_by).toBe(outgoing.id);
    expect(shift.version).toBe(1);
    expect(shift.sync_status).toBe('pending');
    expect(shift.handed_over_by_name).toBe(outgoing.full_name);

    const operations = await db.outbox.toArray();
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      entity_type: 'shift',
      entity_id: shift.id,
      op_type: 'create',
      base_version: null,
    });
    expect(operations[0]?.payload).toMatchObject({
      journal_id: DEFAULT_JOURNAL_ID,
      handover_comment: handover.handover_comment,
    });
    expect(await pendingShiftCount()).toBe(1);
  });

  it('accepts offline with an update operation against the handover version', async () => {
    const shift = await createShiftLocal(handover, outgoing);
    const accepted = await acceptShiftLocal(shift.id, 'Принято, замечаний нет', incoming);

    expect(accepted.status).toBe('accepted');
    expect(accepted.accepted_by).toBe(incoming.id);
    expect(accepted.acceptance_comment).toBe('Принято, замечаний нет');
    expect(accepted.sync_status).toBe('pending');

    const operations = await db.outbox.toArray();
    const update = operations.find((operation) => operation.op_type === 'update');
    expect(update).toMatchObject({
      entity_type: 'shift',
      entity_id: shift.id,
      base_version: 1,
    });
    expect(update?.payload).toMatchObject({ action: 'accept' });
  });

  it('rejects offline with a reason and forbids self-acceptance', async () => {
    const shift = await createShiftLocal(handover, outgoing);

    await expect(acceptShiftLocal(shift.id, null, outgoing)).rejects.toThrow(
      /другой руководитель/,
    );

    const rejected = await rejectShiftLocal(
      shift.id,
      'Не приложены ведомости замеров',
      incoming,
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejection_reason).toBe('Не приложены ведомости замеров');

    const update = (await db.outbox.toArray()).find(
      (operation) => operation.op_type === 'update',
    );
    expect(update?.payload).toMatchObject({
      action: 'reject',
      rejection_reason: 'Не приложены ведомости замеров',
    });

    // A second decision on the same shift is refused locally.
    await expect(acceptShiftLocal(shift.id, null, incoming)).rejects.toThrow(
      /уже принята или отклонена/,
    );
  });

  it('lists and filters shifts and applies the server state', async () => {
    const first = await createShiftLocal(handover, outgoing);
    const second = await createShiftLocal(
      { ...handover, shift_date: '2026-11-25' },
      outgoing,
    );

    const all = await listLocalShifts();
    expect(all.map((shift) => shift.id)).toEqual([second.id, first.id]);

    const serverShift: Shift = {
      ...first,
      status: 'accepted',
      accepted_by: incoming.id,
      accepted_at: '2026-11-24T18:00:00.000Z',
      acceptance_comment: 'Принято',
      version: 2,
      content_hash: 'a'.repeat(64),
    };
    await applyServerShift(serverShift);
    const stored = await getLocalShift(first.id);
    expect(stored?.status).toBe('accepted');
    expect(stored?.sync_status).toBe('synced');

    await applyServerShift(serverShift, { conflict: 'shift_already_accepted' });
    const conflicted = await getLocalShift(first.id);
    expect(conflicted?.sync_status).toBe('conflict');
    expect(conflicted?.sync_error).toBe('shift_already_accepted');

    await resolveShiftConflict(first.id);
    expect((await getLocalShift(first.id))?.sync_status).toBe('synced');

    expect(await listLocalShifts({ status: 'handed_over' })).toHaveLength(1);
  });
});
