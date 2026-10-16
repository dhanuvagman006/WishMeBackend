/**
 * Fan / celebrity chat. Messages are written by participants only, with the sender taken from the token. When a
 * message is inserted the server maintains last_message_at and the unread counters (the client's read-modify-write
 * PATCHes are accepted and ignored); message_count, numbering and closing at the limit belong to production's
 * enforce_conversation_limit trigger.
 */
import { z } from 'zod';
import type { Deps } from '../../deps.js';
import { compileUpdate, filtersSql } from '../../compat/postgrest/compiler.js';
import { parseRead, pgrstError } from '../../compat/postgrest/parser.js';
import type { CompatResult, CustomArgs } from '../../compat/postgrest/policy.js';
import { run, type Tx } from '../../lib/db.js';
import { AppError, badRequest, forbidden } from '../../lib/errors.js';
import { ident, sql, type Sql } from '../../lib/sql.js';
import { settingValue } from '../pricing.js';
import { asCaller, checkStorageUrl, compileEnv, insertRow, objectBody, represent, requireProfile, uuidArray } from './compat.js';
import { UUID_RE } from './shared.js';

/** The chat input allows 1000 characters; a voice-note marker with this server's URL adds a few hundred. */
export const MAX_MESSAGE_CHARS = 2000;

const NewMessage = z
  .object({
    conversation_id: z.string().uuid(),
    sender_id: z.string().uuid().optional().nullable(),
    sender_type: z.enum(['user', 'celebrity']).optional(),
    message_text: z.string(),
    is_read: z.boolean().optional(),
    is_ai_generated: z.literal(false).optional(),
  })
  .strict();

function denyUnknown(issue: z.ZodIssue, table: string): never {
  if (issue.code === 'unrecognized_keys') throw new AppError(403, '42501', `permission denied to write column "${issue.keys[0]}" of ${table}`);
  if (issue.path[0] === 'is_ai_generated') throw new AppError(403, '42501', 'Only the server marks messages as AI generated');
  throw new AppError(400, '22023', `Invalid ${issue.path.join('.') || 'body'}: ${issue.message}`);
}

interface ConversationRow {
  id: string;
  user_id: string;
  celebrity_id: string;
  is_closed: boolean | null;
  message_count: number | null;
}

/**
 * The conversation limit as production's enforce_conversation_limit trigger reads it: platform_settings
 * conversation_message_limit (default 200) and conversation_limit_enabled (default true). Null = no limit.
 */
async function messageLimit(q: Tx): Promise<number | null> {
  const enabled = String((await settingValue(q, 'conversation_limit_enabled')) ?? 'true').trim().toLowerCase();
  if (enabled === 'false' || enabled === 'f' || enabled === '0') return null;
  const n = Number.parseInt(String((await settingValue(q, 'conversation_message_limit')) ?? '200'), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 200;
}

export const LIMIT_REACHED = 'This conversation has been closed after reaching the message limit';
const VOICE_NOTE = /\[Voice Note:\s*([^\]\s]+)\s*\]/g;

/**
 * Voice notes are embedded as `[Voice Note: <public url>]` and played by the other side, so the URL must point at
 * this server's voice-notes bucket inside the sender's own folder (profile id, or own celebrity id). Greeting-card
 * markers are rendered as images by the app and are only produced by server functions, never accepted from clients.
 */
