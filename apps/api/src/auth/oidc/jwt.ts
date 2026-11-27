import {
  constants,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';

export interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  [key: string]: unknown;
}

export interface JwkSet {
  keys: Jwk[];
}

export interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
  [key: string]: unknown;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  preferred_username?: string;
  [key: string]: unknown;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

export interface VerifyIdTokenOptions {
  issuer: string;
  audience: string;
  allowedAlgorithms: string[];
  clockSkewSeconds: number;
  expectedNonce?: string;
  now?: number;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new JwtError('Некорректный base64url в токене');
  }
  return Buffer.from(value, 'base64url');
}

function parseJsonSegment<T>(segment: string, label: string): T {
  try {
    return JSON.parse(decodeBase64Url(segment).toString('utf8')) as T;
  } catch {
    throw new JwtError(`Некорректный JSON в сегменте ${label}`);
  }
}

export function decodeJwt(token: string): {
  header: JwtHeader;
  payload: IdTokenClaims;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new JwtError('Токен должен состоять из трёх сегментов');
  }
  const header = parseJsonSegment<JwtHeader>(parts[0], 'header');
  if (!header.alg || header.alg.toLowerCase() === 'none') {
    throw new JwtError('Алгоритм подписи id_token не указан или none');
  }
  const payload = parseJsonSegment<IdTokenClaims>(parts[1], 'payload');
  return {
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: decodeBase64Url(parts[2] ?? ''),
  };
}

const DIGESTS: Record<string, string> = {
  RS256: 'sha256',
  RS384: 'sha384',
  RS512: 'sha512',
  PS256: 'sha256',
  PS384: 'sha384',
  PS512: 'sha512',
  ES256: 'sha256',
  ES384: 'sha384',
  ES512: 'sha512',
};

function verifySignature(
  header: JwtHeader,
  signingInput: string,
  signature: Buffer,
  jwk: Jwk,
): boolean {
  const key = createPublicKey({
    key: jwk,
    format: 'jwk',
  } as unknown as Parameters<typeof createPublicKey>[0]);
  const data = Buffer.from(signingInput, 'ascii');
  const digest = DIGESTS[header.alg as string];

  switch (header.alg) {
    case 'RS256':
    case 'RS384':
    case 'RS512':
      return cryptoVerify(digest as string, data, key, signature);
    case 'PS256':
    case 'PS384':
    case 'PS512':
      return cryptoVerify(
        digest as string,
        data,
        {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        signature,
      );
    case 'ES256':
    case 'ES384':
    case 'ES512':
      return cryptoVerify(
        digest as string,
        data,
        { key, dsaEncoding: 'ieee-p1363' },
        signature,
      );
    case 'EdDSA':
      return cryptoVerify(null, data, key, signature);
    default:
      throw new JwtError(`Алгоритм подписи ${header.alg} не поддерживается`);
  }
}

function isAudienceMatch(audience: string | string[] | undefined, expected: string): boolean {
  if (!audience) {
    return false;
  }
  return Array.isArray(audience)
    ? audience.includes(expected)
    : audience === expected;
}

/**
 * Full id_token validation: signature against JWKS, then RFC 7519/OIDC claims
 * (iss, aud, exp/nbf/iat with skew, nonce replay protection). Fails closed.
 */
export function verifyIdToken(
  token: string,
  jwks: JwkSet,
  options: VerifyIdTokenOptions,
): IdTokenClaims {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  const alg = header.alg as string;

  if (!options.allowedAlgorithms.includes(alg)) {
    throw new JwtError(`Алгоритм ${alg} не разрешён конфигурацией`);
  }

  const candidates = jwks.keys.filter((key) => {
    if (key.use && key.use !== 'sig') {
      return false;
    }
    if (key.alg && key.alg !== alg) {
      return false;
    }
    if (header.kid) {
      return key.kid === header.kid;
    }
    return true;
  });
  if (candidates.length === 0) {
    throw new JwtError('Не найден ключ IdP для проверки подписи');
  }
  const valid = candidates.some((key) => {
    try {
      return verifySignature(header, signingInput, signature, key);
    } catch {
      return false;
    }
  });
  if (!valid) {
    throw new JwtError('Подпись id_token недействительна');
  }

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const skew = options.clockSkewSeconds;

  if (!payload.iss || payload.iss.replace(/\/$/, '') !== options.issuer.replace(/\/$/, '')) {
    throw new JwtError('Некорректный issuer в id_token');
  }
  if (!isAudienceMatch(payload.aud, options.audience)) {
    throw new JwtError('Некорректный audience в id_token');
  }
  if (typeof payload.exp !== 'number' || payload.exp + skew < nowSeconds) {
    throw new JwtError('id_token истёк');
  }
  if (typeof payload.iat === 'number' && payload.iat - skew > nowSeconds) {
    throw new JwtError('id_token выпущен в будущем');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - skew > nowSeconds) {
    throw new JwtError('id_token ещё не действителен');
  }
  if (options.expectedNonce !== undefined && payload.nonce !== options.expectedNonce) {
    throw new JwtError('nonce id_token не совпадает');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new JwtError('В id_token отсутствует sub');
  }

  return payload;
}
