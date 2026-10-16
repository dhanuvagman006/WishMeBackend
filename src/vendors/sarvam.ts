/**
 * Sarvam AI: real-time speech-to-text, streaming text-to-speech and streaming chat completions. Used by the
 * sarvam-voice relay (the app's assistant) and by the phone-call bridge (AI calls through Vobiz).
 *
 * Protocols are the ones the production edge functions use (supabase audit 2026-10-16, functions/sarvam-voice and
 * functions/vobiz-call/sarvam.ts):
 *  - STT  wss://api.sarvam.ai/speech-to-text-realtime/ws?model=saaras:v3-realtime&sample_rate=16000&encoding=linear16
 *         &stream_type=fast&endpointing=vad&silence_duration_ms=400&language_code=<code|auto>[&prompt=…]
 *         header api-subscription-key. In: {"event":"audio_input","audio":<b64 PCM16 16 kHz>},
 *         {"event":"config.update","prompt"}. Out: {"event":"vad.speech_start"|"vad.speech_end"},
 *         {"event":"transcript.partial"|"transcript.final","text","language_code"}, {"event":"error","message","is_fatal"}.
 *  - TTS  wss://api.sarvam.ai/text-to-speech/ws?model=<model>&send_completion_event=true, header Api-Subscription-Key.
 *         First {"type":"config","data":{language_code, speaker, pace, speech_sample_rate:"24000",
 *         output_audio_codec:"linear16", min_buffer_size, max_chunk_length}}, then {"type":"text","data":{"text"}} +
 *         {"type":"flush"} per sentence, {"type":"ping"} to keep it open. Out: {"type":"audio","data":{"audio"}} (PCM16
 *         24 kHz), {"type":"event"} once per flushed sentence, {"type":"error","data":{"message"}}.
 *  - Chat POST https://api.sarvam.ai/v1/chat/completions (OpenAI-style, stream: true, server-sent events).
 *
 * Streaming responses cannot go through lib/http.ts (vendorFetch buffers the whole body), so `chatStream` gives the
 * same guarantees itself: a timeout, a caller abort, status-only logs, and an AppError on failure. Logs never carry
 * audio, text or keys.
 */
import WebSocket from 'ws';
import type { Env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

const STT_URL =
  'wss://api.sarvam.ai/speech-to-text-realtime/ws?model=saaras:v3-realtime&sample_rate=16000&encoding=linear16&stream_type=fast&endpointing=vad&silence_duration_ms=400';
const TTS_BASE = 'wss://api.sarvam.ai/text-to-speech/ws';
const CHAT_URL = 'https://api.sarvam.ai/v1/chat/completions';

/** Production defaults (SARVAM_LLM_MODEL in the old functions). */
export const SARVAM_CHAT_MODEL = 'sarvam-105b-conversations';
export const SARVAM_TTS_MODEL = 'bulbul:v3';
/** Languages Sarvam can speak (the relay's TTS_LANGS). */
export const SARVAM_TTS_LANGS: ReadonlySet<string> = new Set(['bn-IN', 'en-IN', 'gu-IN', 'hi-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN', 'ta-IN', 'te-IN']);

export interface SttEvents {
  onSpeechStart(): void;
  onSpeechEnd(): void;
  onPartial(text: string): void;
  onFinal(text: string, languageCode: string): void;
  onError(message: string, fatal: boolean): void;
  onOpen(): void;
  onClose(): void;
}

export interface SttStream {
  /** base64 PCM16 mono 16 kHz. Frames sent before the socket opens are queued (bounded). */
  sendAudio(b64: string): void;
  updatePrompt(prompt: string): void;
  close(): void;
}

export interface TtsEvents {
  onOpen(): void;
  /** base64 PCM16 mono 24 kHz. */
  onAudio(b64: string): void;
  /** One per flushed sentence. */
  onSentenceDone(): void;
  onError(message: string): void;
  onClose(): void;
}

export interface TtsStream {
  readonly open: boolean;
  /** Speaks one sentence (text + flush). */
  sentence(text: string): void;
  ping(): void;
  close(): void;
}

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs: string;
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatStreamRequest {
  messages: ChatMessage[];
  tools: ChatTool[];
  toolChoice?: 'auto' | 'none';
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high' | null;
  signal: AbortSignal;
  /** Each content delta, as it arrives. */
  onDelta(text: string): void;
}

/** The voice code depends on this interface, so tests substitute a fake. */
export interface SarvamApi {
  readonly configured: boolean;
  openStt(opts: { languageCode: string; prompt?: string }, ev: SttEvents): SttStream;
  openTts(opts: { languageCode: string; speaker: string; model?: string }, ev: TtsEvents): TtsStream;
  chatStream(req: ChatStreamRequest): Promise<{ content: string; toolCalls: ChatToolCall[] }>;
}

/** Gemini-style declarations (type: 'STRING') → OpenAI-style tools (type: 'string'). */
export function toChatTools(decls: unknown[]): ChatTool[] {
  const lower = (s: unknown): unknown =>
    Array.isArray(s)
      ? s.map(lower)
      : s && typeof s === 'object'
        ? Object.fromEntries(Object.entries(s as Record<string, unknown>).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : lower(v)]))
        : s;
  const out: ChatTool[] = [];
  for (const d of decls) {
    if (!d || typeof d !== 'object') continue;
    const f = d as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof f.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(f.name)) continue;
    out.push({
      type: 'function',
      function: {
        name: f.name,
        description: typeof f.description === 'string' ? f.description.slice(0, 2000) : '',
        parameters: f.parameters && typeof f.parameters === 'object' ? (lower(f.parameters) as Record<string, unknown>) : { type: 'object', properties: {} },
      },
    });
  }
  return out;
}

