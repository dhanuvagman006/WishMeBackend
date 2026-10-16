/**
 * The reminder dispatcher (replaces pg_cron → cron_dispatch_reminders → reminders-dispatch, supabase audit
 * 2026-10-16). Every minute:
 *
 *  1. Due reminders are claimed (fired_at = now), exactly like claim_due_reminders: pending, not fired, due_at minus
 *     lead_minutes reached, and not more than 6 hours late. A 'call' reminder rings the user (an ai_calls row is
 *     created and linked through reminders.call_id in the same transaction, then a job dials it); any other reminder
 *     gets a push backstop job on the notifications queue. A repeating reminder is closed ('done') and its next
 *     occurrence inserted, as production did.
 *  2. Escalations are claimed like claim_reminder_escalations (escalate, fired, not acknowledged, no call yet, fired_at
 *     plus escalate_after_minutes reached): the user (or escalate_phone) is rung.
 *  3. 'call' reminders that were never fired and are more than 6 hours late are marked missed.
 *
 * Settings: reminders_enabled, reminder_call_enabled (platform_settings, text 'false' switches off).
 * Nothing rings twice: claiming happens under row locks in one transaction, jobs have deterministic ids
 * (reminder:<id>:<due_at>:<why>), and dialling claims the ai_calls row again (domains/voice/ai-calls.ts).
 */
import type { Deps } from '../../deps.js';
import { QUEUES } from '../../jobs/queues.js';
import type { Tx } from '../../lib/db.js';
import { cleanText, settings } from '../voice/ai-calls.js';
import { checkIndianNumber } from '../voice/phone.js';

/** Cost guard: at most this many reminder calls per user in 24 hours (production had none). */
export const REMINDER_CALLS_PER_DAY = 20;

interface ReminderRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  timezone: string;
  lead_minutes: number;
  delivery: string;
  style: string;
  recurrence: string;
  recurrence_until: string | null;
  escalate: boolean;
  escalate_after_minutes: number;
  escalate_phone: string | null;
  event_id: string | null;
  pin_to_timezone: boolean;
}

/** The same reminder one period later (UTC arithmetic, as production); null when it does not repeat or ran out. */
export function nextOccurrence(r: { recurrence: string; due_at: string | null; recurrence_until: string | null }): string | null {
  if (r.recurrence === 'none' || !r.due_at) return null;
  const d = new Date(r.due_at);
  switch (r.recurrence) {
    case 'daily':
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case 'weekly':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'monthly':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'yearly':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
    default:
      return null;
  }
  if (r.recurrence_until && d > new Date(`${r.recurrence_until.slice(0, 10)}T23:59:59Z`)) return null;
  return d.toISOString();
}

const COLS = `id::text, user_id::text, title, notes, to_json(due_at) #>> '{}' as due_at, timezone, lead_minutes, delivery, style, recurrence,
  recurrence_until::text, escalate, escalate_after_minutes, escalate_phone, event_id::text, pin_to_timezone`;

/**
 * Creates the ai_calls row for a reminder call and links it, inside the claiming transaction. Returns null when the
 * user has no callable number or hit the daily cap (the caller then falls back to a push).
 */
async function linkCall(tx: Tx, r: ReminderRow, why: 'due' | 'escalation'): Promise<string | null> {
  const profile = await tx<{ phone: string | null; first_name: string | null }[]>`select phone, first_name from public.profiles where user_id = ${r.user_id} limit 1`;
  const number = checkIndianNumber(r.escalate_phone || profile[0]?.phone || '');
  if (!number.ok) return null;
  const today = await tx<{ n: number }[]>`
    select count(*)::int as n from public.ai_calls where user_id = ${r.user_id} and created_at > now() - interval '1 day' and purpose like 'Reminder:%'`;
  if ((today[0]?.n ?? 0) >= REMINDER_CALLS_PER_DAY) return null;
  const purpose = `Reminder: ${cleanText(r.title, 560)}${why === 'escalation' ? ' (no response to the notification)' : ''}`.slice(0, 600);
  const rows = await tx<{ id: string }[]>`
    insert into public.ai_calls (user_id, to_name, to_phone, purpose, details, language, status)
    values (${r.user_id}, ${cleanText(profile[0]?.first_name, 40) || null}, ${number.e164}, ${purpose}, ${r.notes ? cleanText(r.notes, 800) : null}, 'english', 'queued')
    returning id::text`;
  const callId = rows[0]!.id;
  await tx`update public.reminders set call_id = ${callId}, updated_at = now() where id = ${r.id}`;
  return callId;
}