function checkMessageText(deps: Deps, text: string, folders: readonly string[]): void {
  if (/\[Greeting Card:/i.test(text)) throw forbidden('Greeting cards cannot be sent as chat text', '42501');
  for (const m of text.matchAll(VOICE_NOTE)) checkStorageUrl(deps, m[1], 'voice-notes', folders, 'Voice note');
  if (/\[Voice Note:/i.test(text.replace(VOICE_NOTE, ''))) throw badRequest('Invalid voice note');
}

/** POST /rest/v1/messages. */
export async function insertMessage(a: CustomArgs): Promise<CompatResult> {
  const { deps, identity } = a;
  const profileId = requireProfile(a.auth, identity);
  if (Array.isArray(a.body)) throw pgrstError(400, 'PGRST102', 'Send one message per request');
  const r = NewMessage.safeParse(objectBody(a.body));
  if (!r.success) denyUnknown(r.error.issues[0]!, 'messages');
  const m = r.data;
  if (m.sender_id && m.sender_id !== profileId) throw forbidden('You can only send messages as yourself', '42501');
  const text = m.message_text.trim();
  if (!text) throw badRequest('Message cannot be empty');
  if (text.length > MAX_MESSAGE_CHARS) throw badRequest(`Messages are limited to ${MAX_MESSAGE_CHARS} characters`);
  await deps.limiter.hit('chat-send', profileId, { limit: 30, windowSec: 60 }, 'You are sending messages too quickly. Please slow down.');

  const id = await deps.db.begin(async (tx) => {
    const conv = (await tx<ConversationRow[]>`
      select id::text, user_id::text, celebrity_id::text, is_closed, message_count from public.conversations
      where id = ${m.conversation_id} for update`)[0];
    const isUser = !!conv && conv.user_id === profileId;
    const isCelebrity = !!conv && identity.celebrityIds.includes(conv.celebrity_id);
    if (!conv || (!isUser && !isCelebrity)) throw forbidden('You are not part of this conversation', '42501');
    const side = m.sender_type ?? (isUser ? 'user' : 'celebrity');
    if ((side === 'user' && !isUser) || (side === 'celebrity' && !isCelebrity)) {
      throw forbidden('You cannot send messages as the other participant', '42501');
    }
    checkMessageText(deps, text, side === 'user' ? [profileId] : [profileId, conv.celebrity_id]);

    if (side === 'user') {
      // Production's enforce_conversation_limit trigger numbers messages, keeps message_count, posts the warning and
      // closing messages and closes the conversation; this check only answers early with the trigger's own words, so
      // nothing is counted twice.
      const limit = await messageLimit(tx);
      if (conv.is_closed || (limit !== null && (conv.message_count ?? 0) + 1 >= limit)) throw badRequest(LIMIT_REACHED, 'conversation_closed');
    }

    const messageId = await insertRow(deps, tx, 'messages', {
      conversation_id: conv.id,
      sender_id: profileId,
      sender_type: side,
      message_text: text,
      is_read: false,
      is_ai_generated: false,
    });
    await bumpConversation(deps, tx, conv.id, side);    return messageId;
  });
  return represent(a, deps.db, [id], 201);
}

/**
 * Conversation fields no production trigger maintains: last_message_at and the other side's unread counter (the app
 * used to PATCH them from the phone). message_count belongs to the limit trigger. Columns missing from the schema are
 * skipped (production has no last_message_text, which the dashboard reads).
 */
export async function bumpConversation(deps: Deps, tx: Tx, conversationId: string, side: 'user' | 'celebrity'): Promise<void> {
  const cols = deps.schema.table('conversations')?.columns;
  const sets: Sql[] = [];
  if (cols?.has('last_message_at')) sets.push(sql`last_message_at = now()`);
  if (side === 'user' && cols?.has('unread_count_celebrity')) sets.push(sql`unread_count_celebrity = coalesce(unread_count_celebrity, 0) + 1`);
  if (side === 'celebrity' && cols?.has('unread_count_user')) sets.push(sql`unread_count_user = coalesce(unread_count_user, 0) + 1`);
  if (sets.length === 0) return;
  const set = sets.reduce((acc, s, i) => (i === 0 ? s : sql`${acc}, ${s}`));
  await run(tx, sql`update public.conversations set ${set} where id = ${conversationId}::uuid`);
}
/** Who the caller is in conversations: as the fan (profile id) and/or as the celebrity (own celebrity ids). */
function participantOf(alias: string, profileId: string | null, celebrityIds: readonly string[]): Sql {
  const user = profileId ? sql`${ident(alias, 'user_id')} = ${profileId}::uuid` : sql`false`;
  const celeb = celebrityIds.length ? sql`${ident(alias, 'celebrity_id')} = any(${uuidArray(celebrityIds)})` : sql`false`;
  return sql`(${user} or ${celeb})`;
}

/** Resets the caller's own unread counter on the given conversations. */
async function resetUnread(tx: Tx, conversationIds: readonly string[], profileId: string | null, celebrityIds: readonly string[], side: 'user' | 'celebrity' | 'both'): Promise<void> {
  if (conversationIds.length === 0) return;
  if (profileId && side !== 'celebrity') {
    await run(tx, sql`update public.conversations set unread_count_user = 0
      where id = any(${uuidArray(conversationIds)}) and user_id = ${profileId}::uuid and unread_count_user <> 0`);
  }
  if (celebrityIds.length && side !== 'user') {
    await run(tx, sql`update public.conversations set unread_count_celebrity = 0
      where id = any(${uuidArray(conversationIds)}) and celebrity_id = any(${uuidArray(celebrityIds)}) and unread_count_celebrity <> 0`);
  }
}

const ConversationPatch = z
  .object({
    unread_count_user: z.number().int().min(0).optional(),
    unread_count_celebrity: z.number().int().min(0).optional(),
    last_message_at: z.string().max(40).optional(),
  })
  .strict();

/**
 * PATCH /rest/v1/conversations. The app sends three kinds of body: `{unread_count_user: 0}` when the fan opens a chat,
 * and `{last_message_at}` / `{unread_count_celebrity: n + 1}` after sending. Only resetting the caller's own unread
 * counter to 0 has an effect; the rest is maintained on message insert and accepted without writing.
 */
export async function updateConversations(a: CustomArgs): Promise<CompatResult> {
  const r = ConversationPatch.safeParse(objectBody(a.body));
  if (!r.success) denyUnknown(r.error.issues[0]!, 'conversations');
  const patch = r.data;
  const filters = parseRead(a.params).where;
  if (filters.length === 0) throw pgrstError(400, '21000', 'UPDATE requires a WHERE clause');
  const { profileId, celebrityIds } = a.identity;
  if (a.auth.kind === 'anon' || (!profileId && celebrityIds.length === 0)) return represent(a, a.deps.db, [], 200);
  const info = a.deps.schema.table('conversations')!;
  const ids = await asCaller(a, async (tx) => {
    const rows = await run<{ id: string }>(tx, sql`
      select t0.id::text as id from public.conversations as t0
      where ${participantOf('t0', profileId, celebrityIds)} and ${filtersSql(info, null, 't0', filters)} limit 100`);
    const found = rows.map((x) => x.id);
    if (patch.unread_count_user === 0) await resetUnread(tx, found, profileId, [], 'user');
    if (patch.unread_count_celebrity === 0) await resetUnread(tx, found, null, celebrityIds, 'celebrity');
    return found;
  });
  return represent(a, a.deps.db, ids, 200);
}

/**
 * PATCH /rest/v1/messages `{is_read: true}`: marks read only the messages addressed to the caller (the policy's update
 * rule), whatever filter the app sends, then clears the caller's unread counter on those conversations.
 */
export async function markMessagesRead(a: CustomArgs): Promise<CompatResult> {
  const body = objectBody(a.body);
  const keys = Object.keys(body);
  const bad = keys.find((k) => k !== 'is_read');
  if (bad) throw new AppError(403, '42501', `permission denied to write column "${bad}" of messages`);
  if (body.is_read !== true) throw new AppError(403, '42501', 'Messages can only be marked as read');
  if (a.auth.kind === 'anon' || (!a.identity.profileId && a.identity.celebrityIds.length === 0)) return represent(a, a.deps.db, [], 200);
  const filters = parseRead(a.params).where;
  const compiled = compileUpdate(compileEnv(a), 'messages', { is_read: true }, filters, [
    { kind: 'column', name: 'id' },
    { kind: 'column', name: 'conversation_id' },
  ]);
  const touched = await asCaller(a, async (tx) => {
    const res = await run<{ body: string }>(tx, compiled.query);
    const rows = JSON.parse(res[0]?.body ?? '[]') as { id: string; conversation_id: string }[];
    const convs = [...new Set(rows.map((x) => x.conversation_id))];
    await resetUnread(tx, convs, a.identity.profileId, a.identity.celebrityIds, 'both');
    return rows.map((x) => x.id);
  });
  return represent(a, a.deps.db, touched, 200);
}

/** Realtime: may this caller follow inserts into conversation `id`? Database check of participation. */
export async function isParticipant(db: import('../../lib/db.js').Db, conversationId: string, profileId: string | null, celebrityIds: readonly string[]): Promise<boolean> {
  if (!UUID_RE.test(conversationId) || (!profileId && celebrityIds.length === 0)) return false;
  const rows = await run(db, sql`select 1 from public.conversations as cv where cv.id = ${conversationId}::uuid and ${participantOf('cv', profileId, celebrityIds)}`);
  return rows.length > 0;
}
