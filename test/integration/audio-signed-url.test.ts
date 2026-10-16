/**
 * b2-get-signed-url: only keys the caller owns are signed (the deployed function signed any key for anyone).
 * Presigning is local computation, so no network is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, anon, bootTest, profileIdOf, signUp, type TestCtx, type TestSession } from '../helpers.js';

let t: TestCtx;
let alice: TestSession;
let bob: TestSession;
let aliceProfile: string;

const sign = (token: string | null, fileKey: unknown) =>
  t.app.inject({ method: 'POST', url: '/functions/v1/b2-get-signed-url', headers: token ? bearer(token) : anon(), payload: { fileKey } });

beforeAll(async () => {
  t = await bootTest({
    env: { B2_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com', B2_KEY_ID: 'test-key-id', B2_APP_KEY: 'test-app-key', B2_BUCKET: 'wishmetoday' },
  });
  alice = await signUp(t, 'alice-b2@example.com');
  bob = await signUp(t, 'bob-b2@example.com');
  aliceProfile = await profileIdOf(t, alice.user.id);
  const celeb = await t.sql<{ id: string }[]>`insert into public.celebrities (name) values ('Celeb') returning id`;
  await t.sql`
    insert into public.wish_friend_orders (user_id, order_type, celebrity_id, recipient_name, occasion, prompt, status, video_file_key)
    values (${aliceProfile}, 'video_wish', ${celeb[0]!.id}, 'Mom', 'birthday', 'hi', 'completed', 'videos/wish-friend/alice-1.mp4')`;
  await t.sql`
    insert into public.library_items (user_id, kind, source_type, source_id, title, file_key)
    values (${aliceProfile}, 'video', 'ugc_video', gen_random_uuid(), 'Saved', 'videos/library/alice-2.mp4')`;
  await t.sql`
    insert into public.ugc_ads (user_id, product_name, product_image_url, status, video_file_key)
    values (${alice.user.id}, 'Soap', 'https://x/p.jpg', 'completed', 'videos/ugc/alice-ad.mp4')`;
});

afterAll(async () => {
  await t.close();
});

describe('b2-get-signed-url', () => {
  it('signs keys on rows the caller owns, with a short expiry', async () => {
    for (const key of ['videos/wish-friend/alice-1.mp4', 'videos/library/alice-2.mp4', 'videos/ugc/alice-ad.mp4']) {
      const res = await sign(alice.access_token, key);
      expect(res.statusCode, key).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.signedUrl).toBe(body.url);
      expect(body.signedUrl).toContain(`/wishmetoday/${key}`);
      expect(body.signedUrl).toMatch(/X-Amz-Expires=900/);
    }
  });

  it('signs keys under the caller’s own audio prefix', async () => {
    const res = await sign(alice.access_token, `audio/${aliceProfile}/tts/abc.mp3`);
    expect(res.statusCode).toBe(200);
  });

  it('refuses other users’ keys, unknown keys and traversal with 403', async () => {
    expect((await sign(bob.access_token, 'videos/wish-friend/alice-1.mp4')).statusCode).toBe(403);
    expect((await sign(bob.access_token, `audio/${aliceProfile}/tts/abc.mp3`)).statusCode).toBe(403);
    expect((await sign(alice.access_token, 'verification-docs/someone/pan.jpg')).statusCode).toBe(403);
    expect((await sign(alice.access_token, `audio/${aliceProfile}/../other/x.mp3`)).statusCode).toBe(403);
  });

  it('requires a user token and a fileKey', async () => {
    expect((await sign(null, 'videos/wish-friend/alice-1.mp4')).statusCode).toBe(401);
    expect((await sign(alice.access_token, '')).statusCode).toBe(400);
  });
});
