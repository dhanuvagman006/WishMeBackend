/**
 * Expo push notifications (https://docs.expo.dev/push-notifications/sending-notifications/). The app registers Expo
 * push tokens in public.push_tokens; Expo relays to FCM / APNs. No credentials are needed for the basic API.
 */
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts at most 100 messages per request. */
const BATCH = 100;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
}

export interface PushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

export class ExpoPush {
  constructor(private readonly log: Logger) {}

  /** Sends messages in batches; returns one ticket per message, in order. */
  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let i = 0; i < messages.length; i += BATCH) {
      const batch = messages.slice(i, i + BATCH);
      const { data } = await vendorFetch<{ data?: PushTicket[]; errors?: unknown[] }>(this.log, {
        vendor: 'expo-push',
        url: EXPO_PUSH_URL,
        headers: { accept: 'application/json', 'accept-encoding': 'gzip, deflate' },
        json: batch.map((m) => ({ sound: 'default', ...m })),
        timeoutMs: 15_000,
      });
      const got = data?.data ?? [];
      for (let j = 0; j < batch.length; j++) tickets.push(got[j] ?? { status: 'error', message: 'no ticket returned' });
    }
    return tickets;
  }
}
