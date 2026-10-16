/**
 * /storage/v1/object/* — Supabase Storage's object routes, backed by B2.
 *
 * Uploads (POST/PUT /storage/v1/object/<bucket>/<path>) are checked per bucket: who may write where (the first path
 * segment must be the caller's own id), allowed content types, size limit. Objects are stored under
 * `storage/<bucket>/<path>` in B2.
 *
 * Reads of public objects (GET /storage/v1/object/public/<bucket>/<path>) redirect to B2's public URL, so the URLs the
 * app builds keep working when SUPABASE_URL points here. Private buckets (identity documents) are never served
 * publicly; owners and admins get a short-lived signed URL via /storage/v1/object/authenticated/<bucket>/<path>.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { AuthContext, Identity } from '../../auth/context.js';
import type { Deps } from '../../deps.js';
import { AppError, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { B2 } from '../../vendors/b2.js';
import { apikeyOf, bearerOf } from '../common.js';

interface BucketRule {
  isPrivate: boolean;
  maxMb: number;
  types: RegExp;
  /** Which ids may appear as the first path segment for this caller. */
  owners: (auth: AuthContext, identity: Identity) => string[];
  /** Folder names in celebrity buckets are derived from names; allow any first segment for verified celebrities. */
  celebrityAnyFolder?: boolean;
}

const IMAGE = /^image\/(jpeg|jpg|png|webp|heic|heif)$/;
const IMAGE_OR_PDF = /^(image\/(jpeg|jpg|png|webp|heic|heif)|application\/pdf)$/;
const MEDIA = /^(image\/(jpeg|jpg|png|webp)|video\/(mp4|quicktime|webm))$/;
const AUDIO = /^audio\/(m4a|x-m4a|mp4|mpeg|aac|webm|ogg|wav)$/;

export const BUCKETS: Record<string, BucketRule> = {
  'profile-photos': { isPrivate: false, maxMb: 5, types: IMAGE, owners: (a) => [a.userId!] },
  'verification-docs': {
    isPrivate: true,
    maxMb: 50,
    types: /^(image\/(jpeg|jpg|png|webp|heic|heif)|application\/pdf|video\/(mp4|webm|quicktime))$/,
    owners: (a, i) => [a.userId!, ...i.celebrityIds],
  },
  'voice-notes': { isPrivate: false, maxMb: 10, types: AUDIO, owners: (_a, i) => (i.profileId ? [i.profileId, ...i.celebrityIds] : []) },
  'greeting-card-uploads': { isPrivate: false, maxMb: 10, types: IMAGE, owners: (a, i) => [a.userId!, ...(i.profileId ? [i.profileId] : [])] },
  'celebrity-avatars': { isPrivate: false, maxMb: 10, types: IMAGE, owners: () => [], celebrityAnyFolder: true },
  'promotional-content': {
    isPrivate: false,
    maxMb: 100,
    types: MEDIA,
    owners: (a, i) => [a.userId!, ...(i.profileId ? [i.profileId] : []), ...i.celebrityIds],
    celebrityAnyFolder: true,
  },
};

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,400}$/;

function objectKey(bucket: string, path: string): string {
  return `storage/${bucket}/${path}`;
}

function splitPath(wild: string): { bucket: string; path: string } {
  const decoded = decodeURIComponent(wild);
  const i = decoded.indexOf('/');
  if (i <= 0) throw new AppError(400, 'InvalidKey', 'Object path must be <bucket>/<path>');
  const bucket = decoded.slice(0, i);
  const path = decoded.slice(i + 1);
  if (!SAFE_PATH.test(path) || path.includes('..') || path.includes('//')) throw new AppError(400, 'InvalidKey', 'Invalid object path');
  return { bucket, path };
}

