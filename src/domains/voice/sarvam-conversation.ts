/**
 * One spoken conversation on Sarvam: live speech-to-text → streaming chat model (with tools) → streaming
 * text-to-speech. Shared by the app's voice assistant relay (sarvam-voice) and the phone-call bridge (AI calls).
 *
 * Behaviour ported from the production relay (supabase audit, functions/sarvam-voice):
 *  - every reply has a generation number; an interruption bumps it, aborts the model, drops the speech socket (Sarvam
 *    cannot cancel synthesis in flight) and discards anything older;
 *  - each finished sentence is spoken the moment the model writes it, so the voice starts early;
 *  - a user who pauses mid-sentence before anything was said gets one merged request, not two answers;
 *  - the voice follows the language the user speaks unless one was pinned;
 *  - only the recent part of the conversation is sent to the model, with old tool results trimmed.
 * Added here: hard caps on model turns and on synthesised characters per conversation.
 */
import type { Logger } from '../../lib/logger.js';
import { SARVAM_TTS_LANGS, type ChatMessage, type ChatTool, type ChatToolCall, type SarvamApi, type SttStream, type TtsStream } from '../../vendors/sarvam.js';

export interface ConversationEvents {
  /** base64 PCM16 24 kHz for reply generation `gen`. */
  onAudio(b64: string, gen: number): void;
  onTranscript(role: 'user' | 'assistant', text: string, final: boolean): void;
  onVad(event: 'start' | 'end', speakingNow: boolean): void;
  onInterrupted(gen: number): void;
  onTurnComplete(): void;
  onMetrics(m: Record<string, number>): void;
  onError(message: string, fatal: boolean): void;
  /** Runs the model's tool calls; results in the same order. Interruptions resolve them early. */
  runTools(calls: ChatToolCall[], gen: number): Promise<unknown[]>;
}

export interface ConversationOptions {
  system: string;
  tools: ChatTool[];
  speaker: string;
  ttsModel?: string;
  /** Voice language at the start, e.g. 'en-IN'. */
  ttsLang: string;
  /** A pinned language is never overridden by what the recogniser detects. */
  languagePinned: boolean;
  /** 'auto' or a code such as 'hi-IN'. */
  sttLanguage: string;
  sttPrompt?: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  maxTokens: number;
  maxToolHops: number;
  maxContextMessages: number;
  /** Hard caps for one conversation (cost control). */
  maxTurns: number;
  maxTtsChars: number;
}

const TOOL_RESULT_CHARS_NOW = 4000;
const TOOL_RESULT_CHARS_OLD = 600;
const STILL_CHECKING_MS = 4500;
const SEARCH_FILLER: Record<string, string> = {
  'en-IN': 'One moment, let me check.',
  'hi-IN': 'एक मिनट, अभी देखते हैं।',
};
const SEARCH_FILLER_MORE: Record<string, string> = { 'en-IN': 'Let me look a little further.', 'hi-IN': 'थोड़ा और देखते हैं।' };
const SEARCH_STILL: Record<string, string> = { 'en-IN': 'Still checking, nearly there.', 'hi-IN': 'अभी भी देख रहे हैं, बस थोड़ा और।' };

/** The language a sentence is written in, by script (the recogniser tags much Indian-accented English as Hindi). */
export function languageOfSpeech(text: string, reported: string): string {
  const scripts: Array<[RegExp, string]> = [
    [/[ঀ-৿]/, 'bn-IN'],
    [/[਀-੿]/, 'pa-IN'],
    [/[઀-૿]/, 'gu-IN'],
    [/[଀-୿]/, 'od-IN'],
    [/[஀-௿]/, 'ta-IN'],
    [/[ఀ-౿]/, 'te-IN'],
    [/[ಀ-೿]/, 'kn-IN'],
    [/[ഀ-ൿ]/, 'ml-IN'],
  ];
  for (const [re, code] of scripts) if (re.test(text)) return code;
  if (/[ऀ-ॿ]/.test(text)) return reported === 'mr-IN' ? 'mr-IN' : 'hi-IN';
  if (/[A-Za-z]/.test(text)) return 'en-IN';
  return SARVAM_TTS_LANGS.has(reported) ? reported : '';
}

/** Long digit runs are read one digit at a time (a phone number must not be read as one big number). */
export function spellNumbers(text: string): string {
  return text.replace(/\+?\d[\d\s-]{6,}\d/g, (m) => m.replace(/\D/g, '').split('').join(' '));
}

