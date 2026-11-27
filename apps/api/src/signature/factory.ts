import type { SignatureProvider } from './signature.provider';
import { QualifiedSignatureProvider } from './qualified.provider';
import { SimpleSignatureProvider } from './simple.provider';
import type { Env } from '../config/env';

/**
 * Builds the configured signature adapter. Returns null for
 * SIGNATURE_PROVIDER=none (MVP without ЭП, OQ-04 open).
 */
export function createSignatureProvider(env: Env): SignatureProvider | null {
  switch (env.SIGNATURE_PROVIDER) {
    case 'simple': {
      if (!env.SIGNATURE_SECRET) {
        throw new Error(
          'SIGNATURE_PROVIDER=simple требует SIGNATURE_SECRET (>= 32 символов)',
        );
      }
      return new SimpleSignatureProvider(env.SIGNATURE_SECRET, env.SIGNATURE_KEY_ID);
    }
    case 'qualified': {
      if (!env.SIGNATURE_QUALIFIED_ENDPOINT || !env.SIGNATURE_QUALIFIED_TOKEN) {
        throw new Error(
          'SIGNATURE_PROVIDER=qualified требует SIGNATURE_QUALIFIED_ENDPOINT и SIGNATURE_QUALIFIED_TOKEN',
        );
      }
      return new QualifiedSignatureProvider(
        env.SIGNATURE_QUALIFIED_ENDPOINT,
        env.SIGNATURE_QUALIFIED_TOKEN,
        env.SIGNATURE_QUALIFIED_TIMEOUT_MS,
      );
    }
    default:
      return null;
  }
}
