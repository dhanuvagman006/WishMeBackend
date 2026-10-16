/**
 * Audio conversion for phone calls. The phone line carries G.711 mu-law at 8 kHz; the speech engines take PCM16
 * 16 kHz and speak PCM16 at 24 kHz (Gemini Live, Sarvam). All PCM is signed 16-bit little-endian mono.
 */

const BIAS = 0x84;
const CLIP = 32635;

export function mulawToPcm(u: number): number {
  const x = ~u & 0xff;
  const sign = x & 0x80;
  const exponent = (x >> 4) & 0x07;
  const mantissa = x & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

export function pcmToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function pcmFromBuffer(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function pcmToBuffer(pcm: Int16Array): Buffer {
  const buf = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, i * 2);
  return buf;
}

/** Linear-interpolation resampler (used for upsampling the phone line, where no filtering is needed). */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || pcm.length === 0) return pcm;
  const n = Math.max(1, Math.round((pcm.length * to) / from));
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const a = Math.floor(pos);
    const frac = pos - a;
    const s0 = pcm[Math.min(a, pcm.length - 1)]!;
    const s1 = pcm[Math.min(a + 1, pcm.length - 1)]!;
    out[i] = Math.round(s0 + (s1 - s0) * frac);
  }
  return out;
}

/** Phone audio (mu-law or L16 at any rate) → base64 PCM16 16 kHz for the engines. */
export function phoneToEngine(b64: string, encoding: string, sampleRate: number): string {
  const raw = Buffer.from(b64, 'base64');
  const enc = encoding.toLowerCase();
  let pcm: Int16Array;
  if (enc.includes('mulaw') || enc.includes('ulaw') || enc.includes('pcmu')) {
    pcm = new Int16Array(raw.length);
    for (let i = 0; i < raw.length; i++) pcm[i] = mulawToPcm(raw[i]!);
  } else {
    pcm = pcmFromBuffer(raw);
  }
  return pcmToBuffer(resample(pcm, sampleRate || 8000, 16_000)).toString('base64');
}

/**
 * Engine audio (PCM16 at `rate`) → mu-law 8 kHz for the phone. Downsampling averages each group of samples (a box
 * low-pass, so the line does not alias), keeping the remainder between chunks so chunk edges do not click.
 */
export class PhoneEncoder {
  private carry: number[] = [];

  constructor(private readonly rate: number) {}

  reset(): void {
    this.carry = [];
  }

  encode(b64: string): { payload: string; ms: number } {
    const pcm = pcmFromBuffer(Buffer.from(b64, 'base64'));
    const factor = this.rate / 8000;
    let samples: number[];
    if (Number.isInteger(factor) && factor >= 1) {
      const all = this.carry.concat(Array.from(pcm));
      const usable = all.length - (all.length % factor);
      samples = [];
      for (let i = 0; i < usable; i += factor) {
        let sum = 0;
        for (let k = 0; k < factor; k++) sum += all[i + k]!;
        samples.push(sum / factor);
      }
      this.carry = all.slice(usable);
    } else {
      samples = Array.from(resample(pcm, this.rate, 8000));
    }
    const out = Buffer.alloc(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = pcmToMulaw(samples[i]!);
    return { payload: out.toString('base64'), ms: samples.length / 8 };
  }
}
