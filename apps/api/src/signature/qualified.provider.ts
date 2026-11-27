import { QUALIFIED_SIGNATURE_ALGORITHM } from './signature.constants';
import {
  type ProviderSignature,
  type SignatureProvider,
  SignatureProviderError,
  type SignatureSubject,
  type SignatureVerification,
} from './signature.provider';

interface QualifiedResponse {
  signature?: unknown;
  algorithm?: unknown;
  key_id?: unknown;
  certificate_serial?: unknown;
  certificate_subject?: unknown;
  metadata?: unknown;
  valid?: unknown;
  reason?: unknown;
}

/**
 * `qualified` adapter (OQ-04): thin HTTP client for an external КЭП/УЦ service
 * (CryptoPro/Контур or an in-house signing gateway). The adapter never holds
 * private keys; it forwards the canonical content hash and stores the CMS blob.
 * Without a configured endpoint it fails closed with E-SIG-02.
 */
export class QualifiedSignatureProvider implements SignatureProvider {
  readonly kind = 'qualified' as const;
  readonly algorithm = QUALIFIED_SIGNATURE_ALGORITHM;

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async call(payload: Record<string, unknown>): Promise<QualifiedResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SignatureProviderError(
        `Сервис КЭП недоступен: ${error instanceof Error ? error.message : 'сетевая ошибка'}`,
      );
    }
    if (!response.ok) {
      const details = await response.text().catch(() => '');
      throw new SignatureProviderError(
        `Сервис КЭП вернул HTTP ${response.status}${details ? `: ${details.slice(0, 300)}` : ''}`,
      );
    }
    try {
      return (await response.json()) as QualifiedResponse;
    } catch {
      throw new SignatureProviderError('Сервис КЭП вернул некорректный JSON');
    }
  }

  async sign(subject: SignatureSubject): Promise<ProviderSignature> {
    const result = await this.call({
      operation: 'sign',
      entity_type: subject.entityType,
      entity_id: subject.entityId,
      entity_version: subject.entityVersion,
      content_hash: subject.contentHash,
      signer_id: subject.signerId,
    });
    if (typeof result.signature !== 'string' || result.signature.length === 0) {
      throw new SignatureProviderError('Сервис КЭП не вернул подпись');
    }
    return {
      kind: this.kind,
      algorithm:
        typeof result.algorithm === 'string'
          ? result.algorithm
          : QUALIFIED_SIGNATURE_ALGORITHM,
      value: result.signature,
      keyId: typeof result.key_id === 'string' ? result.key_id : null,
      certificateSerial:
        typeof result.certificate_serial === 'string'
          ? result.certificate_serial
          : null,
      certificateSubject:
        typeof result.certificate_subject === 'string'
          ? result.certificate_subject
          : null,
      metadata:
        result.metadata && typeof result.metadata === 'object'
          ? (result.metadata as Record<string, unknown>)
          : null,
    };
  }

  async verify(
    subject: SignatureSubject,
    signature: ProviderSignature,
  ): Promise<SignatureVerification> {
    const result = await this.call({
      operation: 'verify',
      entity_type: subject.entityType,
      entity_id: subject.entityId,
      entity_version: subject.entityVersion,
      content_hash: subject.contentHash,
      signer_id: subject.signerId,
      signature: signature.value,
      algorithm: signature.algorithm,
    });
    if (typeof result.valid !== 'boolean') {
      throw new SignatureProviderError('Сервис КЭП не вернул результат проверки');
    }
    return {
      valid: result.valid,
      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
    };
  }
}
