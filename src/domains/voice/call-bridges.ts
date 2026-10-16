/**
 * The two engines that can hold a phone conversation (ported from production functions/vobiz-call/{gemini,sarvam}.ts):
 *
 *   person's voice ──(mu-law 8 kHz → PCM 16 kHz)──► engine
 *   person's ear   ◄──(PCM 24 kHz → mu-law 8 kHz)── engine
 *
 * Gemini Live hears, thinks and speaks in one session; Sarvam chains speech-to-text, a chat model and
 * text-to-speech (./sarvam-conversation.ts). Both use the same two tools: report_outcome and end_call.
 */
import type WebSocket from 'ws';
import type { Logger } from '../../lib/logger.js';
import type { GeminiLive } from '../../vendors/gemini-live.js';
import { toChatTools, type SarvamApi } from '../../vendors/sarvam.js';
import { PhoneEncoder, phoneToEngine } from './call-audio.js';
import { CALL_TOOLS, callSystemPrompt, openingLine, type CallBrief } from './call-prompt.js';
import { SarvamConversation } from './sarvam-conversation.js';

export interface BridgeEvents {
  /** mu-law 8 kHz for the phone, and how long it plays. */
  onSpeak(mulawB64: string, ms: number): void;
  onClearAudio(): void;
  onLine(role: 'assistant' | 'user', text: string): void;
  onOutcome(args: Record<string, unknown>): void;
  onWantsToHangUp(): void;
  onEnded(reason: string): void;
}

export interface InboundFormat {
  encoding: string;
  sampleRate: number;
}

export interface CallBridge {
  start(): Promise<void>;
  greet(): void;
  setInboundFormat(f: InboundFormat): void;
  onPhoneAudio(b64: string): void;
  /** An instruction the other person does not hear (e.g. "time is almost up"). */
  say(text: string): void;
  close(): void;
}

export class GeminiCallBridge implements CallBridge {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private queue: string[] = [];
  private inbound: InboundFormat = { encoding: 'audio/x-mulaw', sampleRate: 8000 };
  private userBuf = '';
  private aiBuf = '';
  private encoders = new Map<number, PhoneEncoder>();

  constructor(
    private readonly live: GeminiLive,
    private readonly brief: CallBrief,
    private readonly voice: string,
    private readonly ev: BridgeEvents,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.live.connect();
      this.ws = ws;
      const giveUp = setTimeout(() => reject(new Error('Gemini did not answer in time')), 12_000);
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            setup: {
              model: `models/${this.live.model}`,
              generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } } },
              systemInstruction: { parts: [{ text: callSystemPrompt(this.brief) }] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              // A phone line has no echo cancellation and plenty of hiss: only clear speech starts a turn.
              realtimeInputConfig: {
                automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', prefixPaddingMs: 60, silenceDurationMs: 400 },
              },
              tools: [{ functionDeclarations: CALL_TOOLS }],
            },
          }),
        );
      });
      ws.on('message', (data) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (msg.setupComplete) {
          clearTimeout(giveUp);
          this.ready = true;
          for (const a of this.queue.splice(0)) this.sendAudio(a);
          resolve();
          return;
        }
        this.onMessage(msg);
      });
      ws.on('error', () => {
        clearTimeout(giveUp);
        if (!this.ready) reject(new Error('Could not reach Gemini'));
      });
      ws.on('close', () => {
        clearTimeout(giveUp);
        if (!this.ready) reject(new Error('Gemini closed the connection during setup'));
        else if (!this.closed) this.ev.onEnded('assistant-ended-call');
      });
    });
  }

  setInboundFormat(f: InboundFormat): void {
    this.inbound = f;
  }

  greet(): void {
    this.say(`The call has just connected. Say this opening line now, word for word, then wait for the reply: "${openingLine(this.brief)}"`);
  }

  onPhoneAudio(b64: string): void {
    if (this.closed) return;
    const converted = phoneToEngine(b64, this.inbound.encoding, this.inbound.sampleRate);
    if (!this.ready) {
      if (this.queue.length < 400) this.queue.push(converted);
      return;
    }
    this.sendAudio(converted);
  }

  say(text: string): void {
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushUser();
    this.flushAi();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  private sendAudio(data: string): void {
    this.send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } });
  }

  private send(payload: unknown): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private onMessage(msg: Record<string, unknown>): void {
    const toolCall = msg.toolCall as { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> } | undefined;
    for (const fc of toolCall?.functionCalls ?? []) {
      if (fc.name === 'report_outcome') this.ev.onOutcome(fc.args ?? {});
      else if (fc.name === 'end_call') this.ev.onWantsToHangUp();
      this.send({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { ok: true } }] } });
    }
    const sc = msg.serverContent as
      | {
          inputTranscription?: { text?: string };
          outputTranscription?: { text?: string };
          interrupted?: boolean;
          turnComplete?: boolean;
          modelTurn?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
        }
      | undefined;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      this.flushAi();
      this.userBuf += sc.inputTranscription.text;
    }
    if (sc.outputTranscription?.text) {
      this.flushUser();
      this.aiBuf += sc.outputTranscription.text;
    }
    if (sc.interrupted) {
      this.ev.onClearAudio();
      this.flushAi();
      for (const e of this.encoders.values()) e.reset();
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (!data) continue;
      const mime = part.inlineData?.mimeType ?? '';
      const rate = mime.includes('16000') ? 16_000 : mime.includes('8000') ? 8000 : 24_000;
      let enc = this.encoders.get(rate);
      if (!enc) this.encoders.set(rate, (enc = new PhoneEncoder(rate)));
      const { payload, ms } = enc.encode(data);
      this.ev.onSpeak(payload, ms);
    }
    if (sc.turnComplete) {
      this.flushUser();
      this.flushAi();
    }
  }

  private flushUser(): void {
    if (this.userBuf.trim()) this.ev.onLine('user', this.userBuf.trim());
    this.userBuf = '';
  }

  private flushAi(): void {
    if (this.aiBuf.trim()) this.ev.onLine('assistant', this.aiBuf.trim());
    this.aiBuf = '';
  }
}

