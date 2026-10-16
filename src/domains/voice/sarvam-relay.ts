/**
 * The sarvam-voice relay: one WebSocket per assistant session between the app (services/sarvamLive/client.ts) and
 * Sarvam. Frame protocol (unchanged from the production relay):
 *
 *   app → relay  {type:'auth', token} · {type:'start', system, tools, voice, language, greeting?, history?}
 *                {type:'audio', data} (base64 PCM16 16 kHz) · {type:'text', text} · {type:'notify', text}
 *                {type:'set_language', language} · {type:'tool_result', id, result} · {type:'interrupt'}
 *                {type:'ping'} · {type:'end'}
 *   relay → app  {type:'ready'} · {type:'audio', data, g} (PCM16 24 kHz) · {type:'transcript', role, text, final}
 *                {type:'tool_call', id, name, args} · {type:'interrupted', g} · {type:'vad', event, speaking}
 *                {type:'turn_complete'} · {type:'goaway'} · {type:'metrics', …} · {type:'error', message}
 *
 * The app sends `auth` first (a pre-warmed "standby" socket may then wait, pinging every 25 s, for the user's tap) and
 * `start` right after. The upgrade itself carries no user token (the app's WebSocket sends no headers), so the
 * function is registered with access 'anon' and the user is authenticated from the auth frame here.
 *
 * Limits: 8 s to authenticate, 15 minutes of standby, 90 s without any frame, 30 minutes per session (with a goaway
 * 30 s before so the app moves to a fresh session), inbound audio and synthesised text capped per session, and a cap
 * on sessions started per user. On SIGTERM every session gets a goaway and is closed with 1012 (service restart).
 */
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { AuthContext } from '../../auth/context.js';
import type { Deps } from '../../deps.js';
import { isAppError } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';
import { Sarvam, SARVAM_TTS_LANGS, toChatTools, type ChatToolCall, type SarvamApi } from '../../vendors/sarvam.js';
import { SarvamConversation } from './sarvam-conversation.js';

export const sarvamOf = (deps: Deps): SarvamApi => deps.memo('sarvam', () => new Sarvam(deps.env, deps.log));

export const RELAY_LIMITS = {
  authMs: 8000,
  standbyMs: 15 * 60_000,
  idleMs: 90_000,
  sessionMs: 30 * 60_000,
  goawayBeforeMs: 30_000,
  /** ~30 minutes of 16 kHz PCM16, as base64 characters. */
  maxAudioChars: 80 * 1024 * 1024,
  toolTimeoutMs: 25_000,
  sessionsPerUser: { limit: 30, windowSec: 600 },
};

const BASE_HINT =
  'WishMe app voice commands: tap, press, click, scroll, open, go back, call, wallet, flights, hotels, bus tickets, electricity bill, recharge, Fetch Bill, Continue. Apps: WhatsApp, YouTube, Instagram, Facebook, Flipkart, Paytm, PhonePe, Google Pay, Gmail, Maps, Camera.';

const startSchema = z.object({
  type: z.literal('start'),
  system: z.string().max(60_000).default(''),
  tools: z.array(z.unknown()).max(64).default([]),
  voice: z.string().max(40).optional(),
  language: z.string().max(20).optional(),
  greeting: z.string().max(500).optional(),
  history: z
    .array(z.object({ role: z.string().max(20), text: z.string().max(4000) }).passthrough())
    .max(40)
    .optional(),
});

/** Every live relay on this process, so a shutdown can tell each app to move on. */
const live = new Set<RelaySession>();
let shutdownHooked = false;
function hookShutdown(): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  process.once('SIGTERM', () => {
    for (const s of [...live]) s.goaway(1012, 'Server restarting');
  });
}

export function liveRelayCount(): number {
  return live.size;
}

