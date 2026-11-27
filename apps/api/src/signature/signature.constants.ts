import type { SignatureKind } from '@logbook/shared';

export const SIMPLE_SIGNATURE_ALGORITHM = 'HMAC-SHA256';
export const QUALIFIED_SIGNATURE_ALGORITHM = 'CMS-BES';

const DEFAULT_NOTES: Record<SignatureKind, string> = {
  none: 'ЭП не настроена. Записи и визы подтверждаются сессией; юридическая значимость не подтверждена (OQ-04).',
  simple:
    'Простая электронная подпись сервера (HMAC-SHA256). Не является КЭП/УКЭП; юридическая значимость не подтверждена (OQ-04).',
  qualified:
    'Квалифицированная ЭП через внешний сервис КЭП. Требует подтверждения аккредитации УЦ, сертификатов и юридической модели (OQ-04).',
};

/** Legal caveat shown in API responses, CSV export and UI. */
export function signatureLegalNote(
  kind: SignatureKind,
  override?: string,
): string {
  return override?.trim() || DEFAULT_NOTES[kind];
}
