/**
 * Transactional email. `log` is for development and tests only (refused in production by config): it records the
 * message in memory and logs it, so a developer can sign up locally without a mail provider.
 */
import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import { vendorFetch } from '../lib/http.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(msg: EmailMessage): Promise<void>;
}

export class LogMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly log: Logger) {}
  async send(msg: EmailMessage) {
    this.sent.push(msg);
    if (this.sent.length > 100) this.sent.shift();
    this.log.info({ to: msg.to, subject: msg.subject, preview: msg.text.slice(0, 200) }, 'email (log provider, not sent)');
  }
}

class SmtpMailer implements Mailer {
  private transport;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(msg: EmailMessage) {
    await this.transport.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  }
}

class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly log: Logger,
  ) {}
  async send(msg: EmailMessage) {
    await vendorFetch(this.log, {
      vendor: 'resend',
      url: 'https://api.resend.com/emails',
      headers: { authorization: `Bearer ${this.apiKey}` },
      json: { from: this.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html },
      timeoutMs: 10_000,
    });
  }
}

export function createMailer(env: Env, log: Logger): Mailer {
  switch (env.EMAIL_PROVIDER) {
    case 'smtp':
      return new SmtpMailer(env.SMTP_URL!, env.EMAIL_FROM);
    case 'resend':
      return new ResendMailer(env.RESEND_API_KEY!, env.EMAIL_FROM, log);
    default:
      return new LogMailer(log);
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0A1556;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td><h1 style="margin:0 0 16px;font-size:22px;color:#1B1D28">${escapeHtml(title)}</h1>${body}
<p style="margin:24px 0 0;font-size:12px;color:#9BA0B0">If you did not ask for this, you can ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function otpEmail(code: string, minutes: number, purpose: 'signup' | 'reset'): Omit<EmailMessage, 'to'> {
  const what = purpose === 'signup' ? 'finish creating your WishMe account' : 'reset your WishMe password';
  return {
    subject: `${code} is your WishMe code`,
    text: `Your WishMe code is ${code}. Use it to ${what}. It expires in ${minutes} minutes. Never share it with anyone.`,
    html: layout(
      'Your WishMe code',
      `<p style="font-size:15px;color:#585E70">Use this code to ${escapeHtml(what)}:</p>
<p style="font-size:34px;letter-spacing:8px;font-weight:bold;color:#7B5CFA;margin:16px 0">${escapeHtml(code)}</p>
<p style="font-size:14px;color:#585E70">It expires in ${minutes} minutes. WishMe will never ask you for this code.</p>`,
    ),
  };
}

export function resetEmail(link: string, minutes: number): Omit<EmailMessage, 'to'> {
  return {
    subject: 'Reset your WishMe password',
    text: `Open this link to choose a new WishMe password: ${link}\nIt expires in ${minutes} minutes and works once.`,
    html: layout(
      'Reset your password',
      `<p style="font-size:15px;color:#585E70">Tap the button to choose a new password. The link expires in ${minutes} minutes and works once.</p>
<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#7B5CFA;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:bold">Choose a new password</a></p>`,
    ),
  };
}

export function passwordChangedEmail(): Omit<EmailMessage, 'to'> {
  return {
    subject: 'Your WishMe password was changed',
    text: 'Your WishMe password was just changed and other devices were signed out. If this was not you, reset your password now and contact support.',
    html: layout(
      'Password changed',
      '<p style="font-size:15px;color:#585E70">Your WishMe password was just changed and other devices were signed out. If this was not you, reset your password now and contact support.</p>',
    ),
  };
}
