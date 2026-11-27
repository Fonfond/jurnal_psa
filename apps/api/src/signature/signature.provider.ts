import type { SignatureEntityType, SignatureKind } from '@logbook/shared';

export type ActiveSignatureKind = Exclude<SignatureKind, 'none'>;

export interface SignatureSubject {
  entityType: SignatureEntityType;
  entityId: string;
  entityVersion: number;
  contentHash: string;
  signerId: string;
}

export interface ProviderSignature {
  kind: ActiveSignatureKind;
  algorithm: string;
  value: string;
  keyId: string | null;
  certificateSerial: string | null;
  certificateSubject: string | null;
  metadata: Record<string, unknown> | null;
}

export interface SignatureVerification {
  valid: boolean;
  reason?: string;
}

/**
 * Electronic-signature adapter seam (OQ-04):
 * `simple` — server-side HMAC (not КЭП), `qualified` — external КЭП service.
 */
export interface SignatureProvider {
  readonly kind: ActiveSignatureKind;
  readonly algorithm: string;
  sign(subject: SignatureSubject): Promise<ProviderSignature>;
  verify(
    subject: SignatureSubject,
    signature: ProviderSignature,
  ): Promise<SignatureVerification>;
}

export class SignatureProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureProviderError';
  }
}
