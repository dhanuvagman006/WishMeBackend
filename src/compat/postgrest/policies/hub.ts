/**
 * Table policies for the Hub and the voice assistant: assistant_settings, calendar_events, reminders, ai_calls and
 * ai_call_lines. See ../policy.ts for the model and CONTRIBUTING.md for the rules.
 *
 * Identity: these tables key on the AUTH user id (auth.users.id, the JWT `sub`), not profiles.id: the app writes
 * `user_id: user.id` (services/hub/*.ts, AssistantPersonaContext.tsx). Every owner predicate uses c.auth.userId and
 * every insert forces user_id from the token, whatever the body says.
 *
 * Server-owned fields are never client-writable: an AI call row (status, transcript, summary, recording …) is written
 * only by ai-call-start, the Vapi webhook and the calls worker; a reminder's call_id and the 'missed' status only by
 * the reminder dispatcher.
 */
import { checkIndianNumber } from '../../../domains/voice/phone.js';
import { AppError } from '../../../lib/errors.js';
import { and, sql } from '../../../lib/sql.js';
import type { PolicyCtx, RowRule, RpcDefinition, TablePolicy } from '../policy.js';
import { definePolicy } from '../policy.js';

/** Rows owned by the signed-in user (auth user id). Anonymous and service callers see nothing. */
const owner: RowRule = (c) => (c.auth.kind === 'user' && c.auth.userId ? sql`${c.col('user_id')} = ${c.auth.userId}::uuid` : 'none');

const nowIso = () => new Date().toISOString();

function requireUser(c: PolicyCtx): string {
  if (c.auth.kind !== 'user' || !c.auth.userId) throw new AppError(401, '42501', 'permission denied: sign in required');
  return c.auth.userId;
}

const invalid = (message: string, hint?: string) => new AppError(400, '22023', message, null, hint);

// ── field checks (messages are shown by the app from `message`, so they are written for people) ─────────────────

function text(row: Record<string, unknown>, key: string, max: number, opts: { required?: boolean; label: string }): void {
  if (!(key in row)) {
    if (opts.required) throw invalid(`${opts.label} is required.`);
    return;
  }
  const v = row[key];
  if (v === null || v === undefined) {
    if (opts.required) throw invalid(`${opts.label} is required.`);
    row[key] = null;
    return;
  }
  if (typeof v !== 'string') throw invalid(`${opts.label} must be text.`);
  const trimmed = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (opts.required && trimmed.length === 0) throw invalid(`${opts.label} is required.`);
  if (trimmed.length > max) throw invalid(`${opts.label} is too long (at most ${max} characters).`);
  row[key] = trimmed;
}

function oneOf(row: Record<string, unknown>, key: string, allowed: readonly string[], label: string): void {
  if (!(key in row)) return;
  if (typeof row[key] !== 'string' || !allowed.includes(row[key] as string)) {
    throw invalid(`${label} must be one of: ${allowed.join(', ')}.`);
  }
}

function instant(row: Record<string, unknown>, key: string, label: string, nullable: boolean): void {
  if (!(key in row)) return;
  const v = row[key];
  if (v === null) {
    if (!nullable) throw invalid(`${label} is required.`);
    return;
  }
  if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) throw invalid(`${label} is not a valid date and time.`);
}

function date(row: Record<string, unknown>, key: string, label: string): void {
  if (!(key in row) || row[key] === null) return;
  const v = row[key];
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v) || Number.isNaN(Date.parse(v.slice(0, 10)))) {
    throw invalid(`${label} is not a valid date.`);
  }
  row[key] = v.slice(0, 10);
}

function bool(row: Record<string, unknown>, key: string, label: string): void {
  if (key in row && typeof row[key] !== 'boolean') throw invalid(`${label} must be true or false.`);
}