export class SarvamConversation {
  private stt: SttStream | null = null;
  private sttFailures = 0;
  private tts: TtsStream | null = null;
  private ttsReady: Promise<void> | null = null;
  private ttsLang: string;
  private languagePinned: boolean;
  private detectedLang = '';
  private messages: ChatMessage[];
  private gen = 0;
  private abort: AbortController | null = null;
  private playUntil = 0;
  private turnVisible = false;
  private inflight = 0;
  private turnT0 = 0;
  private firstAudioSent = false;
  private searchesThisTurn = 0;
  private pinger: NodeJS.Timeout | null = null;
  private turns = 0;
  private ttsChars = 0;
  private closed = false;
  private sttPrompt: string | undefined;

  constructor(
    private readonly api: SarvamApi,
    private readonly opts: ConversationOptions,
    private readonly ev: ConversationEvents,
    private readonly log: Logger,
  ) {
    this.ttsLang = opts.ttsLang;
    this.languagePinned = opts.languagePinned;
    this.sttPrompt = opts.sttPrompt;
    this.messages = [{ role: 'system', content: opts.system }];
    for (const h of (opts.history ?? []).slice(-10)) {
      const text = h.text.trim().slice(0, 400);
      if (text) this.messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: text });
    }
  }

  get generation(): number {
    return this.gen;
  }

  get language(): string {
    return this.ttsLang;
  }

  start(): void {
    this.connectStt();
    void this.connectTts();
    // Sarvam closes an idle speech connection after about a minute; keep it open between replies.
    this.pinger = setInterval(() => this.tts?.ping(), 20_000);
    this.pinger.unref?.();
  }

  isSpeakingNow(): boolean {
    return this.abort !== null || this.inflight > 0 || Date.now() < this.playUntil;
  }

  // ── hearing ──────────────────────────────────────────────────────────────────────────────────────────────────

  sendAudio(b64: string): void {
    if (!this.closed) this.stt?.sendAudio(b64);
  }

  updateSttPrompt(prompt: string): void {
    this.sttPrompt = prompt;
    this.stt?.updatePrompt(prompt);
  }

  private connectStt(): void {
    if (this.closed) return;
    this.stt = this.api.openStt(
      { languageCode: this.opts.sttLanguage, ...(this.sttPrompt ? { prompt: this.sttPrompt } : {}) },
      {
        onOpen: () => {
          this.sttFailures = 0;
        },
        onSpeechStart: () => {
          const speaking = this.isSpeakingNow();
          this.ev.onVad('start', speaking);
          if (speaking) this.interrupt();
        },
        onSpeechEnd: () => this.ev.onVad('end', false),
        onPartial: (text) => this.ev.onTranscript('user', text, false),
        onFinal: (text, lang) => this.userText(text, lang),
        onError: (message, fatal) => this.ev.onError(message, fatal),
        onClose: () => {
          if (this.closed) return;
          this.sttFailures += 1;
          if (this.sttFailures >= 3) {
            this.ev.onError('Could not reach the speech recognition service. Please try again.', true);
            return;
          }
          const t = setTimeout(() => this.connectStt(), 300 * this.sttFailures);
          t.unref?.();
        },
      },
    );
  }

  // ── speaking ─────────────────────────────────────────────────────────────────────────────────────────────────

  private connectTts(): Promise<void> {
    if (this.closed) return Promise.resolve();
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => (resolveReady = r));
    const giveUp = setTimeout(() => resolveReady(), 5000);
    giveUp.unref?.();
    const stream = this.api.openTts(
      { languageCode: this.ttsLang, speaker: this.opts.speaker, ...(this.opts.ttsModel ? { model: this.opts.ttsModel } : {}) },
      {
        onOpen: () => {
          clearTimeout(giveUp);
          resolveReady();
        },
        onAudio: (b64) => {
          if (this.tts !== stream) return; // a reply the user already interrupted
          if (!this.firstAudioSent) {
            this.firstAudioSent = true;
            this.ev.onMetrics({ tts_first_audio_ms: Date.now() - this.turnT0 });
          }
          // 16-bit mono at 24 kHz is 48 bytes per millisecond.
          const ms = (b64.length * 3) / 4 / 48;
          this.playUntil = Math.max(Date.now(), this.playUntil) + ms;
          this.turnVisible = true;
          this.ev.onAudio(b64, this.gen);
        },
        onSentenceDone: () => {
          this.inflight = Math.max(0, this.inflight - 1);
        },
        onError: () => {
          if (this.tts === stream) {
            this.tts = null;
            this.ttsReady = null;
            stream.close();
          }
        },
        onClose: () => {
          clearTimeout(giveUp);
          resolveReady();
          if (this.tts === stream) {
            this.tts = null;
            this.ttsReady = null;
          }
        },
      },
    );
    this.tts = stream;
    this.ttsReady = ready;
    return ready;
  }

  private async speak(text: string, gen: number): Promise<void> {
    const clean = spellNumbers(text.replace(/[*_`#]/g, '').trim());
    if (!clean || this.closed) return;
    if (this.ttsChars + clean.length > this.opts.maxTtsChars) return;
    if (!this.tts) await this.connectTts();
    else await this.ttsReady;
    if (gen !== this.gen || !this.tts?.open) return;
    this.ttsChars += clean.length;
    this.inflight++;
    this.tts.sentence(clean);
  }

  /** Speaks an opening line and records it as the assistant's. */
  speakAssistantLine(text: string): void {
    const line = text.trim().slice(0, 500);
    if (!line) return;
    this.messages.push({ role: 'assistant', content: line });
    this.turnT0 = Date.now();
    this.firstAudioSent = false;
    this.turnVisible = true;
    this.ev.onTranscript('assistant', line, true);
    void this.speak(line, this.gen);
  }

  /** A short interim line (filler while a tool runs). */
  private say(text: string, gen: number): void {
    this.turnVisible = true;
    this.ev.onTranscript('assistant', text, false);
    void this.speak(text, gen);
  }

  switchLanguage(code: string, pinned = false): void {
    if (!SARVAM_TTS_LANGS.has(code)) return;
    if (pinned) this.languagePinned = true;
    if (code === this.ttsLang) return;
    this.ttsLang = code;
    // Synthesis language is fixed per connection: the next sentence opens a fresh one.
    const old = this.tts;
    this.tts = null;
    this.ttsReady = null;
    old?.close();
  }

  // ── the conversation ─────────────────────────────────────────────────────────────────────────────────────────

  interrupt(): void {
    this.gen++;
    this.abort?.abort();
    this.abort = null;
    this.playUntil = 0;
    this.turnVisible = false;
    this.inflight = 0;
    const old = this.tts;
    this.tts = null;
    this.ttsReady = null;
    old?.close();
    void this.connectTts();
    this.ev.onInterrupted(this.gen);
  }

  /** A finished utterance (or typed text). */
  userText(text: string, lang = ''): void {
    const spoken = text.trim().slice(0, 2000);
    if (spoken.length < 2 || this.closed) return;
    const heard = languageOfSpeech(spoken, lang);
    if (heard && SARVAM_TTS_LANGS.has(heard)) this.detectedLang = heard;
    let forModel = spoken;
    const last = this.messages[this.messages.length - 1];
    if (this.abort && !this.turnVisible && last?.role === 'user') {
      // The user paused mid-sentence before anything was said or done: answer both parts as one request.
      forModel = `${last.content} ${spoken}`.trim();
      this.messages.pop();
    } else if (this.isSpeakingNow()) {
      this.interrupt();
    }
    this.ev.onTranscript('user', spoken, true);
    this.messages.push({ role: 'user', content: forModel });
    void this.runTurn();
  }

  /** An app event the assistant should speak about once it has finished talking. */
  async notice(text: string): Promise<void> {
    for (let i = 0; i < 40 && this.isSpeakingNow() && !this.closed; i++) await new Promise((r) => setTimeout(r, 250));
    if (this.closed) return;
    this.messages.push({ role: 'user', content: `[Notice from the app, not spoken by the user] ${text.replace(/\s+/g, ' ').trim().slice(0, 1800)}` });
    void this.runTurn();
  }

  /** An instruction to the model that the other person did not say (phone calls: "time is almost up"). */
  instruct(text: string): void {
    this.messages.push({ role: 'user', content: `[Note to you, not spoken by the other person] ${text}` });
    void this.runTurn();
  }

  private modelMessages(): ChatMessage[] {
    const [system, ...rest] = this.messages;
    let recent = rest.length > this.opts.maxContextMessages ? rest.slice(-this.opts.maxContextMessages) : rest;
    // A window must open on something the model can follow: never on a tool result whose call was cut away.
    while (recent.length > 1 && recent[0]!.role !== 'user') recent = recent.slice(1);
    let lastUser = -1;
    recent.forEach((m, i) => {
      if (m.role === 'user') lastUser = i;
    });
    const capped = recent.map((m, i): ChatMessage => {
      if (m.role !== 'tool') return m;
      const max = i > lastUser ? TOOL_RESULT_CHARS_NOW : TOOL_RESULT_CHARS_OLD;
      return m.content.length > max ? { ...m, content: `${m.content.slice(0, max)}…` } : m;
    });
    return [system!, ...capped];
  }

  private async runTurn(): Promise<void> {
    if (this.closed) return;
    this.abort?.abort();
    const gen = ++this.gen;
    const abort = new AbortController();
    this.abort = abort;
    this.turnVisible = false;
    this.inflight = 0;
    this.turnT0 = Date.now();
    this.firstAudioSent = false;
    this.searchesThisTurn = 0;
    if (!this.languagePinned) {
      const want = this.detectedLang || this.ttsLang;
      if (want !== this.ttsLang) this.switchLanguage(want);
    }
    try {
      for (let hop = 0; hop < this.opts.maxToolHops; hop++) {
        if (++this.turns > this.opts.maxTurns) {
          this.ev.onError('This conversation has gone on for a long time. Please start a new one.', true);
          return;
        }
        const lastHop = hop === this.opts.maxToolHops - 1;
        const { content, toolCalls } = await this.streamReply(gen, abort.signal, lastHop);
        if (gen !== this.gen) return;
        this.messages.push({
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.rawArgs } })) } : {}),
        });
        if (!toolCalls.length) break;
        const searching = toolCalls.some((c) => c.name === 'web_search');
        let still: NodeJS.Timeout | null = null;
        if (searching) {
          this.searchesThisTurn += 1;
          const filler = this.searchesThisTurn === 1 ? (SEARCH_FILLER[this.ttsLang] ?? SEARCH_FILLER['en-IN']) : this.searchesThisTurn === 2 ? SEARCH_FILLER_MORE[this.ttsLang] : undefined;
          if (!content && filler) this.say(filler, gen);
          still = setTimeout(() => {
            const line = SEARCH_STILL[this.ttsLang];
            if (line && gen === this.gen && !this.closed) this.say(line, gen);
          }, STILL_CHECKING_MS);
        }
        this.turnVisible = true;
        const results = await this.ev.runTools(toolCalls, gen);
        if (still) clearTimeout(still);
        // Always record the results, so the conversation never ends on an unanswered tool call.
        toolCalls.forEach((c, i) => this.messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(results[i] ?? null) ?? 'null' }));
        if (gen !== this.gen) return;
      }
      if (gen !== this.gen) return;
      this.ev.onTurnComplete();
      this.ev.onMetrics({ turn_total_ms: Date.now() - this.turnT0 });
    } catch (e) {
      if (gen === this.gen && !abort.signal.aborted) {
        this.log.warn({ err: (e as Error).message }, 'sarvam turn failed');
        this.ev.onError('The assistant hit a problem. Please try again.', false);
      }
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private async streamReply(gen: number, signal: AbortSignal, lastHop: boolean): Promise<{ content: string; toolCalls: ChatToolCall[] }> {
    const t0 = Date.now();
    let content = '';
    let spoken = 0;
    let sawFirst = false;
    const speakReady = (final: boolean) => {
      let rest = content.slice(spoken);
      for (;;) {
        // The first piece may stop at the first comma after a few words, so the voice starts sooner.
        const m =
          rest.match(/^[\s\S]*?[.!?।\n]+(?=\s|$)/) ??
          (rest.length > 140 ? rest.match(/^[\s\S]{60,140}?[,;:](?=\s)/) : null) ??
          (spoken === 0 ? rest.match(/^[\s\S]{25,}?[,;:](?=\s)/) : null);
        if (!m) break;
        spoken += m[0].length;
        rest = content.slice(spoken);
        void this.speak(m[0], gen);
      }
      if (final && rest.trim()) {
        spoken = content.length;
        void this.speak(rest, gen);
      }
    };
    const out = await this.api.chatStream({
      messages: this.modelMessages(),
      tools: this.opts.tools,
      ...(this.opts.tools.length ? { toolChoice: lastHop ? ('none' as const) : ('auto' as const) } : {}),
      maxTokens: this.opts.maxTokens,
      reasoningEffort: 'low',
      signal,
      onDelta: (d) => {
        if (gen !== this.gen) return;
        if (!sawFirst) {
          sawFirst = true;
          this.ev.onMetrics({ llm_first_token_ms: Date.now() - t0 });
        }
        content += d;
        this.ev.onTranscript('assistant', d, false);
        speakReady(false);
      },
    });
    if (gen === this.gen) speakReady(true);
    return { content: out.content, toolCalls: out.toolCalls };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.gen++;
    this.abort?.abort();
    this.stt?.close();
    this.tts?.close();
    this.stt = null;
    this.tts = null;
  }
}
