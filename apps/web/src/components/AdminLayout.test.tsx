import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiUser } from '../api/types';
import { useAuthStore } from '../stores/auth';
import { AdminLayout } from './AdminLayout';
import styles from '../styles.css?raw';

const admin: ApiUser = {
  id: '01930000-0000-7000-8000-000000000103',
  full_name: 'Сидоров Сергей Сергеевич',
  role: 'admin',
  department: { id: '01930000-0000-7000-8000-000000000001', name: 'Участок №3' },
  status: 'active',
  email: 'admin@logbook.local',
};

function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? '';
}

function rgbOver(value: string, base: [number, number, number]): [number, number, number] {
  // Supports `rgb(248 250 252 / 0.12)` and `#0f172a`-style values.
  const slash = value.match(
    /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)/,
  );
  if (slash) {
    const alpha = Number(slash[4]);
    return [0, 1, 2].map(
      (index) =>
        Number(slash[index + 1]) * alpha + base[index]! * (1 - alpha),
    ) as [number, number, number];
  }
  const hex = value.match(/#([0-9a-f]{6})/i);
  if (hex) {
    return [0, 2, 4].map((offset) =>
      parseInt(hex[1]!.slice(offset, offset + 2), 16),
    ) as [number, number, number];
  }
  throw new Error(`Unsupported color: ${value}`);
}

function contrastRatio(
  foreground: [number, number, number],
  background: [number, number, number],
): number {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb: [number, number, number]): number =>
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort(
    (left, right) => right - left,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

beforeEach(() => {
  useAuthStore.setState({ user: admin, initialized: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null });
});

describe('AdminLayout header contrast (t14 defect)', () => {
  it('renders the header actions as ghost buttons', () => {
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<div>Обзор</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const journal = screen.getByRole('link', { name: 'К журналу' });
    const logout = screen.getByRole('button', { name: 'Выйти' });
    expect(journal).toHaveClass('button', 'button--ghost');
    expect(logout).toHaveClass('button', 'button--ghost');
    expect(screen.getByText('Администрирование')).toBeInTheDocument();
  });

  it('overrides the white ghost background on the dark admin header', () => {
    const defaultGhost = ruleBlock(styles, '.button--ghost');
    const headerGhost = ruleBlock(styles, '.admin-header .button--ghost');

    // The base ghost button paints a white surface…
    expect(defaultGhost).toContain('background: var(--surface)');
    // …so the admin header must override it; otherwise the near-white text is
    // invisible (white-on-white, the t14 defect).
    expect(headerGhost).toContain('background:');
    expect(headerGhost).not.toContain('var(--surface)');
    expect(headerGhost).toContain('color: #f8fafc');
  });

  it('keeps WCAG AA contrast for the header buttons', () => {
    const headerGhost = ruleBlock(styles, '.admin-header .button--ghost');
    const background = headerGhost.match(/background:\s*([^;]+);/)?.[1] ?? '';
    const header = ruleBlock(styles, '.admin-header');
    const headerBackground =
      header.match(/background:\s*(#[0-9a-f]{6})/i)?.[1] ?? '#0f172a';

    const base = rgbOver(headerBackground, [255, 255, 255]);
    const composited = rgbOver(background, base);
    const text: [number, number, number] = [248, 250, 252];

    expect(contrastRatio(text, composited)).toBeGreaterThanOrEqual(4.5);
  });
});