function int(row: Record<string, unknown>, key: string, min: number, max: number, label: string): void {
  if (!(key in row)) return;
  const v = row[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw invalid(`${label} must be a whole number from ${min} to ${max}.`);
}

function timezone(row: Record<string, unknown>): void {
  if (!('timezone' in row)) return;
  const v = row.timezone;
  if (typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(v)) throw invalid('timezone must be an IANA time zone such as Asia/Kolkata.');
}

const RECURRENCE = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const;

// ── assistant_settings ───────────────────────────────────────────────────────────────────────────────────────────

const PERSONALITIES = ['friendly', 'professional', 'funny', 'calm', 'energetic', 'custom'] as const;
const SETTINGS_COLUMNS = ['assistant_name', 'voice', 'personality', 'custom_note', 'language', 'is_default'] as const;

function checkSettings(row: Record<string, unknown>): void {
  text(row, 'assistant_name', 30, { label: 'Assistant name', required: false });
  if ('voice' in row && (typeof row.voice !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(row.voice))) {
    throw invalid('voice is not a known voice.');
  }
  oneOf(row, 'personality', PERSONALITIES, 'personality');
  text(row, 'custom_note', 300, { label: 'Custom note' });
  // ASSUMPTION: today's app sends auto|english|hindi|hinglish; newer builds may add more, so only the shape is checked.
  if ('language' in row && (typeof row.language !== 'string' || !/^[a-z][a-z-]{1,19}$/i.test(row.language))) {
    throw invalid('language is not a known language.');
  }
  bool(row, 'is_default', 'is_default');
}

const assistantSettings = definePolicy({
  table: 'assistant_settings',
  read: [{ name: 'owner', rows: owner, columns: '*' }],
  insert: {
    columns: [...SETTINGS_COLUMNS],
    set: (c) => ({ user_id: requireUser(c), updated_at: nowIso() }),
    check: (row) => checkSettings(row),
    maxRows: 1,
  },
  update: {
    rows: owner,
    columns: [...SETTINGS_COLUMNS],
    set: () => ({ updated_at: nowIso() }),
    check: (row) => checkSettings(row),
  },
  upsertOn: [['user_id']],
});

// ── calendar_events ──────────────────────────────────────────────────────────────────────────────────────────────

const EVENT_COLUMNS = ['title', 'notes', 'location', 'starts_at', 'ends_at', 'all_day', 'recurrence', 'recurrence_until', 'timezone', 'colour'] as const;

function checkEvent(row: Record<string, unknown>, creating: boolean): void {
  text(row, 'title', 200, { label: 'Title', required: creating });
  text(row, 'notes', 2000, { label: 'Notes' });
  text(row, 'location', 300, { label: 'Location' });
  instant(row, 'starts_at', 'Start', false);
  if (creating && !('starts_at' in row)) throw invalid('Start is required.');
  instant(row, 'ends_at', 'End', true);
  if (typeof row.starts_at === 'string' && typeof row.ends_at === 'string' && Date.parse(row.ends_at) < Date.parse(row.starts_at)) {
    throw invalid('The event cannot end before it starts.');
  }
  bool(row, 'all_day', 'all_day');
  oneOf(row, 'recurrence', RECURRENCE, 'recurrence');
  date(row, 'recurrence_until', 'Repeat until');
  timezone(row);
  text(row, 'colour', 32, { label: 'Colour' });
}

/** Mirrored events (occasions, bookings) are maintained by the server and must not be edited from the calendar. */
const ownUserEvent: RowRule = (c) => {
  const o = owner(c);
  return o === 'none' || o === 'all' ? o : and([o, sql`${c.col('source')} = 'user'`]);
};

const calendarEvents = definePolicy({
  table: 'calendar_events',
  read: [
    {
      name: 'owner',
      rows: owner,
      columns: ['id', 'user_id', 'title', 'notes', 'location', 'starts_at', 'ends_at', 'all_day', 'timezone', 'recurrence', 'recurrence_until', 'colour', 'source', 'source_id', 'created_at', 'updated_at'],
    },
  ],
  insert: {
    columns: [...EVENT_COLUMNS],
    // The app sends user_id (auth id) and timezone; user_id is replaced by the token's, source is always 'user'.
    set: (c) => ({ user_id: requireUser(c), source: 'user', updated_at: nowIso() }),
    check: (row) => checkEvent(row, true),
    maxRows: 20,
  },
  update: {
    rows: ownUserEvent,
    columns: [...EVENT_COLUMNS],
    set: () => ({ updated_at: nowIso() }),
    check: (row) => checkEvent(row, false),
  },
  delete: { rows: ownUserEvent },
});

// ── reminders ────────────────────────────────────────────────────────────────────────────────────────────────────

const REMINDER_DRAFT = [
  'title', 'notes', 'due_at', 'pin_to_timezone', 'lead_minutes', 'delivery', 'style', 'recurrence', 'recurrence_until',
  'escalate', 'escalate_after_minutes', 'escalate_phone', 'timezone',
] as const;

function checkReminder(row: Record<string, unknown>, creating: boolean): void {
  text(row, 'title', 200, { label: 'Title', required: creating });
  text(row, 'notes', 2000, { label: 'Notes' });
  instant(row, 'due_at', 'Due time', true);
  bool(row, 'pin_to_timezone', 'pin_to_timezone');
  int(row, 'lead_minutes', 0, 20_160, 'Lead time');
  oneOf(row, 'delivery', ['notification', 'call'], 'delivery');
  oneOf(row, 'style', ['alarm', 'reminder', 'quiet'], 'style');
  oneOf(row, 'recurrence', RECURRENCE, 'recurrence');
  date(row, 'recurrence_until', 'Repeat until');
  bool(row, 'escalate', 'escalate');
  int(row, 'escalate_after_minutes', 2, 60, 'Escalate after');
  timezone(row);
  if ('escalate_phone' in row && row.escalate_phone !== null && row.escalate_phone !== '') {
    // This number will be rung by the platform: the same rules as any AI call.
    const n = checkIndianNumber(row.escalate_phone);
    if (!n.ok) throw invalid(n.reason);
    row.escalate_phone = n.e164;
  } else if ('escalate_phone' in row) {
    row.escalate_phone = null;
  }
  if ('status' in row) {
    // 'missed' is decided by the dispatcher, never by the phone.
    oneOf(row, 'status', ['pending', 'done', 'cancelled'], 'status');
  }
  instant(row, 'completed_at', 'completed_at', true);
  instant(row, 'acknowledged_at', 'acknowledged_at', true);
  // Moving a reminder to a new future time re-arms its escalation: the old acknowledgement was for the old time.
  if (!creating && typeof row.due_at === 'string' && Date.parse(row.due_at) > Date.now() && !('acknowledged_at' in row)) {
    row.acknowledged_at = null;
  }
}

const reminders = definePolicy({
  table: 'reminders',
  read: [
    {
      name: 'owner',
      rows: owner,
      columns: [
        'id', 'user_id', 'title', 'notes', 'due_at', 'timezone', 'pin_to_timezone', 'lead_minutes', 'delivery', 'style', 'recurrence',
        'recurrence_until', 'escalate', 'escalate_after_minutes', 'escalate_phone', 'status', 'completed_at', 'acknowledged_at',
        'event_id', 'call_id', 'created_at', 'updated_at',
      ],
    },
  ],
  insert: {
    columns: [...REMINDER_DRAFT],
    set: (c) => ({ user_id: requireUser(c), status: 'pending', updated_at: nowIso() }),
    check: (row) => checkReminder(row, true),
    maxRows: 20,
  },
  update: {
    rows: owner,
    columns: [...REMINDER_DRAFT, 'status', 'completed_at', 'acknowledged_at'],
    set: () => ({ updated_at: nowIso() }),
    check: (row) => checkReminder(row, false),
  },
  delete: { rows: owner },
});

// ── ai_calls / ai_call_lines (read-only for clients) ─────────────────────────────────────────────────────────────

const aiCalls = definePolicy({
  table: 'ai_calls',
  // The app reads without a user filter (RLS scoped it on Supabase); the owner predicate does that here.
  read: [
    {
      name: 'owner',
      rows: owner,
      columns: [
        'id', 'user_id', 'to_name', 'to_phone', 'purpose', 'details', 'status', 'scheduled_for', 'duration_seconds',
        'transcript', 'summary', 'outcome', 'next_step', 'recording_url', 'error_message', 'ended_reason', 'created_at',
      ],
    },
  ],
});

const aiCallLines = definePolicy({
  table: 'ai_call_lines',
  read: [
    {
      name: 'owner-of-call',
      rows: (c) =>
        c.auth.kind === 'user' && c.auth.userId
          ? sql`exists (select 1 from public.ai_calls oc where oc.id = ${c.col('call_id')} and oc.user_id = ${c.auth.userId}::uuid)`
          : 'none',
      columns: ['id', 'call_id', 'role', 'message', 'seq'],
    },
  ],
});

export const tables: TablePolicy[] = [assistantSettings, calendarEvents, reminders, aiCalls, aiCallLines];

export const rpcs: RpcDefinition[] = [];
