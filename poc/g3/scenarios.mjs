// PoC G3 — C-01..C-12 scenario fixtures. No product code.
import { createEntry } from './merge.mjs';
import { formatHlc } from './hlc.mjs';

export function clock(ms, counter = 0, node = 'poc00001') {
  return formatHlc(ms, counter, node);
}

const BASE_MS = 1_795_000_000_000;

export const CONFLICT_SCENARIOS = [
  {
    id: 'POC-G3-01',
    conflict: 'C-01',
    title: 'разные поля',
    base: createEntry({ text: 'A', performed_at: '2026-11-24T08:00:00.000Z', hlc: clock(BASE_MS) }),
    ops: [
      { op_id: 'g3-01-a', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 10), fields: { text: 'B' } },
      { op_id: 'g3-01-b', entry_id: 'e1', type: 'update', actor: { id: 'u-supervisor', role: 'supervisor' }, hlc: clock(BASE_MS + 11), fields: { performed_at: '2026-11-24T09:00:00.000Z' } },
    ],
    expected: { text: 'B', performed_at: '2026-11-24T09:00:00.000Z', deleted: false },
  },
  {
    id: 'POC-G3-02',
    conflict: 'C-02',
    title: 'одно поле, два автора',
    base: createEntry({ text: 'A', hlc: clock(BASE_MS) }),
    ops: [
      { op_id: 'g3-02-a', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 20), fields: { text: 'B' } },
      { op_id: 'g3-02-b', entry_id: 'e1', type: 'update', actor: { id: 'u-author2', role: 'worker' }, hlc: clock(BASE_MS + 21), fields: { text: 'C' } },
    ],
    expected: { text: 'C', deleted: false },
  },
  {
    id: 'POC-G3-03',
    conflict: 'C-03',
    title: 'проверенная запись, правка автора',
    base: createEntry({ text: 'A', hlc: clock(BASE_MS), verified: true }),
    ops: [
      { op_id: 'g3-03-a', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 30), fields: { text: 'B' } },
      { op_id: 'g3-03-b', entry_id: 'e1', type: 'update', actor: { id: 'u-supervisor', role: 'supervisor' }, hlc: clock(BASE_MS + 31), fields: { text: 'C' } },
    ],
    expected: { text: 'C', deleted: false },
  },
  {
    id: 'POC-G3-04',
    conflict: 'C-04',
    title: 'автор и руководитель без проверки',
    base: createEntry({ text: 'A', hlc: clock(BASE_MS) }),
    ops: [
      { op_id: 'g3-04-a', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 40), fields: { text: 'B' } },
      { op_id: 'g3-04-b', entry_id: 'e1', type: 'update', actor: { id: 'u-supervisor', role: 'supervisor' }, hlc: clock(BASE_MS + 41), fields: { text: 'C' } },
    ],
    expected: { text: 'C', deleted: false },
  },
  {
    id: 'POC-G3-05',
    conflict: 'C-05',
    title: 'удаление и изменение',
    base: createEntry({ text: 'A', hlc: clock(BASE_MS) }),
    ops: [
      { op_id: 'g3-05-a', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 50), fields: { text: 'B' } },
      { op_id: 'g3-05-b', entry_id: 'e1', type: 'delete', actor: { id: 'u-supervisor', role: 'supervisor' }, hlc: clock(BASE_MS + 51) },
    ],
    expected: { deleted: true },
  },
  {
    id: 'POC-G3-06',
    conflict: 'C-06',
    title: 'восстановление автором',
    base: createEntry({ text: 'A', hlc: clock(BASE_MS) }),
    ops: [
      { op_id: 'g3-06-a', entry_id: 'e1', type: 'delete', actor: { id: 'u-supervisor', role: 'supervisor' }, hlc: clock(BASE_MS + 61) },
      { op_id: 'g3-06-b', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 60), fields: { text: 'B' } },
    ],
    expected: { deleted: true },
  },
  {
    id: 'POC-G3-07',
    conflict: 'C-07',
    title: 'дубль create',
    base: createEntry({ text: 'A', hlc: clock(BASE_MS) }),
    ops: [
      { op_id: 'g3-07-a', entry_id: 'e1', type: 'create', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 70), fields: { text: 'B' } },
    ],
    expected: { text: 'A', deleted: false },
  },
  {
    id: 'POC-G3-08',
    conflict: 'C-08',
    title: 'серверная коррекция времени',
    base: createEntry({ text: 'A', performed_at_source: 'server_corrected', hlc: clock(BASE_MS) }),
    ops: [
      { op_id: 'g3-08-a', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 80), fields: { performed_at: '2026-11-24T10:00:00.000Z' }, accept_server_time: false },
    ],
    expected: { performed_at: '2026-11-24T08:00:00.000Z', deleted: false },
  },
  {
    id: 'POC-G3-09',
    conflict: 'C-09',
    title: 'аннулирование наряда',
    base: { ...createEntry({ text: 'A', permit_id: 'p1', hlc: clock(BASE_MS) }), permit_status: 'annulled' },
    ops: [
      { op_id: 'g3-09-a', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 90), fields: { text: 'B', permit_id: 'p1' } },
    ],
    expected: { text: 'B', permit_risk_flag: true, deleted: false },
  },
  {
    id: 'POC-G3-10',
    conflict: 'C-10',
    title: 'невалидный merge',
    base: createEntry({ text: 'A', hlc: clock(BASE_MS) }),
    ops: [
      { op_id: 'g3-10-a', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 100), fields: { text: '' } },
    ],
    expected: { text: 'A', deleted: false },
  },
  {
    id: 'POC-G3-11',
    conflict: 'C-11',
    title: 'сервер новее',
    base: createEntry({ text: 'server', hlc: clock(BASE_MS + 200) }),
    ops: [
      { op_id: 'g3-11-a', entry_id: 'e1', type: 'update', actor: { id: 'u-author', role: 'worker' }, hlc: clock(BASE_MS + 100), fields: { text: 'local' } },
    ],
    expected: { text: 'server', deleted: false },
  },
  {
    id: 'POC-G3-12',
    conflict: 'C-12',
    title: 'два руководителя',
    base: createEntry({ text: 'A', hlc: clock(BASE_MS) }),
    ops: [
      { op_id: 'g3-12-a', entry_id: 'e1', type: 'update', actor: { id: 'u-supervisor', role: 'supervisor' }, hlc: clock(BASE_MS + 120), fields: { text: 'B' } },
      { op_id: 'g3-12-b', entry_id: 'e1', type: 'update', actor: { id: 'u-supervisor2', role: 'supervisor' }, hlc: clock(BASE_MS + 121), fields: { text: 'C' } },
    ],
    expected: { text: 'C', deleted: false },
  },
];

export function checkExpected(state, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'deleted') {
      if (state.deleted !== value) return `deleted=${state.deleted} expected ${value}`;
      continue;
    }
    if (state.fields[key] !== value) {
      return `${key}=${JSON.stringify(state.fields[key])} expected ${JSON.stringify(value)}`;
    }
  }
  return null;
}
