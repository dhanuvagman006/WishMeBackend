/**
 * Google Gemini (Generative Language API) for text, structured JSON, grounded search and image generation.
 * The live voice API (ephemeral tokens) is separate: see vendors/gemini-live.ts.
 */
import type { Env } from '../config/env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { vendorFetch } from '../lib/http.js';
import type { Logger } from '../lib/logger.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface InlineImage {
  mimeType: string;
  /** base64 */
  data: string;
}

export interface TextRequest {
  prompt: string;
  system?: string;
  /** Return JSON (responseMimeType application/json); pass a schema to constrain it. */
  json?: boolean;
  schema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  /** Ground the answer with Google Search. */
  search?: boolean;
  images?: InlineImage[];
  model?: string;
  timeoutMs?: number;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
}

export interface TextResult {
  text: string;
  sources: Array<{ title: string; url: string }>;
}

export class Gemini {
  constructor(
    private readonly env: Env,
    private readonly log: Logger,
  ) {}

  get configured(): boolean {
    return !!this.env.GEMINI_API_KEY;
  }

  private key(): string {
    if (!this.env.GEMINI_API_KEY) throw unavailable('AI generation is not configured');
    return this.env.GEMINI_API_KEY;
  }

  private async call(model: string, body: Record<string, unknown>, timeoutMs: number): Promise<GeminiResponse> {
    const { data } = await vendorFetch<GeminiResponse>(this.log, {
      vendor: 'gemini',
      url: `${BASE}/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'x-goog-api-key': this.key() },
      json: body,
      timeoutMs,
      retries: 1,
    });
    if (data.promptFeedback?.blockReason) {
      throw new AppError(422, 'content_blocked', 'This request was blocked by the content safety filter. Please rephrase it.');
    }
    return data;
  }

  async text(req: TextRequest): Promise<TextResult> {
    const parts: GeminiPart[] = [...(req.images ?? []).map((i) => ({ inlineData: i })), { text: req.prompt }];
    const generationConfig: Record<string, unknown> = {
      temperature: req.temperature ?? 0.8,
      maxOutputTokens: req.maxTokens ?? 2048,
    };
    if (req.json) {
      generationConfig.responseMimeType = 'application/json';
      if (req.schema) generationConfig.responseSchema = req.schema;
    }
    const body: Record<string, unknown> = { contents: [{ role: 'user', parts }], generationConfig };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.search) body.tools = [{ google_search: {} }];
    const data = await this.call(req.model ?? this.env.GEMINI_TEXT_MODEL, body, req.timeoutMs ?? 60_000);
    const cand = data.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    if (!text) throw new AppError(502, 'empty_generation', 'The AI returned an empty answer. Please try again.');
    const sources = (cand?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => ({ title: c.web?.title ?? '', url: c.web?.uri ?? '' }))
      .filter((s) => s.url);
    return { text, sources };
  }

  /** Text generation that must return JSON; parses it and retries once on malformed output. */
  async json<T>(req: Omit<TextRequest, 'json'>): Promise<T> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { text } = await this.text({ ...req, json: true });
      try {
        return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as T;
      } catch {
        if (attempt === 2) throw new AppError(502, 'bad_generation', 'The AI returned an unreadable answer. Please try again.');
      }
    }
    throw new Error('unreachable');
  }

  /** Generates one image; returns the bytes and type. */
  async image(req: { prompt: string; images?: InlineImage[]; model?: string; timeoutMs?: number }): Promise<{ mimeType: string; data: Buffer; text: string }> {
    const parts: GeminiPart[] = [...(req.images ?? []).map((i) => ({ inlineData: i })), { text: req.prompt }];
    const data = await this.call(
      req.model ?? this.env.GEMINI_IMAGE_MODEL,
      { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } },
      req.timeoutMs ?? 120_000,
    );
    const outParts = data.candidates?.[0]?.content?.parts ?? [];
    const img = outParts.find((p) => p.inlineData?.data);
    if (!img?.inlineData) throw new AppError(502, 'no_image', 'The AI did not return an image. Please try again with a different description.');
    return {
      mimeType: img.inlineData.mimeType,
      data: Buffer.from(img.inlineData.data, 'base64'),
      text: outParts.map((p) => p.text ?? '').join('').trim(),
    };
  }
}
