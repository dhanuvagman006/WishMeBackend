/**
 * Razorpay payments, owned end to end by the server.
 *
 *  createOrder  the server decides the amount from the purpose (a plan's price, a deposit within limits, …) and
 *               records the order in wishme.payment_orders before returning it to the app.
 *  verify       the app's checkout callback: signature check, order ownership, Razorpay's own view of the payment,
 *               then fulfilment.
 *  webhook      Razorpay's server-to-server notification: the same fulfilment, so a user who closes the app right
 *               after paying is still credited.
 *  fulfil       idempotent per order: whichever of verify/webhook arrives first does the work, the other gets the
 *               stored result.
 *
 * Purposes are pluggable (registerPurpose) so each domain prices and fulfils its own orders.
 */
import type { AuthContext, Identity } from '../../auth/context.js';
import type { Db, Tx } from '../../lib/db.js';
import { AppError, badRequest, forbidden, notFound, unavailable } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { positiveAmount, rupeesForColumn, toRupeesNumber, toRupeesString } from '../../lib/money.js';
import { randomDigits } from '../../lib/crypto.js';
import type { SchemaCache } from '../../compat/postgrest/schema-cache.js';
import type { Razorpay, RazorpayPayment } from '../../vendors/razorpay.js';
import type { Ledger } from '../wallet/ledger.js';

export interface OrderRow {
  razorpay_order_id: string;
  user_id: string;
  profile_id: string | null;
  purpose: string;
  amount_paise: string;
  currency: string;
  receipt: string | null;
  notes: Record<string, unknown>;
  status: 'created' | 'paid' | 'fulfilled' | 'failed';
  razorpay_payment_id: string | null;
  wishme_payment_id: string | null;
  fulfilment: Record<string, unknown> | null;
}

export interface PriceContext {
  auth: AuthContext;
  identity: Identity;
  /** The client's create-razorpay-order body (amount in rupees, notes, receipt). */
  body: Record<string, unknown>;
  notes: Record<string, unknown>;
}

export interface FulfilContext {
  tx: Tx;
  order: OrderRow & { amountPaise: number };
  paymentId: string;
  wishmePaymentId: string;
  ledger: Ledger;
}

export interface Purpose {
  /** Values the app sends in notes.type (several aliases may map to one purpose). */
  names: readonly string[];
  /** Server-side price in paise. Throw to refuse the order. */
  price(c: PriceContext): Promise<number>;
  /** Applies the paid order (credit, plan change, mark order paid …). Runs once, inside the fulfilment transaction. */
  fulfil(c: FulfilContext): Promise<Record<string, unknown>>;
  /** public.payment_transactions.service_type for the record row. */
  serviceType: string;
}

const MAX_DEPOSIT_RUPEES = 100_000;

/** Fulfilment keys copied onto the payment_transactions row when the column exists. */
const RECORD_LINKS = ['wish_order_id', 'booking_id'] as const;

export class Payments {
  private readonly purposes = new Map<string, Purpose>();

