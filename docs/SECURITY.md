# Security model

## What we protect

Money (wallet balances, payouts, Razorpay payments), personal data (names, phones, emails, Aadhaar/PAN numbers and
documents, bank details, call recordings), the ability to phone people and spend vendor credit, and availability.

## Threats and controls

| Threat | Control |
| --- | --- |
| A signed-in user reads or changes someone else's rows | Default-deny table policies; ownership from the verified token only (`auth/context.ts`); every column reference is masked by read grants, so hidden columns can neither be read nor probed with filters (`compiler.ts`); Supabase RLS also applies in shared mode (`DB_RLS_PASSTHROUGH`). |
| A user credits their own wallet or marks an order paid | Money moves only in server code (`domains/wallet/ledger.ts`); client credit rows are accepted only as mirrors of server movements; order payment flags only after a ledger debit or verified Razorpay payment. See ADR 0004. |
| Forged or replayed Razorpay payments | HMAC signature on the callback, Razorpay API cross-check of order, amount, currency and status, webhook signature over the raw body, de-duplicated webhook events, idempotent fulfilment per order. |
| Double spending under concurrency | Balance row locked (`SELECT … FOR UPDATE`) for every movement; idempotency keys; tested with concurrent debits. |
| SQL injection | All values are parameters; identifiers come only from the introspected schema through a quoting helper that rejects anything that is not a plain name; the PostgREST parser rejects unknown operators and syntax. |
| Account takeover | bcrypt/Argon2id hashes; per-email and per-IP login limits; refresh tokens stored as keyed hashes, rotated on use, with family revocation on reuse; password change and reset revoke other sessions and notify by email; breached-password check at sign-up and change. |
| Sign-up without email ownership | `/auth/v1/signup` succeeds only after a verified OTP for that email within 15 minutes (the old functions did not bind them). OTPs: 6 digits, hashed with a server pepper, 10-minute expiry, 5 attempts, send cool-down and hourly caps. |
| Account and phone enumeration | Recovery answers the same for unknown emails; the app's anonymous phone→email lookup never returns a real email. |
| Identity documents in public buckets | `verification-docs` is private: never served on public URLs, only via short-lived signed URLs to the owner or an admin. Upload paths must start with the caller's own id; type and size limits per bucket; sizes enforced while streaming. |
| Abuse of paid vendors (AI, calls, SMS/WhatsApp) | Authenticated functions only, per-user rate limits, server-side prices charged before the vendor call and refunded on failure, call number validation (no emergency, short or premium numbers). |
| Secrets leaking | Secrets only in the VPS `.env` (mode 600) or GitHub environment secrets; never defaulted; log redaction for tokens, passwords, OTPs, signatures and identity numbers; vendor bodies never logged. |
| Overload and denial of service | Global per-IP rate limit, body size limits, statement timeouts, `under-pressure` load shedding with `Retry-After`, bounded proxy and vendor timeouts, WebSocket message size and subscription caps. |
| Infrastructure compromise | Firewall with 22/80/443 only, key-only SSH, automatic security updates, fail2ban, Postgres and Redis never published, non-root containers, backups encrypted to an offline key in a bucket the server cannot delete from. |

## Known gaps (to close)

- The app loads the full profile with the anon key in `edit-profile.tsx`; the server now returns no private fields to
  that call (and ignores blanked private fields on save). Fix in the app: pass the user's token.
- Aadhaar, PAN and bank numbers are stored in plain text in `profiles`, as Supabase had them. Plan: encrypt at rest
  with a key held by the API (pgcrypto or application-level), and stop collecting what the business does not need.
- Admin tooling (approving celebrities, payouts, refunds) still lives in the Supabase dashboard; it needs an admin
  surface on this server before cutover.
- Penetration test before go-live of each money domain.

## Reporting

Report suspected vulnerabilities privately to the owner; do not open public issues for them.
