import type { Request, RequestHandler, Response } from 'express';
import type { Env } from '../config/env';
import type { AppRequest } from './types';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAtMs: number;
}

interface Bucket {
  count: number;
  resetAtMs: number;
}

/**
 * Process-local fixed-window limiter for the API (AUTH-04).
 * Multi-instance deployments must also enable the nginx `limit_req` zones
 * (deploy/nginx/logbook.conf) or a shared store; the per-instance limiter alone
 * multiplies the budget by the number of replicas.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  consume(key: string): RateLimitDecision {
    const now = this.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAtMs <= now) {
      const bucket = { count: 1, resetAtMs: now + this.windowMs };
      this.buckets.set(key, bucket);
      this.prune(now);
      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - 1,
        retryAfterSeconds: Math.ceil(this.windowMs / 1000),
        resetAtMs: bucket.resetAtMs,
      };
    }

    existing.count += 1;
    const allowed = existing.count <= this.limit;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - existing.count),
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000)),
      resetAtMs: existing.resetAtMs,
    };
  }

  /** Drops expired buckets so a long-running API does not grow unbounded. */
  private prune(now: number): void {
    if (this.buckets.size < 1000) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAtMs <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

const AUTH_PATH = /^\/v1\/auth\/(?:dev-login|authorize|callback)(?:\/|$)/;
const EXCLUDED_PATH = /^\/v1\/health(?:\/|$)/;

export function isAuthRateLimitedPath(path: string): boolean {
  return AUTH_PATH.test(path);
}

export function rateLimit(env: Env): RequestHandler {
  if (!env.RATE_LIMIT_ENABLED || env.LOADTEST_RATE_LIMIT_DISABLED) {
    return (_request, _response, next) => next();
  }

  const apiLimiter = new FixedWindowRateLimiter(
    env.RATE_LIMIT_MAX,
    env.RATE_LIMIT_WINDOW_SECONDS * 1000,
  );
  const authLimiter = new FixedWindowRateLimiter(
    env.AUTH_RATE_LIMIT_MAX,
    env.AUTH_RATE_LIMIT_WINDOW_SECONDS * 1000,
  );

  return (request: Request, response: Response, next) => {
    const path = request.path || request.url;
    if (
      request.method === 'OPTIONS' ||
      EXCLUDED_PATH.test(path) ||
      !path.startsWith('/v1/')
    ) {
      next();
      return;
    }

    const auth = isAuthRateLimitedPath(path);
    const limiter = auth ? authLimiter : apiLimiter;
    const key = `${request.ip ?? request.socket.remoteAddress ?? 'unknown'}:${auth ? 'auth' : 'api'}`;
    const decision = limiter.consume(key);

    response.setHeader('X-RateLimit-Limit', String(decision.limit));
    response.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    response.setHeader(
      'X-RateLimit-Reset',
      String(Math.ceil(decision.resetAtMs / 1000)),
    );

    if (!decision.allowed) {
      const appRequest = request as AppRequest;
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      response.status(429).json({
        error: {
          code: 'E-RATE-01',
          message: 'Слишком много запросов. Повторите позже.',
          request_id: appRequest.requestId ?? null,
        },
      });
      return;
    }

    next();
  };
}
