import pino, { type LoggerOptions } from 'pino';

/**
 * Structured JSON logs to stdout. Secrets and personal data are redacted by path, so a careless `log.info({ body })`
 * cannot leak a password, token, OTP, card or identity number.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.apikey',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  '*.password',
  '*.new_password',
  '*.current_password',
  '*.otp',
  '*.code',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.razorpay_signature',
  '*.aadhaar_number',
  '*.pan_number',
  '*.bank_account_number',
  '*.encrypted_password',
  '*.secret',
  '*.apiKey',
  '*.api_key',
];

export function loggerOptions(level: string, pretty: boolean): LoggerOptions {
  return {
    level,
    base: { service: 'wishme-backend' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
  };
}

let root: pino.Logger | null = null;

export function rootLogger(): pino.Logger {
  if (!root) {
    const level = process.env.LOG_LEVEL ?? 'info';
    root = pino(loggerOptions(level, process.env.NODE_ENV === 'development' && !!process.stdout.isTTY));
  }
  return root;
}

export type Logger = pino.Logger;
