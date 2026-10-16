# Connecting the app

## The one change

The app reads its backend address from `EXPO_PUBLIC_SUPABASE_URL` (see `artifacts/mobile/constants/supabase.ts` and
`.env.example` in the app repository). Build the app with:

```
EXPO_PUBLIC_SUPABASE_URL=https://api.<your-domain>
EXPO_PUBLIC_SUPABASE_ANON_KEY=<the same anon key as today>
```

Nothing else changes in the app. Keep the same anon key: this server accepts it as the `apikey`, exactly like
Supabase, and forwards it on proxied routes.

## Route modes: migrate one piece at a time

Every request family is either served here (`local`) or forwarded to Supabase (`proxy`):

| Group | Covers |
| --- | --- |
| `auth` | `/auth/v1/*` (sign-in, sign-up, refresh, password) |
| `rest`, `rest:<table>` | `/rest/v1/<table>` |
| `rpc`, `rpc:<name>` | `/rest/v1/rpc/<name>` |
| `functions`, `functions:<name>` | `/functions/v1/<name>` |
| `storage`, `storage:<bucket>` | `/storage/v1/object/...` |

Set `COMPAT_DEFAULT_MODE=proxy` and turn groups local with `ROUTE_MODES`, then restart:

```
ROUTE_MODES={"auth":"local","functions:send-email-otp":"local","functions:verify-email-otp":"local"}
```

A specific group beats its family (`rest:wallet_transactions` beats `rest`). Rolling back is the same edit.
Realtime (`/realtime/v1/websocket`) is always served here; it sees changes made through Supabase too, through
database triggers.

## Recommended order

1. **Proxy everything.** Point a test build at the server with `COMPAT_DEFAULT_MODE=proxy`. Everything still runs on
   Supabase; you are only checking networking, TLS, latency and logs.
2. **Auth.** `auth` + the two OTP functions local. Existing users keep their sessions: their Supabase refresh token
   is exchanged for one of ours on the first refresh, and our tokens are signed with the Supabase JWT secret so
   proxied routes accept them.
3. **Read-mostly tables**: catalogue (`celebrities`, `plans`, `occasions`, …), then the user's own data.
4. **Money**: wallet, payments, payouts, bookings, orders, together, after testing on staging with Razorpay test keys.
   When these are local, the money holes in the old protocol are closed for every app build that talks to this
   server.
5. **AI content, voice, calls, travel**, one function family at a time.
6. **Cutover** of the data ([CUTOVER.md](CUTOVER.md)).

## Things to fix in the app when convenient (not required for the switch)

- `edit-profile.tsx` loads the profile with the anon key; pass the user's token.
- `registerPushToken` is never called; call it after sign-in so reminders can push.
- Long-term, move screens to `/api/v1` (typed, no client-built queries) and retire the compat surface.