export function registerStorage(app: FastifyInstance, deps: Deps): void {
  const b2 = deps.memo('b2', () => new B2(deps.env));
  const proxied = (bucket?: string) =>
    deps.proxy.enabled && deps.modes.modeFor(bucket ? `storage:${bucket}` : 'storage') === 'proxy';

  // Streams the request body to B2 (the storage plugin's content parser hands us the raw stream).
  const upload = async (req: FastifyRequest<{ Params: { '*': string } }>, reply: FastifyReply) => {
    const { bucket, path } = splitPath(req.params['*']);
    if (proxied(bucket)) return deps.proxy.forward(req, reply, req.body as Readable);
    const rule = BUCKETS[bucket];
    if (!rule) throw notFound('Bucket not found', 'Bucket not found');
    await deps.resolver.checkApiKey(apikeyOf(req));
    const auth = await deps.resolver.resolve(bearerOf(req));
    if (auth.kind === 'anon' || !auth.userId) throw unauthorized('Sign in to upload files');
    const identity = await auth.identity();
    const first = path.split('/')[0]!;
    const isCelebrity = identity.celebrityIds.length > 0;
    const ownerOk = rule.owners(auth, identity).includes(first) || (rule.celebrityAnyFolder && isCelebrity) || auth.isAdmin;
    if (!ownerOk) throw forbidden('You can only upload into your own folder', 'Unauthorized');
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!rule.types.test(contentType)) throw new AppError(415, 'InvalidMimeType', `mime type ${contentType || 'unknown'} is not supported`);
    const declared = Number(req.headers['content-length'] ?? 0);
    const maxBytes = Math.min(rule.maxMb, deps.env.UPLOAD_LIMIT_MB) * 1024 * 1024;
    if (declared > maxBytes) throw new AppError(413, 'EntityTooLarge', 'The object exceeded the maximum allowed size');
    await deps.limiter.hit('upload', auth.userId, { limit: 60, windowSec: 600 });
    const key = objectKey(bucket, path);
    await b2.upload({ key, body: req.body as Readable, contentType, isPrivate: rule.isPrivate, maxBytes });
    req.log.info({ bucket, key, userId: auth.userId }, 'object uploaded');
    return reply.code(200).send({ Key: `${bucket}/${path}`, Id: key });
  };

  app.post<{ Params: { '*': string } }>('/storage/v1/object/*', upload);
  app.put<{ Params: { '*': string } }>('/storage/v1/object/*', upload);

  // Public object URLs the app stored in rows: redirect to B2. Private buckets are never public.
  app.get<{ Params: { '*': string } }>('/storage/v1/object/public/*', async (req, reply) => {
    const { bucket, path } = splitPath(req.params['*']);
    if (proxied(bucket)) return deps.proxy.forward(req, reply, null);
    const rule = BUCKETS[bucket];
    if (!rule || rule.isPrivate) throw notFound('Object not found', 'not_found');
    const url = b2.publicUrl(objectKey(bucket, path)) ?? (await b2.signedGetUrl(objectKey(bucket, path), { isPrivate: false, expiresSec: 3600 }));
    return reply.header('cache-control', 'public, max-age=300').redirect(url, 302);
  });

  // Authenticated reads (any bucket, including private): owner or admin, via a signed URL redirect.
  app.get<{ Params: { '*': string } }>('/storage/v1/object/authenticated/*', async (req, reply) => {
    const { bucket, path } = splitPath(req.params['*']);
    if (proxied(bucket)) return deps.proxy.forward(req, reply, null);
    const rule = BUCKETS[bucket];
    if (!rule) throw notFound('Object not found', 'not_found');
    await deps.resolver.checkApiKey(apikeyOf(req));
    const auth = await deps.resolver.resolve(bearerOf(req));
    if (auth.kind === 'anon') throw unauthorized('Sign in to view this file');
    const identity = await auth.identity();
    const first = path.split('/')[0]!;
    if (!auth.isAdmin && !rule.owners(auth, identity).includes(first)) throw forbidden('Not allowed');
    const url = await b2.signedGetUrl(objectKey(bucket, path), { isPrivate: rule.isPrivate, expiresSec: 300 });
    return reply.header('cache-control', 'no-store').redirect(url, 302);
  });
}