interface Planned {
  kind: 'call' | 'push';
  reminder: ReminderRow;
  callId?: string;
  why: 'due' | 'escalation';
}

export async function dispatchReminders(deps: Deps): Promise<{ delivered: number; escalated: number; missed: number }> {
  const s = await settings(deps.db, ['reminders_enabled', 'reminder_call_enabled']);
  if (s.get('reminders_enabled') === 'false') return { delivered: 0, escalated: 0, missed: 0 };
  const callsAllowed = s.get('reminder_call_enabled') !== 'false';

  const planned = (await deps.db.begin(async (tx) => {
    const out: Planned[] = [];
    const due = await tx.unsafe<ReminderRow[]>(`
      update public.reminders r set fired_at = now(), updated_at = now()
      where r.id in (
        select id from public.reminders
        where status = 'pending' and fired_at is null and due_at is not null
          and due_at - make_interval(mins => lead_minutes) <= now()
          and due_at > now() - interval '6 hours'
        order by due_at limit 50
        for update skip locked)
      returning ${COLS}`);
    for (const r of due) {
      const callId = r.delivery === 'call' && callsAllowed ? await linkCall(tx, r, 'due') : null;
      out.push(callId ? { kind: 'call', reminder: r, callId, why: 'due' } : { kind: 'push', reminder: r, why: 'due' });
      const next = nextOccurrence(r);
      if (next) {
        await tx`
          insert into public.reminders (user_id, title, notes, due_at, timezone, pin_to_timezone, lead_minutes, delivery, style, recurrence,
            recurrence_until, escalate, escalate_after_minutes, escalate_phone, event_id)
          values (${r.user_id}, ${r.title}, ${r.notes}, ${next}, ${r.timezone}, ${r.pin_to_timezone}, ${r.lead_minutes}, ${r.delivery}, ${r.style},
            ${r.recurrence}, ${r.recurrence_until}, ${r.escalate}, ${r.escalate_after_minutes}, ${r.escalate_phone}, ${r.event_id})`;
        await tx`update public.reminders set status = 'done', completed_at = now(), updated_at = now() where id = ${r.id}`;
      }
    }
    if (callsAllowed) {
      const stale = await tx.unsafe<ReminderRow[]>(`
        select ${COLS} from public.reminders
        where status = 'pending' and escalate and fired_at is not null and acknowledged_at is null and call_id is null
          and fired_at + make_interval(mins => escalate_after_minutes) <= now()
          and fired_at > now() - interval '1 day'
        order by fired_at limit 20
        for update skip locked`);
      for (const r of stale) {
        const callId = await linkCall(tx, r, 'escalation');
        if (callId) out.push({ kind: 'call', reminder: r, callId, why: 'escalation' });
      }
    }
    return out;
  })) as Planned[];

  for (const p of planned) {
    const r = p.reminder;
    const tag = `${r.id}:${r.due_at ?? 'none'}:${p.why}`;
    if (p.kind === 'call') {
      await deps.jobs.enqueue(QUEUES.reminders, 'reminder-call', { callId: p.callId!, reminderId: r.id }, { jobId: `reminder:${tag}` });
    } else {
      await enqueuePush(deps, r, tag);
    }
  }
  const missed = await deps.db`
    update public.reminders set status = 'missed', updated_at = now()
    where status = 'pending' and delivery = 'call' and fired_at is null and due_at is not null
      and due_at < now() - interval '6 hours' and recurrence = 'none'
    returning id`;
  const escalated = planned.filter((p) => p.why === 'escalation').length;
  return { delivered: planned.length - escalated, escalated, missed: missed.length };
}

/** The backstop push for a reminder (the phone schedules its own notification; the notifications worker decides). */
export async function enqueuePush(deps: Deps, r: Pick<ReminderRow, 'id' | 'user_id' | 'title' | 'notes' | 'due_at' | 'style' | 'event_id'>, tag: string): Promise<void> {
  await deps.jobs.enqueue(
    QUEUES.notifications,
    'push',
    {
      userId: r.user_id,
      title: r.title,
      body: r.notes ?? (r.due_at ? 'Reminder' : ''),
      data: { kind: 'reminder', reminderId: r.id, eventId: r.event_id, style: r.style },
    },
    { jobId: `push:reminder:${tag}` },
  );
}
