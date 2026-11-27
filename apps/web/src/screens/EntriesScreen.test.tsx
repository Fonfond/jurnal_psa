import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_JOURNAL_ID,
  SEED_UUIDS,
} from '@logbook/shared';
import type { ApiUser } from '../api/types';
import { createLocalEntry } from '../db/repositories';
import { createShiftLocal } from '../db/shift-repositories';
import { db } from '../db/schema';
import { EntriesScreen } from './EntriesScreen';

const user: ApiUser = {
  id: '01930000-0000-7000-8000-000000000101',
  full_name: 'Иван Петров',
  role: 'worker',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок' },
  status: 'active',
  email: 'worker@logbook.local',
};

beforeEach(async () => {
  await db.dict_work_types.put({
    id: '01930000-0000-7000-8000-000000000302',
    code: 'SIMPLE',
    name: 'Осмотр',
    requires_permit: false,
    requires_site: true,
    default_template_id: null,
    active: true,
    sort_order: 1,
  });
  await createLocalEntry(
    {
      performed_at: '2026-11-24T08:00:00.000Z',
      performed_tz_offset_min: 480,
      work_type_id: '01930000-0000-7000-8000-000000000302',
      site_id: '01930000-0000-7000-8000-000000000402',
      permit_id: null,
      text: 'Проверил оборудование на участке',
      input_method: 'manual',
    },
    user,
  );
});

describe('EntriesScreen', () => {
  it('renders local entries with their sync status', async () => {
    render(
      <MemoryRouter>
        <EntriesScreen />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText('Проверил оборудование на участке'),
    ).toBeInTheDocument();
    expect(screen.getByText('Осмотр')).toBeInTheDocument();
    expect(screen.getByText('Ожидает')).toBeInTheDocument();
  });

  it('filters entries by search text', async () => {
    render(
      <MemoryRouter>
        <EntriesScreen />
      </MemoryRouter>,
    );

    await screen.findByText('Проверил оборудование на участке');
    await userEvent.type(screen.getByLabelText('Поиск записей'), 'нет такого');

    await waitFor(() => {
      expect(screen.queryByText('Проверил оборудование на участке')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('filters entries by journal and shows the journal selector', async () => {
    await db.journals.bulkPut([
      {
        id: DEFAULT_JOURNAL_ID,
        journal_key: 'main',
        name: 'Основной оперативный журнал',
        description: null,
        active: true,
        sort_order: 10,
      },
      {
        id: SEED_UUIDS.journalSubstation,
        journal_key: 'substation',
        name: 'Журнал подстанции',
        description: null,
        active: true,
        sort_order: 20,
      },
    ]);
    await createLocalEntry(
      {
        performed_at: '2026-11-24T09:00:00.000Z',
        performed_tz_offset_min: 480,
        work_type_id: '01930000-0000-7000-8000-000000000302',
        site_id: '01930000-0000-7000-8000-000000000402',
        permit_id: null,
        text: 'Проверил оборудование подстанции',
        input_method: 'manual',
        journal_id: SEED_UUIDS.journalSubstation,
      },
      user,
    );

    render(
      <MemoryRouter>
        <EntriesScreen />
      </MemoryRouter>,
    );

    await screen.findByText('Проверил оборудование подстанции');
    expect(screen.getAllByText('Основной оперативный журнал').length).toBeGreaterThan(0);

    await userEvent.selectOptions(
      screen.getByLabelText('Фильтр по журналу'),
      SEED_UUIDS.journalSubstation,
    );

    await waitFor(() => {
      expect(
        screen.queryByText('Проверил оборудование на участке'),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText('Проверил оборудование подстанции')).toBeInTheDocument();
  });

  it('shows only the entries of a shift when opened from S-15', async () => {
    const supervisor: ApiUser = { ...user, role: 'supervisor' };
    const shift = await createShiftLocal(
      {
        journal_id: DEFAULT_JOURNAL_ID,
        shift_date: '2026-11-24',
        period_start: '2026-11-24T05:00:00.000Z',
        period_end: '2026-11-24T17:00:00.000Z',
        handover_comment: 'Смена сдана, журнал проверен',
      },
      supervisor,
    );
    await createLocalEntry(
      {
        performed_at: '2026-11-24T10:00:00.000Z',
        performed_tz_offset_min: 480,
        work_type_id: '01930000-0000-7000-8000-000000000302',
        site_id: '01930000-0000-7000-8000-000000000402',
        permit_id: null,
        text: 'Запись внутри смены',
        input_method: 'manual',
      },
      supervisor,
    );
    await createLocalEntry(
      {
        performed_at: '2026-11-24T20:00:00.000Z',
        performed_tz_offset_min: 480,
        work_type_id: '01930000-0000-7000-8000-000000000302',
        site_id: '01930000-0000-7000-8000-000000000402',
        permit_id: null,
        text: 'Запись вне смены',
        input_method: 'manual',
      },
      supervisor,
    );

    render(
      <MemoryRouter initialEntries={[`/?shift_id=${shift.id}`]}>
        <EntriesScreen />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Записи смены')).toBeInTheDocument();
    expect(screen.getByText('Сдана, ожидает приёмки')).toBeInTheDocument();
    expect(await screen.findByText('Запись внутри смены')).toBeInTheDocument();
    expect(screen.queryByText('Запись вне смены')).not.toBeInTheDocument();
    // The regular seeded entry is inside the same window and stays visible.
    expect(
      screen.getByText('Проверил оборудование на участке'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button', { name: 'Сбросить' })[0]!);
    expect(await screen.findByText('Запись вне смены')).toBeInTheDocument();
    expect(screen.queryByText('Записи смены')).not.toBeInTheDocument();
  });

  it('filters operational events and links to the grounding registry', async () => {
    await createLocalEntry(
      {
        performed_at: '2026-11-24T10:00:00.000Z',
        performed_tz_offset_min: 480,
        work_type_id: '01930000-0000-7000-8000-000000000302',
        site_id: '01930000-0000-7000-8000-000000000402',
        permit_id: null,
        text: 'Установил заземление на КЛ-5',
        input_method: 'manual',
        event_type: 'grounding',
        event_data: {
          action: 'applied',
          grounding_type: 'portable',
          point: 'КЛ-10 кВ, яч. 5',
          count: 1,
        },
      },
      user,
    );

    render(
      <MemoryRouter>
        <EntriesScreen />
      </MemoryRouter>,
    );

    await screen.findByText('Установил заземление на КЛ-5');
    expect(screen.getByRole('link', { name: 'Заземления' })).toHaveAttribute(
      'href',
      '/groundings',
    );
    expect(screen.getAllByText('Заземление').length).toBeGreaterThan(0);

    await userEvent.selectOptions(
      screen.getByLabelText('Фильтр по типу события'),
      'grounding',
    );

    await waitFor(() => {
      expect(
        screen.queryByText('Проверил оборудование на участке'),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText('Установил заземление на КЛ-5')).toBeInTheDocument();
  });
});
