/**
 * Errors with an HTTP status and a stable code. Each surface renders them in the shape its clients parse:
 *  - PostgREST:  { code, message, details, hint }
 *  - GoTrue:     { error, error_description, msg, code }   (the app reads error_description || error || message || msg)
 *  - functions:  { error, message }
 *  - /api/v1:    { error: { code, message } }
 * The app pattern-matches some words in messages ("invalid", "expir", "already registered"), so messages for those
 * cases are part of the contract and covered by tests.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly hint?: string,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required', code = 'unauthorized') =>
  new AppError(401, code, message);
export const forbidden = (message = 'Not allowed', code = 'forbidden') => new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'not_found') => new AppError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const tooMany = (retryAfterSec: number, message = 'Too many requests') =>
  new AppError(429, 'rate_limited', message, { retryAfter: retryAfterSec }, undefined, {
    'retry-after': String(retryAfterSec),
  });
export const unavailable = (message: string, code = 'unavailable') => new AppError(503, code, message);
export const notImplemented = (message: string) => new AppError(501, 'not_implemented', message);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Postgres error codes we translate instead of answering 500. */
export function fromPostgresError(e: unknown): AppError | null {
  const err = e as { code?: string; message?: string; detail?: string; hint?: string; constraint_name?: string };
  if (!err || typeof err.code !== 'string') return null;
  switch (err.code) {
    case '23505':
      return new AppError(409, err.code, err.message ?? 'duplicate key value violates unique constraint', err.detail, err.hint);
    case '23503':
      return new AppError(409, err.code, err.message ?? 'foreign key violation', err.detail, err.hint);
    case '23502':
    case '23514':
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
    case '42703':
      return new AppError(400, err.code, err.message ?? 'invalid input', err.detail, err.hint);
    case '42501':
      return new AppError(403, err.code, err.message ?? 'permission denied', err.detail, err.hint);
    case '57014':
      return new AppError(504, err.code, 'canceling statement due to statement timeout');
    case 'P0001':
      return new AppError(400, err.code, err.message ?? 'rejected', err.detail, err.hint);
    default:
      return null;
  }
}
