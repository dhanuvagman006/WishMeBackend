/**
 * The two WebSocket paths with Sarvam faked (no vendor is reached):
 *  - sarvam-voice: the app's relay protocol (auth frame, start → ready, greeting, audio in, transcripts, tool calls
 *    round-tripped through the phone, audio out with generation numbers, interruption, end);
 *  - vobiz-stream: an AI phone call (mu-law in and out, the two call tools, lines saved live, the result written).
 */
import type WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callToken } from '../../src/domains/voice/ai-calls.js';
import type { ChatStreamRequest, ChatToolCall, SarvamApi, SttEvents, TtsEvents } from '../../src/vendors/sarvam.js';
import { bootTest, signUp, type TestCtx, type TestSession } from '../helpers.js';

type Step = (req: ChatStreamRequest) => { content: string; toolCalls: ChatToolCall[] };

class FakeSarvam implements SarvamApi {
  readonly configured = true;
  stt: SttEvents | null = null;
  sttAudio: string[] = [];
  spoken: string[] = [];
  ttsOpts: Array<{ languageCode: string; speaker: string }> = [];
  requests: ChatStreamRequest[] = [];
  script: Step[] = [];

  openStt(_o: { languageCode: string }, ev: SttEvents) {
    this.stt = ev;
    setImmediate(() => ev.onOpen());
    return { sendAudio: (b: string) => void this.sttAudio.push(b), updatePrompt: () => {}, close: () => {} };
  }

  openTts(o: { languageCode: string; speaker: string }, ev: TtsEvents) {
    this.ttsOpts.push(o);
    const stream = {
      open: true,
      sentence: (text: string) => {
        this.spoken.push(text);
        // One second of 24 kHz PCM16 per sentence.
        setImmediate(() => {
          ev.onAudio(Buffer.alloc(48_000).toString('base64'));
          ev.onSentenceDone();
        });
      },
      ping: () => {},
      close: () => {
        stream.open = false;
      },
    };
    setImmediate(() => ev.onOpen());
    return stream;
  }

  async chatStream(req: ChatStreamRequest) {
    this.requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) as ChatStreamRequest['messages'] });
    const out = (this.script.shift() ?? (() => ({ content: 'Okay.', toolCalls: [] })))(req);
    if (out.content) req.onDelta(out.content);
    return out;
  }
}

let t: TestCtx;
let alice: TestSession;
/** injectWS builds a request without a socket; the app reads the client address for rate limits. */
const openWS = (path: string) => t.app.injectWS(path, { socket: { remoteAddress: '127.0.0.1' } } as never);
const fake = new FakeSarvam();

