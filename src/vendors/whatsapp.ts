/**
 * WhatsApp Cloud API (Meta Graph) for template messages. Business-initiated messages must use an approved template, so
 * only templates are supported. Configured with WHATSAPP_PROVIDER=meta, WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.
 */
import type { Env } from '../config/env.js';
import { unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

const GRAPH = 'https://graph.facebook.com/v20.0';

/** The approved welcome template (WHATSAPP_WELCOME_TEMPLATE / _LANGUAGE), with one body parameter: the first name. */
export function welcomeTemplate(env: Env): { name: string; language: string } {
  return { name: env.WHATSAPP_WELCOME_TEMPLATE, language: env.WHATSAPP_WELCOME_LANGUAGE };
}

export interface TemplateMessage {
  /** E.164 number, e.g. +919876543210. */
  to: string;
  template: string;
  language: string;
  /** Body parameters, in order. */
  params?: string[];
}

interface SendResponse {
  messages?: Array<{ id: string }>;
}

export class WhatsApp {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return this.env.WHATSAPP_PROVIDER === 'meta' && !!this.env.WHATSAPP_TOKEN && !!this.env.WHATSAPP_PHONE_NUMBER_ID;
  }

  /** Sends one template message; returns Meta's message id. Not retried here (sending is not idempotent). */
  async sendTemplate(m: TemplateMessage): Promise<string | null> {
    if (!this.configured) throw unavailable('WhatsApp is not configured');
    const components = m.params?.length
      ? [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text: text.slice(0, 60) })) }]
      : [];
    const { data } = await vendorFetch<SendResponse>(this.log, {
      vendor: 'whatsapp',
      url: `${GRAPH}/${encodeURIComponent(this.env.WHATSAPP_PHONE_NUMBER_ID!)}/messages`,
      headers: { authorization: `Bearer ${this.env.WHATSAPP_TOKEN!}` },
      json: {
        messaging_product: 'whatsapp',
        to: m.to.replace(/^\+/, ''),
        type: 'template',
        template: { name: m.template, language: { code: m.language }, ...(components.length ? { components } : {}) },
      },
      timeoutMs: 15_000,
    });
    return data?.messages?.[0]?.id ?? null;
  }
}
