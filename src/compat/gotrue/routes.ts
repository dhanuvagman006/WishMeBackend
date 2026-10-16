/**
 * /auth/v1/* — the GoTrue endpoints the app calls, with GoTrue's request and response shapes, plus the hosted
 * password-reset page that the recovery email links to (the app has no screen for it).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { Deps } from '../../deps.js';
import { AppError, unauthorized } from '../../lib/errors.js';
import { requireUser } from '../../auth/context.js';
import { apikeyOf, bearerOf, clientMeta, jsonBody } from '../common.js';

type Body = Record<string, unknown>;

export function registerGotrue(app: FastifyInstance, deps: Deps): void {
  const proxied = () => deps.modes.modeFor('auth') === 'proxy' && deps.proxy.enabled;

  const withMode =
    (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (proxied()) return deps.proxy.forward(req, reply, req.body as Buffer | null);
      return handler(req, reply);
    };

  app.get(
    '/auth/v1/health',
    withMode(async () => ({ version: 'wishme', name: 'GoTrue-compatible', description: 'WishMe auth' })),
  );

  app.get(
    '/auth/v1/settings',
    withMode(async () => ({
      external: { email: true, phone: false },
      disable_signup: false,
      mailer_autoconfirm: false,
      phone_autoconfirm: false,
      sms_provider: '',
    })),
  );

  app.get('/auth/v1/.well-known/jwks.json', async () => deps.tokens.jwks());

  app.post(
    '/auth/v1/token',
    withMode(async (req) => {
      await deps.resolver.checkApiKey(apikeyOf(req));
      const grant = (req.query as { grant_type?: string }).grant_type;
      const body = (jsonBody(req.body) ?? {}) as Body;
      if (grant === 'password') return deps.auth.signInWithPassword(body.email, body.password, clientMeta(req));
      if (grant === 'refresh_token') return deps.auth.refreshSession(body.refresh_token, clientMeta(req));
      throw new AppError(400, 'unsupported_grant_type', 'Unsupported grant type');
    }),
  );

  app.post(
    '/auth/v1/signup',
    withMode(async (req) => {
      await deps.resolver.checkApiKey(apikeyOf(req));
      const body = (jsonBody(req.body) ?? {}) as Body;
      return deps.auth.signUp({ email: body.email, password: body.password, data: body.data }, clientMeta(req));
    }),
  );

  app.post(
    '/auth/v1/logout',
    withMode(async (req, reply) => {
      await deps.resolver.checkApiKey(apikeyOf(req));
      const auth = await deps.resolver.resolve(bearerOf(req)).catch(() => null);
      if (auth?.userId) {
        const scope = (req.query as { scope?: string }).scope === 'global' ? 'global' : 'local';
        await deps.auth.signOut(auth.userId, auth.sessionId, scope);
      }
      return reply.code(204).send();
    }),
  );

  app.get(
    '/auth/v1/user',
    withMode(async (req) => {
      await deps.resolver.checkApiKey(apikeyOf(req));
      const auth = await deps.resolver.resolve(bearerOf(req));
      if (auth.kind !== 'user') throw unauthorized('invalid claim: missing sub claim', 'bad_jwt');
      return deps.auth.getUser(auth.userId!);
    }),
  );

  app.put(
    '/auth/v1/user',
    withMode(async (req) => {
      await deps.resolver.checkApiKey(apikeyOf(req));
      const auth = await deps.resolver.resolve(bearerOf(req));
      requireUser(auth);
      const body = (jsonBody(req.body) ?? {}) as Body;
      const user = await deps.auth.updateUser(auth.userId, auth.sessionId, body);
      await deps.resolver.forgetIdentity(auth.userId);
      return user;
    }),
  );

  app.post(
    '/auth/v1/recover',
    withMode(async (req) => {
      await deps.resolver.checkApiKey(apikeyOf(req));
      const body = (jsonBody(req.body) ?? {}) as Body;
      await deps.auth.recover(body.email, clientMeta(req));
      return {};
    }),
  );

  // ── Hosted reset page ──────────────────────────────────────────────────────────────────────────────────────
  app.get('/auth/reset', async (_req, reply) => {
    const nonce = randomBytes(16).toString('base64');
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header(
        'content-security-policy',
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      );
    return reply.send(resetPage(nonce, deps.env.PASSWORD_MIN_LENGTH));
  });

  app.post('/auth/reset', async (req) => {
    const body = (jsonBody(req.body) ?? {}) as Body;
    await deps.auth.completeReset(body.token, body.password, clientMeta(req));
    return { success: true };
  });
}

function resetPage(nonce: string, minLength: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset your WishMe password</title>
<style nonce="${nonce}">
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A1556;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1B1D28}
main{width:100%;max-width:400px;margin:16px;background:#fff;border-radius:16px;padding:28px}
h1{font-size:22px;margin:0 0 8px}p{color:#585E70;font-size:14px;line-height:1.5}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #d6d8e1;border-radius:10px;font-size:16px}
button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:10px;background:#7B5CFA;color:#fff;font-size:16px;font-weight:700}
button:disabled{opacity:.6}.msg{margin-top:14px;font-size:14px}.err{color:#C62828}.ok{color:#2E7D32}
</style></head><body><main>
<h1>Choose a new password</h1><p>Use at least ${minLength} characters. Other devices will be signed out.</p>
<form id="f"><label for="p1">New password</label><input id="p1" type="password" autocomplete="new-password" minlength="${minLength}" required>
<label for="p2">Confirm password</label><input id="p2" type="password" autocomplete="new-password" minlength="${minLength}" required>
<button id="b" type="submit">Save password</button><div id="m" class="msg" role="status"></div></form>
</main><script nonce="${nonce}">
(function(){var t=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);
var f=document.getElementById('f'),m=document.getElementById('m'),b=document.getElementById('b');
if(!t){m.className='msg err';m.textContent='This link is incomplete. Request a new one from the app.';b.disabled=true;}
f.addEventListener('submit',function(e){e.preventDefault();var a=document.getElementById('p1').value,c=document.getElementById('p2').value;
if(a!==c){m.className='msg err';m.textContent='The passwords do not match.';return;}
b.disabled=true;m.className='msg';m.textContent='Saving…';
fetch('/auth/reset',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:t,password:a})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){
if(x.ok){f.innerHTML='<p class="msg ok">Your password was changed. You can now sign in to WishMe with it.</p>';}
else{b.disabled=false;m.className='msg err';m.textContent=(x.j&&(x.j.msg||x.j.message||x.j.error_description))||'Something went wrong. Please try again.';}
}).catch(function(){b.disabled=false;m.className='msg err';m.textContent='Network error. Please try again.';});});})();
</script></body></html>`;
}