function collect(ws: WebSocket) {
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (d) => {
    try {
      frames.push(JSON.parse(String(d)) as Record<string, unknown>);
    } catch {
      /* not JSON */
    }
  });
  const waitFor = async (pred: (f: Record<string, unknown>) => boolean, ms = 3000) => {
    const start = Date.now();
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) throw new Error(`timed out; frames: ${JSON.stringify(frames.map((f) => f.type ?? f.event))}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  return { frames, waitFor };
}

const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeAll(async () => {
  t = await bootTest({ env: { SARVAM_API_KEY: 'test-sarvam' } });
  // Seed (or overwrite) the memoised Sarvam client before any session starts.
  const inst = t.deps.memo('sarvam', () => fake) as unknown as Record<string, unknown>;
  if (inst !== (fake as unknown)) for (const k of ['openStt', 'openTts', 'chatStream'] as const) inst[k] = (fake[k] as (...a: unknown[]) => unknown).bind(fake);
  alice = await signUp(t, 'relay-alice@example.com', undefined, { first_name: 'Alice', phone: '9123400401' });
});
afterAll(async () => {
  await t.close();
});

describe('sarvam-voice relay', () => {
  it('refuses a bad login with an error frame', async () => {
    const ws = await openWS('/functions/v1/sarvam-voice?apikey=test-anon-key');
    const { waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: 'auth', token: 'not-a-token' }));
    expect(await waitFor((f) => f.type === 'error')).toEqual({ type: 'error', message: 'Unauthorized' });
    ws.terminate();
  });

  it('runs a session: greeting, speech in, a tool on the phone, the answer spoken, interruption, end', async () => {
    const ws = await openWS('/functions/v1/sarvam-voice?apikey=test-anon-key');
    const { frames, waitFor } = collect(ws);
    ws.send(JSON.stringify({ type: 'auth', token: alice.access_token }));
    ws.send(
      JSON.stringify({
        type: 'start',
        system: 'You are WishMe Assistant.',
        tools: [{ name: 'open_app', description: 'Open an app', parameters: { type: 'OBJECT', properties: { app_name: { type: 'STRING' } }, required: ['app_name'] } }],
        voice: 'ritu',
        language: 'english',
        greeting: 'Hi Alice, how can I help?',
        history: [{ role: 'user', text: 'earlier question' }],
      }),
    );
    await waitFor((f) => f.type === 'ready');
    expect(await waitFor((f) => f.type === 'transcript' && f.role === 'assistant' && f.final === true)).toMatchObject({ text: 'Hi Alice, how can I help?' });
    expect(await waitFor((f) => f.type === 'audio')).toMatchObject({ g: 0 });
    expect(fake.ttsOpts[0]).toMatchObject({ languageCode: 'en-IN', speaker: 'ritu' });

    ws.send(JSON.stringify({ type: 'audio', data: Buffer.alloc(640).toString('base64') }));
    await until(() => fake.sttAudio.length === 1);

    fake.script.push(
      () => ({ content: '', toolCalls: [{ id: 'call_1', name: 'open_app', args: { app_name: 'WhatsApp' }, rawArgs: '{"app_name":"WhatsApp"}' }] }),
      () => ({ content: 'Opening WhatsApp now.', toolCalls: [] }),
    );
    fake.stt!.onFinal('open whatsapp please', 'en-IN');
    expect(await waitFor((f) => f.type === 'transcript' && f.role === 'user' && f.final === true)).toMatchObject({ text: 'open whatsapp please' });
    const call = await waitFor((f) => f.type === 'tool_call');
    expect(call).toEqual({ type: 'tool_call', id: 'call_1', name: 'open_app', args: { app_name: 'WhatsApp' } });
    ws.send(JSON.stringify({ type: 'tool_result', id: 'call_1', result: { ok: true, opened: 'WhatsApp' } }));
    await waitFor((f) => f.type === 'turn_complete');
    expect(fake.spoken).toContain('Opening WhatsApp now.');
    // The model got the app's tools in chat form, and the phone's result before answering.
    expect(fake.requests[0]!.tools[0]).toEqual({ type: 'function', function: { name: 'open_app', description: 'Open an app', parameters: { type: 'object', properties: { app_name: { type: 'string' } }, required: ['app_name'] } } });
    expect(fake.requests[0]!.messages.slice(0, 2)).toEqual([{ role: 'system', content: 'You are WishMe Assistant.' }, { role: 'user', content: 'earlier question' }]);
    expect(fake.requests[1]!.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true,"opened":"WhatsApp"}' });

    // The user talks over the reply: the relay drops it and numbers the next one higher.
    ws.send(JSON.stringify({ type: 'interrupt' }));
    const interrupted = await waitFor((f) => f.type === 'interrupted');
    expect(Number(interrupted.g)).toBeGreaterThan(0);

    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    ws.send(JSON.stringify({ type: 'end' }));
    expect(await closed).toBe(1000);
    expect(frames.some((f) => f.type === 'error')).toBe(false);
  });
});

describe('vobiz-stream (AI phone call)', () => {
  it('bridges the phone to the engine, saves lines live and writes the result when the AI hangs up', async () => {
    await t.sql`insert into public.platform_settings (setting_key, setting_value) values ('ai_voice_engine', 'sarvam'), ('ai_voice_fallback', 'false')`;
    const [row] = await t.sql<{ id: string }[]>`
      insert into public.ai_calls (user_id, to_name, to_phone, purpose, status, started_at, vapi_call_id)
      values (${alice.user.id}, 'Ravi', '+919812345678', 'Ask for the electricity bill amount', 'in-progress', now(), 'vz-stream') returning id::text`;
    const id = row!.id;
    const forged = await openWS(`/functions/v1/vobiz-stream?apikey=test-anon-key&k=ai.${id}.${'0'.repeat(40)}`);
    const forgedClosed = new Promise<number>((r) => forged.on('close', (code) => r(code)));
    expect(await forgedClosed).toBe(4004);

    fake.script.length = 0;
    fake.script.push(() => ({
      content: 'Thank you, I will pass that on. Goodbye.',
      toolCalls: [
        { id: 'r1', name: 'report_outcome', args: { outcome: 'success', next_step: 'Pay 400 rupees by Friday' }, rawArgs: '{}' },
        { id: 'e1', name: 'end_call', args: {}, rawArgs: '{}' },
      ],
    }));
    const ws = await openWS(`/functions/v1/vobiz-stream?apikey=test-anon-key&k=ai.${id}.${callToken(t.deps, 'ai', id)}`);
    const { waitFor } = collect(ws);
    ws.send(JSON.stringify({ event: 'start', start: { streamId: 'stream-1', mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 } } }));
    const play = await waitFor((f) => f.event === 'playAudio');
    expect(play).toMatchObject({ streamId: 'stream-1', media: { contentType: 'audio/x-mulaw', sampleRate: 8000 } });
    // One second of 24 kHz speech becomes 8000 mu-law bytes.
    expect(Buffer.from(String((play.media as { payload: string }).payload), 'base64').length).toBe(8000);

    const before = fake.sttAudio.length;
    ws.send(JSON.stringify({ event: 'media', media: { payload: Buffer.alloc(160, 0xff).toString('base64') } }));
    await until(() => fake.sttAudio.length > before);
    expect(Buffer.from(fake.sttAudio.at(-1)!, 'base64').length).toBe(640); // 160 mu-law samples → 320 PCM16 samples at 16 kHz

    fake.stt!.onFinal('The bill is 400 rupees', 'en-IN');
    await until(async () => (await t.sql`select status from public.ai_calls where id = ${id}`)[0]!.status === 'completed', 8000);
    const done = (await t.sql`select * from public.ai_calls where id = ${id}`)[0]!;
    expect(done).toMatchObject({ outcome: 'success', next_step: 'Pay 400 rupees by Friday', ended_reason: 'assistant-ended-call' });
    expect(done.transcript).toContain("Them: The bill is 400 rupees");
    expect(done.transcript).toMatch(/^AI: Hello Ravi, I'm an AI assistant calling on behalf of Alice/);
    const lines = await t.sql`select role, seq from public.ai_call_lines where call_id = ${id} order by seq`;
    expect(lines.map((l) => l.role).slice(0, 2)).toEqual(['assistant', 'user']);
  }, 15_000);
});
