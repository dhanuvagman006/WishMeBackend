/**
 * Backblaze B2 through its S3-compatible API: streaming uploads, presigned GET/PUT URLs, deletes. Public objects are
 * served from B2_PUBLIC_BASE; private ones (identity documents) only through short-lived signed URLs.
 */
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { Env } from '../config/env.js';
import { unavailable } from '../lib/errors.js';

export class B2 {
  private client: S3Client | null = null;

  constructor(private readonly env: Env) {}

  get configured(): boolean {
    return !!(this.env.B2_ENDPOINT && this.env.B2_KEY_ID && this.env.B2_APP_KEY);
  }

  private s3(): S3Client {
    if (!this.configured) throw unavailable('File storage is not configured');
    this.client ??= new S3Client({
      endpoint: this.env.B2_ENDPOINT!,
      region: this.env.B2_REGION,
      credentials: { accessKeyId: this.env.B2_KEY_ID!, secretAccessKey: this.env.B2_APP_KEY! },
      forcePathStyle: true,
    });
    return this.client;
  }

  bucketFor(isPrivate: boolean): string {
    return isPrivate ? (this.env.B2_PRIVATE_BUCKET ?? this.env.B2_BUCKET) : this.env.B2_BUCKET;
  }

  publicUrl(key: string): string | null {
    if (!this.env.B2_PUBLIC_BASE) return null;
    return `${this.env.B2_PUBLIC_BASE.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async upload(input: { key: string; body: Readable | Buffer; contentType: string; isPrivate: boolean; maxBytes: number }): Promise<{ key: string; bytes: number }> {
    let bytes = 0;
    if (!Buffer.isBuffer(input.body)) {
      const stream = input.body;
      // Enforce the size limit while streaming, so a client that lies about Content-Length cannot fill the bucket.
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > input.maxBytes) stream.destroy(new Error('payload too large'));
      });
    } else {
      bytes = input.body.length;
    }
    const up = new Upload({
      client: this.s3(),
      params: { Bucket: this.bucketFor(input.isPrivate), Key: input.key, Body: input.body, ContentType: input.contentType },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false,
    });
    await up.done();
    return { key: input.key, bytes };
  }

  async putBuffer(key: string, body: Buffer, contentType: string, isPrivate = false): Promise<void> {
    await this.s3().send(new PutObjectCommand({ Bucket: this.bucketFor(isPrivate), Key: key, Body: body, ContentType: contentType }));
  }

  async signedGetUrl(key: string, opts: { isPrivate: boolean; expiresSec?: number; downloadName?: string }): Promise<string> {
    return getSignedUrl(
      this.s3(),
      new GetObjectCommand({
        Bucket: this.bucketFor(opts.isPrivate),
        Key: key,
        ...(opts.downloadName ? { ResponseContentDisposition: `attachment; filename="${opts.downloadName.replace(/"/g, '')}"` } : {}),
      }),
      { expiresIn: opts.expiresSec ?? 3600 },
    );
  }

  async signedPutUrl(key: string, contentType: string, opts: { isPrivate: boolean; expiresSec?: number }): Promise<string> {
    return getSignedUrl(this.s3(), new PutObjectCommand({ Bucket: this.bucketFor(opts.isPrivate), Key: key, ContentType: contentType }), {
      expiresIn: opts.expiresSec ?? 900,
    });
  }

  async exists(key: string, isPrivate = false): Promise<boolean> {
    try {
      await this.s3().send(new HeadObjectCommand({ Bucket: this.bucketFor(isPrivate), Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string, isPrivate = false): Promise<void> {
    await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucketFor(isPrivate), Key: key }));
  }
}