export class SarvamCallBridge implements CallBridge {
  private conv: SarvamConversation;
  private encoder = new PhoneEncoder(24_000);
  private inbound: InboundFormat = { encoding: 'audio/x-mulaw', sampleRate: 8000 };
  private aiBuf = '';
  private closed = false;

  constructor(
    api: SarvamApi,
    private readonly brief: CallBrief,
    speaker: string,
    private readonly ev: BridgeEvents,
    log: Logger,
  ) {
    const lang = brief.language === 'english' ? 'en-IN' : 'hi-IN';
    this.conv = new SarvamConversation(
      api,
      {
        system: callSystemPrompt(brief),
        tools: toChatTools(CALL_TOOLS),
        speaker,
        ttsLang: lang,
        languagePinned: true,
        sttLanguage: brief.language === 'english' ? 'en-IN' : brief.language === 'hindi' ? 'hi-IN' : 'auto',
        maxTokens: 300,
        maxToolHops: 3,
        maxContextMessages: 40,
        maxTurns: 120,
        maxTtsChars: 30_000,
      },
      {
        onAudio: (b64) => {
          const { payload, ms } = this.encoder.encode(b64);
          if (payload) this.ev.onSpeak(payload, ms);
        },
        onTranscript: (role, text, final) => {
          if (role === 'user') {
            if (final) this.ev.onLine('user', text);
          } else if (final) {
            this.ev.onLine('assistant', text);
          } else {
            this.aiBuf += text;
          }
        },
        onVad: () => {},
        onInterrupted: () => {
          this.flushAi();
          this.encoder.reset();
          this.ev.onClearAudio();
        },
        onTurnComplete: () => this.flushAi(),
        onMetrics: () => {},
        onError: (_m, fatal) => {
          if (fatal && !this.closed) this.ev.onEnded('engine-error-sarvam');
        },
        runTools: async (calls) =>
          calls.map((c) => {
            if (c.name === 'report_outcome') this.ev.onOutcome(c.args);
            else if (c.name === 'end_call') this.ev.onWantsToHangUp();
            return { ok: true };
          }),
      },
      log,
    );
  }

  async start(): Promise<void> {
    this.conv.start();
  }

  greet(): void {
    this.conv.speakAssistantLine(openingLine(this.brief));
  }

  setInboundFormat(f: InboundFormat): void {
    this.inbound = f;
  }

  onPhoneAudio(b64: string): void {
    if (!this.closed) this.conv.sendAudio(phoneToEngine(b64, this.inbound.encoding, this.inbound.sampleRate));
  }

  say(text: string): void {
    this.conv.instruct(text);
  }

  private flushAi(): void {
    if (this.aiBuf.trim()) this.ev.onLine('assistant', this.aiBuf.trim());
    this.aiBuf = '';
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flushAi();
    this.conv.close();
  }
}
