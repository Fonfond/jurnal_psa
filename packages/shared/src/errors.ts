export const ERROR_HTTP: Record<string, number> = {
  'E-AUTH-01': 401,
  'E-AUTH-02': 403,
  'E-VAL-01': 400,
  'E-VER-01': 409,
  'E-PRM-01': 422,
  'E-PRM-02': 422,
  'E-RATE-01': 429,
  'E-LIM-01': 413,
  'E-APP-01': 426,
  'E-CURSOR-01': 410,
  'E-NOT-01': 404,
  /** OIDC: некорректный state/code/callback. */
  'E-OIDC-01': 400,
  /** OIDC: IdP недоступен, discovery/token/jwks не получены. */
  'E-OIDC-02': 502,
  /** OIDC: аутентификация прошла, но учётная запись не provisioned. */
  'E-OIDC-03': 403,
  /** OIDC: для администратора не подтверждён второй фактор (MFA). */
  'E-OIDC-04': 403,
  /** ЭП: некорректная подпись или данные для подписи. */
  'E-SIG-01': 422,
  /** ЭП: провайдер не настроен / сервис КЭП недоступен. */
  'E-SIG-02': 501,
  'E-SRV-01': 500,
  'E-SRV-02': 503,
};

export type ErrorCode = keyof typeof ERROR_HTTP;

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly fields?: Record<string, string>;

  constructor(code: ErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = ERROR_HTTP[code] ?? 500;
    this.fields = fields;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