  constructor(
    private readonly db: Db,
    private readonly schema: SchemaCache,
    private readonly razorpay: Razorpay,
    private readonly ledger: Ledger,
    private readonly log: Logger,
  ) {
    this.registerPurpose({
      names: ['wallet_deposit', 'deposit', 'wallet'],
      serviceType: 'deposit',
      price: async ({ body }) => {
        const paise = positiveAmount(body.amount, { minRupees: 100, maxRupees: MAX_DEPOSIT_RUPEES });
        // Wallet balances are whole rupees in the production schema.
        if (paise % 100 !== 0) throw badRequest('Deposits must be in whole rupees');
        return paise;
      },
      fulfil: async ({ tx, order, paymentId, ledger }) => {
        const r = await ledger.apply(tx, 'user_wallet', {
          accountId: order.profile_id!,
          deltaPaise: order.amountPaise,
          kind: 'deposit',
          idempotencyKey: `rzp:${paymentId}`,
          createdBy: 'system:razorpay',
          paymentMethod: 'razorpay',
          description: `Wallet deposit of ₹${toRupeesString(order.amountPaise).replace(/\.00$/, '')}`,
          details: { razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: paymentId },
          reference: { type: 'razorpay_payment', id: paymentId },
        });
        return { new_balance: toRupeesNumber(r.balanceAfterPaise), wallet_transaction_id: r.historyRowId };
      },
    });

    this.registerPurpose({
      names: ['plan_purchase', 'plan', 'plan_upgrade'],
      serviceType: 'plan_purchase',
      price: async ({ notes }) => {
        const name = typeof notes.plan_name === 'string' ? notes.plan_name : null;
        if (!name) throw badRequest('plan_name is required');
        const rows = await this.db<{ price: string }[]>`
          select price::text as price from public.plans where lower(name) = lower(${name}) and is_active = true limit 1`;
        if (!rows[0]) throw badRequest('This plan is not available');
        return positiveAmount(rows[0].price);
      },
      fulfil: async ({ tx, order, paymentId, ledger }) => {
        const planName = String(order.notes.plan_name ?? '').toLowerCase();
        const plan = await tx<{ id: string; name: string }[]>`
          select id::text, name from public.plans where lower(name) = ${planName} limit 1`;
        await tx`update public.profiles set plan = ${planName} where id = ${order.profile_id!}`;
        const r = await ledger.apply(tx, 'user_wallet', {
          accountId: order.profile_id!,
          deltaPaise: 0,
          displayPaise: order.amountPaise,
          kind: 'plan_purchase',
          idempotencyKey: `rzp:${paymentId}`,
          createdBy: 'system:razorpay',
          paymentMethod: 'razorpay',
          description: `${plan[0]?.name ?? planName} plan`,
          details: { plan_name: plan[0]?.name ?? planName, plan_id: plan[0]?.id ?? null, razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: paymentId },
          reference: { type: 'razorpay_payment', id: paymentId },
        });
        return { plan: planName, wallet_transaction_id: r.historyRowId };
      },
    });
  }

  /** Domains add their own purposes (subscriptions, wish orders, …). */
  registerPurpose(p: Purpose): void {
    for (const n of p.names) {
      if (this.purposes.has(n)) throw new Error(`Payment purpose "${n}" registered twice`);
      this.purposes.set(n, p);
    }
  }

  private purposeOf(name: string): Purpose {
    const p = this.purposes.get(name);
    if (!p) throw badRequest(`Unsupported payment type: ${name}`, 'unsupported_payment_type');
    return p;
  }

  private newWishmeId(): string {
    const d = new Date();
    const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return `WM${ymd}${randomDigits(8)}`;
  }

  // ── create ─────────────────────────────────────────────────────────────────────────────────────────────────

  async createOrder(auth: AuthContext, identity: Identity, body: Record<string, unknown>) {
    if (!auth.userId || !identity.profileId) throw forbidden('A profile is required to pay');
    if (!this.razorpay.configured) throw unavailable('Payments are not configured');
    const notes = (body.notes && typeof body.notes === 'object' ? body.notes : {}) as Record<string, unknown>;
    // The wish checkout sends no notes.type, only notes.orderId and a 'WISH-<orderId>' receipt. Without this it would be
    // priced as a wallet deposit of the client's amount.
    const isWish = notes.orderId !== undefined || (typeof body.receipt === 'string' && body.receipt.startsWith('WISH-'));
    const type = typeof notes.type === 'string' ? notes.type : isWish ? 'wish_order' : 'wallet_deposit';
    const purpose = this.purposeOf(type);
    const amountPaise = await purpose.price({ auth, identity, body, notes });
    const currency = 'INR';
    const receipt = (typeof body.receipt === 'string' ? body.receipt : `${type}_${Date.now()}`).replace(/[^\w-]/g, '_').slice(0, 40);
    // Notes sent to Razorpay identify the user server-side, whatever the client claimed.
    const safeNotes: Record<string, string> = { type, profile_id: identity.profileId, user_id: auth.userId };
    for (const [k, v] of Object.entries(notes)) {
      if (!(k in safeNotes) && (typeof v === 'string' || typeof v === 'number') && Object.keys(safeNotes).length < 15) {
        safeNotes[k] = String(v).slice(0, 250);
      }
    }
    const order = await this.razorpay.createOrder({ amountPaise, currency, receipt, notes: safeNotes });
    await this.db`
      insert into wishme.payment_orders (razorpay_order_id, user_id, profile_id, purpose, amount_paise, currency, receipt, notes)
      values (${order.id}, ${auth.userId}, ${identity.profileId}, ${purpose.names[0]!}, ${amountPaise}, ${currency}, ${receipt}, ${this.db.json(safeNotes)})`;
    this.log.info({ orderId: order.id, purpose: purpose.names[0], amountPaise }, 'payment order created');
    return {
      id: order.id,
      entity: 'order',
      amount: amountPaise,
      currency,
      receipt,
      status: order.status,
      key_id: this.razorpay.keyId,
    };
  }

