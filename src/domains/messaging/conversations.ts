/**
 * Direct-message helpers shared by the messaging functions: load a conversation, find or create the user↔celebrity
 * conversation, post a message and keep the conversation's counters in step (server-side, so they are not left to the
 * client's read-modify-write PATCHes).
 *
 * Columns follow the production schema (audit export): conversations { id, user_id, celebrity_id, last_message_at,
 * unread_count_user, unread_count_celebrity, message_count, is_closed, closed_reason }; messages { id, conversation_id,
 * sender_type ('user'|'celebrity'|'system'), sender_id (a profiles.id), message_text, is_ai_generated, is_read,
 * created_at, conversation_message_number }. message_count and conversation_message_number are maintained by
 * production's check_conversation_limit trigger, which also enforces the message limit; they are not touched here.
 * Optional columns are written only when the schema cache has them.
 */
import type { SchemaCache } from '../../compat/postgrest/schema-cache.js';
import type { Queryable, Tx } from '../../lib/db.js';
import { ident, sql } from '../../lib/sql.js';
import { insertRow, updateRows } from '../accounts/rows.js';

export interface Conversation {
  id: string;
  user_id: string | null;
  celebrity_id: string | null;
  is_closed?: boolean | null;
}

export interface ChatMessage {
  id: string;
  sender_id: string | null;
  sender_type: string | null;
  message_text: string | null;
  created_at: string | null;
}

export async function loadConversation(q: Queryable, id: string): Promise<Conversation | null> {
  const rows = await q<{ j: Conversation }[]>`select to_jsonb(c) as j from public.conversations c where c.id = ${id}`;
  return rows[0]?.j ?? null;
}

/** The newest messages of a conversation, oldest first. */
export async function recentMessages(q: Queryable, conversationId: string, limit = 12): Promise<ChatMessage[]> {
  const rows = await q<{ j: ChatMessage }[]>`
    select to_jsonb(m) as j from public.messages m where m.conversation_id = ${conversationId}
    order by m.created_at desc limit ${limit}`;
  return rows.map((r) => r.j).reverse();
}

export async function findOrCreateConversation(tx: Tx, schema: SchemaCache, userProfileId: string, celebrityId: string): Promise<string> {
  // Serialise concurrent "first message" requests for the same pair so only one conversation is created.
  await tx`select pg_advisory_xact_lock(hashtext(${`conv:${userProfileId}:${celebrityId}`}))`;
  const existing = await tx<{ id: string }[]>`
    select id::text from public.conversations where user_id = ${userProfileId} and celebrity_id = ${celebrityId} limit 1`;
  if (existing[0]) return existing[0].id;
  const created = await insertRow(tx, schema, 'conversations', {
    user_id: userProfileId,
    celebrity_id: celebrityId,
    unread_count_user: 0,
    unread_count_celebrity: 0,
    message_count: 0,
    is_closed: false,
    last_message_at: new Date().toISOString(),
  });
  if (!created?.id) throw new Error('conversation could not be created');
  return String(created.id);
}

export interface NewMessage {
  conversationId: string;
  senderId: string;
  senderType: 'user' | 'celebrity';
  text: string;
  aiGenerated: boolean;
}

/** Inserts a message and bumps the conversation (last message time, the other side's unread count). */
export async function postMessage(tx: Tx, schema: SchemaCache, m: NewMessage): Promise<Record<string, unknown>> {
  const row = await insertRow(tx, schema, 'messages', {
    conversation_id: m.conversationId,
    sender_id: m.senderId,
    sender_type: m.senderType,
    message_text: m.text,
    is_read: false,
    is_ai_generated: m.aiGenerated,
    // Two messages posted in one transaction must not share now(): the app orders and pages by created_at.
    created_at: sql`clock_timestamp()`,
  });
  const unread = m.senderType === 'user' ? 'unread_count_celebrity' : 'unread_count_user';
  await updateRows(tx, schema, 'conversations', { id: m.conversationId }, {
    last_message_at: sql`now()`,
    last_message_text: m.text.slice(0, 200),
    [unread]: sql`coalesce(${ident(unread)}, 0) + 1`,
  });
  if (!row) throw new Error('message could not be written');
  return row;
}