export class RelaySession {
  private userId: string | null;
  private authPromise: Promise<boolean> | null = null;
  private conv: SarvamConversation | null = null;
  private started = false;
  private closed = false;
  private timers: NodeJS.Timeout[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private audioChars = 0;
  private pendingTools = new Map<string, (r: unknown) => void>();
  private screenTerms: string[] = [];
  private readonly log: Logger;

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: Deps,
    auth: AuthContext,
    log: Logger,
  ) {
    this.log = log;
    this.userId = auth.kind === 'user' ? auth.userId : null;
    if (this.userId) this.authPromise = Promise.resolve(true);
    live.add(this);
    hookShutdown();
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.onFrame(String(data)).catch((e: unknown) => {
        this.log.warn({ err: (e as Error).message }, 'voice relay frame failed');
        this.fail('Relay error. Please try again.');
      });
    });
    socket.on('close', () => this.close());
    socket.on('error', () => this.close());
    this.later(() => {
      if (!this.userId) this.fail('Authentication timed out.');
    }, RELAY_LIMITS.authMs);
    this.later(() => {
      if (!this.started) this.close(1000, 'Standby expired');
    }, RELAY_LIMITS.standbyMs);
    this.touch();
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(fn, ms);
    t.unref?.();
    this.timers.push(t);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(1000, 'Idle'), RELAY_LIMITS.idleMs);
    this.idleTimer.unref?.();
  }

  private send(msg: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private fail(message: string): void {
    this.send({ type: 'error', message });
    this.close(1000, 'Error');
  }

  goaway(code = 1000, reason = 'Session limit'): void {
    this.send({ type: 'goaway' });
    this.close(code, reason);
  }

  private async onFrame(raw: string): Promise<void> {
    if (this.closed) return;
    this.touch();
    let m: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      m = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (m.type === 'audio') {
      if (!this.userId || !this.conv) return;
      const data = typeof m.data === 'string' ? m.data : '';
      this.audioChars += data.length;
      if (this.audioChars > RELAY_LIMITS.maxAudioChars) return this.goaway();
      this.conv.sendAudio(data);
      return;
    }
    if (!this.userId) {
      if (m.type === 'auth') {
        this.authPromise = this.authenticate(m.token);
        if (!(await this.authPromise)) return this.fail('Unauthorized');
        return;
      }
      // The app sends auth and start back to back; frames that arrive while the login is checked wait for it.
      if (!this.authPromise || !(await this.authPromise)) return;
    }
    switch (m.type) {
      case 'start':
        await this.start(m);
        break;
      case 'tool_result': {
        const resolve = this.pendingTools.get(String(m.id));
        if (resolve) {
          this.pendingTools.delete(String(m.id));
          resolve(m.result ?? null);
        }
        break;
      }
      case 'text':
        if (typeof m.text === 'string') this.conv?.userText(m.text.slice(0, 2000), '');
        break;
      case 'notify':
        if (typeof m.text === 'string' && m.text.trim()) void this.conv?.notice(m.text);
        break;
      case 'set_language':
        if (typeof m.language === 'string' && SARVAM_TTS_LANGS.has(m.language)) this.conv?.switchLanguage(m.language, true);
        break;
      case 'interrupt':
        if (this.conv?.isSpeakingNow()) this.conv.interrupt();
        break;
      case 'end':
        this.close(1000, 'Ended');
        break;
      default:
        break; // 'ping' and anything unknown
    }
  }

  private async authenticate(token: unknown): Promise<boolean> {
    if (typeof token !== 'string' || !token || token.length > 4096) return false;
    try {
      const auth = await this.deps.resolver.resolve(token);
      if (auth.kind !== 'user' || !auth.userId) return false;
      await this.deps.limiter.hit('voice-relay', `u:${auth.userId}`, RELAY_LIMITS.sessionsPerUser, 'Too many voice sessions. Please wait a little.');
      this.userId = auth.userId;
      return true;
    } catch (e) {
      if (isAppError(e) && e.code === 'rate_limited') this.send({ type: 'error', message: e.message });
      return false;
    }
  }

  /** The Sarvam speaker: the app's choice when it is a plain speaker name, else the persona's voice gender. */
  private async speaker(requested: string | undefined): Promise<string> {
    const v = (requested ?? '').toLowerCase().trim();
    if (/^[a-z]{2,20}$/.test(v)) return v;
    // ASSUMPTION: the persona maps to Sarvam by gender (services/assistant/persona.ts sarvamSpeakerFor).
    const male = new Set(['puck', 'charon', 'fenrir', 'orus', 'iapetus', 'algieba']);
    const rows = await this.deps.db<{ voice: string }[]>`select voice from public.assistant_settings where user_id = ${this.userId!} limit 1`;
    return male.has((rows[0]?.voice ?? '').toLowerCase()) ? 'shubh' : 'ritu';
  }

  private async start(m: Record<string, unknown>): Promise<void> {
    if (this.started) return;
    const parsed = startSchema.safeParse(m);
    if (!parsed.success) return this.fail('Invalid session setup.');
    const api = sarvamOf(this.deps);
    if (!api.configured) return this.fail('Voice service is not configured.');
    this.started = true;
    const s = parsed.data;
    const fixed = ({ english: 'en-IN', hindi: 'hi-IN', hinglish: 'hi-IN' } as Record<string, string>)[(s.language ?? 'auto').toLowerCase()];
    const conv = new SarvamConversation(
      api,
      {
        system: s.system,
        tools: toChatTools(s.tools),
        speaker: await this.speaker(s.voice),
        ttsLang: fixed ?? 'en-IN',
        languagePinned: !!fixed,
        // Always auto: the user may switch language mid-conversation.
        sttLanguage: 'auto',
        sttPrompt: BASE_HINT,
        history: (s.history ?? []).map((h) => ({ role: h.role === 'assistant' ? ('assistant' as const) : ('user' as const), text: h.text })),
        maxTokens: 1600,
        maxToolHops: 6,
        maxContextMessages: 14,
        maxTurns: 400,
        maxTtsChars: 120_000,
      },
      {
        onAudio: (data, g) => this.send({ type: 'audio', data, g }),
        onTranscript: (role, text, final) => this.send({ type: 'transcript', role, text, final }),
        onVad: (event, speaking) => this.send({ type: 'vad', event, ...(event === 'start' ? { speaking } : {}) }),
        onInterrupted: (g) => {
          for (const resolve of this.pendingTools.values()) resolve({ ok: false, error: 'Interrupted by the user.' });
          this.pendingTools.clear();
          this.send({ type: 'interrupted', g });
        },
        onTurnComplete: () => this.send({ type: 'turn_complete' }),
        onMetrics: (metrics) => this.send({ type: 'metrics', ...metrics }),
        onError: (message, fatal) => (fatal ? this.fail(message) : this.send({ type: 'error', message })),
        runTools: (calls) => Promise.all(calls.map((c) => this.runToolOnPhone(c))),
      },
      this.log,
    );
    this.conv = conv;
    conv.start();
    this.send({ type: 'ready' });
    if (s.greeting) conv.speakAssistantLine(s.greeting);
    this.later(() => this.send({ type: 'goaway' }), RELAY_LIMITS.sessionMs - RELAY_LIMITS.goawayBeforeMs);
    this.later(() => this.close(1000, 'Session limit'), RELAY_LIMITS.sessionMs);
  }

  private runToolOnPhone(call: ChatToolCall): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingTools.delete(call.id);
        resolve({ ok: false, error: 'That took too long and was stopped.' });
      }, RELAY_LIMITS.toolTimeoutMs);
      timer.unref?.();
      this.pendingTools.set(call.id, (r) => {
        clearTimeout(timer);
        this.learnScreen(r);
        resolve(r);
      });
      this.send({ type: 'tool_call', id: call.id, name: call.name, args: call.args });
    });
  }

  /** Button and field labels from a screen tool's result help the recogniser hear them. */
  private learnScreen(result: unknown): void {
    const r = result as { screen?: { controls?: unknown[] }; controls?: unknown[]; elements?: Array<{ label?: unknown }> } | null;
    if (!r || typeof r !== 'object') return;
    const raw: string[] = [];
    for (const c of r.screen?.controls ?? r.controls ?? []) if (typeof c === 'string') raw.push(c);
    for (const e of Array.isArray(r.elements) ? r.elements : []) if (e && typeof e.label === 'string') raw.push(e.label);
    const terms: string[] = [];
    for (const label of raw) {
      const t = label.replace(/^\d+:\s*/, '').replace(/\s*\[[^\]]*\]\s*$/, '').replace(/…$/, '').trim();
      if (t.length >= 2 && t.length <= 36 && !/unlabelled/i.test(t) && !terms.includes(t)) terms.push(t);
      if (terms.length >= 24) break;
    }
    if (!terms.length || terms.join('|') === this.screenTerms.join('|')) return;
    this.screenTerms = terms;
    this.conv?.updateSttPrompt(`${BASE_HINT} On the screen now: ${terms.join(', ')}.`.slice(0, 600));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    live.delete(this);
    for (const t of this.timers) clearTimeout(t);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const resolve of this.pendingTools.values()) resolve({ ok: false, error: 'Session ended.' });
    this.pendingTools.clear();
    this.conv?.close();
    try {
      if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }
}
