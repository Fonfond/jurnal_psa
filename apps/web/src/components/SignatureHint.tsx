import type { SignatureInfo, SignatureRecord } from '../api/types';
import { useAuthStore } from '../stores/auth';
import { formatDateTime } from '../utils/format';

/**
 * ЭП hints (OQ-04). The adapter is configured on the server; the UI must be
 * honest about what the signature means: `simple` confirms integrity but is
 * not a qualified electronic signature (КЭП), `none` means nothing is signed.
 */

const PROVIDER_LABELS: Record<SignatureInfo['provider'], string> = {
  none: 'ЭП не настроена',
  simple: 'Простая ЭП',
  qualified: 'Квалифицированная ЭП',
};

export function signatureCaveat(
  signature: SignatureInfo | null | undefined,
): string {
  if (!signature) {
    return 'Сведения об ЭП недоступны: подпись может не формироваться.';
  }
  if (signature.provider === 'none') {
    return 'Документ не подписывается: действия фиксируются только в аудите. Для юридически значимого журнала нужна ЭП (OQ-04).';
  }
  if (signature.provider === 'simple') {
    return `Подпись подтверждает целостность, но не является КЭП (OQ-04)${
      signature.algorithm ? ` · ${signature.algorithm}` : ''
    }.`;
  }
  return `Подпись формируется настроенным сервисом КЭП${
    signature.algorithm ? ` · ${signature.algorithm}` : ''
  }.`;
}

export function signatureProviderLabel(
  signature: SignatureInfo | null | undefined,
): string {
  return signature ? PROVIDER_LABELS[signature.provider] : 'Сведения об ЭП';
}

export function useSignatureInfo(): SignatureInfo | null {
  return useAuthStore((state) => state.signature);
}

export function SignatureHint({
  signature,
  context = 'документ',
  compact = false,
}: {
  signature: SignatureInfo | null | undefined;
  /** What is being signed: «визу», «смену», «проверку записи». */
  context?: string;
  compact?: boolean;
}): JSX.Element {
  const provider = signature?.provider ?? 'none';
  const tone =
    provider === 'qualified'
      ? 'signature-hint--qualified'
      : provider === 'simple'
        ? 'signature-hint--simple'
        : 'signature-hint--none';
  const unknown = !signature;

  return (
    <div
      className={`signature-hint ${tone}${compact ? ' signature-hint--compact' : ''}`}
      role="note"
      aria-label={`ЭП: ${signatureProviderLabel(signature)}`}
      data-testid="signature-hint"
      data-provider={signalProvider(signature)}
    >
      <strong>{signatureProviderLabel(signature)}</strong>
      <span>
        {unknown
          ? 'Сведения об ЭП недоступны: подпись может не формироваться.'
          : `${signatureCaveat(signature)} Подписывается: ${context}.`}
      </span>
      {signature?.auto_sign ? (
        <span className="signature-hint__auto">
          Подпись формируется автоматически при сохранении.
        </span>
      ) : null}
      {signature?.legal_note ? (
        <small className="signature-hint__legal">{signature.legal_note}</small>
      ) : null}
    </div>
  );
}

function signalProvider(
  signature: SignatureInfo | null | undefined,
): string {
  return signature?.provider ?? 'unknown';
}

/** Compact record of a real signature (review visa, entry visa, shift). */
export function SignatureBadge({
  signature,
  showHash = false,
}: {
  signature: SignatureRecord;
  showHash?: boolean;
}): JSX.Element {
  const qualified = signature.kind === 'qualified';
  return (
    <span
      className="signature-badge"
      title={signature.legal_note}
      data-testid="signature-badge"
    >
      <span className={`badge badge--${qualified ? 'success' : 'info'}`}>
        {qualified ? 'КЭП' : 'Простая ЭП'}
      </span>
      <span>{signature.algorithm}</span>
      <span>{formatDateTime(signature.signed_at)}</span>
      {signature.certificate_subject ? (
        <span className="signature-badge__subject">
          {signature.certificate_subject}
        </span>
      ) : null}
      {signature.status !== 'valid' ? (
        <span className="error-text">{signature.status}</span>
      ) : null}
      {showHash ? (
        <code className="signature-badge__hash">
          {signature.content_hash.slice(0, 12)}…
        </code>
      ) : null}
    </span>
  );
}

export function SignatureList({
  signatures,
  title = 'Подписи',
}: {
  signatures: SignatureRecord[];
  title?: string;
}): JSX.Element | null {
  if (signatures.length === 0) {
    return null;
  }
  return (
    <section className="signature-list" aria-label={title}>
      <h3>{title}</h3>
      <ul>
        {signatures.map((signature) => (
          <li key={signature.id}>
            <SignatureBadge signature={signature} showHash />
          </li>
        ))}
      </ul>
    </section>
  );
}
