import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SignatureInfo, SignatureRecord } from '../api/types';
import {
  SignatureBadge,
  SignatureHint,
  SignatureList,
  signatureCaveat,
} from './SignatureHint';

const simple: SignatureInfo = {
  provider: 'simple',
  algorithm: 'HMAC-SHA256',
  auto_sign: true,
  legal_note: 'Простая ЭП подтверждает целостность и не является КЭП.',
};

const qualified: SignatureInfo = {
  provider: 'qualified',
  algorithm: 'GOST R 34.10-2012',
  auto_sign: false,
  legal_note: 'Квалифицированная подпись через сервис КЭП.',
};

const none: SignatureInfo = {
  provider: 'none',
  algorithm: null,
  auto_sign: false,
  legal_note: 'ЭП не настроена: подписи не формируются.',
};

const record: SignatureRecord = {
  id: '01930000-0000-7000-8000-000000003001',
  entity_type: 'entry',
  entity_id: '01930000-0000-7000-8000-000000000401',
  entity_version: 2,
  content_hash: 'a'.repeat(64),
  kind: 'simple',
  algorithm: 'HMAC-SHA256',
  value: 'signature-value',
  key_id: 'key-1',
  certificate_serial: null,
  certificate_subject: null,
  signer_id: '01930000-0000-7000-8000-000000000102',
  signed_at: '2026-11-24T08:10:00.000Z',
  status: 'valid',
  metadata: null,
  legal_note: 'Простая ЭП не является КЭП',
};

describe('SignatureHint (OQ-04)', () => {
  it('explains that a simple signature is not a КЭП', () => {
    render(<SignatureHint signature={simple} context="визу журнала" />);
    expect(screen.getByTestId('signature-hint')).toHaveAttribute(
      'data-provider',
      'simple',
    );
    expect(screen.getByText('Простая ЭП')).toBeInTheDocument();
    expect(
      screen.getByText(/Подпись подтверждает целостность, но не является КЭП/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Подписывается: визу журнала/)).toBeInTheDocument();
    expect(
      screen.getByText(/Подпись формируется автоматически/),
    ).toBeInTheDocument();
    expect(screen.getByText(simple.legal_note)).toBeInTheDocument();
  });

  it('reports the qualified provider without the caveat', () => {
    render(<SignatureHint signature={qualified} context="проверку записи" />);
    expect(screen.getByText('Квалифицированная ЭП')).toBeInTheDocument();
    expect(screen.getByText(/сервисом КЭП/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Подпись формируется автоматически/),
    ).not.toBeInTheDocument();
  });

  it('is honest when no signature adapter is configured', () => {
    render(<SignatureHint signature={none} context="смену" />);
    expect(screen.getByText('ЭП не настроена')).toBeInTheDocument();
    expect(screen.getByText(/Документ не подписывается/)).toBeInTheDocument();
  });

  it('does not claim anything when the adapter state is unknown', () => {
    render(<SignatureHint signature={null} />);
    expect(screen.getByTestId('signature-hint')).toHaveAttribute(
      'data-provider',
      'unknown',
    );
    expect(screen.getByText(/Сведения об ЭП недоступны/)).toBeInTheDocument();
  });

  it('builds the caveat text for every provider', () => {
    expect(signatureCaveat(simple)).toContain('не является КЭП');
    expect(signatureCaveat(qualified)).toContain('сервисом КЭП');
    expect(signatureCaveat(none)).toContain('только в аудите');
    expect(signatureCaveat(null)).toContain('недоступны');
  });
});

describe('SignatureBadge and SignatureList', () => {
  it('renders a simple signature record with algorithm and date', () => {
    render(<SignatureBadge signature={record} showHash />);
    expect(screen.getByText('Простая ЭП')).toBeInTheDocument();
    expect(screen.getByText('HMAC-SHA256')).toBeInTheDocument();
    expect(screen.getByText(/24\.11\.2026/)).toBeInTheDocument();
    expect(screen.getByText(/aaaaaaaaaaaa/)).toBeInTheDocument();
  });

  it('renders a list of signatures only when present', () => {
    const { rerender } = render(<SignatureList signatures={[]} />);
    expect(screen.queryByText('Подписи визы')).not.toBeInTheDocument();

    rerender(
      <SignatureList
        signatures={[record, { ...record, id: 'sig-2', kind: 'qualified' }]}
        title="Подписи визы"
      />,
    );
    expect(screen.getByText('Подписи визы')).toBeInTheDocument();
    expect(screen.getAllByTestId('signature-badge')).toHaveLength(2);
    expect(screen.getByText('КЭП')).toBeInTheDocument();
  });
});