  // ── verify (checkout callback) ─────────────────────────────────────────────────────────────────────────────

  async verify(auth: AuthContext, body: Record<string, unknown>) {
    const orderId = body.razorpay_order_id;
    const paymentId = body.razorpay_payment_id;
    const signature = body.razorpay_signature;
    if (typeof orderId !== 'string' || typeof paymentId !== 'string' || typeof signature !== 'string') {
      throw badRequest('razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
    }
    if (!this.razorpay.verifyPaymentSignature(orderId, paymentId, signature)) {
      this.log.warn({ orderId, userId: auth.userId }, 'razorpay signature mismatch');
      throw new AppError(400, 'invalid_signature', 'Payment verification failed: invalid signature');
    }
    const order = await this.loadOrder(orderId);
    if (!order) throw notFound('Payment order not found');
    if (order.user_id !== auth.userId) throw forbidden('This payment belongs to another account');
    return this.fulfil(order, paymentId);
  }

  // ── webhook ────────────────────────────────────────────────────────────────────────────────────────────────

  async handleWebhook(raw: Buffer, signature: string | undefined, eventId: string | undefined): Promise<{ status: string }> {
    if (!signature || !this.razorpay.verifyWebhookSignature(raw, signature)) {
      throw new AppError(400, 'invalid_signature', 'Invalid webhook signature');
    }
    const payload = JSON.parse(raw.toString('utf8')) as {
      event: string;
      payload?: { payment?: { entity?: RazorpayPayment }; order?: { entity?: { id: string } } };
    };
    const id = eventId ?? `${payload.event}:${payload.payload?.payment?.entity?.id ?? payload.payload?.order?.entity?.id ?? Date.now()}`;
    const inserted = await this.db`
      insert into wishme.razorpay_events (event_id, event, payload) values (${id}, ${payload.event}, ${this.db.json(payload as never)})
      on conflict (event_id) do nothing returning event_id`;
    if (inserted.length === 0) return { status: 'duplicate' };

    try {
      const payment = payload.payload?.payment?.entity;
      if ((payload.event === 'payment.captured' || payload.event === 'order.paid') && payment?.order_id) {
        const order = await this.loadOrder(payment.order_id);
        if (order) await this.fulfil(order, payment.id, payment);
        else this.log.warn({ orderId: payment.order_id }, 'webhook for an order this server did not create');
      } else if (payload.event === 'payment.failed' && payment?.order_id) {
        await this.db`update wishme.payment_orders set status = 'failed', updated_at = now() where razorpay_order_id = ${payment.order_id} and status = 'created'`;
      }
      await this.db`update wishme.razorpay_events set processed_at = now() where event_id = ${id}`;
      return { status: 'processed' };
    } catch (e) {
      await this.db`update wishme.razorpay_events set error = ${(e as Error).message.slice(0, 500)} where event_id = ${id}`;
      throw e;
    }
  }

  // ── fulfilment ─────────────────────────────────────────────────────────────────────────────────────────────

  private async loadOrder(orderId: string, tx: Db | Tx = this.db): Promise<OrderRow | null> {
    const rows = await tx<OrderRow[]>`select * from wishme.payment_orders where razorpay_order_id = ${orderId}`;
    return rows[0] ?? null;
  }

  async fulfil(order: OrderRow, paymentId: string, knownPayment?: RazorpayPayment) {
    if (order.status === 'fulfilled') return this.result(order);
    if (order.razorpay_payment_id && order.razorpay_payment_id !== paymentId) {
      throw new AppError(409, 'order_already_paid', 'This order was already paid with another payment');
    }
    // Razorpay's own record must agree with what we are about to credit (amount, order, success).
    const payment = knownPayment ?? (await this.razorpay.fetchPayment(paymentId));
    if (payment.order_id !== order.razorpay_order_id) throw new AppError(400, 'payment_mismatch', 'Payment does not belong to this order');
    if (payment.amount !== Number(order.amount_paise) || payment.currency !== order.currency) {
      this.log.error({ orderId: order.razorpay_order_id, paymentId, paid: payment.amount, expected: order.amount_paise }, 'payment amount mismatch');
      throw new AppError(400, 'payment_mismatch', 'Payment amount does not match the order');
    }
    if (payment.status === 'authorized') {
      await this.razorpay.capture(paymentId, payment.amount, payment.currency);
    } else if (payment.status !== 'captured') {
      throw new AppError(400, 'payment_not_captured', `Payment is ${payment.status}`);
    }

    const done = await this.db.begin(async (tx) => {
      const locked = await tx<OrderRow[]>`
        select * from wishme.payment_orders where razorpay_order_id = ${order.razorpay_order_id} for update`;
      const cur = locked[0]!;
      if (cur.status === 'fulfilled') return cur;
      const purpose = this.purposeOf(cur.purpose);
      const wishmePaymentId = cur.wishme_payment_id ?? this.newWishmeId();
      const fulfilment = await purpose.fulfil({
        tx,
        order: { ...cur, amountPaise: Number(cur.amount_paise) },
        paymentId,
        wishmePaymentId,
        ledger: this.ledger,
      });
      await this.writePaymentRecord(tx, cur, purpose, paymentId, wishmePaymentId, fulfilment);
      const updated = await tx<OrderRow[]>`
        update wishme.payment_orders
        set status = 'fulfilled', razorpay_payment_id = ${paymentId}, wishme_payment_id = ${wishmePaymentId},
            fulfilment = ${tx.json(fulfilment as never)}, fulfilled_at = now(), updated_at = now()
        where razorpay_order_id = ${cur.razorpay_order_id}
        returning *`;
      return updated[0]!;
    });
    this.log.info({ orderId: done.razorpay_order_id, purpose: done.purpose }, 'payment fulfilled');
    return this.result(done);
  }

  private result(o: OrderRow) {
    return {
      success: true,
      verified: true,
      wishme_payment_id: o.wishme_payment_id,
      razorpay_order_id: o.razorpay_order_id,
      razorpay_payment_id: o.razorpay_payment_id,
      amount: toRupeesNumber(Number(o.amount_paise)),
      ...(o.fulfilment ?? {}),
    };
  }

  /** The public.payment_transactions row the app's history reads (only columns that exist are written). */
  private async writePaymentRecord(
    tx: Tx,
    o: OrderRow,
    purpose: Purpose,
    paymentId: string,
    wishmePaymentId: string,
    fulfilment: Record<string, unknown>,
  ): Promise<void> {
    const table = this.schema.table('payment_transactions');
    if (!table) return;
    const row: Record<string, unknown> = {
      wishme_payment_id: wishmePaymentId,
      user_id: o.profile_id,
      amount: rupeesForColumn(Number(o.amount_paise), table.columns.get('amount')?.type),
      payment_method: 'razorpay',
      service_type: purpose.serviceType,
      razorpay_payment_id: paymentId,
      razorpay_order_id: o.razorpay_order_id,
      description: purpose.serviceType === 'deposit' ? `Wallet deposit of ₹${toRupeesString(Number(o.amount_paise)).replace(/\.00$/, '')}` : String(o.notes.plan_name ?? purpose.serviceType),
      status: 'completed',
      paid_at: new Date().toISOString(),
    };
    // Links the app's history uses (payment_transactions.wish_order_id, booking_id), taken from what the purpose fulfilled.
    for (const link of RECORD_LINKS) {
      const v = fulfilment[link];
      if (typeof v === 'string' && v) row[link] = v;
    }
    const cols = Object.keys(row).filter((c) => table.columns.has(c));
    await tx.unsafe(
      `insert into public.payment_transactions (${cols.map((c) => `"${c}"`).join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => row[c]) as never[],
    );
  }

  /** For compat mirrors: the fulfilled order behind a Razorpay payment id, if it belongs to this user. */
  async fulfilledByPayment(paymentId: string, userId: string): Promise<OrderRow | null> {
    const rows = await this.db<OrderRow[]>`
      select * from wishme.payment_orders
      where razorpay_payment_id = ${paymentId} and user_id = ${userId} and status = 'fulfilled'`;
    return rows[0] ?? null;
  }
}