export class Sarvam implements SarvamApi {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!this.env.SARVAM_API_KEY;
  }

  private key(): string {
    if (!this.env.SARVAM_API_KEY) throw unavailable('Voice service is not configured.');
    return this.env.SARVAM_API_KEY;
  }

  openStt(opts: { languageCode: string; prompt?: string }, ev: SttEvents): SttStream {
    const url = `${STT_URL}&language_code=${encodeURIComponent(opts.languageCode)}${opts.prompt ? `&prompt=${encodeURIComponent(opts.prompt.slice(0, 600))}` : ''}`;
    const ws = new WebSocket(url, { headers: { 'api-subscription-key': this.key() }, handshakeTimeout: 8000, maxPayload: 1024 * 1024 });
    const queue: string[] = [];
    const started = Date.now();
    ws.on('open', () => {
      this.log.info({ vendor: 'sarvam', stream: 'stt', ms: Date.now() - started }, 'vendor stream open');
      for (const f of queue.splice(0)) ws.send(f);
      ev.onOpen();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let j: { event?: string; text?: unknown; language_code?: unknown; message?: unknown; is_fatal?: unknown };
      try {
        j = JSON.parse(String(data)) as typeof j;
      } catch {
        return;
      }
      switch (j.event) {
        case 'vad.speech_start':
          ev.onSpeechStart();
          break;
        case 'vad.speech_end':
          ev.onSpeechEnd();
          break;
        case 'transcript.partial':
          if (typeof j.text === 'string' && j.text) ev.onPartial(j.text);
          break;
        case 'transcript.final':
          if (typeof j.text === 'string') ev.onFinal(j.text, typeof j.language_code === 'string' ? j.language_code : '');
          break;
        case 'error':
          this.log.warn({ vendor: 'sarvam', stream: 'stt', fatal: !!j.is_fatal }, 'vendor stream error frame');
          ev.onError('Speech recognition error.', !!j.is_fatal);
          break;
      }
    });
    ws.on('error', (e) => this.log.warn({ vendor: 'sarvam', stream: 'stt', err: e.message }, 'vendor stream error'));
    ws.on('close', (code) => {
      this.log.info({ vendor: 'sarvam', stream: 'stt', code, ms: Date.now() - started }, 'vendor stream closed');
      ev.onClose();
    });
    return {
      sendAudio: (b64) => {
        if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return;
        const frame = `{"event":"audio_input","audio":"${b64}"}`;
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
        else if (ws.readyState === WebSocket.CONNECTING && queue.length < 100) queue.push(frame);
      },
      updatePrompt: (prompt) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'config.update', prompt: prompt.slice(0, 600) }));
      },
      close: () => {
        try {
          ws.close(1000);
        } catch {
          ws.terminate();
        }
      },
    };
  }

  openTts(opts: { languageCode: string; speaker: string; model?: string }, ev: TtsEvents): TtsStream {
    const model = opts.model ?? SARVAM_TTS_MODEL;
    const ws = new WebSocket(`${TTS_BASE}?model=${encodeURIComponent(model)}&send_completion_event=true`, {
      headers: { 'Api-Subscription-Key': this.key() },
      handshakeTimeout: 8000,
      maxPayload: 8 * 1024 * 1024,
    });
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'config',
          data: {
            model,
            language_code: opts.languageCode,
            speaker: opts.speaker,
            pace: 1.0,
            speech_sample_rate: '24000',
            output_audio_codec: 'linear16',
            min_buffer_size: 30,
            max_chunk_length: 120,
          },
        }),
      );
      ev.onOpen();
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let j: { type?: string; data?: { audio?: unknown; message?: unknown } };
      try {
        j = JSON.parse(String(data)) as typeof j;
      } catch {
        return;
      }
      if (j.type === 'event') ev.onSentenceDone();
      else if (j.type === 'audio' && typeof j.data?.audio === 'string') ev.onAudio(j.data.audio);
      else if (j.type === 'error') {
        this.log.warn({ vendor: 'sarvam', stream: 'tts' }, 'vendor stream error frame');
        ev.onError('Speech synthesis error.');
      }
    });
    ws.on('error', (e) => this.log.warn({ vendor: 'sarvam', stream: 'tts', err: e.message }, 'vendor stream error'));
    ws.on('close', () => ev.onClose());
    return {
      get open() {
        return ws.readyState === WebSocket.OPEN;
      },
      sentence: (text) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'text', data: { text } }));
        ws.send('{"type":"flush"}');
      },
      ping: () => {
        if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
      },
      close: () => {
        try {
          ws.close(1000);
        } catch {
          ws.terminate();
        }
      },
    };
  }

  async chatStream(req: ChatStreamRequest): Promise<{ content: string; toolCalls: ChatToolCall[] }> {
    const key = this.key();
    const started = Date.now();
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]);
    const body = {
      model: SARVAM_CHAT_MODEL,
      messages: req.messages,
      ...(req.tools.length ? { tools: req.tools, tool_choice: req.toolChoice ?? 'auto' } : {}),
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens,
      ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      stream: true,
    };
    let res: Response;
    try {
      res = await fetch(CHAT_URL, {
        method: 'POST',
        signal,
        headers: { 'api-subscription-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (req.signal.aborted) throw e;
      this.log.warn({ vendor: 'sarvam', op: 'chat', ms: Date.now() - started, err: (e as Error).name }, 'vendor call error');
      throw new AppError(504, 'vendor_unreachable', 'The assistant is not responding.');
    }
    this.log.info({ vendor: 'sarvam', op: 'chat', status: res.status, ms: Date.now() - started }, 'vendor call');
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new AppError(502, 'vendor_error', `sarvam request failed (${res.status})`, { vendor: 'sarvam', status: res.status });
    }
    let content = '';
    let inThink = false;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const decoder = new TextDecoder();
    let buffer = '';
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) throw new AppError(502, 'vendor_error', 'The assistant answer was too long.');
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j: { choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
        try {
          j = JSON.parse(payload) as typeof j;
        } catch {
          continue;
        }
        const d = j.choices?.[0]?.delta;
        if (!d) continue;
        if (d.content) {
          // A reasoning model may think out loud in <think>…</think>; that must never be spoken.
          let piece = d.content;
          let visible = '';
          while (piece) {
            if (inThink) {
              const end = piece.indexOf('</think>');
              if (end < 0) {
                piece = '';
              } else {
                inThink = false;
                piece = piece.slice(end + 8);
              }
            } else {
              const start = piece.indexOf('<think>');
              if (start < 0) {
                visible += piece;
                piece = '';
              } else {
                visible += piece.slice(0, start);
                inThink = true;
                piece = piece.slice(start + 7);
              }
            }
          }
          if (visible) {
            content += visible;
            req.onDelta(visible);
          }
        }
        for (const tc of d.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
      }
    }
    const toolCalls: ChatToolCall[] = [...calls.values()]
      .filter((c) => c.name)
      .map((c, i) => {
        let args: Record<string, unknown> = {};
        try {
          const parsed = c.args ? (JSON.parse(c.args) as unknown) : {};
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        } catch {
          /* the model wrote broken JSON: run the tool with no arguments */
        }
        return { id: c.id || `call_${started}_${i}`, name: c.name, args, rawArgs: JSON.stringify(args) };
      });
    return { content: content.trim(), toolCalls };
  }
}
