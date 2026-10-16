/** Razorpay REST client and signature checks. Keys come from env; the key secret never leaves the server. */
import type { Env } from '../config/env.js';
import { hmacSha256Hex, safeEqual } from '../lib/crypto.js';
import { unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

export interface RazorpayOrder {
  id: string;
  entity: 'order';
  amount: number;
  amount_paid: number;
  currency: string;
  receipt: string | null;
  status: 'created' | 'attempted' | 'paid';
  notes: Record<string, string>;
  created_at: number;
}

export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method?: string;
  email?: string;
  contact?: string;
  captured?: boolean;
}

export class Razorpay {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!(this.env.RAZORPAY_KEY_ID && this.env.RAZORPAY_KEY_SECRET);
  }

  get keyId(): string {
    if (!this.env.RAZORPAY_KEY_ID) throw unavailable('Payments are not configured');
    return this.env.RAZORPAY_KEY_ID;
  }

  private auth(): string {
    if (!this.configured) throw unavailable('Payments are not configured');
    return `Basic ${Buffer.from(`${this.env.RAZORPAY_KEY_ID}:${this.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
  }

  async createOrder(input: { amountPaise: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<RazorpayOrder> {
    const { data } = await vendorFetch<RazorpayOrder>(this.log, {
      vendor: 'razorpay',
      url: 'https://api.razorpay.com/v1/orders',
      headers: { authorization: this.auth() },
      json: { amount: input.amountPaise, currency: input.currency, receipt: input.receipt.slice(0, 40), notes: input.notes, payment_capture: 1 },
      timeoutMs: 15_000,
    });
    return data;
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    const { data } = await vendorFetch<RazorpayPayment>(this.log, {
      vendor: 'razorpay',
      url: `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`,
      headers: { authorization: this.auth() },
      timeoutMs: 15_000,
      retries: 2,
    });
    return data;
  }

  async capture(paymentId: string, amountPaise: number, currency: string): Promise<RazorpayPayment> {
    const { data } = await vendorFetch<RazorpayPayment>(this.log, {
      vendor: 'razorpay',
      url: `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/capture`,
      headers: { authorization: this.auth() },
      json: { amount: amountPaise, currency },
      timeoutMs: 15_000,
    });
    return data;
  }

  /** Checkout callback signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!this.env.RAZORPAY_KEY_SECRET) throw unavailable('Payments are not configured');
    return safeEqual(hmacSha256Hex(this.env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`), signature);
  }

  /** Webhook signature: HMAC_SHA256(raw body, webhook_secret). Must use the raw bytes, not re-serialised JSON. */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    if (!this.env.RAZORPAY_WEBHOOK_SECRET) throw unavailable('Webhooks are not configured');
    return safeEqual(hmacSha256Hex(this.env.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
  }
}
