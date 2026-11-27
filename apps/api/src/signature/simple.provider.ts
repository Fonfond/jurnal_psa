import { createHmac } from 'node:crypto';
import { constantTimeEqual, stableStringify } from '../common/context';
import { SIMPLE_SIGNATURE_ALGORITHM } from './signature.constants';
import type {
  ProviderSignature,
  SignatureProvider,
  SignatureSubject,
  SignatureVerification,
} from './signature.provider';

/**
 * `simple` adapter (OQ-04): HMAC-SHA256 over a canonical payload with a
 * server-side secret. Integrity-only: it is NOT a КЭП/УКЭП and carries no
 * legal force; the caveat is returned with every signature record.
 */
export class SimpleSignatureProvider implements SignatureProvider {
  readonly kind = 'simple' as const;
  readonly algorithm = SIMPLE_SIGNATURE_ALGORITHM;

  constructor(
    private readonly secret: string,
    private readonly keyId: string,
  ) {
    if (!secret || secret.length < 32) {
      throw new Error('SIGNATURE_SECRET должен быть не короче 32 символов');
    }
  }

  private message(subject: SignatureSubject, keyId: string): string {
    return stableStringify({
      schema: 'logbook.signature.simple.v1',
      entity_type: subject.entityType,
      entity_id: subject.entityId,
      entity_version: subject.entityVersion,
      content_hash: subject.contentHash,
      signer_id: subject.signerId,
      key_id: keyId,
    });
  }

  private hmac(message: string): string {
    return createHmac('sha256', this.secret).update(message, 'utf8').digest('base64url');
  }

  async sign(subject: SignatureSubject): Promise<ProviderSignature> {
    return {
      kind: this.kind,
      algorithm: this.algorithm,
      value: this.hmac(this.message(subject, this.keyId)),
      keyId: this.keyId,
      certificateSerial: null,
      certificateSubject: null,
      metadata: null,
    };
  }

  async verify(
    subject: SignatureSubject,
    signature: ProviderSignature,
  ): Promise<SignatureVerification> {
    if (signature.kind !== this.kind) {
      return { valid: false, reason: 'Тип подписи не соответствует провайдеру' };
    }
    if (signature.algorithm !== this.algorithm) {
      return { valid: false, reason: 'Алгоритм подписи не соответствует провайдеру' };
    }
    const keyId = signature.keyId ?? this.keyId;
    if (keyId !== this.keyId) {
      return {
        valid: false,
        reason: 'Подпись создана другим ключом (ротация ключей не настроена)',
      };
    }
    const expected = this.hmac(this.message(subject, keyId));
    if (!constantTimeEqual(expected, signature.value)) {
      return { valid: false, reason: 'Подпись не совпадает с содержимым' };
    }
    return { valid: true };
  }
}
