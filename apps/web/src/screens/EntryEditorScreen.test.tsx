import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiUser } from '../api/types';
import { db } from '../db/schema';
import { useAuthStore } from '../stores/auth';
import { EntryEditorScreen } from './EntryEditorScreen';

const user: ApiUser = {
  id: '01930000-0000-7000-8000-000000000102',
  full_name: 'Петров Пётр Петрович',
  role: 'supervisor',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'supervisor@logbook.local',
};

beforeEach(async () => {
  for (const table of db.tables) {
    await table.clear();
  }
  await db.dict_work_types.put({
    id: '01930000-0000-7000-8000-000000000302',
    code: 'INSPECT',
    name: 'Осмотр территории',
    requires_permit: false,
    requires_site: false,
    default_template_id: null,
    active: true,
    sort_order: 10,
  });
  useAuthStore.setState({ user, initialized: true });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline in test')));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderEditor(): void {
  render(
    <MemoryRouter initialEntries={['/entries/new']}>
      <Routes>
        <Route path="entries/new" element={<EntryEditorScreen />} />
        <Route path="entries/:id" element={<div>карточка</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EntryEditorScreen structured events (JRN-05/JRN-06)', () => {
  it('saves a switching form with operations and checks', async () => {
    renderEditor();

    await screen.findByLabelText('Тип события');
    await userEvent.selectOptions(
      screen.getByLabelText('Тип события'),
      'switching',
    );

    expect(screen.getByText('Последовательность операций')).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText('Номер бланка переключения'),
      'БЛ-757/2026-15',
    );
    await userEvent.type(screen.getByLabelText('Аппарат 1'), 'Выключатель Q1');
    await userEvent.type(screen.getByLabelText('Исходное состояние 1'), 'включено');
    await userEvent.type(screen.getByLabelText('Целевое состояние 1'), 'отключено');

    await userEvent.click(screen.getByRole('button', { name: '+ Проверка' }));
    await userEvent.type(
      screen.getByLabelText('Проверка 1'),
      'Проверено отсутствие напряжения',
    );

    await userEvent.type(
      screen.getByLabelText(/Текст записи/),
      'Переключение по бланку с проверкой напряжения',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Сохранить запись' }),
    );

    await waitFor(async () => {
      expect(await db.outbox.count()).toBe(1);
    });
    const operations = await db.outbox.toArray();
    const payload = operations[0]?.payload as {
      event_type: string;
      event_data: {
        order_no: string;
        operations: Array<Record<string, unknown>>;
        checks: Array<Record<string, unknown>>;
      };
    };
    expect(payload.event_type).toBe('switching');
    expect(payload.event_data.order_no).toBe('БЛ-757/2026-15');
    expect(payload.event_data.operations[0]).toMatchObject({
      operation: 'open',
      device: 'Выключатель Q1',
      from_state: 'включено',
      to_state: 'отключено',
    });
    expect(payload.event_data.checks[0]).toMatchObject({
      check: 'Проверено отсутствие напряжения',
      passed: true,
    });
  });

  it('saves a manual site name without blocking on the dictionary', async () => {
    await db.dict_work_types.put({
      id: '01930000-0000-7000-8000-000000000303',
      code: 'SITE_WORK',
      name: 'Работы на объекте',
      requires_permit: false,
      requires_site: true,
      default_template_id: null,
      active: true,
      sort_order: 0,
    });
    renderEditor();

    await screen.findByLabelText(/Тип события/);
    await userEvent.click(screen.getByRole('button', { name: 'Другой объект' }));
    await userEvent.type(
      screen.getByPlaceholderText('Начните вводить или выберите из списка'),
      'Временный объект №99',
    );
    await userEvent.type(
      screen.getByLabelText(/Текст записи/),
      'Работа на объекте, которого нет в справочнике',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Сохранить запись' }),
    );

    await waitFor(async () => {
      expect(await db.outbox.count()).toBe(1);
    });
    const payload = (await db.outbox.toArray())[0]?.payload as {
      site_id: string | null;
      site_name_raw: string;
      site_binding_status: string;
    };
    expect(payload).toMatchObject({
      site_id: null,
      site_name_raw: 'Временный объект №99',
      site_binding_status: 'unresolved',
    });
  });

  it('saves a grounding event with the tool number', async () => {
    renderEditor();

    await screen.findByLabelText('Тип события');
    await userEvent.selectOptions(
      screen.getByLabelText('Тип события'),
      'grounding',
    );
    await userEvent.type(
      screen.getByLabelText('Точка установки *'),
      'КЛ-10 кВ, яч. 5',
    );
    await userEvent.type(screen.getByLabelText('Номер заземления'), 'T-7');
    await userEvent.type(
      screen.getByLabelText(/Текст записи/),
      'Установлено переносное заземление',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Сохранить запись' }),
    );

    await waitFor(async () => {
      expect(await db.outbox.count()).toBe(1);
    });
    const operations = await db.outbox.toArray();
    const payload = operations[0]?.payload as {
      event_data: Record<string, unknown>;
    };
    expect(payload.event_data).toMatchObject({
      action: 'applied',
      grounding_type: 'portable',
      point: 'КЛ-10 кВ, яч. 5',
      tool_number: 'T-7',
    });
  });
});
