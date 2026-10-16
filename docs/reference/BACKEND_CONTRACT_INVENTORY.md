# WishMe backend contract inventory

Everything the mobile app (`artifacts/mobile`) asks of the Supabase project `eqikeuqwbphwongtfzhe`, read from the
call sites on 16 Oct 2026 (branch `claude/backend-migration-plan-f28c94`, cut from `chore/structure-and-tooling`).
It is the contract the new API must honour while screens move over one at a time; see
[BACKEND_MIGRATION_PLAN.md](BACKEND_MIGRATION_PLAN.md). The server side (schema, RLS, SQL functions, edge-function
code) is not in this repository; [scripts/supabase-audit](../scripts/supabase-audit/README.md) exports it, and its
`SUMMARY.md` cross-checks the project against the name lists used here (`tables.txt`, `functions.txt`).

How this was built: a grep over `artifacts/mobile` for `/rest/v1/`, `/rpc/`, `/functions/v1/`, `/auth/v1/`,
`/storage/v1/` and `/realtime/v1/`, plus the dynamic names (`tboService.ts` builds `tbo-flights` / `tbo-hotels`,
`occasion-book/[id].tsx` picks `generate-occasion-video` / `generate-greeting-card`, `components/bookings/TabConfig.tsx`
holds twelve table names). Every call site was then read to record filters, request fields and the response fields
the code actually touches. Line numbers drift; the index below was generated from source by a one-off script on 16 Oct 2026, the domain sections
were written by hand.

## Counts compared with PROJECT_REPORT.md

| Surface | Report (15 Oct) | Re-derived | Difference |
| --- | --- | --- | --- |
| Tables via `/rest/v1/<table>` | 45 | 47 | `voice_call_wishes` and `music_generations` are only reached through the Bookings tab config and realtime. |
| RPCs via `/rest/v1/rpc/<name>` | 6 | 6 | Same six. |
| Edge functions via `/functions/v1/<name>` | 43 | 46 | Three names are built at runtime (`tbo-hotels`, `generate-occasion-video`, `generate-greeting-card`) or are fallbacks (`elevenlabs-get-user-voices`). |
| Supabase Auth routes | not counted | 6 | token (password and refresh), signup, user (GET/PUT), recover, logout, health. |
| Storage buckets via `/storage/v1/object/…` | not counted | 6 | `celebrity-avatars`, `greeting-card-uploads`, `profile-photos`, `promotional-content`, `verification-docs`, `voice-notes`. |
| Realtime channels | not mentioned | 8 tables | `profiles`, `bookings`, `music_generations`, `wish_friend_orders`, `image_promotions`, `celebrity_favorites`, `conversations`, `messages`. |
| WebSocket relays | 1 | 1 | `sarvam-voice`. |

## Transport conventions every endpoint inherits

- **One wrapper.** `supabaseFetch(path, options, token?)` in `constants/supabase.ts` sends `apikey: <anon key>`,
  `Authorization: Bearer <token ?? anon key>` and JSON headers, and aborts after **20 s**. A missing token silently
  means "anon key", and several screens rely on that. About fifteen call sites use raw `fetch(SUPABASE_URL + …)`
  with the same headers (long AI calls that need more than 20 s, storage uploads, the wallet sheets).
- **Errors.** `parseApiError` reads `error_description || error || message || msg`. Screens then match words in
  that text (`invalid`, `expir`, `used`, `already registered`), so the new API must keep both the shape and the
  wording during the transition. The Hub services read PostgREST's `message` / `hint`.
- **PostgREST semantics the app depends on:** arrays for every GET (even `limit=1`), `Prefer: return=representation`
  on inserts it reads back, `Prefer: resolution=merge-duplicates` + `on_conflict=` upserts, `Prefer: count=exact`
  with a `HEAD` request (profile counters), embedded resources (`celebrities(name,image_url)`,
  `celebrity:celebrities!conversations_celebrity_id_fkey(…)`), `or=(…)`, `in.(…)`, `is.null`, `not.is.null`, and
  `order=…nullslast`.
- **Identity keys are inconsistent.** Most tables key on `profiles.id` (`user.profileId`), but `reminders`,
  `calendar_events`, `assistant_settings`, `ugc_ads` and some legacy `wallet_transactions` use the **auth user id**,
  and `celebrity_wallet_transactions.celebrity_id` is filtered with a profile id while `payout_requests.celebrity_id`
  receives `celebrities.id`. The new API should resolve the caller from the token and ignore ids sent by the client.

## Cross-cutting findings that shape the migration

1. **The phone writes money.** It inserts `wallet_transactions` (deposits, plan purchases, Scan & Pay, booking and
   wish debits), `payment_transactions` (with client-invented `WM-…` ids), `payout_requests`, and PATCHes
   `celebrities.available_balance`, order `payment_status`, and `profiles.plan` after a Razorpay success callback.
   Prices and platform fees are computed on the phone. `profiles.wallet_balance` itself appears to be maintained
   by a database trigger on `wallet_transactions` (to be confirmed by the audit). All of this moves server-side in
   phase C of the plan.
2. **Some paths never charge at all.** The flight review screen books and tickets through `tbo-flights` without a
   client-side charge; the video-wish booking has no balance check for `ad` / `video`; the Razorpay option on the
   booking wizard is a "Coming soon" stub. The audit must show whether the edge functions charge server-side.
3. **Sensitive reads with the anon key.** `edit-profile.tsx` loads the full profile (Aadhaar, PAN, bank fields) with
   the anon key, and "forgot password by phone" looks up an email by phone number anonymously. These only work if
   RLS is permissive on `profiles`, which the audit will show.
4. **Realtime is used, not just polling.** Five screens open Supabase Realtime (Phoenix protocol) sockets and
   refetch over REST on any change. The VPS needs an equivalent push channel (phase D).
5. **Mock flows.** Hotels, buses and bill payments use static data and simulated payments; only flights reach TBO.
   `registerPushToken` exists but is never called, so `push_tokens` is probably empty.
6. **Public buckets.** The app builds `…/object/public/<bucket>/<path>` itself and stores that URL in rows, including
   for `verification-docs` (identity documents). Those URLs will need rewriting or redirecting at cutover.

## Index: every endpoint and the files that call it

Generated from source on 16 Oct 2026. Files under `scripts/` (self-checks) are excluded. An endpoint whose name is
built at runtime shows the file that holds the literal name.


### Tables (47)

| Name | Called from (file and lines) |
| --- | --- |
| `ai_call_lines` | [services/hub/callLogs.ts](../artifacts/mobile/services/hub/callLogs.ts) 53 |
| `ai_calls` | [services/assistant/aiCalls.ts](../artifacts/mobile/services/assistant/aiCalls.ts) 104, 120 |
| `assistant_settings` | [context/AssistantPersonaContext.tsx](../artifacts/mobile/context/AssistantPersonaContext.tsx) 133, 174 |
| `audio_isolation_generations` | [components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 103<br>[components/music/IsolateTab.tsx](../artifacts/mobile/components/music/IsolateTab.tsx) 30 |
| `bank_details` | [components/celebrity-dashboard/WalletTab.tsx](../artifacts/mobile/components/celebrity-dashboard/WalletTab.tsx) 46, 121<br>[components/wallet/WithdrawModal.tsx](../artifacts/mobile/components/wallet/WithdrawModal.tsx) 60 |
| `bookings` | [app/(tabs)/profile.tsx](../artifacts/mobile/app/(tabs)/profile.tsx) 83<br>[app/booking/[id].tsx](../artifacts/mobile/app/booking/[id].tsx) 354, 403<br>[app/booking-summary.tsx](../artifacts/mobile/app/booking-summary.tsx) 79<br>[app/celebrity-dashboard.tsx](../artifacts/mobile/app/celebrity-dashboard.tsx) 73<br>[components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 92<br>[components/bookings/useRealtimeBookings.tsx](../artifacts/mobile/components/bookings/useRealtimeBookings.tsx) 43<br>[components/celebrity-dashboard/BookingsTab.tsx](../artifacts/mobile/components/celebrity-dashboard/BookingsTab.tsx) 26, 77, 96 |
| `calendar_events` | [services/hub/calendar.ts](../artifacts/mobile/services/hub/calendar.ts) 59 |
| `celebrities` | [app/booking/[id].tsx](../artifacts/mobile/app/booking/[id].tsx) 141<br>[app/celebrity/[id].tsx](../artifacts/mobile/app/celebrity/[id].tsx) 88<br>[app/celebrity-dashboard.tsx](../artifacts/mobile/app/celebrity-dashboard.tsx) 54<br>[app/dashboard.tsx](../artifacts/mobile/app/dashboard.tsx) 210<br>[app/favorites.tsx](../artifacts/mobile/app/favorites.tsx) 570<br>[app/image-promotions.tsx](../artifacts/mobile/app/image-promotions.tsx) 128<br>[app/occasion-book/[id].tsx](../artifacts/mobile/app/occasion-book/[id].tsx) 129<br>[app/occasion-wishes.tsx](../artifacts/mobile/app/occasion-wishes.tsx) 240<br>[app/wish-booking/[id].tsx](../artifacts/mobile/app/wish-booking/[id].tsx) 99<br>[app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 132<br>[app/wish-celebrity.tsx](../artifacts/mobile/app/wish-celebrity.tsx) 66<br>[app/wish-friend.tsx](../artifacts/mobile/app/wish-friend.tsx) 132<br>[components/celebrity-dashboard/ConsentTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ConsentTab.tsx) 47<br>[components/celebrity-dashboard/ContentTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ContentTab.tsx) 53<br>[components/celebrity-dashboard/ProfileTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ProfileTab.tsx) 62<br>[components/ugc/FormFields.tsx](../artifacts/mobile/components/ugc/FormFields.tsx) 165<br>[components/wallet/WithdrawModal.tsx](../artifacts/mobile/components/wallet/WithdrawModal.tsx) 54, 139<br>[hooks/useCelebrities.ts](../artifacts/mobile/hooks/useCelebrities.ts) 181<br>[hooks/useCelebrity.ts](../artifacts/mobile/hooks/useCelebrity.ts) 21<br>[hooks/useVoiceCallCelebrities.ts](../artifacts/mobile/hooks/useVoiceCallCelebrities.ts) 49 |
| `celebrity_applications` | [context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 724, 820, 841 |
| `celebrity_categories` | [app/celebrity-signup.tsx](../artifacts/mobile/app/celebrity-signup.tsx) 223 |
| `celebrity_events` | [app/celebrity/[id].tsx](../artifacts/mobile/app/celebrity/[id].tsx) 239<br>[components/celebrity-dashboard/EventsTab.tsx](../artifacts/mobile/components/celebrity-dashboard/EventsTab.tsx) 44, 79, 105 |
| `celebrity_favorite_pricing` | [app/booking/[id].tsx](../artifacts/mobile/app/booking/[id].tsx) 184<br>[app/celebrity/[id].tsx](../artifacts/mobile/app/celebrity/[id].tsx) 170<br>[app/favorites.tsx](../artifacts/mobile/app/favorites.tsx) 571 |
| `celebrity_favorites` | [app/(tabs)/profile.tsx](../artifacts/mobile/app/(tabs)/profile.tsx) 85<br>[app/booking/[id].tsx](../artifacts/mobile/app/booking/[id].tsx) 186<br>[app/celebrity/[id].tsx](../artifacts/mobile/app/celebrity/[id].tsx) 165<br>[app/favorites.tsx](../artifacts/mobile/app/favorites.tsx) 592<br>[app/occasion-book/[id].tsx](../artifacts/mobile/app/occasion-book/[id].tsx) 112<br>[app/occasion-wishes.tsx](../artifacts/mobile/app/occasion-wishes.tsx) 220<br>[app/wish-celebrity.tsx](../artifacts/mobile/app/wish-celebrity.tsx) 71<br>[components/celebrity-dashboard/FollowersTab.tsx](../artifacts/mobile/components/celebrity-dashboard/FollowersTab.tsx) 27, 50, 55<br>[hooks/useCelebrityFavorites.ts](../artifacts/mobile/hooks/useCelebrityFavorites.ts) 31 |
| `celebrity_media` | [app/celebrity/[id].tsx](../artifacts/mobile/app/celebrity/[id].tsx) 222<br>[components/celebrity-dashboard/ContentTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ContentTab.tsx) 31, 86 |
| `celebrity_occasions` | [app/occasion-wishes.tsx](../artifacts/mobile/app/occasion-wishes.tsx) 245 |
| `celebrity_reviews` | [app/celebrity/[id].tsx](../artifacts/mobile/app/celebrity/[id].tsx) 203<br>[components/celebrity-dashboard/ReviewsTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ReviewsTab.tsx) 27 |
| `celebrity_settings` | [components/celebrity-dashboard/MessagesTab.tsx](../artifacts/mobile/components/celebrity-dashboard/MessagesTab.tsx) 63, 83 |
| `celebrity_wallet_transactions` | [app/commission.tsx](../artifacts/mobile/app/commission.tsx) 165<br>[components/celebrity-dashboard/TdsTab.tsx](../artifacts/mobile/components/celebrity-dashboard/TdsTab.tsx) 35<br>[components/celebrity-dashboard/WalletTab.tsx](../artifacts/mobile/components/celebrity-dashboard/WalletTab.tsx) 48 |
| `conversations` | [app/chat/[id].tsx](../artifacts/mobile/app/chat/[id].tsx) 399, 453, 606, 617<br>[app/messages.tsx](../artifacts/mobile/app/messages.tsx) 98<br>[components/celebrity-dashboard/MessagesTab.tsx](../artifacts/mobile/components/celebrity-dashboard/MessagesTab.tsx) 58, 112, 117, 253 |
| `greeting_card_generations` | [app/greeting-cards.tsx](../artifacts/mobile/app/greeting-cards.tsx) 169, 206, 354<br>[components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 95<br>[services/library.ts](../artifacts/mobile/services/library.ts) 72, 144 |
| `image_music_generations` | [components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 99<br>[components/music/ImageMusicTab.tsx](../artifacts/mobile/components/music/ImageMusicTab.tsx) 78 |
| `image_promotions` | [app/image-promotions.tsx](../artifacts/mobile/app/image-promotions.tsx) 163, 306<br>[components/celebrity-dashboard/BookingsTab.tsx](../artifacts/mobile/components/celebrity-dashboard/BookingsTab.tsx) 31, 78<br>[components/celebrity-dashboard/WalletTab.tsx](../artifacts/mobile/components/celebrity-dashboard/WalletTab.tsx) 49 |
| `library_items` | [services/library.ts](../artifacts/mobile/services/library.ts) 77, 119, 149, 160 |
| `loved_ones` | [app/loved-ones.tsx](../artifacts/mobile/app/loved-ones.tsx) 139, 209, 224, 257, 313<br>[services/occasionAlerts.ts](../artifacts/mobile/services/occasionAlerts.ts) 123, 155, 168, 194 |
| `messages` | [app/chat/[id].tsx](../artifacts/mobile/app/chat/[id].tsx) 408, 426, 427, 463, 544, 582<br>[app/messages.tsx](../artifacts/mobile/app/messages.tsx) 115<br>[components/celebrity-dashboard/MessagesTab.tsx](../artifacts/mobile/components/celebrity-dashboard/MessagesTab.tsx) 151, 156, 169, 188, 194, 234 |
| `music_generations` | [components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 98<br>[components/bookings/useRealtimeBookings.tsx](../artifacts/mobile/components/bookings/useRealtimeBookings.tsx) 44 |
| `occasion_alerts` | [app/loved-ones.tsx](../artifacts/mobile/app/loved-ones.tsx) 335, 345<br>[services/occasionAlerts.ts](../artifacts/mobile/services/occasionAlerts.ts) 113, 132, 173 |
| `occasion_bookings` | [app/occasion-book/[id].tsx](../artifacts/mobile/app/occasion-book/[id].tsx) 169 |
| `occasion_wishes` | [app/occasion-wishes.tsx](../artifacts/mobile/app/occasion-wishes.tsx) 250, 302 |
| `occasions` | [app/occasion-book/[id].tsx](../artifacts/mobile/app/occasion-book/[id].tsx) 109<br>[app/occasions.tsx](../artifacts/mobile/app/occasions.tsx) 83 |
| `payment_transactions` | [app/booking/[id].tsx](../artifacts/mobile/app/booking/[id].tsx) 383<br>[app/image-promotions.tsx](../artifacts/mobile/app/image-promotions.tsx) 283<br>[app/photo-wish.tsx](../artifacts/mobile/app/photo-wish.tsx) 334<br>[components/wallet/DepositModal.tsx](../artifacts/mobile/components/wallet/DepositModal.tsx) 116<br>[components/wallet/TransactionsTab.tsx](../artifacts/mobile/components/wallet/TransactionsTab.tsx) 90 |
| `payout_requests` | [components/celebrity-dashboard/WalletTab.tsx](../artifacts/mobile/components/celebrity-dashboard/WalletTab.tsx) 47, 82<br>[components/wallet/WithdrawModal.tsx](../artifacts/mobile/components/wallet/WithdrawModal.tsx) 117 |
| `photo_wishes` | [app/photo-wish.tsx](../artifacts/mobile/app/photo-wish.tsx) 195, 351<br>[components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 96 |
| `plans` | [app/greeting-cards.tsx](../artifacts/mobile/app/greeting-cards.tsx) 149<br>[app/referrals.tsx](../artifacts/mobile/app/referrals.tsx) 122<br>[app/select-plan.tsx](../artifacts/mobile/app/select-plan.tsx) 99<br>[hooks/usePlan.ts](../artifacts/mobile/hooks/usePlan.ts) 45 |
| `platform_settings` | [app/chat/[id].tsx](../artifacts/mobile/app/chat/[id].tsx) 458<br>[app/greeting-cards.tsx](../artifacts/mobile/app/greeting-cards.tsx) 130<br>[app/image-promotions.tsx](../artifacts/mobile/app/image-promotions.tsx) 144<br>[app/photo-wish.tsx](../artifacts/mobile/app/photo-wish.tsx) 173<br>[app/ugc-ads.tsx](../artifacts/mobile/app/ugc-ads.tsx) 27<br>[app/ugc-videos.tsx](../artifacts/mobile/app/ugc-videos.tsx) 27<br>[app/wish-friend.tsx](../artifacts/mobile/app/wish-friend.tsx) 118 |
| `profiles` | [app/booking/[id].tsx](../artifacts/mobile/app/booking/[id].tsx) 142<br>[app/dashboard.tsx](../artifacts/mobile/app/dashboard.tsx) 143, 148, 200, 246<br>[app/edit-profile.tsx](../artifacts/mobile/app/edit-profile.tsx) 148, 298, 386<br>[app/favorites.tsx](../artifacts/mobile/app/favorites.tsx) 681<br>[app/greeting-cards.tsx](../artifacts/mobile/app/greeting-cards.tsx) 132<br>[app/referrals.tsx](../artifacts/mobile/app/referrals.tsx) 109<br>[app/select-plan.tsx](../artifacts/mobile/app/select-plan.tsx) 105, 216<br>[app/wish-booking/[id].tsx](../artifacts/mobile/app/wish-booking/[id].tsx) 123<br>[app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 156<br>[components/celebrity-dashboard/ProfileTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ProfileTab.tsx) 44<br>[components/scan-pay/ScanPayScreen.tsx](../artifacts/mobile/components/scan-pay/ScanPayScreen.tsx) 231<br>[context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 308, 369, 562, 695<br>[hooks/usePlan.ts](../artifacts/mobile/hooks/usePlan.ts) 42<br>[hooks/useWallet.ts](../artifacts/mobile/hooks/useWallet.ts) 23 |
| `push_tokens` | [services/hub/notifications.ts](../artifacts/mobile/services/hub/notifications.ts) 97 |
| `referral_transactions` | [app/commission.tsx](../artifacts/mobile/app/commission.tsx) 159, 163<br>[components/wallet/ReferralEarningsTab.tsx](../artifacts/mobile/components/wallet/ReferralEarningsTab.tsx) 46<br>[components/wallet/TransactionsTab.tsx](../artifacts/mobile/components/wallet/TransactionsTab.tsx) 66 |
| `reminders` | [services/hub/reminders.ts](../artifacts/mobile/services/hub/reminders.ts) 59 |
| `sound_effect_generations` | [components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 101<br>[components/music/SFXTab.tsx](../artifacts/mobile/components/music/SFXTab.tsx) 35 |
| `tts_generations` | [components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 100<br>[components/music/TTSTab.tsx](../artifacts/mobile/components/music/TTSTab.tsx) 42 |
| `ugc_ads` | [components/ugc/UgcHistory.tsx](../artifacts/mobile/components/ugc/UgcHistory.tsx) 173 |
| `voice_call_wishes` | [components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 97 |
| `voice_conversion_generations` | [components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 102<br>[components/music/VoiceConversionTab.tsx](../artifacts/mobile/components/music/VoiceConversionTab.tsx) 44 |
| `wallet_transactions` | [app/booking/[id].tsx](../artifacts/mobile/app/booking/[id].tsx) 365<br>[app/dashboard.tsx](../artifacts/mobile/app/dashboard.tsx) 205<br>[app/select-plan.tsx](../artifacts/mobile/app/select-plan.tsx) 230<br>[app/wish-booking/[id].tsx](../artifacts/mobile/app/wish-booking/[id].tsx) 254<br>[app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 434<br>[components/scan-pay/ScanPayScreen.tsx](../artifacts/mobile/components/scan-pay/ScanPayScreen.tsx) 197<br>[components/wallet/DepositModal.tsx](../artifacts/mobile/components/wallet/DepositModal.tsx) 94<br>[components/wallet/TransactionsTab.tsx](../artifacts/mobile/components/wallet/TransactionsTab.tsx) 49 |
| `wish_celebrity_orders` | [app/wish-booking/[id].tsx](../artifacts/mobile/app/wish-booking/[id].tsx) 221, 268, 277, 325, 370, 404<br>[app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 184, 196, 352, 393, 455, 463, …<br>[app/wish-confirmation/[id].tsx](../artifacts/mobile/app/wish-confirmation/[id].tsx) 65<br>[app/wish-congratulations.tsx](../artifacts/mobile/app/wish-congratulations.tsx) 51<br>[app/wish-orders.tsx](../artifacts/mobile/app/wish-orders.tsx) 303<br>[components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 94 |
| `wish_friend_orders` | [app/(tabs)/profile.tsx](../artifacts/mobile/app/(tabs)/profile.tsx) 84<br>[components/bookings/TabConfig.tsx](../artifacts/mobile/components/bookings/TabConfig.tsx) 93<br>[components/bookings/useRealtimeBookings.tsx](../artifacts/mobile/components/bookings/useRealtimeBookings.tsx) 45<br>[components/ugc/UgcHistory.tsx](../artifacts/mobile/components/ugc/UgcHistory.tsx) 193 |

### RPCs (6)

| Name | Called from (file and lines) |
| --- | --- |
| `create_ugc_ad_order` | [app/ugc-ads.tsx](../artifacts/mobile/app/ugc-ads.tsx) 47 |
| `create_wish_friend_order` | [app/ugc-videos.tsx](../artifacts/mobile/app/ugc-videos.tsx) 48<br>[app/wish-friend.tsx](../artifacts/mobile/app/wish-friend.tsx) 187 |
| `get_my_referral_history` | [app/referrals.tsx](../artifacts/mobile/app/referrals.tsx) 126 |
| `get_my_referrals` | [app/(tabs)/profile.tsx](../artifacts/mobile/app/(tabs)/profile.tsx) 76<br>[app/referrals.tsx](../artifacts/mobile/app/referrals.tsx) 127 |
| `purchase_celebrity_subscription` | [app/favorites.tsx](../artifacts/mobile/app/favorites.tsx) 636<br>[components/celebrity/SubscribeSheet.tsx](../artifacts/mobile/components/celebrity/SubscribeSheet.tsx) 82 |
| `validate_referral_code` | [app/(auth)/index.tsx](../artifacts/mobile/app/(auth)/index.tsx) 242 |

### Edge functions (46)

| Name | Called from (file and lines) |
| --- | --- |
| `send-email-otp` | [constants/supabase.ts](../artifacts/mobile/constants/supabase.ts) 68<br>[context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 428, 616, 742 |
| `verify-email-otp` | [constants/supabase.ts](../artifacts/mobile/constants/supabase.ts) 68<br>[context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 466, 770 |
| `send-whatsapp-welcome` | [context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 593 |
| `trigger-message-event` | [context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 598 |
| `create-razorpay-order` | [app/favorites.tsx](../artifacts/mobile/app/favorites.tsx) 709<br>[app/select-plan.tsx](../artifacts/mobile/app/select-plan.tsx) 159<br>[app/wish-booking/[id].tsx](../artifacts/mobile/app/wish-booking/[id].tsx) 298<br>[app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 491<br>[components/wallet/DepositModal.tsx](../artifacts/mobile/components/wallet/DepositModal.tsx) 42 |
| `verify-razorpay-payment` | [app/select-plan.tsx](../artifacts/mobile/app/select-plan.tsx) 198<br>[app/wish-booking/[id].tsx](../artifacts/mobile/app/wish-booking/[id].tsx) 313<br>[app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 506<br>[components/wallet/DepositModal.tsx](../artifacts/mobile/components/wallet/DepositModal.tsx) 76 |
| `tbo-flights` | [services/tboService.ts](../artifacts/mobile/services/tboService.ts) 144, 178, 186, 195, 203, 210, … |
| `tbo-hotels` | [services/tboService.ts](../artifacts/mobile/services/tboService.ts) 144, 239, 246, 263, 270, 430 |
| `celebrity-conversation-auto-reply` | [app/chat/[id].tsx](../artifacts/mobile/app/chat/[id].tsx) 630 |
| `celebrity-ai-message` | [components/celebrity-dashboard/MessagesTab.tsx](../artifacts/mobile/components/celebrity-dashboard/MessagesTab.tsx) 208 |
| `generate-occasion-auto-reply` | [app/occasion-wishes.tsx](../artifacts/mobile/app/occasion-wishes.tsx) 326 |
| `send-celebrity-subscription-email` | [app/favorites.tsx](../artifacts/mobile/app/favorites.tsx) 654 |
| `heygen-get-languages` | [app/booking/[id].tsx](../artifacts/mobile/app/booking/[id].tsx) 143 |
| `generate-script` | [app/booking/[id].tsx](../artifacts/mobile/app/booking/[id].tsx) 279 |
| `generate-occasion-video` | [app/occasion-book/[id].tsx](../artifacts/mobile/app/occasion-book/[id].tsx) 190 |
| `generate-greeting-card` | [app/greeting-cards.tsx](../artifacts/mobile/app/greeting-cards.tsx) 301<br>[app/occasion-book/[id].tsx](../artifacts/mobile/app/occasion-book/[id].tsx) 191 |
| `generate-message-suggestions` | [app/wish-booking/[id].tsx](../artifacts/mobile/app/wish-booking/[id].tsx) 155<br>[app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 249 |
| `suggest-greeting-card-prompts` | [app/wish-booking/[id].tsx](../artifacts/mobile/app/wish-booking/[id].tsx) 183<br>[app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 272 |
| `generate-wish-celebrity-card` | [app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 612<br>[app/wish-confirmation/[id].tsx](../artifacts/mobile/app/wish-confirmation/[id].tsx) 89 |
| `send-wish-to-celebrity` | [app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 652<br>[app/wish-confirmation/[id].tsx](../artifacts/mobile/app/wish-confirmation/[id].tsx) 130 |
| `send-wish-thankyou-dm` | [app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 670 |
| `generate-greeting-card-ai` | [app/greeting-cards.tsx](../artifacts/mobile/app/greeting-cards.tsx) 301 |
| `generate-photo-wish` | [app/photo-wish.tsx](../artifacts/mobile/app/photo-wish.tsx) 282 |
| `generate-image-promotion` | [app/image-promotions.tsx](../artifacts/mobile/app/image-promotions.tsx) 234 |
| `generate-document` | [services/documents/generate.ts](../artifacts/mobile/services/documents/generate.ts) 111 |
| `generate-lyrics` | [components/music/GenerateSongTab.tsx](../artifacts/mobile/components/music/GenerateSongTab.tsx) 57<br>[components/music/ImageMusicTab.tsx](../artifacts/mobile/components/music/ImageMusicTab.tsx) 38 |
| `generate-music` | [components/music/GenerateSongTab.tsx](../artifacts/mobile/components/music/GenerateSongTab.tsx) 106 |
| `check-music-status` | [components/music/GenerateSongTab.tsx](../artifacts/mobile/components/music/GenerateSongTab.tsx) 125 |
| `elevenlabs-image-music-video` | [components/music/ImageMusicTab.tsx](../artifacts/mobile/components/music/ImageMusicTab.tsx) 69 |
| `elevenlabs-sound-effects` | [components/music/SFXTab.tsx](../artifacts/mobile/components/music/SFXTab.tsx) 29 |
| `elevenlabs-speech-to-speech` | [components/music/VoiceConversionTab.tsx](../artifacts/mobile/components/music/VoiceConversionTab.tsx) 38 |
| `elevenlabs-clone-voice` | [components/music/CloneTab.tsx](../artifacts/mobile/components/music/CloneTab.tsx) 29 |
| `elevenlabs-text-to-speech` | [components/music/TTSTab.tsx](../artifacts/mobile/components/music/TTSTab.tsx) 36 |
| `elevenlabs-audio-isolation` | [components/music/IsolateTab.tsx](../artifacts/mobile/components/music/IsolateTab.tsx) 24 |
| `get-user-voices` | [hooks/useVoices.ts](../artifacts/mobile/hooks/useVoices.ts) 27 |
| `elevenlabs-get-user-voices` | [hooks/useVoices.ts](../artifacts/mobile/hooks/useVoices.ts) 40 |
| `voice-token` | [services/geminiLive/client.ts](../artifacts/mobile/services/geminiLive/client.ts) 369<br>[services/voice/engine.ts](../artifacts/mobile/services/voice/engine.ts) 151 |
| `sarvam-voice` | [services/sarvamLive/client.ts](../artifacts/mobile/services/sarvamLive/client.ts) 143 |
| `ai-call-start` | [services/assistant/aiCalls.ts](../artifacts/mobile/services/assistant/aiCalls.ts) 90 |
| `ai-call-recording` | [services/hub/callLogs.ts](../artifacts/mobile/services/hub/callLogs.ts) 98 |
| `vapi-celebrity-call` | [app/(tabs)/voice-call.tsx](../artifacts/mobile/app/(tabs)/voice-call.tsx) 477 |
| `vapi-get-voices` | [app/voice-call-wish.tsx](../artifacts/mobile/app/voice-call-wish.tsx) 91 |
| `vapi-upload-voice` | [app/voice-call-wish.tsx](../artifacts/mobile/app/voice-call-wish.tsx) 135 |
| `vapi-make-call` | [app/voice-call-wish.tsx](../artifacts/mobile/app/voice-call-wish.tsx) 174 |
| `web-search` | [services/assistant/webSearch.ts](../artifacts/mobile/services/assistant/webSearch.ts) 76 |
| `b2-get-signed-url` | [components/bookings/CelebCard.tsx](../artifacts/mobile/components/bookings/CelebCard.tsx) 66<br>[components/bookings/WishFriendCard.tsx](../artifacts/mobile/components/bookings/WishFriendCard.tsx) 36<br>[services/library.ts](../artifacts/mobile/services/library.ts) 190 |

### Storage buckets (6)

| Name | Called from (file and lines) |
| --- | --- |
| `celebrity-avatars` | [components/celebrity-dashboard/ContentTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ContentTab.tsx) 50 |
| `greeting-card-uploads` | [app/wish-celebrity-occasion/[id].tsx](../artifacts/mobile/app/wish-celebrity-occasion/[id].tsx) 297, 307 |
| `profile-photos` | [app/edit-profile.tsx](../artifacts/mobile/app/edit-profile.tsx) 224, 242 |
| `promotional-content` | [app/wish-friend.tsx](../artifacts/mobile/app/wish-friend.tsx) 100, 105<br>[components/celebrity-dashboard/ContentTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ContentTab.tsx) 83<br>[components/ugc/FormFields.tsx](../artifacts/mobile/components/ugc/FormFields.tsx) 106, 111 |
| `verification-docs` | [app/edit-profile.tsx](../artifacts/mobile/app/edit-profile.tsx) 276, 294<br>[components/celebrity-dashboard/ConsentTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ConsentTab.tsx) 40, 41 |
| `voice-notes` | [app/chat/[id].tsx](../artifacts/mobile/app/chat/[id].tsx) 729, 751 |

### Supabase Auth routes

| Name | Called from (file and lines) |
| --- | --- |
| `/auth/v1/token` | [app/settings/security.tsx](../artifacts/mobile/app/settings/security.tsx) 79<br>[context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 224, 348, 513, 809 |
| `/auth/v1/signup` | [context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 481, 783 |
| `/auth/v1/user` | [app/edit-profile.tsx](../artifacts/mobile/app/edit-profile.tsx) 426<br>[app/settings/security.tsx](../artifacts/mobile/app/settings/security.tsx) 89<br>[components/celebrity-dashboard/ProfileTab.tsx](../artifacts/mobile/components/celebrity-dashboard/ProfileTab.tsx) 89<br>[context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 662 |
| `/auth/v1/recover` | [context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 671, 707 |
| `/auth/v1/logout` | [context/AuthContext.tsx](../artifacts/mobile/context/AuthContext.tsx) 634 |
| `/auth/v1/health` | [constants/supabase.ts](../artifacts/mobile/constants/supabase.ts) 66 |

### Realtime (Phoenix websocket, postgres_changes)

| Name | Called from (file and lines) |
| --- | --- |
| `/realtime/v1/websocket` | [app/dashboard.tsx](../artifacts/mobile/app/dashboard.tsx) 130<br>[components/bookings/useRealtimeBookings.tsx](../artifacts/mobile/components/bookings/useRealtimeBookings.tsx) 16<br>[components/celebrity-dashboard/BookingsTab.tsx](../artifacts/mobile/components/celebrity-dashboard/BookingsTab.tsx) 55<br>[components/celebrity-dashboard/FollowersTab.tsx](../artifacts/mobile/components/celebrity-dashboard/FollowersTab.tsx) 41<br>[components/celebrity-dashboard/MessagesTab.tsx](../artifacts/mobile/components/celebrity-dashboard/MessagesTab.tsx) 103, 142 |

## Domain sections

Each section lists one H4 per endpoint and method with callers, auth, filters, request fields, the response
fields the app reads, and behaviour notes, then the end-to-end flows of that domain. An endpoint used by several
domains appears in each of them with that domain's call sites.


---

## Domain 1 — Auth, profiles, wallet, payments, plans, referrals

Scope: every Supabase call made from these files under `artifacts/mobile`:
`context/AuthContext.tsx`, `app/(auth)/index.tsx`, `app/(auth)/verify-otp.tsx` (no direct calls), `app/edit-profile.tsx`,
`app/settings/security.tsx`, `app/(tabs)/profile.tsx`, `app/dashboard.tsx`, `hooks/useWallet.ts`, `hooks/usePlan.ts`,
`app/select-plan.tsx`, `app/referrals.tsx`, `app/commission.tsx`, `components/wallet/{DepositModal,WithdrawModal,TransactionsTab,ReferralEarningsTab,shared}.tsx`,
`components/scan-pay/ScanPayScreen.tsx`, `services/hub/notifications.ts` (push_tokens only), `constants/supabase.ts`.

### Transport conventions (constants/supabase.ts, services/supabaseRest.ts)

- `supabaseFetch(path, options, accessToken?)` (`constants/supabase.ts:16`) prefixes `SUPABASE_URL` and always sends
  `apikey: <anon key>`, `Authorization: Bearer <accessToken ?? anon key>`, `Content-Type: application/json`, then spreads
  `options.headers` over those. **A `null`/`undefined` token silently means "anon key as bearer"** — several call sites below
  rely on that (flagged "anon key only"). Every request is aborted after **20 s** (`FETCH_TIMEOUT_MS`).
- `parseApiError(res)` (`constants/supabase.ts:41`) reads `error_description || error || message || msg` from the JSON
  body, else `Request failed (<status>)`. The app matches on these strings (see OTP / login entries), so a replacement API
  must return the same shape *and* the same words (`invalid`, `expir`, `used`/`already`, `already registered`).
- `services/supabaseRest.ts`: `fetchRows` (GET → array, `null` → `[]`), `fetchOne` (first row or `null`; caller adds
  `limit=1`), `insertRows` / `updateRows` (POST / PATCH with `Prefer: return=representation`, return array),
  `deleteRows` (DELETE), `callRpc(name, args)` (POST `/rest/v1/rpc/<name>`). Non-2xx → `SupabaseRestError{status,path}`.
  In this domain only `fetchOne`/`fetchRows` are used (useWallet, usePlan); everything else is hand-rolled `supabaseFetch`
  or raw `fetch`.
- Several files bypass `supabaseFetch` with raw `fetch(`${SUPABASE_URL}...`)` and hand-built headers (DepositModal,
  WithdrawModal, edit-profile storage uploads + password change, dashboard celebrity check). Same header set.
- Local storage (AsyncStorage) keys: `@wishme/session` `{access_token, refresh_token}`, `@wishme/user` (the `User`
  object incl. `profileId`, `walletBalance`, `referralCode`, `gender`), `@wishme/pending_signup`, legacy `user` (migrated
  then removed). `edit-profile.tsx:177` reads `@wishme/session` **directly** (not via `getValidSession`), so it can use a
  stale access token.
- Token lifecycle (`AuthContext.tsx:159-176, 220-251, 334-340`): JWT `exp` is decoded client-side; a token is "stale"
  when it expires within 5 min. `getValidSession()` refreshes single-flight. On app start a stale token is refreshed in the
  background; only a non-5xx refusal signs the user out (5xx / network = "offline", keep session).

---

### Supabase Auth (/auth/v1)

#### `GET /auth/v1/health`
- **Callers:** `constants/supabase.ts:66` — `warmUpBackend()`: opens DNS/TLS when the sign-in screen mounts (`app/(auth)/index.tsx:554`).
- **Auth:** anon key only (header `apikey` only, no `Authorization`).
- **Query / filters:** none.
- **Request body:** none.
- **Response fields the app reads:** none (result and errors ignored).
- **Behaviour notes:** throttled to once per 60 s (`warmedAt`). Fired together with the two `OPTIONS /functions/v1/...` pre-warms (see Edge functions).

#### `POST /auth/v1/token?grant_type=password`
- **Callers:**
  - `context/AuthContext.tsx:348` — `login()`: primary sign-in.
  - `context/AuthContext.tsx:513` — `verifyOtp()`: fallback sign-in when `/auth/v1/signup` returned no `access_token` (e.g. email confirmation on).
  - `context/AuthContext.tsx:809` — `applyCelebrityWithAuth()`: same fallback for the celebrity signup.
  - `app/settings/security.tsx:79` — change-password screen re-authenticates with the *current* password purely to verify it (Supabase does not check the old password on update).
- **Auth:** anon key only.
- **Query / filters:** `grant_type=password`.
- **Request body:** `{ email: string (trimmed+lowercased in login), password: string }`.
- **Response fields the app reads:** `access_token`, `refresh_token`, `user` (object) → `user.id`, `user.email`, `user.user_metadata.{first_name|firstName, last_name|lastName, phone, role, wallet_balance, member_since, gender}` (via `buildUserFromSupabase`, `AuthContext.tsx:182`). `security.tsx` reads only `access_token`.
- **Behaviour notes:** on `!ok`, `parseApiError` text containing `invalid` is mapped to "Incorrect email or password". `login()` then immediately does the profiles GET (below) and **fails the login** if no profile row exists ("Account profile not found"). `security.tsx` creates a throwaway session (never stored) just to validate the password — a custom API should expose "verify current password" or "change password with current password" instead. Session + user are persisted to AsyncStorage without awaiting.

#### `POST /auth/v1/token?grant_type=refresh_token`
- **Callers:** `context/AuthContext.tsx:224` — `doRefresh()`, used by `getValidSession()` and the app-start restore.
- **Auth:** anon key only.
- **Query / filters:** `grant_type=refresh_token`.
- **Request body:** `{ refresh_token: string }`.
- **Response fields the app reads:** `access_token` (required; missing → treated as revoked), `refresh_token` (optional; falls back to the old one).
- **Behaviour notes:** single-flight (`refreshInFlight`) because Supabase rotates refresh tokens — two overlapping refreshes make the second fail. Status `>= 500` or network error = `'offline'` (keep signed in); any other non-ok = revoked (sign out, clear `@wishme/session` + `@wishme/user`). New session written to `@wishme/session`.

#### `POST /auth/v1/signup`
- **Callers:**
  - `context/AuthContext.tsx:481` — `verifyOtp()`: creates the regular user **after** the custom email OTP was verified.
  - `context/AuthContext.tsx:783` — `applyCelebrityWithAuth()`: creates the celebrity applicant's auth user.
- **Auth:** anon key only.
- **Query / filters:** none.
- **Request body (user):** `{ email, password, data: { first_name, last_name, phone, referral_code: string ('' if none — the code the user was *referred by*), gender: 'male'|'female'|'other'|null, role: 'user', wallet_balance: 0, member_since: 'YYYY-MM-DD' } }`.
- **Request body (celebrity):** `{ email, password, data: { first_name, last_name, phone, role: 'celebrity_pending', member_since: 'YYYY-MM-DD' } }`.
- **Response fields the app reads:** `access_token`, `refresh_token` (may be absent → password-grant fallback), `user` (or the whole body if no `user` key) → `id`, `email`, `user_metadata.*` as above.
- **Behaviour notes:** error text containing `already registered` / `already exists` → "account exists" message. The profile row (and the user's own `referral_code`) is created by a **DB trigger** on auth user insert — the app polls for it (profiles GET below, 3 attempts × 1.5 s). The migration must keep "signup creates profile + referral code + applies `referral_code` metadata as the referrer link" server-side. After signup the app fires `send-whatsapp-welcome` and `trigger-message-event` (see Edge functions).

#### `POST /auth/v1/logout`
- **Callers:** `context/AuthContext.tsx:634` — `logout()`.
- **Auth:** user access token.
- **Request body:** none (empty POST).
- **Response fields the app reads:** none; errors swallowed. Local state and AsyncStorage (`@wishme/session`, `@wishme/user`, `@wishme/pending_signup`, `user`) are cleared regardless.

#### `PUT /auth/v1/user`
- **Callers:**
  - `context/AuthContext.tsx:662` — `setGender()`: `{ data: { gender } }` (updates `user_metadata`; best effort, offline ignored).
  - `app/edit-profile.tsx:426` — "Account Security" card: `{ password: newPassword }` (raw `fetch`, token read from AsyncStorage; min 6 chars).
  - `app/settings/security.tsx:89` — `{ password: next }` using the `access_token` obtained from the password-grant check above (min 8 chars).
- **Auth:** user access token.
- **Response fields the app reads:** none (only `res.ok`; error via `parseApiError`).
- **Behaviour notes:** gender is stored in auth metadata *only* (comment: "so no database change is needed") — profiles has no gender column the app knows of. Two different password-change UIs with different minimum lengths (6 vs 8).

#### `POST /auth/v1/recover`
- **Callers:**
  - `context/AuthContext.tsx:671` — `forgotPasswordByEmail(email)`.
  - `context/AuthContext.tsx:707` — `forgotPasswordByPhone(phone)` after resolving the email (see `GET /rest/v1/profiles` anon lookup).
- **Auth:** anon key only.
- **Request body:** `{ email }`.
- **Response fields the app reads:** none (`res.ok` only).
- **Behaviour notes:** UI text says "reset link" (email) or "reset OTP" (phone) but both paths send the same Supabase recovery email. There is no in-app screen that consumes the recovery link/token.

---

### Tables

#### `GET /rest/v1/bank_details`
- **Callers:** `components/wallet/WithdrawModal.tsx:60` — load the celebrity's default bank account when the Withdraw sheet opens.
- **Auth:** user access token (raw `fetch`).
- **Query / filters:** `user_id=eq.<profileId>&order=is_default.desc&select=*&limit=1`.
- **Request body:** none.
- **Response fields the app reads:** array; `[0].id`, `account_number`, `bank_name`, `ifsc_code`, `account_holder_name`, `is_default`.
- **Behaviour notes:** **Inconsistency:** the Withdraw sheet tells the user to "add bank details in Edit Profile", but `edit-profile.tsx` writes bank data to `profiles.bank_account_number / bank_name / bank_ifsc / bank_account_holder_name`, never to `bank_details`. Nothing in the app writes `bank_details`. The migration should pick one source.

#### `HEAD /rest/v1/bookings`  (count only)
- **Callers:** `app/(tabs)/profile.tsx:83` — "Bookings" stat on the profile tab (summed with `wish_friend_orders`).
- **Auth:** user access token.
- **Query / filters:** `select=id&user_id=eq.<profileId>&limit=1` with header `Prefer: count=exact`.
- **Request body:** none.
- **Response fields the app reads:** `Content-Range` header, regex `/\/(\d+)$/` → total count. Body ignored.
- **Behaviour notes:** same HEAD+count pattern for `wish_friend_orders` and `celebrity_favorites` (below). A replacement needs a cheap "count my rows" endpoint for these three tables. (Tables themselves belong to the bookings domain.)

#### `GET /rest/v1/celebrities`
- **Callers:**
  - `app/dashboard.tsx:209` — "am I a celebrity?" check (raw `fetch`, header `Accept: application/vnd.pgrst.object+json`; status `200` = yes, anything else (406 when 0 rows) = no). Query: `select=id&profile_id=eq.<profileId>&limit=1`.
  - `components/wallet/WithdrawModal.tsx:54` — load celebrity id + withdrawable balance. Query: `profile_id=eq.<profileId>&select=id,available_balance&limit=1`.
- **Auth:** user access token.
- **Response fields the app reads:** dashboard: status code only. WithdrawModal: array `[0].id` (→ `celebrity_id` of the payout), `[0].available_balance`.
- **Behaviour notes:** `login()` detects celebrity differently — via the embedded `celebrities(id)` join on profiles (below). Three different "is celebrity" signals exist: `profiles.role === 'celebrity'`, non-empty `celebrities(id)` embed, and a `celebrities` row by `profile_id`.

#### `PATCH /rest/v1/celebrities`  **(client writes money — must move server-side)**
- **Callers:** `components/wallet/WithdrawModal.tsx:139` — after inserting the payout request, debit the celebrity's balance.
- **Auth:** user access token (raw `fetch`).
- **Query / filters:** `id=eq.<celebrityId>`; header `Prefer: return=minimal`.
- **Request body:** `{ available_balance: <celebAvailableBalance - amount> }` — a **client-computed absolute value**, not a decrement.
- **Response fields the app reads:** none; result not even checked for `ok`.
- **Behaviour notes:** race-prone and trusts the client. Two payout requests in flight would double-spend or overwrite. Replacement: one atomic "request payout" endpoint that validates `amount <= available_balance`, inserts `payout_requests` and decrements in a transaction.

#### `GET /rest/v1/celebrity_applications`
- **Callers:** `context/AuthContext.tsx:840` — `checkCelebrityStatus(email)` ("Already applied? Check status" on the auth screen).
- **Auth:** anon key only.
- **Query / filters:** `select=id,status&email=eq.<encodeURIComponent(email)>&limit=1`.
- **Response fields the app reads:** array; `[0].status` (`'pending' | 'approved' | 'rejected'`). Empty/err → "No application found".
- **Behaviour notes:** anonymous lookup of applications by email — information leak to preserve or (better) rate-limit.

#### `POST /rest/v1/celebrity_applications`
- **Callers:**
  - `context/AuthContext.tsx:723` — `applyCelebrity(data: CelebrityApplyData)` — explicit `null` token → anon.
  - `context/AuthContext.tsx:819` — `applyCelebrityWithAuth(...)` after OTP + signup — token if obtained, else anon.
- **Auth:** either (anon in `applyCelebrity`; user token when available in `applyCelebrityWithAuth`, otherwise anon).
- **Query / filters:** none; header `Prefer: return=minimal`.
- **Request body:** the form object verbatim. `CelebrityApplyData`: `{ first_name, last_name, email, phone, dob, stage_name, category, bio, achievements, instagram, youtube, twitter, portfolio }`. `CelebrityFormData`: `{ first_name, last_name, email, phone, date_of_birth: string|null, stage_name, category, bio, achievements, portfolio_link: string|null, social_media: { instagram, youtube, twitter, tiktok, facebook, linkedin, website, other } }`. (Two different column sets hit the same table — the live schema must accept both or one path is dead.)
- **Response fields the app reads:** none; `status === 201 || ok` = success.
- **Behaviour notes:** `applyCelebrityWithAuth` order: `verify-email-otp` → `/auth/v1/signup` (role `celebrity_pending`) → (`token?grant_type=password` fallback) → this insert. Approval (role flip, `celebrities` row) is an admin/server job the app never performs.

#### `HEAD /rest/v1/celebrity_favorites`  (count only)
- **Callers:** `app/(tabs)/profile.tsx:85` — "Favorites" stat.
- **Auth:** user access token.
- **Query / filters:** `select=id&user_id=eq.<profileId>&limit=1`, `Prefer: count=exact`.
- **Response fields the app reads:** `Content-Range` total.

#### `GET /rest/v1/celebrity_wallet_transactions`
- **Callers:** `app/commission.tsx:165-173` — "Celebrity Commissions" list + TDS totals on the Commission screen.
- **Auth:** user access token.
- **Query / filters:** `celebrity_id=eq.<profileId>&transaction_type=eq.earning&order=created_at.desc` plus optional `&created_at=gte.<YYYY-MM-DD>T00:00:00` and `&created_at=lte.<YYYY-MM-DD>T23:59:59`. No `select` (all columns).
- **Response fields the app reads:** array of `{ id, amount, gross_amount, tds_percentage, tds_amount, description, created_at }` (type also declares `celebrity_id, booking_id, transaction_type, commission_percentage, status`).
- **Behaviour notes:** **Filters by `celebrity_id = profileId`**, whereas WithdrawModal uses `celebrities.id` as the celebrity id. One of these is wrong unless `celebrity_wallet_transactions.celebrity_id` actually stores the profile id. Verify against the schema before re-implementing.

#### `GET /rest/v1/payment_transactions`
- **Callers:** `components/wallet/TransactionsTab.tsx:89` — builds an `amount → wishme_payment_id` lookup so wallet rows can show / be searched by WishMe payment ID.
- **Auth:** user access token.
- **Query / filters:** `user_id=eq.<profileId>&select=wishme_payment_id,user_id,amount,paid_at&order=paid_at.desc`.
- **Response fields the app reads:** array; `wishme_payment_id`, `amount` (keyed by `String(Math.abs(amount))`, first wins).
- **Behaviour notes:** the join is by *amount*, not by id — two deposits of the same amount share one WM id in the UI. A replacement wallet-transactions endpoint should return `wishme_payment_id` on the row instead.

#### `POST /rest/v1/payment_transactions`  **(client writes money — must move server-side)**
- **Callers:** `components/wallet/DepositModal.tsx:116` — after Razorpay verify, record the payment.
- **Auth:** user access token (raw `fetch`); `Prefer: return=minimal`.
- **Request body:** `{ wishme_payment_id: <verifyData.wishme_payment_id ?? generateWMId() ('WM' + 8 chars, client-random)>, user_id: <profileId>, amount: number (rupees), payment_method: 'razorpay', service_type: 'deposit', razorpay_payment_id, razorpay_order_id, description: 'Wallet deposit of ₹<amount>', status: 'completed', paid_at: ISO now }`.
- **Response fields the app reads:** none (result not checked).
- **Behaviour notes:** called *after* the `wallet_transactions` insert, both unchecked; a failure leaves the ledger inconsistent. Should be written by `verify-razorpay-payment` server-side.

#### `POST /rest/v1/payout_requests`  **(client writes money — must move server-side)**
- **Callers:** `components/wallet/WithdrawModal.tsx:117` — celebrity withdrawal request.
- **Auth:** user access token (raw `fetch`); `Prefer: return=minimal`.
- **Request body:** `{ celebrity_id: <celebrities.id>, profile_id: <profileId>, requested_amount: number, bank_account_number, bank_name, ifsc_code, account_holder_name, status: 'pending' }` (bank fields copied from the `bank_details` row).
- **Response fields the app reads:** none; `!ok` → "Failed to submit withdrawal request".
- **Behaviour notes:** validation (`amount > 0`, `amount <= available_balance`, bank details present) is client-side only. Followed by the `PATCH celebrities.available_balance` above.

#### `GET /rest/v1/plans`
- **Callers:**
  - `hooks/usePlan.ts:45` — `select=*&is_active=eq.true` (via `fetchRows`); matches current plan by `name` (case-insensitive) to get `service_discount_percentage`.
  - `app/select-plan.tsx:98` — `is_active=eq.true&order=price.asc` (all columns).
  - `app/referrals.tsx:121` — `select=name,price,referral_commission_l1,referral_commission_l2&is_active=eq.true&order=price.asc`.
- **Auth:** user access token (select-plan passes `session?.access_token ?? null`, so anon when logged out).
- **Response fields the app reads:** `id`, `name` (expected values `basic|premium|elite`, compared lower-cased), `price` (rupees/year), `original_price`, `service_discount_percentage`, `referral_commission_l1`, `referral_commission_l2`, `is_active`, `features` (string[] **or** object whose string values are shown). `is_popular` is typed but not used ("MOST POPULAR" = name `premium`).
- **Behaviour notes:** default plan when the profile has none: `'basic'` (`usePlan.ts:24`, `referrals.tsx:115`).

#### `GET /rest/v1/profiles`
- **Callers:**
  - `context/AuthContext.tsx:368` — `login()`: `select=id,first_name,last_name,phone,role,wallet_balance,referral_code,celebrities(id)&user_id=eq.<authUserId>&limit=1`.
  - `context/AuthContext.tsx:307` — app-start restore after a token refresh: `select=id,first_name,last_name,phone,role,wallet_balance,referral_code&user_id=eq.<authUserId>&limit=1`.
  - `context/AuthContext.tsx:561` — post-signup poll (3 attempts, 1.5 s apart): `select=id,wallet_balance,referral_code&user_id=eq.<authUserId>&limit=1`.
  - `context/AuthContext.tsx:694` — `forgotPasswordByPhone`: `select=email&phone=eq.<encodeURIComponent(phone)>&limit=1`, tried for `+91XXXXXXXXXX`, `XXXXXXXXXX`, `91XXXXXXXXXX` in turn — **anon key only** (phone→email lookup without auth).
  - `app/edit-profile.tsx:148` — `user_id=eq.<authUserId>&select=*` — **explicit `null` token → anon key** (loads the full profile incl. Aadhaar/PAN/bank with the anon key).
  - `hooks/useWallet.ts:22` — `select=id,wallet_balance&user_id=eq.<authUserId>&limit=1` (via `fetchOne`, `getValidSession()` token). Used by wallet tab, profile tab and ~12 service screens.
  - `hooks/usePlan.ts:41` — `select=plan&id=eq.<profileId>&limit=1`.
  - `app/select-plan.tsx:104` — `select=plan&id=eq.<profileId>&limit=1`.
  - `app/referrals.tsx:108` — `select=plan,referral_code,referral_url&id=eq.<profileId>&limit=1`.
  - `app/dashboard.tsx:199` and `:245` — `select=wallet_balance&id=eq.<profileId>&limit=1` (initial load + on realtime UPDATE).
  - `components/scan-pay/ScanPayScreen.tsx:230` — `select=wallet_balance&id=eq.<profileId>&limit=1` after the payment insert.
- **Auth:** user access token everywhere except the two anon cases flagged above (`AuthContext.tsx:694`, `edit-profile.tsx:148`) — these imply the live RLS allows anon reads of `profiles` (at least `email`, and in edit-profile the full row).
- **Query / filters:** two key styles: `user_id=eq.<auth.users.id>` (AuthContext, useWallet, edit-profile) and `id=eq.<profiles.id>` (everything that has `user.profileId`). Embedded resource: `celebrities(id)` (FK celebrities.profile_id → profiles.id).
- **Response fields the app reads:** always an array, `[0]` used. Columns: `id`, `user_id`, `first_name`, `last_name`, `email`, `phone`, `role` (`'celebrity'` or other), `wallet_balance` (number), `member_since` (read in AuthContext even though **not** in its `select` — always undefined today), `referral_code` (user's own code), `referral_url`, `plan` (`basic|premium|elite|null`), `address`, `avatar_url`, `aadhaar_number`, `pan_number`, `aadhaar_verified`, `pan_verified`, `pan_document_url`, `bank_name`, `bank_account_number`, `bank_ifsc`, `bank_account_holder_name`, `profile_completion_percentage`, `celebrities` (embedded array of `{id}`).
- **Behaviour notes:** `wallet_balance` on profiles is **the** balance the UI shows (hero cards, Scan & Pay check, service screens). `login()` hard-fails without a profile row. Role resolution: `p.role === 'celebrity' || celebrities.length > 0`.

#### `PATCH /rest/v1/profiles`
- **Callers:**
  - `app/edit-profile.tsx:385` — Save: `user_id=eq.<authUserId>`, body `{ first_name, last_name, phone, avatar_url, address, bank_account_number, bank_name, bank_ifsc, bank_account_holder_name, aadhaar_number, pan_number, profile_completion_percentage: <client-computed 20..100> }`, `Prefer: return=minimal`.
  - `app/edit-profile.tsx:297` — after PAN upload: `user_id=eq.<authUserId>`, body `{ pan_document_url: <public URL> }`, `Prefer: return=minimal`.
  - `app/select-plan.tsx:215` — after Razorpay verify: `id=eq.<profileId>`, body `{ plan: <plan.name.toLowerCase()> }`, `Prefer: return=minimal`. **Client sets its own paid plan** — must move into the verify step server-side.
- **Auth:** user access token (edit-profile uses the token read from AsyncStorage).
- **Response fields the app reads:** none (`ok` only).
- **Behaviour notes:** the app never writes `profiles.wallet_balance` directly — it relies on DB triggers on `wallet_transactions` (see there). `profile_completion_percentage` is computed on the client (`computeCompletion`, `edit-profile.tsx:51`): 20 + 8 per filled field (10 fields) + 10 each for `aadhaar_verified` / `pan_verified`, capped at 100. Aadhaar/PAN/bank numbers are stored in plain text on the profile row.

#### `POST /rest/v1/push_tokens`
- **Callers:** `services/hub/notifications.ts:96` — `registerPushToken(accessToken, projectId?)`.
- **Auth:** user access token.
- **Query / filters:** none; header `Prefer: resolution=merge-duplicates` (upsert on the table's unique key — presumably `token`).
- **Request body:** `{ token: <Expo push token>, platform: 'ios'|'android'|'web', last_seen_at: ISO now }`. **No `user_id`** — the server must default it from the JWT.
- **Response fields the app reads:** none; errors swallowed.
- **Behaviour notes:** skipped on simulators and when notification permission is not granted. **`registerPushToken` is exported but never called anywhere in the app** (grep: only its definition) — push registration is currently dead code; the backstop push described in the file header never gets a token.

#### `GET /rest/v1/referral_transactions`
- **Callers:**
  - `app/commission.tsx:159-171` — completed: `referrer_id=eq.<profileId>&status=eq.completed&order=created_at.desc` [+ `&created_at=gte.<date>T00:00:00` / `&created_at=lte.<date>T23:59:59`]; pending: `referrer_id=eq.<profileId>&status=eq.pending&order=created_at.desc`.
  - `components/wallet/TransactionsTab.tsx:65` — `referrer_id=eq.<profileId>&select=*&order=created_at.desc`, merged into the wallet list as synthetic `transaction_type: 'referral_commission'` rows.
  - `components/wallet/ReferralEarningsTab.tsx:45` — `referrer_id=eq.<profileId>&select=*`.
- **Auth:** user access token.
- **Response fields the app reads:** `id`, `referrer_id`, `referred_id`, `booking_id`, `commission_level` (1|2), `commission_amount`, `status` (`completed|pending`), `order_type` (`ugc_video|ugc_ad|wish_friend|...`), `created_at`.
- **Behaviour notes:** `referrals.tsx` deliberately does **not** read this table and uses the `get_my_referral_history` RPC instead (needs the referred person's name, which RLS hides). Earnings are summed client-side.

#### `GET /rest/v1/wallet_transactions`
- **Callers:**
  - `app/dashboard.tsx:204` — `user_id=eq.<profileId>&order=created_at.desc&limit=50` (all columns); stat cards sum `amount` of `status==='completed'` rows by type group.
  - `components/wallet/TransactionsTab.tsx:48` — `user_id=eq.<uid>&select=*&order=created_at.desc`; first with `profileId`, and **if that returns 0 rows and `user.id !== profileId`, retried with the auth user id** (legacy rows keyed by `auth.users.id`).
- **Auth:** user access token.
- **Response fields the app reads:** `id`, `transaction_type`, `amount`, `status` (`completed|pending|failed|rejected`), `description`, `created_at`.
- **Behaviour notes:** `transaction_type` vocabulary the UI knows (`shared.tsx:13,47-96`, `dashboard.tsx:38-101`): credits = `deposit, admin_credit, commission_earning, referral_commission`; debits = `booking, photo_wish, ugc_video, music_generation, music_download, celebrity_call, voice_call, voice_call_wish, greeting_card_generation, image_promotion, service_payment, plan_upgrade, plan_purchase, debit, refund, withdrawal, celebrity_subscription`. Unknown types are title-cased.

#### `POST /rest/v1/wallet_transactions`  **(client writes money — must move server-side)**
- **Callers:**
  - `components/wallet/DepositModal.tsx:94` — after Razorpay verify (raw `fetch`, `Prefer: return=minimal`): `{ user_id: <profileId>, transaction_type: 'deposit', amount, status: 'completed', payment_method: 'razorpay', description: 'Wallet deposit of ₹<amount>', transaction_details: { razorpay_order_id, razorpay_payment_id } }`. Result unchecked.
  - `app/select-plan.tsx:229` — after plan verify + profile PATCH (`Prefer: return=minimal`): `{ user_id: <profileId>, transaction_type: 'plan_purchase', amount: plan.price, status: 'completed', payment_method: 'razorpay', transaction_details: { plan_name, plan_id, razorpay_payment_id, razorpay_order_id, razorpay_signature } }`. Result unchecked.
  - `components/scan-pay/ScanPayScreen.tsx:196` — pay a scanned UPI/merchant code from the wallet (`Prefer: return=representation`): `{ user_id: <profileId>, amount, transaction_type: 'service_payment', status: 'completed', payment_method: 'wallet', description: 'Scan & Pay · <payeeName>', transaction_details: { channel: 'scan_pay', payee_id, payee_name, note?, raw: <first 500 chars of QR> } }`. Reads `[0].id` (first 8 chars upper-cased shown as Txn id). On `!ok` shows `res.text()`.
- **Auth:** user access token.
- **Behaviour notes:** The code comment at `ScanPayScreen.tsx:229` ("trigger deducts on completed debit types") documents the implicit contract: **a DB trigger on `wallet_transactions` adjusts `profiles.wallet_balance`** — credits for credit types, debits for debit types, when `status = 'completed'`. The client never touches `wallet_balance` itself but fully controls the ledger rows (amount, type, status). Consequences the migration must address: (a) anyone with a token can credit themselves with a `deposit` row; (b) Scan & Pay enforces "sufficient balance" only on the client; (c) the `plan_purchase` row is inserted with `status: 'completed'` for a Razorpay-paid plan — if the trigger treats it as a debit type, buying a plan **also debits the wallet** by the plan price (needs verification against the trigger). Server-side equivalents: `verify-razorpay-payment` should write the deposit/plan rows; Scan & Pay needs a `pay_from_wallet` endpoint that checks and debits atomically.

#### `HEAD /rest/v1/wish_friend_orders`  (count only)
- **Callers:** `app/(tabs)/profile.tsx:84` — added to the "Bookings" stat.
- **Auth:** user access token.
- **Query / filters:** `select=id&user_id=eq.<profileId>&limit=1`, `Prefer: count=exact`.
- **Response fields the app reads:** `Content-Range` total.

---

### RPCs

#### `POST /rest/v1/rpc/validate_referral_code`
- **Callers:** `app/(auth)/index.tsx:242` — `lookupReferral(code)` on the sign-up form: debounced 450 ms once the code is ≥ 4 chars, and again synchronously before `signup()` if the check had not settled.
- **Auth:** anon key only.
- **Request body:** `{ p_code: string }` (upper-cased, whitespace stripped).
- **Response fields the app reads:** the JSON body is a **scalar**: the referrer's display name (`string`) when valid, `null`/empty when not. Non-ok → treated as invalid.
- **Behaviour notes:** a code the server rejects blocks sign-up ("That referral code does not exist"). Validated code is then passed as `referral_code` in `/auth/v1/signup` metadata.

#### `POST /rest/v1/rpc/get_my_referrals`
- **Callers:**
  - `app/(tabs)/profile.tsx:76` — "Referrals" stat.
  - `app/referrals.tsx:127` — "Total Referrals" stat.
- **Auth:** user access token (caller identity comes from the JWT; no args).
- **Request body:** `{}` (literal `'{}'`).
- **Response fields the app reads:** array; only `.length` is used (one element per directly referred user).

#### `POST /rest/v1/rpc/get_my_referral_history`
- **Callers:** `app/referrals.tsx:126` — referral history table + earnings totals.
- **Auth:** user access token (identity from JWT).
- **Request body:** `{}`.
- **Response fields the app reads:** array of `{ id, commission_level: 1|2, commission_amount: number, status: string ('completed'|'pending'|...), created_at, order_type: string|null, referred_name: string }`.
- **Behaviour notes:** exists because `profiles` is private under RLS; the function joins the referred user's name. Totals (`completed` sum, `pending` sum, L1/L2 counts) are computed client-side.

---

### Edge functions

#### `OPTIONS /functions/v1/send-email-otp`, `OPTIONS /functions/v1/verify-email-otp`
- **Callers:** `constants/supabase.ts:69` — `warmUpBackend()` (cold-start the function workers).
- **Auth:** `apikey` header only.
- **Response fields the app reads:** none.

#### `POST /functions/v1/send-email-otp`
- **Callers:**
  - `context/AuthContext.tsx:428` — `signup()` (user sign-up step 1; stores `PendingSignup` in state + `@wishme/pending_signup`, password kept in memory only).
  - `context/AuthContext.tsx:616` — `resendOtp()` (30 s client cooldown in `verify-otp.tsx`).
  - `context/AuthContext.tsx:742` — `sendCelebOtp()` (celebrity sign-up).
- **Auth:** anon key only.
- **Request body:** `{ email: string }`.
- **Response fields the app reads:** on `429`: `retryAfter` or `retry_after` (seconds, default 60). Status codes with fixed meanings: `409` = email already registered ("sign in instead"), `400` = invalid email, `429` = rate limited. Otherwise `parseApiError`.
- **Behaviour notes:** the function must check for an existing account (409) *before* sending, since `/auth/v1/signup` only happens after OTP verification. UI promises "code expires in 10 minutes".

#### `POST /functions/v1/verify-email-otp`
- **Callers:**
  - `context/AuthContext.tsx:466` — `verifyOtp(code)` (user).
  - `context/AuthContext.tsx:770` — `applyCelebrityWithAuth()` (celebrity).
- **Auth:** anon key only.
- **Request body:** `{ email: string, otp: string (6 digits) }`.
- **Response fields the app reads:** none on success (`ok`). On error the `parseApiError` text is pattern-matched: contains `expir` → "code has expired" (and `verify-otp.tsx` navigates back after 2.5 s); `invalid|incorrect|wrong` → "Invalid code"; `used|already` → "already been used".
- **Behaviour notes:** success is immediately followed by `/auth/v1/signup`. **Nothing binds the two calls** — a custom API should return a short-lived signed proof from verify that signup requires, otherwise the OTP check is decorative.

#### `POST /functions/v1/send-whatsapp-welcome`
- **Callers:** `context/AuthContext.tsx:592` — fire-and-forget after successful user sign-up.
- **Auth:** user access token if the signup returned one, else anon.
- **Request body:** `{ phone: '+91' + 10 digits (normalised from `phone` by stripping a leading `91`), name: firstName }`.
- **Response fields the app reads:** none; errors swallowed.

#### `POST /functions/v1/trigger-message-event`
- **Callers:** `context/AuthContext.tsx:597` — fire-and-forget after successful user sign-up.
- **Auth:** user access token if available, else anon.
- **Request body:** `{ event: 'signup_complete', user_id: <auth user id>, email }`.
- **Response fields the app reads:** none; errors swallowed.
- **Behaviour notes:** other `event` values may be sent from other domains; in this domain only `signup_complete`.

#### `POST /functions/v1/create-razorpay-order`
- **Callers:**
  - `components/wallet/DepositModal.tsx:42` — wallet top-up (raw `fetch`). Body `{ amount: <rupees, int ≥ 100>, currency: 'INR', receipt: 'wallet_<profileId>_<ts>'.slice(0,40), notes: { user_id: <profileId>, type: 'wallet_deposit' } }`.
  - `app/select-plan.tsx:158` — plan purchase. Body `{ amount: plan.price, currency: 'INR', receipt: 'plan_<profileId[0:8]>_<ts>'.slice(0,40), notes: { user_id: <profileId>, plan_name: plan.name, type: 'plan_purchase' } }`.
- **Auth:** user access token.
- **Response fields the app reads:** `id` (Razorpay order id → `order_id` in checkout), `amount` (passed straight to Razorpay checkout, so the function must return **paise**), `key_id` (Razorpay public key), `currency` (select-plan only, default `'INR'`). Error body: `error`.
- **Behaviour notes:** amount is sent in rupees and the returned `amount` is used as-is by the SDK; the function is therefore the rupee→paise converter. Checkout: `react-native-razorpay` `RazorpayCheckout.open({ key, amount, currency, name: 'WishMe', description, order_id, prefill: {name,email,contact}, theme })`; `select-plan.tsx` also has a web path loading `checkout.razorpay.com/v1/checkout.js`. User cancel is detected by `err.description` containing `cancel`.

#### `POST /functions/v1/verify-razorpay-payment`
- **Callers:**
  - `components/wallet/DepositModal.tsx:76` — body `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`.
  - `app/select-plan.tsx:197` — same three fields.
- **Auth:** user access token.
- **Response fields the app reads:** DepositModal: `success` (boolean, **the** success signal — `res.ok` is not checked), `wishme_payment_id` (optional; else client generates `WM` + 8 random chars), `error`. select-plan: `res.ok` only; `error` on failure.
- **Behaviour notes:** today this function only verifies the signature; the **ledger writes happen on the client afterwards** (`wallet_transactions`, `payment_transactions`, `profiles.plan`). In the new backend this endpoint (or a Razorpay webhook) must do those writes itself and return `{ success, wishme_payment_id, new_balance? }`.

---

### Storage buckets

#### `POST /storage/v1/object/profile-photos/<authUserId>/profile_<timestamp>.<ext>`
- **Callers:** `app/edit-profile.tsx:223` — avatar picker (image ≤ 5 MB, square-cropped, quality 0.8).
- **Auth:** user access token (raw `fetch`, token from AsyncStorage).
- **Request body:** raw image `Blob`; `Content-Type: image/<ext>` (`jpg` → `image/jpeg`). No `x-upsert`.
- **Response fields the app reads:** none (`ok` + `parseApiError`).
- **Behaviour notes:** the app then *constructs* `SUPABASE_URL + /storage/v1/object/public/profile-photos/<path>` and saves it in `profiles.avatar_url` on the next Save (not immediately). Bucket must be public-read.

#### `POST /storage/v1/object/verification-docs/<authUserId>/pan_<timestamp>.<ext>`
- **Callers:** `app/edit-profile.tsx:275` — PAN document picker (`image/*` or `application/pdf`).
- **Auth:** user access token.
- **Request body:** raw file `Blob`; `Content-Type: <asset.mimeType ?? 'application/pdf'>`.
- **Response fields the app reads:** none.
- **Behaviour notes:** public URL `.../object/public/verification-docs/<path>` is written **immediately** to `profiles.pan_document_url` via PATCH (`edit-profile.tsx:297`). A KYC document in a public bucket — the migration should make this private + signed URLs.

---

### Realtime (/realtime/v1)

#### `WSS /realtime/v1/websocket?apikey=<anon>&vsn=1.0.0`
- **Callers:** `app/dashboard.tsx:123-175` — `useRealtimeBalance(profileId, accessToken, onUpdate)`.
- **Auth:** anon key in the URL; user access token in the join payload.
- **Protocol:** Phoenix. On open sends `{ topic: 'realtime:public:profiles', event: 'phx_join', payload: { config: { broadcast: {ack:false,self:false}, postgres_changes: [{ event: 'UPDATE', schema: 'public', table: 'profiles', filter: 'id=eq.<profileId>' }] }, access_token }, ref }`, then `{ topic: 'phoenix', event: 'heartbeat', payload: {}, ref }` every 30 s.
- **Messages the app reads:** `event === 'postgres_changes'` and (`payload.data.type === 'UPDATE'` or `payload.eventType === 'UPDATE'`) → refetch `profiles.wallet_balance`. Row contents are **not** read.
- **Behaviour notes:** only the Dashboard screen subscribes; everywhere else the balance is refetched on focus (`useFocusEffect` in profile tab, `refetch()` after deposit / Scan & Pay). A replacement can be any "balance changed" push, or dropped in favour of refetch-on-focus.

---

### Flows

**Sign in** — `warmUpBackend()` on screen mount → `POST /auth/v1/token?grant_type=password {email,password}` → `GET /rest/v1/profiles?select=...,celebrities(id)&user_id=eq.<uid>&limit=1` (token). No row → login fails. Role = `role==='celebrity' || celebrities.length>0`. Persist `@wishme/session` + `@wishme/user`; route celebrity → `/celebrity-dashboard`, else `/(tabs)/assistant`. On later app starts: restore from storage; if JWT stale → `POST token?grant_type=refresh_token` → `GET profiles` (refresh wallet/role); refusal → sign out.

**OTP sign-up (user)** — form validates; referral code (≥4 chars) checked via `POST /rest/v1/rpc/validate_referral_code {p_code}` (debounced, and re-checked before submit) → `signup()`: save `PendingSignup` → `POST /functions/v1/send-email-otp {email}` (409 exists / 429 retryAfter / 400) → navigate to verify-otp → `verifyOtp(code)`: `POST /functions/v1/verify-email-otp {email,otp}` → `POST /auth/v1/signup {email,password,data:{first_name,last_name,phone,referral_code,gender,role:'user',wallet_balance:0,member_since}}` → if no `access_token`, `POST token?grant_type=password` → persist session/user, clear pending → background: poll `GET profiles?select=id,wallet_balance,referral_code&user_id=eq.<uid>` (≤3×, 1.5 s) for the trigger-created profile; fire-and-forget `POST /functions/v1/send-whatsapp-welcome {phone,name}` and `POST /functions/v1/trigger-message-event {event:'signup_complete',user_id,email}` → UI goes to `/select-plan?source=signup`. Resend: `send-email-otp` again (30 s UI cooldown).

**OTP sign-up (celebrity)** — (celebrity-signup screen, outside this file set, collects `CelebrityFormData` + password) `sendCelebOtp` → `POST send-email-otp {email}` → `applyCelebrityWithAuth`: `POST verify-email-otp {email,otp}` → `POST /auth/v1/signup {..., data:{first_name,last_name,phone,role:'celebrity_pending',member_since}}` → (`token?grant_type=password` fallback for a token) → `POST /rest/v1/celebrity_applications` (form body, `return=minimal`, token or anon). No session is stored — the applicant signs in normally later; status is checked anonymously via `GET celebrity_applications?select=id,status&email=eq.<email>`. Legacy path `applyCelebrity()` posts `CelebrityApplyData` anonymously with no auth user at all.

**Password reset** — by email: `POST /auth/v1/recover {email}`. By phone: anon `GET /rest/v1/profiles?select=email&phone=eq.<p>&limit=1` for `+91…`, `…`, `91…` → first hit → `POST /auth/v1/recover {email}`. Change while signed in: `security.tsx` `POST token?grant_type=password {email,current}` (verify) → `PUT /auth/v1/user {password}` with that token; or `edit-profile.tsx` `PUT /auth/v1/user {password}` with the stored token (no current-password check).

**Add money to wallet** — `useDeposit.handleDeposit` (min ₹100): `POST /functions/v1/create-razorpay-order {amount,currency:'INR',receipt:'wallet_…',notes:{user_id,type:'wallet_deposit'}}` → read `id,amount,key_id` → `RazorpayCheckout.open(...)` → `POST /functions/v1/verify-razorpay-payment {razorpay_order_id,razorpay_payment_id,razorpay_signature}` → require `success` → **client** `POST /rest/v1/wallet_transactions {type:'deposit',status:'completed',payment_method:'razorpay',…}` → **client** `POST /rest/v1/payment_transactions {wishme_payment_id,…,service_type:'deposit',status:'completed',paid_at}` → `refetch()` → `GET profiles?select=id,wallet_balance&user_id=eq.<uid>` (balance credited by DB trigger on the wallet_transactions insert). Cancel → back to amount step silently.

**Buy a plan** — `GET /rest/v1/plans?is_active=eq.true&order=price.asc` + `GET profiles?select=plan&id=eq.<pid>` → only tiers ≥ current shown (`basic < premium < elite`) → `POST create-razorpay-order {amount:plan.price,currency:'INR',receipt:'plan_…',notes:{user_id,plan_name,type:'plan_purchase'}}` → Razorpay checkout (native SDK or web script) → `POST verify-razorpay-payment {…}` (`res.ok`) → **client** `PATCH /rest/v1/profiles?id=eq.<pid> {plan:<lowercased name>}` → **client** `POST /rest/v1/wallet_transactions {type:'plan_purchase',amount:plan.price,status:'completed',payment_method:'razorpay',transaction_details:{plan_name,plan_id,razorpay_*}}` → alert → `/(tabs)`. Plan drives `service_discount_percentage` (usePlan) and referral L1/L2 rates (referrals).

**Scan-and-pay** — camera / manual entry parses `upi://…?pa&pn&am&tn`, plain `name@upi`, or JSON `{upi|pa|payee|id, name|pn|payeeName, amount|am, note|tn}` → amount (fixed if QR carried `am`) → client checks `amount <= walletBalance` → `getValidSession()` → **client** `POST /rest/v1/wallet_transactions {user_id,amount,transaction_type:'service_payment',status:'completed',payment_method:'wallet',description:'Scan & Pay · <payee>',transaction_details:{channel:'scan_pay',payee_id,payee_name,note,raw}}` (`return=representation`, reads `[0].id`) → `GET profiles?select=wallet_balance&id=eq.<pid>` (trigger has debited) → `updateUser({walletBalance})`. Note: nothing actually pays the payee — the row is the whole "payment".

**Celebrity withdraw** — open sheet (role must be `celebrity`): `GET /rest/v1/celebrities?profile_id=eq.<pid>&select=id,available_balance&limit=1` + `GET /rest/v1/bank_details?user_id=eq.<pid>&order=is_default.desc&select=*&limit=1` → client validates amount ≤ `available_balance` and bank row present → **client** `POST /rest/v1/payout_requests {celebrity_id,profile_id,requested_amount,bank_account_number,bank_name,ifsc_code,account_holder_name,status:'pending'}` → **client** `PATCH /rest/v1/celebrities?id=eq.<celebId> {available_balance: old - amount}` (unchecked) → "Admin will process within 3-5 business days".


---

## Domain 2 — Celebrities, bookings, chat, occasions, loved ones

Scope: every Supabase call made from these files under `artifacts/mobile`:
`hooks/useCelebrities.ts`, `hooks/useCelebrity.ts`, `hooks/useCelebrityFavorites.ts`, `hooks/useVoiceCallCelebrities.ts`,
`app/celebrity/[id].tsx`, `app/booking/[id].tsx`, `app/booking-summary.tsx`, `app/bookings.tsx`, `components/bookings/*.tsx`,
`app/chat/[id].tsx`, `app/messages.tsx`, `app/favorites.tsx`, `components/celebrity/SubscribeSheet.tsx`,
`app/occasions.tsx`, `app/occasion-book/[id].tsx`, `app/occasion-wishes.tsx`, `app/loved-ones.tsx`, `services/occasionAlerts.ts`,
`app/celebrity-signup.tsx`.

Checked and found to contain **no** Supabase calls: `app/(tabs)/celebrities.tsx`, `app/(tabs)/index.tsx`, `components/home/*.tsx`, `app/following.tsx`,
`app/occasion-alerts.tsx`, `components/occasions/AddOccasionSheet.tsx`, `components/OccasionInApp.tsx` (the last three only call `services/occasionAlerts.ts`, documented below).

### Transport conventions (apply to every entry)

- `supabaseFetch(path, init, token)` (`constants/supabase.ts:16`) sends to `${SUPABASE_URL}${path}` with headers `apikey: <anon key>`, `Authorization: Bearer ${token ?? anon key}`, `Content-Type: application/json`, plus any `init.headers`. 20 s abort timeout. **"Auth: either"** below means the code passes `session?.access_token` which may be null/undefined, so the anon key is used when logged out.
- `app/booking/[id].tsx:59` has its own `sbFetch` that is identical **but adds `Prefer: return=representation` to every request** (GETs included) and uses a 30 s timeout. `app/booking-summary.tsx:23` has a GET-only `sbFetch` without `Prefer`.
- `services/supabaseRest.ts` helpers: `fetchRows`/`fetchOne` (GET, `fetchOne` = first row or null), `insertRows`/`updateRows` (POST/PATCH with `Prefer: return=representation`), `deleteRows`, `callRpc` (POST `/rest/v1/rpc/<name>`). Non-2xx → `SupabaseRestError(message, status, path)` where message comes from `parseApiError` (`error_description || error || message || msg`).
- `parseApiError(res)` (`constants/supabase.ts:41`) is what most screens display on failure, so the server's error JSON should carry one of `error_description`, `error`, `message`, `msg`.
- Relative `image_url` values (no `http` prefix) are resolved client-side against the Backblaze public base `https://f005.backblazeb2.com/file/wishmetoday/<image_url>` in `app/favorites.tsx:258,427`, `app/chat/[id].tsx:30`, `app/messages.tsx:23`, `app/occasions.tsx:22`, `app/occasion-book/[id].tsx:23`, `app/occasion-wishes.tsx:23`. `app/celebrity/[id].tsx:486` appends `?w=800` to `imageUrl` for the header image.
- `user.profileId` (profiles.id) is the value used as `user_id` in all app tables; `user.id` is the auth uid and is only used for `profiles?user_id=eq.<uid>`.

---

### Tables

#### `GET /rest/v1/audio_isolation_generations`
- **Callers:** `app/bookings.tsx:67` (config `components/bookings/TabConfig.tsx:103`) — "Isolate" tab of My Bookings.
- **Auth:** user access token (fetch skipped without one).
- **Query / filters:** `select=id,original_file_name,audio_url,credits_used,status,created_at&user_id=eq.<profileId>&order=created_at.desc&limit=20` (select is `encodeURIComponent`'d).
- **Request body:** none.
- **Response fields the app reads:** array of `AudioIsolation` (`components/bookings/shared.tsx:122`): `{ id; original_file_name; audio_url: string|null; credits_used: number; status; created_at }`. Card shows audio player + `credits_used` as ₹ when `status === 'completed' && audio_url`.
- **Behaviour notes:** Loaded lazily the first time the tab is opened; cached per tab (`loadedTabsRef`) until manual refresh.

#### `GET /rest/v1/bookings`
- **Callers:**
  - `app/booking-summary.tsx:78` — confirmation screen after paying; loads the booking just created.
  - `app/bookings.tsx:67` (config `components/bookings/TabConfig.tsx:92`) — "Celebrity" tab list.
- **Auth:** booking-summary: either (`session?.access_token`); bookings.tsx: user token.
- **Query / filters:**
  - booking-summary: `id=eq.<bookingId>&select=*,celebrities(name,image_url,category)&limit=1`
  - bookings tab: `select=id,user_id,celebrity_id,service_type,status,generation_status,video_status,video_file_key,video_url,message,final_price,created_at,generation_error,celebrities:celebrity_id(name,image_url,category)&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Request body:** none.
- **Response fields the app reads:**
  - booking-summary `Booking` (`app/booking-summary.tsx:33`): `{ id; service_type; final_price; status; created_at; celebrities: { name; image_url?; category } | null }` — reads `celebrities.name`, `celebrities.category`, `service_type` (mapped video_wish→"Video Wish", image_promotion→"UGC Ad", video_promotion→"Video Promotion"), `final_price`. Expects array, uses `rows[0]`.
  - bookings tab `CelebBooking` (`shared.tsx:54`): `{ id; user_id; celebrity_id; service_type; status; generation_status: string|null; video_status: string|null; video_file_key: string|null; video_url: string|null; message: string|null; final_price: number; created_at; generation_error: string|null; celebrities: { name; image_url; category } | null }`. `CelebCard` (`components/bookings/CelebCard.tsx`) derives a status label from `status` ∈ {pending, confirmed, video_sent, sent, completed, cancelled}, `generation_status` ∈ {script_generating, video_generating, downloading, uploading, completed, failed, timeout}, `video_status` ∈ {ready, failed}; parses `message` as JSON and reads `requestDetails.recipientName|occasion|message` (falls back to `step1.*`); uses `video_file_key` to request a signed URL (see `b2-get-signed-url`); `service_type` labels: video_wish, voice_message, live_call, personalized_song, shoutout.
- **Behaviour notes:** Realtime UPDATEs on `bookings` (see Realtime section) force a refetch of this tab.

#### `POST /rest/v1/bookings`
- **Callers:** `app/booking/[id].tsx:354` — step 6 "Pay via Wallet" of the booking wizard (first write of the flow).
- **Auth:** either (`getValidSession()?.access_token ?? null`, anon fallback — in practice the user is logged in because `profileId` is required).
- **Query / filters:** none. `Prefer: return=representation` (from the local `sbFetch`).
- **Request body** (`bookingData`, lines 313-352):
  - `celebrity_id: string`
  - `user_id: string` (profiles.id)
  - `service_type: 'video_wish' | 'image_promotion' | 'video_promotion'` (map: wish→video_wish, ad→image_promotion, video→video_promotion)
  - `original_price: number` (basePrice)
  - `discount_amount: number` (always 0 — `discountPct` is never set)
  - `final_price: number` (= basePrice − discount + round(10% service fee))
  - `status: 'pending'`
  - `message: string` — JSON.stringify of `{ serviceType, requestDetails: step1 {recipientName, recipientRelation, occasion, message, preferredLanguage, videoType:'marketing'|'business_event', businessName, businessPronunciation}, deliveryType:'video'|'card'|'both', creativeGuidelines: {goal, goalOther, toneAndStyle, filmingRequirements, thingsToAvoid: string[], thingsToAvoidOther:'', otherInfo:''}, scriptBuilder: {scriptType:'talking_points'|'exact_script', talkingPoints, exactScript, generatedScript, requiredLines:''}, [recipientName, recipientEmail, recipientPhone when scheduleGift] }`
  - `instructions: string` (goal text)
  - `delivery_type: 'video' | 'card' | 'both'`
  - `generated_prompt: string` (script text)
- **Response fields the app reads:** `Array.isArray(rows) ? rows[0] : rows` → `.id` (bookingId). On error reads `err.message`.
- **Behaviour notes:** See Flows → Book a video wish. `step6.deliveryDate` is collected but never sent.

#### `PATCH /rest/v1/bookings`
- **Callers:** `app/booking/[id].tsx:403` — last step of the pay flow; stamps the payment id onto the booking.
- **Auth:** either (user token in practice).
- **Query / filters:** `id=eq.<bookingId>`; `Prefer: return=representation`.
- **Request body:** `{ wishme_payment_id: string }` — client-generated `'WM' + Date.now().toString(36).toUpperCase()`.
- **Response fields the app reads:** none (not awaited for content; failure is ignored).

#### `GET /rest/v1/celebrities`
- **Callers:**
  - `hooks/useCelebrities.ts:180` — singleton catalogue store used by home/celebrities tabs (fetched once per session, limit 50, filtered/sliced locally).
  - `hooks/useCelebrity.ts:20` — "does the signed-in user own a celebrity profile?" (`fetchOne`).
  - `hooks/useVoiceCallCelebrities.ts:48` — voice-call picker list.
  - `app/celebrity/[id].tsx:87` — celebrity detail page.
  - `app/booking/[id].tsx:141` — booking wizard init.
  - `app/favorites.tsx:570` — "Browse" tab of Celebrity Favorites.
  - `app/occasion-book/[id].tsx:128` — subscribed celebrities to pick from for an occasion booking.
  - `app/occasion-wishes.tsx:239` — subscribed celebrities for the occasion-wish sender.
- **Auth:** useCelebrities: **anon key only** (no token passed); useCelebrity: user token; useVoiceCallCelebrities: either (`session?.access_token ?? SUPABASE_ANON_KEY`); celebrity/[id]: **anon key only**; booking: either; favorites: either; occasion-book: either; occasion-wishes: user token.
- **Query / filters (verbatim):**
  - useCelebrities: `select=id,name,category,bio,image_url,video_thumbnail_url,rating,followers,location,delivery_time,is_verified,service_prices,voice_call_price,social_media,vapi_voice_id,vapi_phone_id,celebrity_favorite_pricing!inner(price,is_enabled),celebrity_reviews(count)` (URL-encoded) `&celebrity_favorite_pricing.is_enabled=eq.true&is_active=eq.true&is_verified=eq.true&consent_status=eq.approved&order=rating.desc.nullslast&limit=50`
  - useCelebrity: `select=id&profile_id=eq.<profileId>&limit=1`
  - useVoiceCallCelebrities: `select=id,name,category,image_url,vapi_voice_id,voice_call_price,rating,is_verified,vapi_phone_id&vapi_voice_id=not.is.null&is_active=eq.true&order=rating.desc`
  - celebrity/[id]: `id=eq.<id>&select=*,celebrity_reviews(count)&limit=1`
  - booking/[id]: `id=eq.<id>&select=*&limit=1`
  - favorites: `is_active=eq.true&order=name.asc` (all columns)
  - occasion-book: `is_active=eq.true&is_verified=eq.true&id=in.(<id1>,<id2>,...)&select=id,name,image_url,category,service_prices`
  - occasion-wishes: `select=id,name,image_url,category&id=in.(<idList>)&is_active=eq.true`
- **Request body:** none.
- **Response fields the app reads (per caller):**
  - useCelebrities `RestCelebrity` (`useCelebrities.ts:55`): `{ id; name; category; bio: string|null; image_url: string|null; rating: number|null; followers?; location?; delivery_time?; is_verified: boolean; service_prices?: { general_wish?; image_promotion?; text_message?; ugc_ad?; video_promotion? }; voice_call_price?; social_media?: { instagram?; twitter? }; vapi_voice_id?: string|null; vapi_phone_id?: string|null; celebrity_favorite_pricing: {price; is_enabled} | {price; is_enabled}[]; celebrity_reviews?: { count: number }[] }`. Normalised to exported `Celebrity` (`useCelebrities.ts:4`): `{ id; name; category; rating; reviewCount; pricePerWish (=service_prices.general_wish ?? 0); pricePerCall & ratePerMinute (=voice_call_price ?? 0); imageUrl; bio; tags: []; isVerified; isAvailable: true; followers?; location?; deliveryTime?; subscription?: {is_enabled; price} (from celebrity_favorite_pricing, first element if array); socialMedia?; vapiVoiceId?; vapiPhoneId? }`. **Rating rule:** `rating` is shown only if `celebrity_reviews[0].count > 0`, else 0; `reviewCount = celebrity_reviews[0].count`. Rows are de-duplicated client-side on `name|category` (lower-cased).
  - useCelebrity: array; truthiness of first row only.
  - useVoiceCallCelebrities `Row` (`useVoiceCallCelebrities.ts:18`): `{ id; name; category: string|null; image_url: string|null; vapi_voice_id: string|null; vapi_phone_id: string|null; voice_call_price: number|null; rating: number|null; is_verified: boolean|null }` → rows with empty `vapi_voice_id` dropped; `pricePerCall` default 500; `category` default 'Celebrity'. On error reads body `message ?? error`.
  - celebrity/[id]: `rows[0]` → `id, name, category, bio, image_url, rating, followers, location, delivery_time, is_verified, service_prices.{general_wish, ugc_ad (default 25000), video_promotion ?? image_promotion (default 50000)}, voice_call_price, subscription, social_media, vapi_voice_id, vapi_phone_id, celebrity_reviews[0].count`. Same rating rule as above.
  - booking/[id] `Celebrity` (`booking/[id].tsx:46`): reads `id, name, image_url, category, price_per_wish ?? pricePerWish ?? 1500, service_prices.{general_wish, ugc_ad (default 25000), video_promotion (default 50000), image_promotion}`.
  - favorites `Celebrity` (`favorites.tsx:49`): `{ id; name; category; image_url; location?; rating?; review_count?; is_verified; is_active }`.
  - occasion-book `Celebrity` (`occasion-book/[id].tsx:67`): `{ id; name; image_url: string|null; category; service_prices: Record<string, number>|null }`.
  - occasion-wishes `Celebrity` (`occasion-wishes.tsx:25`): `{ id; name; image_url: string|null; category }`.
- **Behaviour notes:** useCelebrities is a module-level singleton (one fetch per app session, dedup of concurrent mounts, `refetch` clears and refetches). The `!inner` join on `celebrity_favorite_pricing` plus `celebrity_favorite_pricing.is_enabled=eq.true` means only celebrities with an enabled subscription price appear in the catalogue. `useCelebrity` re-checks on every screen focus.

#### `GET /rest/v1/celebrity_categories`
- **Callers:** `app/celebrity-signup.tsx:222` — category picker on the celebrity registration form.
- **Auth:** anon key only (token explicitly `null`).
- **Query / filters:** `select=id,name&is_active=eq.true&order=name.asc`
- **Request body:** none.
- **Response fields the app reads:** array of `Category { id: string; name: string }` (`celebrity-signup.tsx:25`); the selected `name` string is what gets submitted as `category` in the application form (via `applyCelebrityWithAuth` in AuthContext — auth domain, not covered here).
- **Behaviour notes:** The rest of the sign-up (`checkCelebrityStatus`, `sendCelebOtp`, `applyCelebrityWithAuth`) lives in `context/AuthContext` and is out of this document's scope.

#### `GET /rest/v1/celebrity_events`
- **Callers:** `app/celebrity/[id].tsx:238` — "Events" tab on the celebrity page (lazy, first open only).
- **Auth:** anon key only.
- **Query / filters:** `celebrity_id=eq.<id>&is_public=eq.true&order=event_date.asc` (all columns)
- **Request body:** none.
- **Response fields the app reads:** array of `EventItem { id; title; event_date; location? }` (`celebrity/[id].tsx:45`).

#### `GET /rest/v1/celebrity_favorite_pricing`
- **Callers:**
  - `app/celebrity/[id].tsx:169` — subscription price for the detail page / SubscribeSheet.
  - `app/booking/[id].tsx:184` — `subPrice` (fetched, stored, not otherwise used).
  - `app/favorites.tsx:571` — pricing map for the Browse grid.
- **Auth:** celebrity/[id]: user token (whole `fetchSubscriptionData` skipped unless logged in); booking: either; favorites: either.
- **Query / filters:**
  - celebrity/[id] & booking: `celebrity_id=eq.<id>&is_enabled=eq.true&select=price&limit=1`
  - favorites: `is_enabled=eq.true` (all columns)
- **Request body:** none.
- **Response fields the app reads:** `rows[0].price` (number). favorites `CelebrityPricing` (`favorites.tsx:61`): `{ id; celebrity_id; price; referrer_commission_percentage; celebrity_commission_percentage; is_enabled }` keyed by `celebrity_id`. Also embedded via `celebrity_favorite_pricing!inner(price,is_enabled)` in `GET celebrities` (useCelebrities).
- **Behaviour notes:** Empty result on the detail page → "Subscription Not Available" state (`isPricingDisabled`).

#### `GET /rest/v1/celebrity_favorites`
- **Callers:**
  - `hooks/useCelebrityFavorites.ts:30` — set of subscribed celebrity ids (`fetchRows`).
  - `app/celebrity/[id].tsx:164` — is the user subscribed to this celebrity.
  - `app/booking/[id].tsx:186` — same check inside the wizard (gates the "wish" service).
  - `app/favorites.tsx:591` — "My Favorites" tab.
  - `app/occasion-book/[id].tsx:111` — ids of subscribed celebrities.
  - `app/occasion-wishes.tsx:219` — ids of subscribed celebrities.
- **Auth:** user access token in all cases.
- **Query / filters:**
  - useCelebrityFavorites: `user_id=eq.<profileId>&status=eq.active&select=celebrity_id`
  - celebrity/[id] & booking: `user_id=eq.<profileId>&celebrity_id=eq.<id>&status=eq.active&select=id&limit=1`
  - favorites: `select=*,celebrities(*)&user_id=eq.<profileId>&status=eq.active`
  - occasion-book: `user_id=eq.<profileId>&status=eq.active&select=celebrity_id`
  - occasion-wishes: `select=celebrity_id&user_id=eq.<profileId>&status=eq.active`
- **Request body:** none.
- **Response fields the app reads:** `celebrity_id` lists; `rows.length > 0` as the subscribed flag; favorites `FavoriteRow` (`favorites.tsx:70`): `{ id; user_id; celebrity_id; price_paid; referrer_commission; celebrity_commission; status; created_at; celebrities: { id; name; category; image_url; rating?; review_count?; is_verified } }` — shows `created_at` as "Since <date>".
- **Behaviour notes:** The app never writes this table directly; rows are created by RPC `purchase_celebrity_subscription`. "Subscription" and "favorite" are the same concept (`status = 'active'`).

#### `GET /rest/v1/celebrity_media`
- **Callers:** `app/celebrity/[id].tsx:221` — "Media" tab (lazy, first open only).
- **Auth:** anon key only.
- **Query / filters:** `celebrity_id=eq.<id>&is_public=eq.true&order=created_at.desc` (all columns)
- **Request body:** none.
- **Response fields the app reads:** array of `MediaItem { id; media_type: string; media_url: string; thumbnail_url?; title? }` (`celebrity/[id].tsx:37`) — renders a play icon when `media_type === 'video'`, otherwise `thumbnail_url ?? media_url` as image.

#### `GET /rest/v1/celebrity_occasions`
- **Callers:** `app/occasion-wishes.tsx:244` — upcoming public occasions of the user's subscribed celebrities.
- **Auth:** user access token.
- **Query / filters:** `select=*,celebrities:celebrity_id(id,name,image_url,category)&celebrity_id=in.(<idList>)&is_public=eq.true&occasion_date=gte.<YYYY-MM-DD today>&order=occasion_date.asc`
- **Request body:** none.
- **Response fields the app reads:** array of `CelebOccasion` (`occasion-wishes.tsx:32`): `{ id; celebrity_id; occasion_name; occasion_type: 'birthday'|'anniversary'|'other'; occasion_date: 'YYYY-MM-DD'; is_public; auto_reply_enabled: boolean; celebrities: Celebrity }`. `auto_reply_enabled` decides whether to call `generate-occasion-auto-reply` after sending a wish.

#### `GET /rest/v1/celebrity_reviews`
- **Callers:** `app/celebrity/[id].tsx:202` — reviews list at the bottom of the celebrity page.
- **Auth:** either (`session?.access_token`).
- **Query / filters:** `celebrity_id=eq.<id>&select=*,profiles(first_name,last_name)&order=created_at.desc&limit=10`
- **Request body:** none.
- **Response fields the app reads:** array of `Review { id; rating: number; comment: string; created_at; profiles: { first_name; last_name } | null }` (`celebrity/[id].tsx:29`). Also used as an aggregate `celebrity_reviews(count)` embed in `GET celebrities` (reads `[0].count`).
- **Behaviour notes:** No write path for reviews exists in the app.

#### `GET /rest/v1/conversations`
- **Callers:**
  - `app/messages.tsx:97` — inbox list, polled.
  - `app/chat/[id].tsx:452` — conversation header/meta on open.
- **Auth:** user access token (both).
- **Query / filters:**
  - messages: `select=*,celebrity:celebrities!conversations_celebrity_id_fkey(id,name,image_url)&user_id=eq.<profileId>&order=last_message_at.desc`
  - chat: `select=*,celebrity:celebrities!conversations_celebrity_id_fkey(id,name,image_url)&id=eq.<convId>&limit=1`
- **Request body:** none.
- **Response fields the app reads:**
  - messages `Conversation` (`messages.tsx:58`): `{ id; user_id; celebrity_id; last_message_at: string|null; unread_count_user: number; message_count: number; is_closed: boolean; celebrity: { id; name; image_url: string|null } }`.
  - chat `ConvMeta` (`chat/[id].tsx:81`): `{ id; message_count; is_closed; closed_reason: string|null; unread_count_celebrity: number; celebrity: { id; name; image_url } }` — `unread_count_celebrity` is cached in a ref and incremented client-side on each send.
- **Behaviour notes:** messages.tsx polls this every **8000 ms** (plus pull-to-refresh), and for every conversation returned also fetches the last message (N+1, see `GET messages`). No endpoint in the app creates a conversation; they must already exist (created elsewhere/by the backend).

#### `PATCH /rest/v1/conversations`
- **Callers (all `app/chat/[id].tsx`, all `Prefer: return=minimal`, fire-and-forget `.catch(() => {})`):**
  - `:398` — `markAsRead` on open: body `{ unread_count_user: 0 }`.
  - `:605` — after a successful message insert: body `{ last_message_at: <ISO now> }`.
  - `:616` — right after that: body `{ unread_count_celebrity: <cached value + 1> }`.
- **Auth:** user access token.
- **Query / filters:** `id=eq.<convId>` in all three.
- **Response fields the app reads:** none.
- **Behaviour notes:** `unread_count_celebrity` is a read-modify-write from a client-side ref (race-prone, and the celebrity side may reset it concurrently). A re-implementation should maintain `last_message_at` / unread counters server-side on message insert instead.

#### `GET /rest/v1/greeting_card_generations`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:95`) — "Cards" tab.
- **Auth:** user access token.
- **Query / filters:** `select=id,occasion_name,recipient_name,original_prompt,generated_image_url,amount_charged,status,created_at&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `GreetingCard` (`shared.tsx:77`): `{ id; occasion_name; recipient_name; original_prompt; generated_image_url: string|null; amount_charged: number; status; created_at }`. Download link shown when `status === 'completed' && generated_image_url`.

#### `GET /rest/v1/image_music_generations`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:99`) — "Img+Music" tab.
- **Auth:** user access token.
- **Query / filters:** `select=id,genre,mood,has_vocals,description,image_url,audio_url,amount_charged,status,created_at&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `ImgMusicGen` (`shared.tsx:101`): `{ id; genre; mood; has_vocals: boolean; description; image_url: string|null; audio_url: string|null; amount_charged: number; status; created_at }`.

#### `GET /rest/v1/loved_ones`
- **Callers:**
  - `app/loved-ones.tsx:138` — list screen.
  - `services/occasionAlerts.ts:122` `fetchLovedOnes()` — person picker in `components/occasions/AddOccasionSheet.tsx:77`.
  - `services/occasionAlerts.ts:168` inside `createOccasion()` — current `occasions` JSON of an existing person before appending.
- **Auth:** loved-ones.tsx: either (`session?.access_token`, user in practice); service: token parameter (user token).
- **Query / filters:**
  - loved-ones.tsx: `user_id=eq.<profileId>&order=first_name.asc` (all columns)
  - fetchLovedOnes: `select=id,first_name,last_name,relationship,occasions&user_id=eq.<profileId>&order=first_name.asc`
  - createOccasion: `id=eq.<lovedOneId>&select=occasions`
- **Request body:** none.
- **Response fields the app reads:** `LovedOne` (`loved-ones.tsx:34`): `{ id; user_id; first_name; last_name; date_of_birth: 'YYYY-MM-DD'|null; relationship; email?; phone?; notes?; occasions: OccasionItem[] }` where `OccasionItem { id; name; date; type }` (`loved-ones.tsx:27`) is a **JSON array column**; non-array `occasions` is coerced to `[]`. `LovedOneLite` (`occasionAlerts.ts:47`): `{ id; first_name; last_name: string|null; relationship: string|null; occasions: {id; name; date; type}[] | null }`. `[0].occasions` in createOccasion.
- **Behaviour notes:** `occasions[].id` is client-generated `` `occ${Date.now()}` ``; `occasions[].type` stores the display label (`'Birthday' | 'Anniversary' | 'Wedding' | 'Festival' | 'Other'`), while `occasion_alerts.occasion_type` stores the lower-case key (see `normType`).

#### `POST /rest/v1/loved_ones`
- **Callers:**
  - `app/loved-ones.tsx:223` — "Add Loved One" modal (`Prefer: return=minimal`).
  - `services/occasionAlerts.ts:155` `createOccasion()` with `newPerson` — creates the person inline from the Add Occasion sheet (`Prefer: return=representation`).
- **Auth:** user token.
- **Request body:**
  - loved-ones.tsx: `{ user_id, first_name (trimmed, required), last_name, email: string|null, phone: string|null, date_of_birth: 'YYYY-MM-DD'|null, relationship: 'Family'|'Friend'|'Partner'|'Colleague'|'Other', notes: string|null, occasions: [] }`
  - createOccasion: `{ user_id, first_name, relationship, occasions: [] }`
- **Response fields the app reads:** loved-ones.tsx: none (refetches list). createOccasion: `rows[0].id` (new loved_one id). Errors shown via `parseApiError`.

#### `PATCH /rest/v1/loved_ones`
- **Callers (all `Prefer: return=minimal`):**
  - `app/loved-ones.tsx:208` — edit person; body = same payload as POST minus `occasions`.
  - `app/loved-ones.tsx:312` — "Save Occasions"; body `{ occasions: OccasionItem[] }` (full replacement of the JSON array).
  - `services/occasionAlerts.ts:194` `createOccasion()` — body `{ occasions: list }` where `list` = existing occasions minus any with the same `name`, plus `{ id: 'occ<ts>', name, date, type: <label> }`; failure ignored.
- **Auth:** user token.
- **Query / filters:** `id=eq.<lovedOneId>`.
- **Response fields the app reads:** none.

#### `DELETE /rest/v1/loved_ones`
- **Callers:** `app/loved-ones.tsx:256` — delete confirmation modal.
- **Auth:** user token.
- **Query / filters:** `id=eq.<lovedOneId>`.
- **Response fields the app reads:** none (refetch). The UI text promises "and all their occasions" — the app does **not** delete the matching `occasion_alerts` rows itself; that must be a DB cascade / server behaviour.

#### `GET /rest/v1/messages`
- **Callers (all user token):**
  - `app/chat/[id].tsx:462` — initial page on open.
  - `app/chat/[id].tsx:425-427` — `fetchNewMessages` poll (newer than latest non-temp message).
  - `app/chat/[id].tsx:543` — `loadOlderMessages` on scroll to end.
  - `app/messages.tsx:114` — last message preview per conversation (one request per conversation).
- **Query / filters:**
  - initial: `select=*&conversation_id=eq.<convId>&order=created_at.desc&limit=50`
  - poll: `select=*&conversation_id=eq.<convId>&created_at=gt.<encodeURIComponent(latest created_at)>&order=created_at.desc&limit=50` (or the initial query when there is no message yet)
  - older: `select=*&conversation_id=eq.<convId>&created_at=lt.<encodeURIComponent(oldest created_at)>&order=created_at.desc&limit=30`
  - preview: `select=message_text,sender_type&conversation_id=eq.<convId>&order=created_at.desc&limit=1`
- **Request body:** none.
- **Response fields the app reads:** `ChatMessage` (`chat/[id].tsx:58`): `{ id; conversation_id; sender_id; sender_type: 'user'|'celebrity'; message_text: string; is_read: boolean; is_ai_generated: boolean; created_at; conversation_message_number?: number|null }`. `LastMessage { message_text; sender_type }` (`messages.tsx:69`). `message_text` conventions parsed client-side: `[Voice Note: <url>]` → voice player; text containing `[Greeting Card: <https url>]` → card image + remaining text; else plain. `is_ai_generated` shows an "AI" badge on celebrity messages. Rows with `id` starting `temp-` are local optimistic placeholders.
- **Behaviour notes:** Poll interval **5000 ms** while app is active (stopped on background, restarted on foreground). `hasMoreMessages=false` when fewer than 50 rows come back initially or an older-page returns 0. Lists are deduped by `id`. Pagination is keyset on `created_at` (equal timestamps could be skipped).

#### `POST /rest/v1/messages`
- **Callers:** `app/chat/[id].tsx:581` — `sendMessage` (text, emoji, and voice-note messages all go through here).
- **Auth:** user token.
- **Query / filters:** none; `Prefer: return=minimal`.
- **Request body:** `{ conversation_id: string; sender_id: string (profileId); sender_type: 'user'; message_text: string (trimmed, ≤1000 chars from the input; voice notes send "[Voice Note: <public url>]"); is_read: false; is_ai_generated: false }`
- **Response fields the app reads:** none — only `res.ok`. The real row is picked up by the next poll (`fetchNewMessages` scheduled at +1500 ms); the optimistic `temp-<ts>` row is removed on failure or replaced when real rows arrive.
- **Behaviour notes:** See Flows → Send a chat message.

#### `PATCH /rest/v1/messages`
- **Callers:** `app/chat/[id].tsx:407` — `markAsRead` on conversation open.
- **Auth:** user token.
- **Query / filters:** `conversation_id=eq.<convId>&is_read=eq.false`; `Prefer: return=minimal`.
- **Request body:** `{ is_read: true }`
- **Response fields the app reads:** none (fire-and-forget).
- **Behaviour notes:** Marks **all** unread messages in the conversation read, including the user's own, not just the celebrity's.

#### `GET /rest/v1/music_generations`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:98`) — "Music" tab.
- **Auth:** user token.
- **Query / filters:** `select=id,title,genre,mood,lyrics,audio_url,credits_used,has_vocals,status,error_message,created_at&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `MusicGen` (`shared.tsx:95`): `{ id; title; genre; mood; lyrics: string|null; audio_url: string|null; credits_used: number; has_vocals: boolean; status; error_message: string|null; created_at }`.
- **Behaviour notes:** Realtime UPDATEs on this table refetch the tab.

#### `GET /rest/v1/occasion_alerts`
- **Callers:** `services/occasionAlerts.ts:112` `fetchAlerts()` — used by `app/occasion-alerts.tsx:162`, `components/OccasionInApp.tsx:34`, and `app/loved-ones.tsx:373` (after saving occasions) to drive local phone notifications and in-app banners.
- **Auth:** user token.
- **Query / filters:** `select=*,loved_ones(first_name,last_name),celebrities!occasion_alerts_celebrity_id_fkey(name)&user_id=eq.<profileId>&order=occasion_date.asc`
- **Request body:** none.
- **Response fields the app reads:** `AlertRow` (`occasionAlerts.ts:32`): `{ id; occasion_name; occasion_type: string; occasion_date: 'YYYY-MM-DD'; alert_enabled: boolean; auto_send_enabled: boolean; alert_days_before: number; reminder_time: 'HH:MM:SS'|null; loved_one_id: string|null; celebrity_id: string|null; loved_ones: { first_name; last_name: string|null } | null; celebrities: { name } | null }`.
- **Behaviour notes:** `occasion_type` is normalised through `normType` to `'birthday'|'anniversary'|'wedding'|'festival'|'other'`; birthday/anniversary/festival recur yearly, wedding/other are one-off. Throws `HTTP <status>` on non-ok.

#### `POST /rest/v1/occasion_alerts` (upsert)
- **Callers:**
  - `app/loved-ones.tsx:344` — one call per occasion with a date when "Save Occasions" is pressed.
  - `services/occasionAlerts.ts:173` `createOccasion()` — from the Add Occasion sheet.
- **Auth:** user token.
- **Query / filters:** `on_conflict=user_id,loved_one_id,occasion_name`; header `Prefer: resolution=merge-duplicates,return=minimal` → the server needs a unique constraint on `(user_id, loved_one_id, occasion_name)`.
- **Request body:**
  - loved-ones.tsx: `{ user_id, loved_one_id, occasion_name, occasion_type: normType(type) (lower-case key), occasion_date: 'YYYY-MM-DD' }` (other columns rely on DB defaults).
  - createOccasion: `{ user_id, loved_one_id, occasion_name (trimmed), occasion_type: OccasionType, occasion_date, alert_enabled: boolean, auto_send_enabled: false, alert_days_before: number (0|1|3|7|14), reminder_time: '<HH:MM>:00' }`
- **Response fields the app reads:** none (`res.ok` only).

#### `PATCH /rest/v1/occasion_alerts`
- **Callers:** `services/occasionAlerts.ts:132` `patchAlert()` — called from `app/occasion-alerts.tsx:183` with `{ alert_enabled }`, `{ reminder_time: '<HH:MM>:00' }`, or `{ alert_days_before }` (one field per call, optimistic UI with revert on failure).
- **Auth:** user token.
- **Query / filters:** `id=eq.<alertId>`; no `Prefer` header (PostgREST default, minimal body).
- **Request body:** `Partial<AlertRow>` as above.
- **Response fields the app reads:** none; throws `HTTP <status>` on failure.

#### `DELETE /rest/v1/occasion_alerts`
- **Callers:** `app/loved-ones.tsx:334` — one call per occasion removed from a person's list in "Save Occasions".
- **Auth:** user token.
- **Query / filters:** `user_id=eq.<profileId>&loved_one_id=eq.<lovedOneId>&occasion_name=eq.<encodeURIComponent(name)>`
- **Response fields the app reads:** none; non-ok sets `syncFailed` → "Occasions saved, but some alerts could not be synced."

#### `POST /rest/v1/occasion_bookings`
- **Callers:** `app/occasion-book/[id].tsx:168` — "Create Booking" on the occasion booking screen.
- **Auth:** user token.
- **Query / filters:** none; `Prefer: return=representation`.
- **Request body:** `{ user_id: profileId; occasion_id: <route id>; celebrity_id: string; booking_type: 'video' | 'greeting_card'; recipient_name: string; recipient_email: string|null; recipient_phone: string|null; message: string; price: 0; status: 'pending' }`
- **Response fields the app reads:** `rows[0].id` → `bookingId` (passed to the edge function and shown as orderId). On error reads body text for a console warning only.
- **Behaviour notes:** Always free (`price: 0`). See Flows → Book an occasion.

#### `GET /rest/v1/occasion_wishes`
- **Callers:** `app/occasion-wishes.tsx:249` — "My Wishes" tab.
- **Auth:** user token.
- **Query / filters:** `select=*,celebrity_occasions!inner(*,celebrities:celebrity_id(id,name,image_url,category))&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `Wish` (`occasion-wishes.tsx:43`): `{ id; user_id; celebrity_id; occasion_id; message; reply_message: string|null; reply_sent_at: string|null; created_at; celebrity_occasions: CelebOccasion & { celebrities: Celebrity } }` — shows "Replied" when `reply_message` is set.

#### `POST /rest/v1/occasion_wishes`
- **Callers:** `app/occasion-wishes.tsx:301` — "Send Wish".
- **Auth:** user token.
- **Query / filters:** none; `Prefer: return=representation`.
- **Request body:** `{ user_id: profileId; celebrity_id: string; occasion_id: string (celebrity_occasions.id); message: string (10–500 chars, trimmed) }`
- **Response fields the app reads:** `inserted[0].id` → `wish_id` for the auto-reply function.

#### `GET /rest/v1/occasions`
- **Callers:**
  - `app/occasions.tsx:82` — public occasions catalogue.
  - `app/occasion-book/[id].tsx:109` — the one occasion being booked.
- **Auth:** either (`session?.access_token ?? null`).
- **Query / filters:**
  - occasions.tsx: `is_active=eq.true&order=date.asc` (all columns)
  - occasion-book: `id=eq.<id>&limit=1`
- **Response fields the app reads:** `Occasion { id; name; description; date: 'YYYY-MM-DD'; image_url: string|null; is_active; is_featured: boolean }` (`occasions.tsx:60`, `occasion-book/[id].tsx:57`). `is_featured` rows are shown in a separate grid.

#### `POST /rest/v1/payment_transactions`  ⚠ money row written by the client
- **Callers:** `app/booking/[id].tsx:383` — third write of the wallet pay flow.
- **Auth:** either (user token in practice).
- **Query / filters:** none; `Prefer: return=representation`.
- **Request body:** `{ wishme_payment_id: 'WM<base36 ts>'; user_id: profileId; amount: finalPrice; payment_method: 'wallet'; service_type: 'booking'; booking_id: <bookingId>; description: 'Booking for <celebrity name> - <wish|ad|video>'; status: 'completed'; paid_at: <ISO now> }`
- **Response fields the app reads:** none; on error `err.message`.
- **Behaviour notes:** **The client asserts the payment is `completed` without any server-side validation.** Must move server-side.

#### `GET /rest/v1/photo_wishes`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:96`) — "Photo" tab.
- **Auth:** user token.
- **Query / filters:** `select=id,occasion_type,recipient_name,message,output_url,credits_used,status,created_at&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `PhotoWish` (`shared.tsx:82`): `{ id; occasion_type; recipient_name; message; output_url: string|null; credits_used: number; status; created_at }`.

#### `GET /rest/v1/platform_settings`
- **Callers:** `app/chat/[id].tsx:457` — conversation bootstrap.
- **Auth:** user token.
- **Query / filters:** `select=setting_value&setting_key=eq.conversation_message_limit`
- **Response fields the app reads:** `rows[0].setting_value` parsed with `parseInt` — **the value is then discarded** (dead code with a comment "would be used for UI warning"). Safe to drop or keep returning a string.

#### `GET /rest/v1/profiles`
- **Callers:**
  - `app/booking/[id].tsx:142` — wizard init: profile id + wallet balance (only when `user.id` is known).
  - `app/favorites.tsx:680` — after a wallet subscription: refresh balance into AuthContext (`updateUser({ walletBalance })`).
- **Auth:** either (user token in practice).
- **Query / filters:**
  - booking: `user_id=eq.<auth uid>&select=id,wallet_balance&limit=1`
  - favorites: `select=wallet_balance&id=eq.<profileId>&limit=1`
- **Response fields the app reads:** `rows[0].id`, `rows[0].wallet_balance` (number). Falls back to `user.profileId` / `user.walletBalance` from AuthContext when the fetch fails.
- **Behaviour notes:** This document's screens never PATCH `profiles.wallet_balance`; the booking flow inserts a `wallet_transactions` withdrawal but **never decrements the balance** — unless a DB trigger does it, the wallet is not actually charged (see Flows).

#### `GET /rest/v1/sound_effect_generations`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:101`) — "SFX" tab.
- **Auth:** user token.
- **Query / filters:** `select=id,description,duration_seconds,audio_url,credits_used,status,created_at&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `SfxGen` (`shared.tsx:112`): `{ id; description; duration_seconds: number|null; audio_url: string|null; credits_used: number; status; created_at }`.

#### `GET /rest/v1/tts_generations`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:100`) — "TTS" tab.
- **Auth:** user token.
- **Query / filters:** `select=id,text,voice_name,audio_url,credits_used,status,created_at&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `TtsGen` (`shared.tsx:107`): `{ id; text; voice_name; audio_url: string|null; credits_used: number; status; created_at }`.

#### `GET /rest/v1/voice_call_wishes`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:97`) — "Calls" tab.
- **Auth:** user token.
- **Query / filters:** `select=id,celebrity_id,recipient_name,recipient_phone,occasion,sender_name,call_status,scheduled_at,call_duration_seconds,price_paid,vapi_voice_name,created_at,celebrities:celebrity_id(name,image_url)&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `VoiceCall` (`shared.tsx:87`): `{ id; celebrity_id; recipient_name; recipient_phone; occasion; sender_name; call_status; scheduled_at: string|null; call_duration_seconds: number|null; price_paid: number; vapi_voice_name: string|null; created_at; celebrities: { name; image_url } | null }`.

#### `GET /rest/v1/voice_conversion_generations`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:102`) — "Convert" tab.
- **Auth:** user token.
- **Query / filters:** `select=id,target_voice_name,original_file_name,audio_url,credits_used,status,created_at&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `VoiceConversion` (`shared.tsx:117`): `{ id; target_voice_name; original_file_name; audio_url: string|null; credits_used: number; status; created_at }`.

#### `POST /rest/v1/wallet_transactions`  ⚠ money row written by the client
- **Callers:** `app/booking/[id].tsx:365` — second write of the wallet pay flow.
- **Auth:** either (user token in practice).
- **Query / filters:** none; `Prefer: return=representation`.
- **Request body:** `{ user_id: profileId; transaction_type: 'withdrawal'; amount: finalPrice; status: 'completed'; payment_method: 'wallet'; description: 'Booking: <celebrity name> - <wish|ad|video>' }`
- **Response fields the app reads:** none; on error `err.message` ("Wallet deduction failed").
- **Behaviour notes:** Client-side balance check happens **only for `service === 'wish'`**; for `ad`/`video` the withdrawal is inserted with no balance check at all. No `booking_id` link is stored on this row. Must become a server-side atomic debit.

#### `GET /rest/v1/wish_celebrity_orders`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:94`) — "Wishes" tab.
- **Auth:** user token.
- **Query / filters:** `select=id,celebrity_id,occasion_type,recipient_name,message,amount_paid,status,generated_card_image_url,card_url,created_at,celebrities:celebrity_id(name,image_url)&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `WishOrder` (`shared.tsx:70`): `{ id; celebrity_id; occasion_type; recipient_name; message; amount_paid: number; status; generated_card_image_url: string|null; card_url: string|null; created_at; celebrities: { name; image_url } | null }` — image = `generated_card_image_url ?? card_url`.

#### `GET /rest/v1/wish_friend_orders`
- **Callers:** `app/bookings.tsx:67` (config `TabConfig.tsx:93`) — "Wish a Friend" tab.
- **Auth:** user token.
- **Query / filters:** `select=id,order_type,status,recipient_name,occasion,prompt,price_paid,video_url,video_file_key,admin_notes,created_at,celebrities:celebrity_id(name,image_url)&user_id=eq.<profileId>&order=created_at.desc&limit=20`
- **Response fields the app reads:** `WishFriendOrder` (`shared.tsx:63`): `{ id; order_type: 'video_wish'|'ugc_video'; status: 'pending'|'processing'|'completed'|'rejected'; recipient_name; occasion; prompt; price_paid: number; video_url: string|null; video_file_key: string|null; admin_notes: string|null; created_at; celebrities: { name; image_url } | null }`. `WishFriendCard` requests a signed URL for `video_file_key` when `status === 'completed'`, falling back to `video_url`; shows `admin_notes` on `rejected`.
- **Behaviour notes:** Realtime UPDATEs on this table refetch the tab.

---

### RPCs

#### `POST /rest/v1/rpc/purchase_celebrity_subscription`
- **Callers:**
  - `components/celebrity/SubscribeSheet.tsx:82` — "Pay ₹X from wallet" on the celebrity page sheet.
  - `app/favorites.tsx:635` (`callPurchaseRpc`) — both the wallet button and the Razorpay success callback on the Favorites screen.
- **Auth:** user access token (SubscribeSheet returns early if `!token`).
- **Request body (RPC args):** `{ p_celebrity_id: string; p_price: number (from celebrity_favorite_pricing.price); p_payment_method: 'wallet' | 'razorpay' }` — SubscribeSheet always sends `'wallet'`.
- **Response fields the app reads:** SubscribeSheet: JSON `{ success?: boolean; error?: string }` — throws `data.error ?? 'Subscription failed…'` when `success` is falsy; an error message matching `/already subscribed/i` is rewritten to "You are already subscribed to this celebrity." favorites.tsx: only `res.ok`; on non-ok reads `message ?? error` from the body.
- **Behaviour notes:** This RPC is expected to (server-side) debit the wallet when `p_payment_method='wallet'`, insert the `celebrity_favorites` row with `status='active'` and `price_paid`, compute `referrer_commission`/`celebrity_commission` from `celebrity_favorite_pricing` percentages, and reject duplicates. With `'razorpay'` it is invoked purely on the client's payment-success callback with **no payment id / signature passed**, so there is no server-side verification of the Razorpay payment. After success the app re-reads `celebrity_favorites` (and in favorites.tsx `profiles.wallet_balance`).

---

### Edge functions

#### `POST /functions/v1/b2-get-signed-url`
- **Callers:**
  - `components/bookings/CelebCard.tsx:65` — when a celebrity booking is `video_sent|sent|completed` and has `video_file_key`.
  - `components/bookings/WishFriendCard.tsx:35` — when a Wish-a-Friend order is `completed` and has `video_file_key`.
- **Auth:** user access token (skipped when null; WishFriendCard then falls back to `video_url`).
- **Request body:** `{ fileKey: string }` (the Backblaze object key stored in `video_file_key`).
- **Response fields the app reads:** `data.signedUrl ?? data.url` (string). Non-ok → treated as no video (CelebCard) or fallback to `video_url` (WishFriendCard).
- **Behaviour notes:** Called once per card mount / status change; result not cached across mounts.

#### `POST /functions/v1/celebrity-conversation-auto-reply`
- **Callers:** `app/chat/[id].tsx:629` — immediately after the user's message insert succeeds (fire-and-forget).
- **Auth:** user access token.
- **Request body:** `{ conversationId: string; userMessage: string }`
- **Response fields the app reads:** none. The reply is expected to appear as a new `messages` row (`sender_type: 'celebrity'`, `is_ai_generated: true`) picked up by polling; the typing indicator is shown until new rows arrive or 20 s pass.

#### `POST /functions/v1/create-razorpay-order`
- **Callers:** `app/favorites.tsx:708` — "Pay via Razorpay" in the subscription modal.
- **Auth:** user access token.
- **Request body:** `{ amount: number (rupees, = pricing.price); currency: 'INR'; receipt: 'fav_<Date.now()>_<profileId first 6 chars>'; notes: { user_id: profileId; celebrity_id: string; type: 'celebrity_favorite' } }`
- **Response fields the app reads:** `{ id: string (Razorpay order id); amount: number; currency: string; key_id: string (Razorpay public key) }`; on non-ok reads `error`.
- **Behaviour notes:** Web: loads `https://checkout.razorpay.com/v1/checkout.js` and opens `window.Razorpay` with `{ key, amount, currency, order_id, name:'WishMe', description, prefill:{name,email,contact}, theme }`. Native: `react-native-razorpay` `open({ ...same, amount: String(amount) })`, success when `razorpay_payment_id` is returned. Either way success → `purchase_celebrity_subscription` with `'razorpay'` (no payment id forwarded).

#### `POST /functions/v1/generate-greeting-card`
- **Callers:** `app/occasion-book/[id].tsx:199` (raw `fetch`, fire-and-forget) — when `booking_type === 'greeting_card'`.
- **Auth:** user access token (+ `apikey`).
- **Request body:** `{ bookingId: string (occasion_bookings.id); occasionName: string; recipientName: string; message: string; celebrityId: string }`
- **Response fields the app reads:** none.

#### `POST /functions/v1/generate-occasion-auto-reply`
- **Callers:** `app/occasion-wishes.tsx:325` — after inserting an `occasion_wishes` row, only if the selected `celebrity_occasions.auto_reply_enabled` is true (fire-and-forget).
- **Auth:** user access token.
- **Request body:** `{ wish_id: string; celebrity_id: string; occasion_name: string; user_message: string }`
- **Response fields the app reads:** none; expected to populate `occasion_wishes.reply_message` / `reply_sent_at`.

#### `POST /functions/v1/generate-occasion-video`
- **Callers:** `app/occasion-book/[id].tsx:199` (raw `fetch`, fire-and-forget) — when `booking_type === 'video'`.
- **Auth:** user access token (+ `apikey`).
- **Request body:** same shape as `generate-greeting-card`: `{ bookingId, occasionName, recipientName, message, celebrityId }`.
- **Response fields the app reads:** none.

#### `POST /functions/v1/generate-script`
- **Callers:** `app/booking/[id].tsx:279` (raw `fetch`, 30 s timeout) — "AI Generate Script" button in wizard step 4.
- **Auth:** either (`token ?? anon`).
- **Request body:** `{ prompt: string }` — a long template string built client-side containing service type, celebrity name, talking points, `JSON.stringify(step1)` and creative guidelines.
- **Response fields the app reads:** `data.script` (string) → written into the script textbox. Missing/non-ok → toast "AI generation failed".

#### `POST /functions/v1/heygen-get-languages`
- **Callers:** `app/booking/[id].tsx:143` — wizard init (languages dropdown).
- **Auth:** either (`sbFetch` with token or anon; note `Prefer: return=representation` is also sent).
- **Request body:** `{}` (literal `'{}'`).
- **Response fields the app reads:** array of `string | { name: string }` → mapped to names. Empty/failed → 16 hard-coded Indian-language fallbacks.

#### `POST /functions/v1/send-celebrity-subscription-email`
- **Callers:** `app/favorites.tsx:653` — after a successful `purchase_celebrity_subscription` (both payment methods), fire-and-forget. **Not** called from `SubscribeSheet`.
- **Auth:** user access token.
- **Request body:** `{ celebrity_id: string; subscriber_name: '<firstName> <lastName>'.trim(); subscriber_email: string; price_paid: number }`
- **Response fields the app reads:** none.

---

### Storage buckets

#### `PUT /storage/v1/object/voice-notes/<profileId>/voice-<Date.now()>.m4a`
- **Callers:** `app/chat/[id].tsx:728` — `uploadAndSendVoiceNote` after the mic recording stops.
- **Auth:** user access token (`Authorization: Bearer <token>`, `apikey: <anon>`).
- **Request:** headers `Content-Type: audio/m4a`, `x-upsert: true`; body = binary Blob (recording read as base64 via `expo-file-system`, converted through a `data:audio/m4a;base64,` fetch).
- **Bucket / path:** bucket `voice-notes`, path `<profileId>/voice-<timestamp>.m4a`.
- **Response fields the app reads:** `res.ok` only; on failure reads response text for the alert.
- **Public URL stored:** `${SUPABASE_URL}/storage/v1/object/public/voice-notes/<profileId>/voice-<ts>.m4a`, embedded verbatim into `messages.message_text` as `[Voice Note: <url>]` (so the bucket must be publicly readable, and the celebrity side/web app parse the same convention).

#### Read-only external media (not Supabase Storage)
- Celebrity/occasion images with relative `image_url` are read from Backblaze `https://f005.backblazeb2.com/file/wishmetoday/<image_url>`.
- Booking videos are private Backblaze objects referenced by `video_file_key` and fetched through `b2-get-signed-url`.

---

### Realtime

#### `WSS /realtime/v1/websocket?apikey=<anon>&vsn=1.0.0`
- **Callers:** `components/bookings/useRealtimeBookings.tsx:16` — mounted by `app/bookings.tsx:107` while the My Bookings screen is open and the user has a token.
- **Auth:** anon key in the query string; user `access_token` inside each `phx_join` payload.
- **Protocol:** Phoenix channels. On open, joins three topics `realtime:public:bookings`, `realtime:public:music_generations`, `realtime:public:wish_friend_orders`, each with payload `{ config: { broadcast: { ack:false, self:false }, postgres_changes: [{ event: 'UPDATE', schema: 'public', table, filter: 'user_id=eq.<profileId>' }] }, access_token }` and incrementing string `ref`. Heartbeat `{ topic:'phoenix', event:'heartbeat', payload:{} }` every **30000 ms**.
- **Messages read:** `msg.event === 'postgres_changes'` with `msg.payload.data.type === 'UPDATE'` or `msg.payload.eventType === 'UPDATE'`; `msg.topic` substring decides which tab (`wish_friend_orders` / `music_generations` / `bookings`) to invalidate and refetch via REST. No payload data is used — it is purely a refetch trigger.

---

### Flows

#### 1. Book a video wish / UGC ad / video promo (`app/booking/[id].tsx`)
Route params: `id` (celebrity), `service` ∈ `wish | ad | video` (default `wish`).

**Init (parallel, `Promise.allSettled`):**
1. `GET /rest/v1/celebrities?id=eq.<id>&select=*&limit=1`
2. `GET /rest/v1/profiles?user_id=eq.<auth uid>&select=id,wallet_balance&limit=1` (only when logged in) → `profileId`, `walletBalance`; falls back to AuthContext values.
3. `POST /functions/v1/heygen-get-languages` `{}`.
Then, if the celebrity loaded (parallel): 4. `GET celebrity_favorite_pricing?celebrity_id=eq.<id>&is_enabled=eq.true&select=price&limit=1`; 5. `GET celebrity_favorites?user_id=eq.<profileId>&celebrity_id=eq.<id>&status=eq.active&select=id&limit=1` → `isSubscribed`.

**Pricing (client-side):** `basePrice` = `service_prices.general_wish ?? price_per_wish` (wish) / `service_prices.ugc_ad ?? 25000` (ad) / `service_prices.video_promotion ?? 50000` (video); `discountPct` is always 0; `serviceFee = round(afterDiscount × 0.10)`; `finalPrice = afterDiscount + serviceFee`. The server never sees or validates this arithmetic.

**Step 4 (optional):** `POST /functions/v1/generate-script` `{ prompt }` → `script`.

**Step 6 validation:** wish requires `isSubscribed`; terms accepted; wish requires `walletBalance >= finalPrice` (**no balance check for ad/video**).

**Wallet path (`handlePay`), strictly sequential, each step aborts the rest on failure but does not roll back earlier writes:**
1. `POST /rest/v1/bookings` (body above, `status:'pending'`) → `bookingId`.
2. `POST /rest/v1/wallet_transactions` `{ user_id, transaction_type:'withdrawal', amount: finalPrice, status:'completed', payment_method:'wallet', description }` ⚠ client-written money row.
3. `POST /rest/v1/payment_transactions` `{ wishme_payment_id: 'WM…', user_id, amount, payment_method:'wallet', service_type:'booking', booking_id, description, status:'completed', paid_at }` ⚠ client-written money row.
4. `PATCH /rest/v1/bookings?id=eq.<bookingId>` `{ wishme_payment_id }` (result ignored).
5. `router.replace('/booking-summary', { bookingId, paymentId })` → `GET bookings?id=eq.<bookingId>&select=*,celebrities(name,image_url,category)&limit=1`.
`profiles.wallet_balance` is **never updated by the app** in this flow. A failed step 2 or 3 leaves an orphan `pending` booking (and, after step 2, a recorded withdrawal with no payment). The whole thing must become a single server-side "create booking and charge wallet" operation that validates price, subscription and balance.

**Razorpay path:** does not exist in this screen — the "Pay via Razorpay" button only shows `Alert('Coming Soon')`. (Razorpay is implemented only for subscriptions in `app/favorites.tsx`, see flow 2.)

#### 2. Subscribe to a celebrity
**A. From the celebrity page (`app/celebrity/[id].tsx` + `components/celebrity/SubscribeSheet.tsx`), wallet only:**
1. Page already has `pricingPrice` (`GET celebrity_favorite_pricing … select=price`) and `isSubscribed` (`GET celebrity_favorites … select=id`); `useWallet().refetch()` supplies `walletBalance` (wallet domain).
2. Sheet "offer" → "pay". If `price > walletBalance` the button becomes "Add ₹short to wallet" → `onAddMoney` → navigates to `/wallet`; on return the sheet reopens on "pay" (`reopenAfterWallet` ref + `useFocusEffect`).
3. `POST /rest/v1/rpc/purchase_celebrity_subscription` `{ p_celebrity_id, p_price: price, p_payment_method:'wallet' }` → expects `{ success: true }`.
4. On success: `onSubscribed()` → page sets `isSubscribed=true`, re-runs `fetchSubscriptionData` (both GETs above) and `wallet.refetch()`; sheet shows "success" with Video Wish / UGC Ad / Video Promo tiles → `router.push('/booking/[id]', { service })`.

**B. From Favorites (`app/favorites.tsx`), wallet or Razorpay:**
- Load: `GET celebrities?is_active=eq.true&order=name.asc` ∥ `GET celebrity_favorite_pricing?is_enabled=eq.true` ∥ `GET celebrity_favorites?select=*,celebrities(*)&user_id=eq.<pid>&status=eq.active`.
- Wallet: client checks `user.walletBalance >= price` → RPC with `'wallet'` → fire-and-forget `POST /functions/v1/send-celebrity-subscription-email` → `GET celebrity_favorites` refetch → fire-and-forget `GET profiles?select=wallet_balance&id=eq.<pid>&limit=1` → `updateUser({ walletBalance })`.
- Razorpay: `POST /functions/v1/create-razorpay-order` `{ amount, currency:'INR', receipt, notes:{user_id, celebrity_id, type:'celebrity_favorite'} }` → open Razorpay checkout with `key_id`/`id`/`amount`/`currency` → on client success callback: RPC with `'razorpay'` (no payment id sent) → email function → refetch favorites. Failure after a successful payment surfaces as "Partial Payment Error".

#### 3. Send a chat message (user side, `app/chat/[id].tsx`)
**Open:** parallel `GET conversations?select=*,celebrity:celebrities!conversations_celebrity_id_fkey(id,name,image_url)&id=eq.<convId>&limit=1` ∥ `GET platform_settings?select=setting_value&setting_key=eq.conversation_message_limit` (unused) ∥ `GET messages?select=*&conversation_id=eq.<convId>&order=created_at.desc&limit=50`; then `markAsRead`: `PATCH conversations?id=eq.<convId> {unread_count_user:0}` and `PATCH messages?conversation_id=eq.<convId>&is_read=eq.false {is_read:true}`. Start polling `GET messages … created_at=gt.<latest>` every 5 s (paused while backgrounded). Scrolling up loads older pages (`created_at=lt.<oldest>&limit=30`).

**Send (`sendMessage(text)`):**
1. Optimistically prepend `{ id:'temp-<ts>', sender_type:'user', message_text, … }`.
2. `POST /rest/v1/messages` `{ conversation_id, sender_id: profileId, sender_type:'user', message_text, is_read:false, is_ai_generated:false }` (`Prefer: return=minimal`). Failure → remove temp row, alert.
3. Fire-and-forget `PATCH conversations?id=eq.<convId> { last_message_at: now }`.
4. Fire-and-forget `PATCH conversations?id=eq.<convId> { unread_count_celebrity: cached+1 }`; cache incremented.
5. Show typing indicator; fire-and-forget `POST /functions/v1/celebrity-conversation-auto-reply { conversationId, userMessage }`.
6. Timers: `fetchNewMessages()` at +1.5 s (pulls the real row and, usually, the AI reply); at +8 s if still "typing" poll again; at +20 s hide the typing indicator regardless.
Voice note variant: record (expo-av) → `PUT /storage/v1/object/voice-notes/<profileId>/voice-<ts>.m4a` → `sendMessage('[Voice Note: <public url>]')` (same steps 1-6). Sending is blocked when `conversations.is_closed`.

#### 4. Add a loved one with occasions (`app/loved-ones.tsx`; alt path `services/occasionAlerts.ts#createOccasion`)
**Add person:** `POST /rest/v1/loved_ones` `{ user_id, first_name, last_name, email|null, phone|null, date_of_birth|null, relationship, notes|null, occasions: [] }` (`return=minimal`) → `GET loved_ones?user_id=eq.<pid>&order=first_name.asc`.
**Manage Occasions → Save:**
1. `PATCH /rest/v1/loved_ones?id=eq.<lovedOneId>` `{ occasions: [{ id:'occ<ts>', name, date:'YYYY-MM-DD', type:'Birthday'|… }] }` (full replacement).
2. For each occasion present before but removed now: `DELETE /rest/v1/occasion_alerts?user_id=eq.<pid>&loved_one_id=eq.<id>&occasion_name=eq.<name>`.
3. For each occasion with a date: `POST /rest/v1/occasion_alerts?on_conflict=user_id,loved_one_id,occasion_name` (`Prefer: resolution=merge-duplicates,return=minimal`) `{ user_id, loved_one_id, occasion_name, occasion_type: normType(type), occasion_date }`.
4. Any failure in 2/3 → `GET loved_ones` refetch + warning "some alerts could not be synced"; otherwise close, refetch, then `fetchAlerts()` (`GET occasion_alerts?select=*,loved_ones(first_name,last_name),celebrities!occasion_alerts_celebrity_id_fkey(name)&user_id=eq.<pid>&order=occasion_date.asc`) and reschedule local phone notifications (`scheduleOccasionNotifications`, up to 20 within 60 days).
**`createOccasion` (Add Occasion sheet):** optional `POST loved_ones { user_id, first_name, relationship, occasions: [] }` (`return=representation`, read `[0].id`) or `GET loved_ones?id=eq.<id>&select=occasions`; then `POST occasion_alerts` upsert with `alert_enabled, auto_send_enabled:false, alert_days_before, reminder_time:'HH:MM:00'`; then `PATCH loved_ones?id=eq.<id> { occasions: existing-minus-same-name + new }` (failure ignored). The two stores (`loved_ones.occasions` JSON and `occasion_alerts` rows) are kept in sync only by the client — a server re-implementation should make one the source of truth.
**Delete person:** `DELETE /rest/v1/loved_ones?id=eq.<id>`; alerts are expected to be removed by the database.

#### 5. Book an occasion (`app/occasion-book/[id].tsx`)
1. Requires `user && session` (otherwise sign-in gate). Parallel: `GET occasions?id=eq.<id>&limit=1` ∥ `GET celebrity_favorites?user_id=eq.<pid>&status=eq.active&select=celebrity_id`.
2. If any favourites: `GET celebrities?is_active=eq.true&is_verified=eq.true&id=in.(<ids>)&select=id,name,image_url,category,service_prices`; zero results → "No Celebrity Subscriptions" gate.
3. Submit: `POST /rest/v1/occasion_bookings` `{ user_id, occasion_id, celebrity_id, booking_type:'video'|'greeting_card', recipient_name, recipient_email|null, recipient_phone|null, message, price: 0, status:'pending' }` (`return=representation`) → `bookingId`.
4. Fire-and-forget `POST /functions/v1/generate-occasion-video` or `/generate-greeting-card` `{ bookingId, occasionName, recipientName, message, celebrityId }`.
5. `confirmOrder(...)` UI → "View" goes to `/bookings`.

#### 6. Send an occasion wish (`app/occasion-wishes.tsx`)
1. `GET celebrity_favorites?select=celebrity_id&user_id=eq.<pid>&status=eq.active` → ids; then parallel `GET celebrities?select=id,name,image_url,category&id=in.(<ids>)&is_active=eq.true` ∥ `GET celebrity_occasions?select=*,celebrities:celebrity_id(id,name,image_url,category)&celebrity_id=in.(<ids>)&is_public=eq.true&occasion_date=gte.<today>&order=occasion_date.asc` ∥ `GET occasion_wishes?select=*,celebrity_occasions!inner(*,celebrities:celebrity_id(id,name,image_url,category))&user_id=eq.<pid>&order=created_at.desc&limit=20`.
2. `POST /rest/v1/occasion_wishes` `{ user_id, celebrity_id, occasion_id, message }` (`return=representation`) → `wish.id`.
3. If `celebrity_occasions.auto_reply_enabled`: fire-and-forget `POST /functions/v1/generate-occasion-auto-reply` `{ wish_id, celebrity_id, occasion_name, user_message }`.
4. Refetch everything from step 1; switch to "My Wishes" tab.

#### Known problems the migration must fix (summary)
- `app/booking/[id].tsx` writes `bookings`, `wallet_transactions` (withdrawal, `status:'completed'`) and `payment_transactions` (`status:'completed'`) directly from the client, computes the price client-side, never decrements `profiles.wallet_balance`, and skips the balance check for `ad`/`video` services. Non-atomic: partial failures leave orphan rows.
- `purchase_celebrity_subscription` is called with `p_payment_method:'razorpay'` on the client's success callback only; no Razorpay payment id/signature reaches the server.
- Chat counters (`conversations.unread_count_celebrity`, `last_message_at`) and read-marking are client-driven PATCHes.
- `loved_ones.occasions` JSON and `occasion_alerts` rows are dual-written by the client.
- Voice notes depend on a public `voice-notes` bucket and the `[Voice Note: <url>]` text convention.


---

## Domain 3 — Celebrity dashboard

Scope: `app/celebrity-dashboard.tsx` and everything in `components/celebrity-dashboard/` (shared.tsx, BookingsTab, ConsentTab, ContentTab, EventsTab, FollowersTab, MessagesTab, ProfileTab, ReviewsTab, TdsTab, WalletTab). Paths are relative to `artifacts/mobile`.

Transport facts that apply to every entry below:

- All PostgREST calls go through `supabaseFetch(path, options, accessToken)` in `constants/supabase.ts:16`. It sends `apikey: <SUPABASE_ANON_KEY>`, `Authorization: Bearer <accessToken ?? SUPABASE_ANON_KEY>`, `Content-Type: application/json`, 20 s abort timeout. Every dashboard call passes `session.access_token` (or `session?.access_token`, which falls back to the anon key when the session is null — in practice the dashboard only renders with a session, so treat all calls as **user access token**).
- Writes send `Prefer: return=minimal` (except the `celebrity_settings` upsert which sends `Prefer: resolution=merge-duplicates,return=minimal`). The app never reads a body from a successful write; on failure it reads `err.message` from the JSON error body.
- The dashboard does **not** import anything from `services/supabaseRest.ts`; it only uses `constants/supabase.ts` (`supabaseFetch`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`) and `uploadToStorage` from `components/celebrity-dashboard/shared.tsx:194`.
- Three tabs open **Supabase Realtime WebSockets** (`wss://<project>/realtime/v1/websocket?apikey=<anon>&vsn=1.0.0`) and refetch on `postgres_changes` — see the "Realtime" section. Nothing in the dashboard uses `setInterval` polling against REST; MessagesTab is realtime-driven, not polled.

### Row shapes declared in `components/celebrity-dashboard/shared.tsx`

These are the TypeScript interfaces the tabs cast JSON into; a replacement API must return at least these fields.

```ts
// shared.tsx:61
export interface Celebrity {
  id: string;
  profile_id: string;
  name: string;
  category: string;
  bio: string;
  image_url: string;
  available_balance: number;
  rating: number;
  review_count: number;
  consent_status: string;
  consent_photo_url: string;
  consent_video_url: string;
  date_of_birth: string;
  anniversary: string;
  social_media: Record<string, string>;   // keys read: instagram, youtube, twitter, tiktok, facebook, linkedin, website, other
  service_prices: Record<string, number>; // keys written: general_wish, text_message, image_promotion, video_promotion, ugc_ad, voice_call
  status: string;
  commission_percentage?: number;
  delivery_time?: number;
}

// shared.tsx:83
export interface Booking {
  id: string;
  celebrity_id: string;
  profile_id: string;
  service_type: string;
  final_price: number;
  celebrity_commission: number;
  status: string;            // values the UI reacts to: pending, accepted, rejected, completed, in_progress
  created_at: string;
  message?: string;          // JSON string; parsed as { requestDetails | step1 | <root> } -> { recipientName?, occasion?, message? }
  fan_name?: string;         // declared, never read
  profiles?: { first_name: string; last_name: string };   // embedded via profiles(first_name,last_name)
}

// shared.tsx:97
export interface ImagePromotion {
  id: string;
  concept: string;
  price_paid: number;
  status: string;
  created_at: string;
  profiles?: { first_name: string; last_name: string };
}

// shared.tsx:249
export interface WalletTx {
  id: string;
  transaction_type: string;  // UI treats 'credit' | 'booking_payment' | 'bonus' as credits (+), everything else as debit (-)
  amount: number;            // net amount
  gross_amount?: number;
  tds_amount?: number;
  tds_percentage?: number;
  status: string;            // 'pending' rows are summed into "Pending Clearance"
  description: string;
  created_at: string;
}
```

Tab-local interfaces (declared inside the tab files, documented under their tables): `MediaItem` (ContentTab), `CelebEvent` (EventsTab), `Follower` (FollowersTab), `Conversation` / `Message` / `CelebSettings` (MessagesTab), `ProfileInfo` (ProfileTab), `Review` (ReviewsTab), `BankDetail` / `PayoutRequest` (WalletTab).

---

### Supabase Auth

#### `PUT /auth/v1/user`
- **Callers:** `components/celebrity-dashboard/ProfileTab.tsx:89` — "Change Password" card; sets a new password for the signed-in celebrity.
- **Auth:** user access token (`Authorization: Bearer <session.access_token>`) plus `apikey: <anon key>`; raw `fetch`, not `supabaseFetch`.
- **Query / filters:** none.
- **Request body:** `{ password: string }` — client-side validated: length >= 6 and equal to a confirm field.
- **Response fields the app reads:** nothing on success; on failure `message` from the JSON error body.
- **Behaviour notes:** Pure GoTrue password update. No re-login after success; the existing session continues to be used.

---

### Tables

#### `GET /rest/v1/bank_details`
- **Callers:** `components/celebrity-dashboard/WalletTab.tsx:46` — list the celebrity user's saved bank accounts for payout selection.
- **Auth:** user access token.
- **Query / filters:** `?user_id=eq.<user.profileId>&order=created_at.desc` (no `select`, all columns).
- **Request body:** none.
- **Response fields the app reads:** `id`, `bank_name`, `bank_account_number` (only last 4 shown via `.slice(-4)`), `ifsc_code`, `account_holder_name` (interface `BankDetail`, WalletTab.tsx:13). First row is auto-selected as `selectedBank`.
- **Behaviour notes:** Filter is by `user_id = profileId` (the auth user's profile id), not `celebrity_id`. Full account number is returned to the client.

#### `POST /rest/v1/bank_details`
- **Callers:** `components/celebrity-dashboard/WalletTab.tsx:120` — "Save Bank Account" form.
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** none.
- **Request body:** `{ bank_name: string, bank_account_number: string, ifsc_code: string (uppercased client-side), account_holder_name: string, user_id: <user.profileId> }`. All four text fields required client-side.
- **Response fields the app reads:** none on success (then refetches everything via `fetchAll()`); `message` on error.
- **Behaviour notes:** **MONEY-ADJACENT WRITE FROM CLIENT** — the app inserts bank details directly. No validation of IFSC format or account number beyond non-empty. Server re-implementation should own this write and validate.

#### `GET /rest/v1/bookings`
- **Callers:**
  - `app/celebrity-dashboard.tsx:72` — earnings/stat computation for the header cards.
  - `components/celebrity-dashboard/BookingsTab.tsx:25` — "All Bookings" list.
- **Auth:** user access token.
- **Query / filters:**
  - dashboard: `?celebrity_id=eq.<celebrity.id>&select=status,celebrity_commission` (no limit, no order — fetches all rows).
  - BookingsTab: `?celebrity_id=eq.<celebrity.id>&select=*,profiles(first_name,last_name)&order=created_at.desc&limit=50` (embeds `profiles` via `bookings.profile_id -> profiles.id`).
- **Request body:** none.
- **Response fields the app reads:**
  - dashboard: `status`, `celebrity_commission`.
  - BookingsTab (interface `Booking`): `id`, `status`, `service_type`, `final_price`, `created_at`, `message`, `profiles.first_name`, `profiles.last_name`.
- **Behaviour notes:**
  - **Earnings are computed client-side** (`app/celebrity-dashboard.tsx:79-81`):
    - `totalEarnings = sum(celebrity_commission ?? 0) where status === 'completed'`
    - `pendingEarnings = sum(celebrity_commission ?? 0) where status in ['pending','in_progress','accepted']`
    - `totalBookings = rows.length` (all statuses, including rejected).
    A replacement API should expose these as a stats endpoint or keep the same raw query.
  - `message` is a JSON string; parse order is `parsed.requestDetails ?? parsed.step1 ?? parsed`, reading `recipientName`, `occasion`, `message`.
  - BookingsTab also subscribes to Realtime `postgres_changes` on `bookings` filtered by `celebrity_id` and refetches on any event (see Realtime).

#### `PATCH /rest/v1/bookings`
- **Callers:** `components/celebrity-dashboard/BookingsTab.tsx:95` — Accept / Decline buttons on a `pending` booking.
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** `?id=eq.<booking.id>`.
- **Request body:** `{ status: 'accepted' | 'rejected' }` — the only two values the UI sends. No other status transitions are made from the dashboard (there is no "complete" button; `completed` must come from elsewhere, e.g. the fan/admin side or a delivery flow).
- **Response fields the app reads:** none on success (optimistically sets `status` in local state); `message` on error.
- **Behaviour notes:** No guard other than the button only showing when `status === 'pending'`. Server must enforce that only the owning celebrity can change status and only from `pending`. Note the mismatch: `STATUS_COLORS` knows both `rejected` and `declined`, but the app writes `rejected`.

#### `GET /rest/v1/celebrities`
- **Callers:** `app/celebrity-dashboard.tsx:53` — load the signed-in user's celebrity row (gates the whole screen).
- **Auth:** user access token.
- **Query / filters:** `?profile_id=eq.<user.profileId>&select=*&limit=1`.
- **Request body:** none.
- **Response fields the app reads:** full `Celebrity` interface. Directly read: `id`, `name`, `category`, `rating`, `review_count`, `consent_status`, `consent_photo_url`, `image_url`, `available_balance`, `service_prices`, `social_media`, `bio`, `date_of_birth`, `anniversary`, `status`, `commission_percentage`, `delivery_time`, `profile_id`.
- **Behaviour notes:** Empty array => "Access Restricted" (not a celebrity). Non-OK => error screen with retry. `consent_status` not in `('submitted','approved')` shows the orange consent banner. `fetchCelebrity` is re-run by pull-to-refresh and by tabs after they PATCH the row (`onRefresh` / `onRefreshCeleb`). `image_url` that does not start with `http` is rendered as `https://f005.backblazeb2.com/file/wishmetoday/<image_url>` (ContentTab.tsx:107-111) — legacy Backblaze storage.

#### `PATCH /rest/v1/celebrities`
- **Callers:**
  - `components/celebrity-dashboard/ConsentTab.tsx:46` — submit consent after uploading photo + video.
  - `components/celebrity-dashboard/ContentTab.tsx:52` — set new avatar after upload.
  - `components/celebrity-dashboard/ProfileTab.tsx:61` — save service pricing.
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** `?id=eq.<celebrity.id>` in all three.
- **Request body (exact columns, per caller):**
  - ConsentTab: `{ consent_photo_url: string (public storage URL), consent_video_url: string (public storage URL), consent_status: 'submitted', consent_given_at: string (ISO timestamp, client clock) }`.
  - ContentTab: `{ image_url: string (public storage URL) }`.
  - ProfileTab: `{ service_prices: { general_wish: number, text_message: number, image_promotion: number, video_promotion: number, ugc_ad: number, voice_call: number } }` — each value `parseFloat(input || '0') || 0`; the whole JSON object is replaced, not merged.
- **Response fields the app reads:** none on success (each calls `onRefresh()` => refetch of the celebrity row); `message` on error.
- **Behaviour notes:** Client sets `consent_status='submitted'` itself and stamps `consent_given_at` with the device clock; approval to `approved` happens elsewhere (admin). The celebrity can rewrite its own prices at any time with no bounds check. Note that `available_balance` is a column on this table but the dashboard **never writes it** — it only reads it (WalletTab balance card, payout amount check).

#### `GET /rest/v1/celebrity_events`
- **Callers:** `components/celebrity-dashboard/EventsTab.tsx:43` — list the celebrity's events.
- **Auth:** user access token.
- **Query / filters:** `?celebrity_id=eq.<celebrity.id>&order=event_date.asc&limit=30`.
- **Request body:** none.
- **Response fields the app reads** (interface `CelebEvent`, EventsTab.tsx:16): `id`, `title`, `event_date`, `event_type`, `description`, `location?`, `is_public?`, `status` (declared, not rendered).
- **Behaviour notes:** `event_type` is rendered through `StatusBadge`. `is_public === false` shows "Private".

#### `POST /rest/v1/celebrity_events`
- **Callers:** `components/celebrity-dashboard/EventsTab.tsx:78` — "Create Event".
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** none.
- **Request body:** `{ title: string, event_type: 'concert'|'meetup'|'birthday'|'anniversary'|'launch'|'charity'|'other', event_date: string ('YYYY-MM-DD' free text), description: string, location: string, is_public: boolean, celebrity_id: <celebrity.id> }` (spread of the form plus `celebrity_id`). Client requires `title`, `event_type`, `event_date`.
- **Response fields the app reads:** none (refetches list); `message` on error.

#### `PATCH /rest/v1/celebrity_events`
- **Callers:** `components/celebrity-dashboard/EventsTab.tsx:78` — "Save Changes" on an existing event (same call site, `isEdit` branch).
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** `?id=eq.<event.id>`.
- **Request body:** `{ title, event_type, event_date, description, location, is_public }` (no `celebrity_id`).
- **Response fields the app reads:** none; `message` on error.

#### `DELETE /rest/v1/celebrity_events`
- **Callers:** `components/celebrity-dashboard/EventsTab.tsx:104` — trash icon, after an `Alert` confirm.
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** `?id=eq.<event.id>`.
- **Request body:** none.
- **Response fields the app reads:** none; `message` on error.
- **Behaviour notes:** Hard delete. Server must restrict to events owned by the caller's celebrity.

#### `GET /rest/v1/celebrity_favorites`
- **Callers:** `components/celebrity-dashboard/FollowersTab.tsx:26` — "Followers" list and count.
- **Auth:** user access token.
- **Query / filters:** `?celebrity_id=eq.<celebrity.id>&select=*,profiles(first_name,last_name,email)&order=created_at.desc&limit=50` (embeds `profiles` via `celebrity_favorites.user_id -> profiles.id`).
- **Request body:** none.
- **Response fields the app reads** (interface `Follower`, FollowersTab.tsx:11): `id`, `user_id`, `created_at`, `status` (defaults to `'active'` when falsy), `subscription_expires_at?` (null => "Lifetime"), `profiles.first_name`, `profiles.last_name`, `profiles.email`.
- **Behaviour notes:** Exposes follower **emails** to the celebrity. "Total Followers" = `rows.length` (capped at 50 by the limit, so the count is wrong beyond 50). Realtime subscription on `celebrity_favorites` filtered by `celebrity_id` triggers refetch.

#### `GET /rest/v1/celebrity_media`
- **Callers:** `components/celebrity-dashboard/ContentTab.tsx:30` — promo media grid.
- **Auth:** user access token.
- **Query / filters:** `?celebrity_id=eq.<celebrity.id>&order=created_at.desc&limit=20` (all columns).
- **Request body:** none.
- **Response fields the app reads** (interface `MediaItem`, ContentTab.tsx:16): `id`, `media_url`, `media_type` (`'video'` shows a play icon, anything else renders `media_url` as an image), `created_at`.

#### `POST /rest/v1/celebrity_media`
- **Callers:** `components/celebrity-dashboard/ContentTab.tsx:85` — after uploading a promo photo/video to storage.
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** none.
- **Request body:** `{ celebrity_id: <celebrity.id>, media_url: string (public storage URL), media_type: 'photo' | 'video' }`.
- **Response fields the app reads:** none (refetches media); `message` on error.

#### `GET /rest/v1/celebrity_reviews`
- **Callers:** `components/celebrity-dashboard/ReviewsTab.tsx:26` — reviews list + rating histogram.
- **Auth:** user access token.
- **Query / filters:** `?celebrity_id=eq.<celebrity.id>&select=*,profiles(first_name,last_name),bookings(service_type)&order=created_at.desc&limit=30` (two embeds: `profiles` via the reviewer FK, `bookings` via `booking_id`).
- **Request body:** none.
- **Response fields the app reads** (interface `Review`, ReviewsTab.tsx:11): `id`, `rating`, `review_text`, `created_at`, `booking_id?` (declared only), `profiles.first_name`, `profiles.last_name`, `bookings.service_type`.
- **Behaviour notes:** Average rating and 5..1 star counts are computed client-side from the (max 30) returned rows, independent of `celebrities.rating` / `review_count` shown in the header.

#### `GET /rest/v1/celebrity_settings`
- **Callers:** `components/celebrity-dashboard/MessagesTab.tsx:62` — read the AI auto-reply toggle (fetched in parallel with conversations).
- **Auth:** user access token.
- **Query / filters:** `?celebrity_id=eq.<celebrity.id>&limit=1`.
- **Request body:** none.
- **Response fields the app reads** (interface `CelebSettings`, MessagesTab.tsx:35): `id?`, `celebrity_id`, `ai_auto_reply_enabled`. Missing row defaults to `{ celebrity_id, ai_auto_reply_enabled: false }`.

#### `POST /rest/v1/celebrity_settings` (upsert)
- **Callers:** `components/celebrity-dashboard/MessagesTab.tsx:82` — ON/OFF toggle for AI auto-reply.
- **Auth:** user access token. `Prefer: resolution=merge-duplicates,return=minimal` — i.e. **upsert on conflict**; requires a unique constraint on `celebrity_id` for this to behave as an update.
- **Query / filters:** none.
- **Request body:** `{ celebrity_id: <celebrity.id>, ai_auto_reply_enabled: boolean }`.
- **Response fields the app reads:** none (local state flipped on `res.ok`).
- **Behaviour notes:** This flag is presumably consumed server-side by whatever auto-replies to fans (not visible in this domain); the replacement API must keep a per-celebrity settings record.

#### `GET /rest/v1/celebrity_wallet_transactions`
- **Callers:**
  - `components/celebrity-dashboard/WalletTab.tsx:48` — "Transaction History" and "Pending Clearance".
  - `components/celebrity-dashboard/TdsTab.tsx:34` — TDS summary for a financial year.
- **Auth:** user access token.
- **Query / filters:**
  - WalletTab: `?celebrity_id=eq.<celebrity.id>&order=created_at.desc&limit=50`.
  - TdsTab: `?celebrity_id=eq.<celebrity.id>&tds_amount=not.is.null&created_at=gte.<YYYY>-04-01&created_at=lte.<YYYY+1>-03-31T23:59:59&order=created_at.desc` (no limit). FY options hard-coded: `FY 2022-23` .. `FY 2025-26`, default `FY 2024-25`; Indian FY = 1 Apr to 31 Mar.
- **Request body:** none.
- **Response fields the app reads** (interface `WalletTx`): `id`, `transaction_type`, `amount`, `gross_amount`, `tds_amount`, `tds_percentage`, `status`, `description`, `created_at`.
- **Behaviour notes:**
  - WalletTab **merges virtual rows** derived from `image_promotions` (see below) into this list: for each completed image promotion it fabricates `{ id: 'ip-<id>', transaction_type: 'earning', amount: round(price_paid * 0.7), status: 'completed', description: 'Image promotion commission', created_at }` and sorts the union by `created_at` desc. The 70 % split is **hard-coded in the client** (WalletTab.tsx:55-62). Note `'earning'` is not in the credit list `['credit','booking_payment','bonus']`, so these virtual rows render with a "-" sign (a visible bug to decide on, not to preserve).
  - `pendingClearance = sum(amount) where status === 'pending'` over the merged list.
  - TdsTab totals: `totalGross = sum(gross_amount)`, `totalTds = sum(tds_amount)`, `totalNet = sum(amount)`.
  - The dashboard **never writes** this table; rows must be produced server-side (booking completion, payouts, TDS).

#### `GET /rest/v1/conversations`
- **Callers:** `components/celebrity-dashboard/MessagesTab.tsx:57` — conversation list.
- **Auth:** user access token.
- **Query / filters:** `?celebrity_id=eq.<celebrity.id>&select=*,profiles(first_name,last_name)&order=last_message_at.desc&limit=30` (embeds `profiles` via `conversations.user_id`).
- **Request body:** none.
- **Response fields the app reads** (interface `Conversation`, MessagesTab.tsx:16): `id`, `user_id`, `last_message_at`, `last_message_text`, `unread_count_celebrity?`, `profiles.first_name`, `profiles.last_name`.
- **Behaviour notes:** Realtime subscription on `conversations` filtered by `celebrity_id` => refetch (`fetchConvos`), which also refetches `celebrity_settings`.

#### `PATCH /rest/v1/conversations`
- **Callers:** `components/celebrity-dashboard/MessagesTab.tsx:252` — after a manual reply is inserted.
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** `?id=eq.<activeConvo.id>`.
- **Request body:** `{ last_message_at: string (ISO, client clock) }`. The app does **not** update `last_message_text` or `unread_count_*`; those must be maintained by a trigger/server.
- **Response fields the app reads:** none; errors swallowed (`.catch(() => {})`).

#### `GET /rest/v1/image_promotions`
- **Callers:**
  - `components/celebrity-dashboard/BookingsTab.tsx:30` — "Image Promotions" list under bookings.
  - `components/celebrity-dashboard/WalletTab.tsx:49` — source of virtual earning rows.
- **Auth:** user access token.
- **Query / filters:**
  - BookingsTab: `?celebrity_id=eq.<celebrity.id>&select=*,profiles(first_name,last_name)&order=created_at.desc&limit=30`.
  - WalletTab: `?celebrity_id=eq.<celebrity.id>&status=eq.completed&order=created_at.desc&limit=50`.
- **Request body:** none.
- **Response fields the app reads** (interface `ImagePromotion`): `id`, `concept` (falls back to "Image Promotion"), `price_paid`, `status`, `created_at`, `profiles.first_name`, `profiles.last_name`.
- **Behaviour notes:** Read-only from the dashboard; no accept/decline for image promotions. Realtime subscription on `image_promotions` filtered by `celebrity_id` => refetch in BookingsTab.

#### `GET /rest/v1/messages`
- **Callers:**
  - `components/celebrity-dashboard/MessagesTab.tsx:187` — open a conversation (`openConvo`).
  - `components/celebrity-dashboard/MessagesTab.tsx:168` — refetch on Realtime `INSERT` into `messages` for the open conversation.
- **Auth:** user access token.
- **Query / filters:** `?conversation_id=eq.<conversation.id>&order=created_at.asc&limit=100` (both call sites; all columns).
- **Request body:** none.
- **Response fields the app reads** (interface `Message`, MessagesTab.tsx:25): `id`, `conversation_id`, `sender_id`, `message_text`, `created_at`, `is_read`, `is_ai_generated?`.
- **Behaviour notes:** "Mine" = `sender_id === user.profileId`. `is_ai_generated && isMine` shows an "AI" badge. Fan messages = `sender_id !== user.profileId`.

#### `PATCH /rest/v1/messages`
- **Callers:** `components/celebrity-dashboard/MessagesTab.tsx:193` — mark fan messages as read when a conversation is opened.
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** `?conversation_id=eq.<conversation.id>&sender_id=neq.<user.profileId>&is_read=eq.false`.
- **Request body:** `{ is_read: true }`.
- **Response fields the app reads:** none; errors swallowed.
- **Behaviour notes:** Runs after the GET on every `openConvo` (including the re-open after sending or generating a reply). The app does not reset `conversations.unread_count_celebrity` itself.

#### `POST /rest/v1/messages`
- **Callers:** `components/celebrity-dashboard/MessagesTab.tsx:233` — manual reply from the celebrity.
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** none.
- **Request body:** `{ conversation_id: <activeConvo.id>, sender_id: <user.profileId>, sender_type: 'celebrity', message_text: string (trimmed) }`. Note `sender_type` is sent but not in the `Message` interface the app reads.
- **Response fields the app reads:** none; `message` on error.
- **Behaviour notes:** Followed by `PATCH conversations` (last_message_at) then `openConvo()` (GET messages + PATCH is_read). See Flows.

#### `GET /rest/v1/payout_requests`
- **Callers:** `components/celebrity-dashboard/WalletTab.tsx:47` — "Payout History".
- **Auth:** user access token.
- **Query / filters:** `?celebrity_id=eq.<celebrity.id>&order=requested_at.desc&limit=20`.
- **Request body:** none.
- **Response fields the app reads** (interface `PayoutRequest`, WalletTab.tsx:21): `id`, `requested_amount`, `status`, `bank_name`, `requested_at`.

#### `POST /rest/v1/payout_requests`
- **Callers:** `components/celebrity-dashboard/WalletTab.tsx:81` — "Submit Payout Request".
- **Auth:** user access token. `Prefer: return=minimal`.
- **Query / filters:** none.
- **Request body:** `{ celebrity_id: <celebrity.id>, profile_id: <user.profileId>, requested_amount: number, bank_name: string, bank_account_number: string, ifsc_code: string, account_holder_name: string }` — bank fields are **copied from the selected `bank_details` row** (denormalised snapshot). `requested_at` and `status` are not sent (DB defaults).
- **Response fields the app reads:** none (then `fetchAll()` and `onRefreshCeleb()` to re-read `available_balance`); `message` on error.
- **Behaviour notes:** **MONEY WRITE FROM CLIENT.** The only balance check is client-side: `amt <= celebrity.available_balance`. The app does **not** debit `celebrities.available_balance` or insert a `celebrity_wallet_transactions` row — it expects the backend (trigger/admin) to do so, since it refetches the celebrity row right after. Server re-implementation must: validate amount against the real balance atomically, reserve/debit the balance, create the ledger row, and own the bank snapshot.

#### `GET /rest/v1/profiles`
- **Callers:** `components/celebrity-dashboard/ProfileTab.tsx:43` — "Personal Info" card.
- **Auth:** user access token.
- **Query / filters:** `?id=eq.<celebrity.profile_id>&select=first_name,last_name,email,phone&limit=1`.
- **Request body:** none.
- **Response fields the app reads** (interface `ProfileInfo`, ProfileTab.tsx:21): `first_name`, `last_name`, `email`, `phone?`.
- **Behaviour notes:** Also appears as an **embedded resource** in `bookings`, `image_promotions`, `celebrity_favorites` (with `email`), `conversations`, `celebrity_reviews` — the API must be able to join the counterpart profile's `first_name`/`last_name` (and `email` for followers) into those list responses.

---

### Edge functions

#### `POST /functions/v1/celebrity-ai-message`
- **Callers:** `components/celebrity-dashboard/MessagesTab.tsx:208` — "AI Reply" button in an open conversation.
- **Auth:** user access token (`Authorization: Bearer <session.access_token>`) plus `apikey: <anon key>`, `Content-Type: application/json`; raw `fetch`.
- **Query / filters:** none.
- **Request body:** `{ conversationId: <activeConvo.id>, userMessage: string }` where `userMessage` = `message_text` of the **last message whose `sender_id !== user.profileId`** (empty string if none; the button is disabled when there are no fan messages).
- **Response fields the app reads:** none on success — the app immediately re-runs `openConvo()` to GET messages, so the **function itself must INSERT the AI reply into `messages`** (with `is_ai_generated: true`, `sender_id` = celebrity's profile id so it renders on the right) and presumably bump the conversation. On failure reads `message`.
- **Behaviour notes:** The generated text is never returned to or shown by the client directly; it only appears via the subsequent messages fetch (and the Realtime INSERT subscription would also trigger a refetch).

(`send-email-otp` / `verify-email-otp` are only warmed up in `constants/supabase.ts:68` from the sign-in screen; not part of this domain.)

---

### Storage buckets

All uploads go through `uploadToStorage(bucket, path, uri, mimeType, token)` in `components/celebrity-dashboard/shared.tsx:194`:
`POST ${SUPABASE_URL}/storage/v1/object/<bucket>/<path>` with headers `Authorization: Bearer <token>` and `x-upsert: true`, body = `multipart/form-data` with a single `file` field (on web a `Blob` fetched from the picker URI; on native `{ uri, name, type }`). No `apikey` header. On `res.ok` it returns the **public URL** `${SUPABASE_URL}/storage/v1/object/public/<bucket>/<path>`, otherwise `null`. That returned string is what gets stored in the DB columns below, so the buckets must be public-read.

#### `POST /storage/v1/object/verification-docs/<celebrity.id>/consent-photo-<ts>.jpg` and `.../consent-video-<ts>.webm`
- **Callers:** `components/celebrity-dashboard/ConsentTab.tsx:40` and `:41` — consent photo and video, uploaded in parallel (`Promise.all`).
- **Auth:** user access token.
- **Request body:** multipart `file`; declared content types `image/jpeg` and `video/webm` (the video is labelled `.webm`/`video/webm` regardless of what the picker actually returned).
- **Public URL stored:** into `celebrities.consent_photo_url` / `celebrities.consent_video_url` via `PATCH /rest/v1/celebrities`.
- **Behaviour notes:** Both uploads must succeed before the PATCH; otherwise "Upload failed" and no DB write. `ts = Date.now()` shared by both paths.

#### `POST /storage/v1/object/celebrity-avatars/<safeName>/avatar/<ts>-avatar.jpg`
- **Callers:** `components/celebrity-dashboard/ContentTab.tsx:50` — "Change Photo".
- **Auth:** user access token.
- **Request body:** multipart `file`, `image/jpeg`. `safeName = celebrity.name.replace(/\s+/g,'_').toLowerCase()` (path keyed by display name, not id).
- **Public URL stored:** into `celebrities.image_url` via `PATCH /rest/v1/celebrities`.

#### `POST /storage/v1/object/promotional-content/<safeName>/promotional/<photo|video>/<ts>-promo.<jpg|mp4>`
- **Callers:** `components/celebrity-dashboard/ContentTab.tsx:83` — "Upload Photo" / "Upload Video".
- **Auth:** user access token.
- **Request body:** multipart `file`; `image/jpeg` for photos, `video/mp4` for videos (extension/mime fixed by the button pressed, not sniffed).
- **Public URL stored:** into a new `celebrity_media` row (`media_url`, `media_type: 'photo'|'video'`) via `POST /rest/v1/celebrity_media`.

---

### Realtime (Supabase-specific transport the API must replace)

Three tabs open a raw Phoenix WebSocket to `wss://<SUPABASE_HOST>/realtime/v1/websocket?apikey=<SUPABASE_ANON_KEY>&vsn=1.0.0`, send `phx_join` with `payload.access_token = session.access_token` and a `postgres_changes` config, heartbeat every 30 s on topic `phoenix`, and on any message with `event === 'postgres_changes'` simply **refetch via REST** (they never read the change payload):

| File | Topic(s) | Filter | Event | Refetch |
|---|---|---|---|---|
| `components/celebrity-dashboard/BookingsTab.tsx:52-90` | `realtime:public:bookings`, `realtime:public:image_promotions` (one socket, two joins) | `celebrity_id=eq.<celebrity.id>` | `*` | `fetchBookings()` |
| `components/celebrity-dashboard/FollowersTab.tsx:38-72` | `realtime:public:celebrity_favorites` | `celebrity_id=eq.<celebrity.id>` | `*` | `fetchFollowers()` |
| `components/celebrity-dashboard/MessagesTab.tsx:100-134` | `realtime:public:conversations` | `celebrity_id=eq.<celebrity.id>` | `*` | `fetchConvos()` |
| `components/celebrity-dashboard/MessagesTab.tsx:139-181` | `realtime:public:messages` (second socket, per open conversation) | `conversation_id=eq.<activeConvo.id>` | `INSERT` | `GET /rest/v1/messages?...` |

A replacement needs an equivalent "something changed for celebrity X / conversation Y" push (SSE/WebSocket) or the UI degrades to manual refresh only. There is **no REST polling** anywhere in the dashboard.

---

### Flows

#### Dashboard load (celebrity row + earnings)
1. `GET /rest/v1/celebrities?profile_id=eq.<profileId>&select=*&limit=1` (`app/celebrity-dashboard.tsx:53`). No rows => "Access Restricted"; error => retry screen.
2. `GET /rest/v1/bookings?celebrity_id=eq.<celebrity.id>&select=status,celebrity_commission` (`:72`).
3. Client computes `totalEarnings` (completed), `pendingEarnings` (pending/in_progress/accepted), `totalBookings` (count); header also shows `celebrity.rating`, `celebrity.review_count`.
4. The active tab then issues its own fetches (BookingsTab by default: bookings + image_promotions in parallel, then opens the Realtime socket).
5. Pull-to-refresh and `onRefresh`/`onRefreshCeleb` from tabs rerun steps 1-3.

#### Accept / decline a booking
1. BookingsTab shows Accept/Decline only for `status === 'pending'`.
2. `PATCH /rest/v1/bookings?id=eq.<id>` body `{ status: 'accepted' }` or `{ status: 'rejected' }` (`BookingsTab.tsx:95`).
3. On success local state is patched; the Realtime `postgres_changes` event then triggers a full `fetchBookings()`.
4. Header stats are **not** refreshed by this (no `onRefresh` prop on BookingsTab) until pull-to-refresh. There is no "complete" action in the dashboard; `completed` (which moves commission from pending to total earnings and, server-side, should create the `celebrity_wallet_transactions` row / credit `available_balance`) must be set by another actor.

#### Celebrity replies to a message
Open conversation (`openConvo`, MessagesTab.tsx:183):
1. `GET /rest/v1/messages?conversation_id=eq.<id>&order=created_at.asc&limit=100`
2. `PATCH /rest/v1/messages?conversation_id=eq.<id>&sender_id=neq.<profileId>&is_read=eq.false` body `{ is_read: true }`
3. Opens Realtime socket on `messages` INSERT for that conversation.

Manual reply (`sendReply`, MessagesTab.tsx:229):
1. `POST /rest/v1/messages` `{ conversation_id, sender_id: <profileId>, sender_type: 'celebrity', message_text }`
2. `PATCH /rest/v1/conversations?id=eq.<id>` `{ last_message_at: now }` (errors ignored; `last_message_text` and unread counters are left to the server)
3. `openConvo()` again (steps 1-2 above).

AI reply (`generateAIReply`, MessagesTab.tsx:202):
1. Pick `userMessage` = last message with `sender_id !== profileId`.
2. `POST /functions/v1/celebrity-ai-message` `{ conversationId, userMessage }` with user token + anon apikey.
3. On OK, `openConvo()` — the function is expected to have inserted the AI message (`is_ai_generated: true`) itself.

AI auto-reply toggle: `POST /rest/v1/celebrity_settings` upsert `{ celebrity_id, ai_auto_reply_enabled }` with `Prefer: resolution=merge-duplicates`.

#### Request payout
1. WalletTab load (parallel): `GET bank_details?user_id=eq.<profileId>`, `GET payout_requests?celebrity_id=...&limit=20`, `GET celebrity_wallet_transactions?celebrity_id=...&limit=50`, `GET image_promotions?celebrity_id=...&status=eq.completed&limit=50`; merges wallet txns with virtual 70 % image-promotion rows.
2. Optional: `POST /rest/v1/bank_details` `{ bank_name, bank_account_number, ifsc_code, account_holder_name, user_id }` then refetch.
3. Client checks: bank selected, `amount > 0`, `amount <= celebrity.available_balance`.
4. `POST /rest/v1/payout_requests` `{ celebrity_id, profile_id, requested_amount, bank_name, bank_account_number, ifsc_code, account_holder_name }`.
5. `fetchAll()` + `onRefreshCeleb()` (re-reads `celebrities.available_balance`, expecting the backend to have adjusted it).

**Money rows written by the client in this domain:** `payout_requests` (INSERT) and `bank_details` (INSERT) only. The client never writes `celebrity_wallet_transactions` or `celebrities.available_balance`, but it *reads* both and hard-codes the 70 % image-promotion commission and the "pending clearance" sum — all of that belongs server-side in the new API.

#### Upload media
Consent (ConsentTab.tsx:30): pick photo + video -> parallel `POST /storage/v1/object/verification-docs/<celebrity.id>/consent-{photo,video}-<ts>.{jpg,webm}` -> `PATCH /rest/v1/celebrities?id=eq.<id>` `{ consent_photo_url, consent_video_url, consent_status: 'submitted', consent_given_at }` -> `onRefresh()`.

Avatar (ContentTab.tsx:42): pick image -> `POST /storage/v1/object/celebrity-avatars/<safeName>/avatar/<ts>-avatar.jpg` -> `PATCH /rest/v1/celebrities?id=eq.<id>` `{ image_url }` -> `onRefresh()`.

Promo media (ContentTab.tsx:70): pick image or video -> `POST /storage/v1/object/promotional-content/<safeName>/promotional/<photo|video>/<ts>-promo.<jpg|mp4>` -> `POST /rest/v1/celebrity_media` `{ celebrity_id, media_url, media_type }` -> refetch `celebrity_media`.

In every case the stored value is the public URL `${SUPABASE_URL}/storage/v1/object/public/<bucket>/<path>`; existing `image_url` values that are not absolute URLs are treated as Backblaze keys (`https://f005.backblazeb2.com/file/wishmetoday/<key>`).


---

## Domain 4 — Wish orders and AI-generated content

Scope: every Supabase call made from these files under `artifacts/mobile`:
`app/wish-celebrity.tsx`, `app/wish-celebrity-occasion/[id].tsx`, `app/wish-booking/[id].tsx`, `app/wish-confirmation/[id].tsx`, `app/wish-congratulations.tsx`, `app/wish-orders.tsx`, `app/wish-friend.tsx`, `app/ugc-videos.tsx`, `app/ugc-ads.tsx`, `components/ugc/FormFields.tsx`, `components/ugc/UgcHistory.tsx`, `components/ugc/UgcOrderShell.tsx` (no calls), `components/ugc/types.ts` (no calls), `app/greeting-cards.tsx`, `app/photo-wish.tsx`, `app/image-promotions.tsx`, `services/library.ts`, `app/library.tsx` (only via services/library.ts), `components/SaveToLibraryButton.tsx` (only via services/library.ts), `services/documents/generate.ts`, `services/documents/store.ts` (local only, no backend), `components/music/GenerateSongTab.tsx`, `ImageMusicTab.tsx`, `SFXTab.tsx`, `VoiceConversionTab.tsx`, `CloneTab.tsx`, `TTSTab.tsx`, `IsolateTab.tsx`, `shared.tsx` (no calls), `AudioInputs.tsx` (no calls), `ImgMusicResult.tsx` (no calls), `hooks/useVoices.ts`.

### Transport conventions that every entry below inherits

- `constants/supabase.ts` `supabaseFetch(path, init, accessToken?)` sends `apikey: <ANON_KEY>` on every request and `Authorization: Bearer <accessToken ?? ANON_KEY>`. Nearly every call site passes `session?.access_token`; when the session is missing that silently degrades to the anon key. "Auth: user access token" below means "token when signed in, anon otherwise" unless stated.
- `supabaseFetch` aborts after **20 000 ms**. This applies to every edge-function call that goes through it, including the long AI ones (`generate-greeting-card-ai`, `generate-image-promotion`, `generate-wish-celebrity-card`, all `elevenlabs-*`, `generate-music`). Only `generate-photo-wish` (120 s) and `generate-document` (150 s) use raw `fetch` with their own timeouts.
- `Content-Type: application/json` is always set; call sites override it for storage uploads.
- `parseApiError(res)` reads `error_description || error || message || msg` from a JSON error body.
- `services/supabaseRest.ts` (`fetchRows`, `insertRows`, `updateRows`, `deleteRows`, `callRpc`) is **not used** by any file in this domain; every call is a hand-built `supabaseFetch`.
- Celebrity image URLs that are not absolute are prefixed with `https://f005.backblazeb2.com/file/wishmetoday/` on the client (B2 public bucket `wishmetoday`).

---

### Tables

#### `POST /rest/v1/audio_isolation_generations`
- **Callers:** `components/music/IsolateTab.tsx:30` — record a completed audio-isolation job after the edge function returns.
- **Auth:** user access token (`ctx.session?.access_token`).
- **Query / filters:** none. Header `Prefer: return=minimal`.
- **Request body:** `{ user_id: <profileId>, original_file_name: string ('audio.wav' default), audio_url: string (value of edge `audioUrl`, may be a `data:audio/...;base64,` URI), status: 'completed', credits_used: 40 }` (`COSTS.audioIsolation`).
- **Response fields the app reads:** none (result ignored, failures not checked).
- **Behaviour notes:** Written by the client after `/functions/v1/elevenlabs-audio-isolation` succeeds. `credits_used` is a client constant. **Money-adjacent: the app decides the charge amount recorded for the job.**

#### `GET /rest/v1/celebrities`
- **Callers:**
  - `app/wish-celebrity.tsx:66` — list all active celebrities for the Wish a Celebrity picker.
  - `app/wish-celebrity-occasion/[id].tsx:132` — load one celebrity + `service_prices.general_wish`.
  - `app/wish-booking/[id].tsx:99` — same, for the booking screen.
  - `app/wish-friend.tsx:132` — debounced (250 ms) searchable list for video wish / UGC video.
  - `components/ugc/FormFields.tsx:165` — debounced (250 ms) celebrity picker modal in UGC forms.
  - `app/image-promotions.tsx:128` — celebrities the user has favourited (ids from `useCelebrityFavorites`).
- **Auth:** user access token.
- **Query / filters (verbatim):**
  - wish-celebrity: `?select=id,name,image_url,category,rating,is_verified,service_prices&is_active=eq.true&order=name.asc`
  - occasion / booking: `?id=eq.<id>&select=id,name,category,image_url,is_verified,rating,service_prices&limit=1`
  - wish-friend: `?select=id,name,category,image_url,delivery_time,service_prices&is_active=eq.true&or=(consent_status.neq.rejected,consent_status.is.null)[&name=ilike.*<term>*]&order=name.asc&limit=48` (term has `% , ( ) *` replaced by spaces, then URL-encoded)
  - FormFields: `?select=id,name,category,image_url,service_prices&is_active=eq.true&or=(consent_status.neq.rejected,consent_status.is.null)[&name=ilike.*<term>*]&order=name.asc&limit=48`
  - image-promotions: `?select=id,name,category,image_url&id=in.(<id1>,<id2>,...)`
- **Request body:** none.
- **Response fields the app reads:** array of rows. Interfaces declared:
  - `Celebrity` (wish-celebrity): `id, name, image_url: string|null, category, rating: number, is_verified: boolean, service_prices?: { general_wish?: number }`
  - `CelebrityDetail` (occasion/booking): `id, name, category, image_url, is_verified, rating, service_prices?: { general_wish?: number }`
  - `Celebrity` (wish-friend): `id, name, category: string|null, image_url: string|null, delivery_time: string|null, service_prices: { general_wish?: number; ugc_ad?: number } | null`
  - `CelebrityLite` (ugc/types.ts): `id, name, category: string|null, image_url: string|null, service_prices: { general_wish?: number; ugc_ad?: number } | null`
  - `SubscribedCeleb` (image-promotions): `id, name, category, image_url: string|null`
- **Behaviour notes:** `service_prices` is a JSON column with keys `general_wish` and `ugc_ad`; the UGC price falls back to `platform_settings.ugc_video_price` / `ugc_ads_price` when `ugc_ad` is 0/missing. Filter `consent_status` (`rejected`) excludes celebrities who declined. `image_url` may be a bare B2 key or an absolute URL.

#### `GET /rest/v1/celebrity_favorites`
- **Callers:** `app/wish-celebrity.tsx:71` — which celebrities the user is subscribed to (splits list into "Your Subscribed" vs "Other").
- **Auth:** user access token.
- **Query / filters:** `?select=celebrity_id&user_id=eq.<profileId>&status=eq.active`
- **Request body:** none.
- **Response fields the app reads:** array of `{ celebrity_id: string }`.
- **Behaviour notes:** Subscribed → routes to `/wish-booking/<celebId>`; unsubscribed → `/celebrity/<celebId>`. Failure is ignored (falls back to all unsubscribed).

#### `GET /rest/v1/greeting_card_generations`
- **Callers:**
  - `app/greeting-cards.tsx:169` — "My Cards" history (also drives the "Library" reference-image picker and today's count).
  - `app/greeting-cards.tsx:206` — polling one generation until completed/failed.
  - `services/library.ts:72` — starred cards shown in the Library grid.
- **Auth:** user access token.
- **Query / filters:**
  - history: `?user_id=eq.<profileId>&order=created_at.desc&limit=30` (no `select`, all columns)
  - poll: `?id=eq.<generationId>&select=status,generated_image_url,greeting_text,refined_prompt&limit=1`
  - library: `?user_id=eq.<profileId>&saved_to_library=eq.true&status=eq.completed&select=id,occasion_name,recipient_name,generated_image_url,created_at&order=created_at.desc&limit=60`
- **Request body:** none.
- **Response fields the app reads:** array. Interface `Generation` (greeting-cards.tsx): `id, user_id, original_prompt: string|null, refined_prompt: string|null, occasion_name: string, recipient_name: string|null, generated_image_url: string|null, greeting_text: string|null, reference_image_url: string|null, reference_image_source: string|null, prompt_refinement_used: boolean, saved_to_library: boolean, amount_charged: number|null, status: 'processing'|'completed'|'failed', error_message: string|null, created_at: string`. Interface `CardRow` (library.ts): `id, occasion_name: string|null, recipient_name: string|null, generated_image_url: string|null, created_at`.
- **Behaviour notes:** `user_id` here is the **profile id** (`wallet.profileId`). Polling: every **3 000 ms**, max **20 attempts** (~60 s); stops when `status === 'completed' && generated_image_url` (success toast, `wallet.refetch()`, history reload) or `status === 'failed'`; on timeout the client marks the local generation failed with "Generation timed out". Library filters client-side to rows with a non-null `generated_image_url`.

#### `PATCH /rest/v1/greeting_card_generations`
- **Callers:**
  - `app/greeting-cards.tsx:354` — toggle star ("Save to Library" / "Remove from Library").
  - `services/library.ts:144` — "Remove" from the Library viewer for `origin === 'card'` items.
- **Auth:** user access token.
- **Query / filters:** `?id=eq.<generationId>`; header `Prefer: return=minimal`.
- **Request body:** `{ saved_to_library: boolean }` (greeting-cards toggles; library.ts always `false`).
- **Response fields the app reads:** none; `res.ok || res.status === 204` is treated as success.
- **Behaviour notes:** Afterwards calls `dropLibraryCache()` (module-level cache in `services/library.ts`). Only the owner should be able to flip this flag.

#### `POST /rest/v1/image_music_generations`
- **Callers:** `components/music/ImageMusicTab.tsx:78` — record an Img+Music job after `/functions/v1/elevenlabs-image-music-video` succeeds.
- **Auth:** user access token.
- **Query / filters:** none; `Prefer: return=minimal`.
- **Request body:** `{ user_id: <profileId>, image_url: <imageBase64 data URI — the full uploaded image, not a URL>, audio_url: string (b2Url || audioUrl), video_url: string|null, description: string, lyrics: string|null, genre: string, mood: string, duration_seconds: number (10–60), has_vocals: boolean, amount_charged: 150 | 120 (COSTS.imgVocals if hasVocals else COSTS.imgInstrumental), status: 'completed', completed_at: ISO string }`.
- **Response fields the app reads:** none (not checked).
- **Behaviour notes:** Stores the base64 image in the row. **Money-adjacent: `amount_charged` is chosen by the client.**

#### `GET /rest/v1/image_promotions`
- **Callers:** `app/image-promotions.tsx:163` — "My Promotions" history and stats (today / completed counts).
- **Auth:** user access token.
- **Query / filters:** `?user_id=eq.<profileId>&order=created_at.desc&limit=50` (all columns).
- **Request body:** none.
- **Response fields the app reads:** array of `ImagePromotion`: `id, user_id, celebrity_id, concept, branding_details: string|null, price_paid: number|null, generated_image_url: string|null, status: 'pending'|'completed'|'failed', error_message: string|null, completed_at: string|null, created_at, wishme_payment_id?: string`.
- **Behaviour notes:** `generated_image_url` may be an `https://` URL or a `data:` base64 URI (download/share code handles both).

#### `PATCH /rest/v1/image_promotions`
- **Callers:** `app/image-promotions.tsx:306` — write the client-generated payment id onto the promotion after inserting `payment_transactions`.
- **Auth:** user access token.
- **Query / filters:** `?id=eq.<generationId>`; no Prefer header (default representation).
- **Request body:** `{ wishme_payment_id: 'WM-YYYYMMDD-NNNN' }`.
- **Response fields the app reads:** none.
- **Behaviour notes:** Only runs if the `payment_transactions` insert returned ok. **Money-adjacent (payment reference written by client).**

#### `GET /rest/v1/library_items`
- **Callers:**
  - `services/library.ts:77` — saved videos for the Library grid (`fetchLibrary`).
  - `services/library.ts:160` — ids of already-saved videos so Save buttons can show "Saved" (`fetchSavedVideoIds`).
- **Auth:** user access token.
- **Query / filters:**
  - grid: `?user_id=eq.<profileId>&select=id,kind,title,subtitle,media_url,file_key,thumbnail_url,created_at&order=created_at.desc&limit=60`
  - saved ids: `?user_id=eq.<profileId>&kind=eq.video&select=source_id&limit=500`
- **Request body:** none.
- **Response fields the app reads:** `LibraryRow`: `id, kind: 'image'|'video', title, subtitle: string|null, media_url: string|null, file_key: string|null, thumbnail_url: string|null, created_at`; and `{ source_id }[]`.
- **Behaviour notes:** Results merged with starred greeting cards and sorted by `createdAt` desc; cached in a module-level `cache` keyed by profileId (`getCachedLibrary`, `dropLibraryCache`). `loadSavedVideoIds` memoises a single promise per profile for all SaveToLibrary buttons on screen.

#### `POST /rest/v1/library_items`
- **Callers:** `services/library.ts:119` (`saveVideoToLibrary`, used by `components/SaveToLibraryButton.tsx:33`, which `components/ugc/UgcHistory.tsx:141` renders for ready UGC videos).
- **Auth:** user access token.
- **Query / filters:** `?on_conflict=user_id,source_type,source_id`; header `Prefer: return=minimal,resolution=ignore-duplicates` (idempotent upsert; duplicate save is a no-op).
- **Request body:** `{ user_id: <profileId>, kind: 'video', source_type: string ('ugc_ad' | 'ugc_video' from UgcHistory; other values from bookings screens), source_id: string (source row id), title: string, subtitle: string|null, media_url: string|null, file_key: string|null, thumbnail_url: string|null }`.
- **Response fields the app reads:** none; throws on `!res.ok`.
- **Behaviour notes:** Requires a unique constraint on `(user_id, source_type, source_id)`. Calls `dropLibraryCache()` and `markVideoSaved(sourceId)` afterwards.

#### `DELETE /rest/v1/library_items`
- **Callers:** `services/library.ts:149` — "Remove" from Library viewer for `origin === 'library'` items.
- **Auth:** user access token.
- **Query / filters:** `?id=eq.<libraryItemId>`; `Prefer: return=minimal`.
- **Request body:** none.
- **Response fields the app reads:** none; throws on `!res.ok`.
- **Behaviour notes:** Removes from the in-memory cache on success.

#### `POST /rest/v1/payment_transactions`
- **Callers:**
  - `app/photo-wish.tsx:334` — record the wallet charge after `/functions/v1/generate-photo-wish` returns.
  - `app/image-promotions.tsx:283` — record the wallet charge after `/functions/v1/generate-image-promotion` returns.
- **Auth:** user access token.
- **Query / filters:** none; no Prefer header.
- **Request body:**
  - photo-wish: `{ wishme_payment_id: 'WM-YYYYMMDD-NNNN' (client random), user_id: <profileId>, amount: data.amountCharged ?? finalPrice, payment_method: 'wallet', service_type: 'photo_wish', photo_wish_id: <photoWishId>, description: 'Photo Wish - <occasion> for <recipient>', status: 'completed', paid_at: ISO }`
  - image-promotions: `{ wishme_payment_id: 'WM-YYYYMMDD-NNNN', user_id: <profileId>, amount: finalPrice (client-computed discounted price), payment_method: 'wallet', service_type: 'image_promotion', image_promotion_id: <generationId>, description: 'Image Promotion', status: 'completed', paid_at: ISO }`
- **Response fields the app reads:** only `res.ok`.
- **Behaviour notes:** **MONEY ROW WRITTEN BY THE CLIENT.** The edge function has already debited the wallet (app calls `wallet.refetch()` after); this is a second, client-authored ledger entry with a client-invented id and a client-computed amount. If it fails the app just logs and continues. Migration must move this server-side (the generating function should create the payment record and return its id).

#### `GET /rest/v1/photo_wishes`
- **Callers:** `app/photo-wish.tsx:195` — history tab + stats.
- **Auth:** user access token (from `getValidSession()`).
- **Query / filters:** `?user_id=eq.<profileId>&order=created_at.desc&limit=20&select=*`
- **Request body:** none.
- **Response fields the app reads:** `PhotoWishRecord`: `id, occasion, recipient_name, wish_message?, sender_name?, text_style?, status, created_at, completed_at?, edited_image_url: string|null, amount_charged?: number, wishme_payment_id?: string`.
- **Behaviour notes:** `edited_image_url === 'processing'` is a sentinel the UI treats as in-progress; only `https://` values are rendered.

#### `PATCH /rest/v1/photo_wishes`
- **Callers:** `app/photo-wish.tsx:351` — write the client-generated payment id onto the photo wish.
- **Auth:** user access token.
- **Query / filters:** `?id=eq.<photoWishId>`
- **Request body:** `{ wishme_payment_id: 'WM-YYYYMMDD-NNNN' }`
- **Response fields the app reads:** none.
- **Behaviour notes:** Only after `payment_transactions` insert ok. **Money-adjacent.**

#### `GET /rest/v1/plans`
- **Callers:** `app/greeting-cards.tsx:149` — plan discount for the greeting-card price.
- **Auth:** user access token.
- **Query / filters:** `?name=eq.<encodeURIComponent(planName)>&select=service_discount_percentage`
- **Request body:** none.
- **Response fields the app reads:** `[{ service_discount_percentage?: number }]`.
- **Behaviour notes:** Only called when `profiles.plan_name` is non-empty. (Other screens use the `usePlan()` hook instead — out of this domain.) `finalPrice = Math.round(basePrice * (1 - discountPct/100))`.

#### `GET /rest/v1/platform_settings`
- **Callers:**
  - `app/wish-friend.tsx:118` — `ugc_video_price` fallback.
  - `app/ugc-videos.tsx:27` — `ugc_video_price` fallback (default 500).
  - `app/ugc-ads.tsx:27` — `ugc_ads_price` (default 999).
  - `app/greeting-cards.tsx:130` — `greeting_card_price` (default 199).
  - `app/photo-wish.tsx:173` — `photo_wish_price` (default 99).
  - `app/image-promotions.tsx:144` — `image_promotion_price` (default 25).
- **Auth:** user access token (greeting-cards/photo-wish/image-promotions fall back to anon when no session).
- **Query / filters:** `?setting_key=eq.<key>&select=setting_value[&limit=1]` (greeting-cards omits `limit`).
- **Request body:** none.
- **Response fields the app reads:** `[{ setting_value: string }]`, parsed with `parseInt`/`parseFloat`.
- **Behaviour notes:** Prices are display-only hints; the authoritative charge is made server-side (RPC / edge function) except where flagged.

#### `GET /rest/v1/profiles`
- **Callers:**
  - `app/wish-celebrity-occasion/[id].tsx:156` — wallet balance + profile id before paying.
  - `app/wish-booking/[id].tsx:123` — same.
  - `app/greeting-cards.tsx:132` — `plan_name` for discount lookup.
- **Auth:** user access token (occasion/booking refresh via `getValidSession()` first).
- **Query / filters:**
  - `?select=id,wallet_balance&user_id=eq.<auth uid>&limit=1`
  - `?select=plan_name&user_id=eq.<auth uid>&limit=1`
- **Request body:** none.
- **Response fields the app reads:** `ProfileRow { id, wallet_balance: number }`; `{ plan_name?: string }`.
- **Behaviour notes:** `profiles.user_id` = auth uid, `profiles.id` = profile id; most other tables key on profile id (exception: `ugc_ads.user_id`, see below). The app never PATCHes `profiles.wallet_balance` in this domain; balance changes are expected to come from `wallet_transactions` inserts (trigger) or server code.

#### `POST /rest/v1/sound_effect_generations`
- **Callers:** `components/music/SFXTab.tsx:35`
- **Auth:** user access token.
- **Query / filters:** none; `Prefer: return=minimal`.
- **Request body:** `{ user_id: <profileId>, description: string (≤500 chars), duration_seconds: number (1–22), audio_url: string (edge audioUrl), status: 'completed', credits_used: 60 }`.
- **Response fields the app reads:** none.
- **Behaviour notes:** client-chosen `credits_used` (money-adjacent).

#### `POST /rest/v1/tts_generations`
- **Callers:** `components/music/TTSTab.tsx:42`
- **Auth:** user access token.
- **Query / filters:** none; `Prefer: return=minimal`.
- **Request body:** `{ user_id: <profileId>, text: string (≤500 chars), voice_id: string, voice_name: string, audio_url: string, status: 'completed', credits_used: 50 }`.
- **Response fields the app reads:** none.
- **Behaviour notes:** client-chosen `credits_used` (money-adjacent).

#### `GET /rest/v1/ugc_ads`
- **Callers:** `components/ugc/UgcHistory.tsx:173` (kind `'ad'`, rendered by `app/ugc-ads.tsx`).
- **Auth:** user access token.
- **Query / filters:** `?user_id=eq.<authUid>&select=id,product_name,aspect_ratio,status,price_paid,video_url,video_file_key,created_at,generation_error,celebrities(name,image_url)&order=created_at.desc&limit=30`
- **Request body:** none.
- **Response fields the app reads:** `id, product_name, aspect_ratio, status, price_paid, video_url, video_file_key, created_at, generation_error, celebrities?.name, celebrities?.image_url` (embedded via FK `celebrity_id`).
- **Behaviour notes:** **`ugc_ads.user_id` is the auth uid**, unlike `wish_friend_orders.user_id` (profile id). Status → stage mapping: `completed`→ready; `failed|rejected`→failed; `processing|script_generating|video_generating|video_processing`→production; anything else→awaiting. Playback resolves `video_file_key` through `b2-get-signed-url`.

#### `POST /rest/v1/voice_conversion_generations`
- **Callers:** `components/music/VoiceConversionTab.tsx:44`
- **Auth:** user access token.
- **Query / filters:** none; `Prefer: return=minimal`.
- **Request body:** `{ user_id: <profileId>, voice_id: string, voice_name: string, audio_url: string, status: 'completed', credits_used: 75 }`.
- **Response fields the app reads:** none.
- **Behaviour notes:** client-chosen `credits_used` (money-adjacent).

#### `POST /rest/v1/wallet_transactions`
- **Callers:**
  - `app/wish-celebrity-occasion/[id].tsx:434` — debit the wallet for a wish order paid "via Wallet".
  - `app/wish-booking/[id].tsx:254` — same, older booking screen.
- **Auth:** user access token.
- **Query / filters:** none; `Prefer: return=minimal`.
- **Request body:**
  - occasion: `{ user_id: <profileId>, amount: -finalPrice, type: 'debit', transaction_type: 'greeting_card_generation', reference_id: <orderId>, status: 'completed', description: 'Wish order #<orderId> for <celebName> - <occasion>', transaction_details: { base_price, discount_percentage, discount_amount, plan: 'subscriber'|'standard' } }`
  - booking: `{ user_id: <profileId>, amount: -finalPrice, transaction_type: 'booking', status: 'completed', description: 'Wish order #<orderId> for <celebName> - <occasion>', payment_method: 'wallet' }`
- **Response fields the app reads:** only `res.ok`. If not ok the app DELETEs the just-created order and throws "Wallet transaction failed".
- **Behaviour notes:** **MONEY ROW WRITTEN BY THE CLIENT.** The two screens disagree on the schema (`type`, `reference_id`, `transaction_details` vs `payment_method`). The app relies on something server-side (trigger) to apply the negative `amount` to `profiles.wallet_balance`; it only checks `walletBalance < finalPrice` client-side beforehand. Migration must replace this with a server-side "pay wish order from wallet" operation that checks balance, debits and marks the order atomically.

#### `GET /rest/v1/wish_celebrity_orders`
- **Callers:**
  - `app/wish-celebrity-occasion/[id].tsx:184` — find the latest order for this user+celebrity when no `AsyncStorage` id is cached.
  - `app/wish-celebrity-occasion/[id].tsx:196` — load the full order to restore the form / paid state.
  - `app/wish-confirmation/[id].tsx:65` — order + embedded celebrity for the confirmation/card screen.
  - `app/wish-congratulations.tsx:51` — order summary after sending.
  - `app/wish-orders.tsx:303` — "My Wish Orders" list.
- **Auth:** user access token.
- **Query / filters:**
  - `?user_id=eq.<profileId>&celebrity_id=eq.<celebId>&order=created_at.desc&limit=1`
  - `?id=eq.<orderId>&select=*&limit=1`
  - `?id=eq.<orderId>&select=id,occasion_type,recipient_name,message,card_prompt,amount_paid,payment_status,status,generated_card_image_url,greeting_text,generation_attempts,card_approved,celebrities(id,name,category,image_url)&limit=1`
  - `?id=eq.<orderId>&select=id,occasion_type,recipient_name,amount_paid,status,created_at,conversation_id,celebrities(name,category)&limit=1`
  - `?select=*,celebrities(id,name,image_url)&user_id=eq.<profileId>&order=created_at.desc&limit=50`
- **Request body:** none.
- **Response fields the app reads (declared interfaces):**
  - occasion `WishOrder`: `id, occasion_type, recipient_name, message, card_prompt: string|null, card_generation_type: 'ai'|'upload-card'|'upload-video', amount_paid: number, payment_status: string, status: string, generated_card_image_url: string|null, greeting_text: string|null, reference_image_url: string|null, user_uploaded_card_url: string|null, user_uploaded_video_url: string|null, generation_attempts: number`
  - confirmation `WishOrder`: `id, occasion_type, recipient_name, message, card_prompt, amount_paid, payment_status, status, generated_card_image_url?, greeting_text?, generation_attempts?, card_approved?: boolean, celebrities: { id, name, category, image_url }`
  - congratulations `OrderSummary`: `id, occasion_type, recipient_name, amount_paid, status, created_at, conversation_id: string|null, celebrities: { name, category }`
  - wish-orders `WishOrder`: `id, user_id, celebrity_id, occasion_type, message, recipient_name: string|null, status, payment_status, amount_paid: number|null, payment_method: string|null, card_generation_type: string|null, generated_card_image_url: string|null, card_approved: boolean|null, completed_at: string|null, created_at, celebrities: { id, name, image_url: string|null }`
- **Behaviour notes:** Embedded `celebrities(...)` relies on FK `wish_celebrity_orders.celebrity_id → celebrities.id`. `conversation_id` is set server-side by `send-wish-to-celebrity` and used to deep-link to `/chat/<id>`. wish-orders classification: pending = `payment_status==='completed' && status!=='sent'` OR `payment_status!=='completed'`; completed = `status==='sent'`. Status values seen: `pending`, `paid`, `processing`, `sent`, `completed`. `restoreOrder` picks the *latest* order for the celeb regardless of status, so a previously sent order can be restored as "paid" state (quirk to preserve or fix).

#### `POST /rest/v1/wish_celebrity_orders`
- **Callers:**
  - `app/wish-celebrity-occasion/[id].tsx:393` — create the order (after optional storage uploads).
  - `app/wish-booking/[id].tsx:221` — create the order (AI card only).
- **Auth:** user access token.
- **Query / filters:** none; `Prefer: return=representation`.
- **Request body:**
  - occasion: `{ user_id: <profileId>, celebrity_id: <celebId>, occasion_type, recipient_name, message, card_prompt: string|null, reference_image_url: string|null, user_uploaded_card_url: string|null, user_uploaded_video_url: string|null, card_generation_type: 'ai'|'upload-card'|'upload-video', amount_paid: finalPrice, discount_percentage: planDiscountPct, discount_amount: discountAmt, payment_method: 'wallet'|'razorpay', payment_status: 'completed'|'pending', status: 'pending' }`
  - booking: `{ user_id, celebrity_id, occasion_type, recipient_name, message, card_prompt, card_generation_type: 'ai', amount_paid, discount_percentage, discount_amount, payment_method, payment_status, status: 'pending' }`
- **Response fields the app reads:** `[{ id }]` → `rows[0].id`.
- **Behaviour notes:** **MONEY FIELDS WRITTEN BY THE CLIENT**: `amount_paid`, `discount_percentage`, `discount_amount`, `payment_method`, `payment_status`. For wallet payment the order is inserted with `payment_status: 'completed'` *before* the wallet debit exists. `planDiscountPct` is a `useState(0)` that is never set in either screen, so discount is always 0 today. Occasion screen stores the new id in `AsyncStorage['wishOrderId:<celebId>']`.

#### `PATCH /rest/v1/wish_celebrity_orders`
- **Callers:**
  - `app/wish-celebrity-occasion/[id].tsx:352` — reuse an existing order: set `{ payment_method, payment_status }` before paying again.
  - `app/wish-celebrity-occasion/[id].tsx:463` — after wallet debit: `{ status: 'paid', payment_status: 'completed', payment_method: 'wallet' }`.
  - `app/wish-celebrity-occasion/[id].tsx:518` — after Razorpay verify: `{ status: 'paid', payment_status: 'completed', payment_method: 'razorpay' }`.
  - `app/wish-celebrity-occasion/[id].tsx:676` — after `send-wish-thankyou-dm` (upload modes): `{ status: 'sent' }`.
  - `app/wish-booking/[id].tsx:277` — after wallet debit: `{ status: 'paid', payment_method: 'wallet', payment_status: 'completed' }`.
  - `app/wish-booking/[id].tsx:325` — after Razorpay verify: `{ status: 'paid', payment_method: 'razorpay', payment_status: 'completed' }`.
- **Auth:** user access token.
- **Query / filters:** `?id=eq.<orderId>`; `Prefer: return=minimal`.
- **Response fields the app reads:** none.
- **Behaviour notes:** **MONEY/STATE FIELDS WRITTEN BY THE CLIENT** (`payment_status`, `payment_method`, `status`). A server must own these transitions (`pending → paid → sent`).

#### `DELETE /rest/v1/wish_celebrity_orders`
- **Callers:**
  - `app/wish-celebrity-occasion/[id].tsx:455` — rollback when the wallet_transactions insert fails.
  - `app/wish-celebrity-occasion/[id].tsx:566` — rollback when native Razorpay module is unavailable.
  - `app/wish-celebrity-occasion/[id].tsx:597` — rollback when the user cancels Razorpay checkout.
  - `app/wish-booking/[id].tsx:268`, `:370`, `:404` — same three cases.
- **Auth:** user access token.
- **Query / filters:** `?id=eq.<orderId>`; `Prefer: return=minimal`.
- **Response fields the app reads:** none (`.catch(() => {})`).
- **Behaviour notes:** Client-side compensation for a non-atomic flow; also removes `AsyncStorage['wishOrderId:<celebId>']`. A server-side "create order + pay" transaction removes the need.

#### `GET /rest/v1/wish_friend_orders`
- **Callers:** `components/ugc/UgcHistory.tsx:193` (kind `'video'`, rendered by `app/ugc-videos.tsx`).
- **Auth:** user access token.
- **Query / filters:** `?user_id=eq.<profileId>&order_type=eq.ugc_video&select=id,recipient_name,occasion,aspect_ratio,status,price_paid,video_url,video_file_key,admin_notes,created_at,celebrities:celebrity_id(name,image_url)&order=created_at.desc&limit=30`
- **Request body:** none.
- **Response fields the app reads:** `id, recipient_name, occasion, aspect_ratio, status, price_paid, video_url, video_file_key, admin_notes, created_at, celebrities?.name, celebrities?.image_url` (embedded with explicit FK hint `celebrities:celebrity_id(...)`).
- **Behaviour notes:** `user_id` = profile id. Stage mapping: `completed`→ready; `failed|rejected`→failed; `processing`→production; else awaiting. `admin_notes` shown as failure note. `video_wish`-type rows are listed elsewhere (bookings, out of scope).

---

### RPCs

#### `POST /rest/v1/rpc/create_wish_friend_order`
- **Callers:**
  - `app/wish-friend.tsx:187` — place a `video_wish` or `ugc_video` order paid from wallet.
  - `app/ugc-videos.tsx:48` — place a `ugc_video` order from the structured UGC form.
- **Auth:** user access token (required; the screens gate on session).
- **Query / filters:** none.
- **Request body (RPC args):**
  - wish-friend: `{ p_order_type: 'video_wish'|'ugc_video', p_celebrity_id: uuid, p_recipient_name: string, p_occasion: string, p_relationship: string, p_tone: string, p_prompt: string (10–600 chars), [ugc_video only:] p_aspect_ratio: '9:16'|'1:1'|'16:9', p_hook_style: 'question'|'bold_claim'|'testimonial'|'curiosity'|'', p_call_to_action: string, p_reference_image_url: string ('' or public URL in bucket promotional-content) }`
  - ugc-videos: `{ p_order_type: 'ugc_video', p_celebrity_id, p_recipient_name (user firstName or 'Me' when for_whom==='me'), p_occasion (label text), p_relationship (label or ''), p_tone (comma-joined labels or ''), p_prompt: v.message, p_aspect_ratio (default '9:16'), p_hook_style: '', p_call_to_action: '', p_reference_image_url: photos[0] ?? '', p_details: Record<string, unknown> (every answered form field, chips as labels, photos as URL arrays — see `buildDetails` in components/ugc/types.ts) }`
- **Response fields the app reads:** single object `{ id?: string; price_paid?: number }` (ugc-videos reads only `id`).
- **Behaviour notes:** The RPC is expected to: resolve the caller's profile, compute the price (celebrity `service_prices.general_wish` / `ugc_ad`, falling back to `platform_settings.ugc_video_price`, with plan discount), verify and debit the wallet, insert `wish_friend_orders`, and return the row. The client only pre-checks `wallet.balance < price` for UX and calls `wallet.refetch()` afterwards. Errors surface via `parseApiError`. Drafts of the UGC form are cached in `AsyncStorage['ugc-draft:<configId>:<authUid>']` and cleared on success.

#### `POST /rest/v1/rpc/create_ugc_ad_order`
- **Callers:** `app/ugc-ads.tsx:47` — place a UGC ad order paid from wallet.
- **Auth:** user access token.
- **Query / filters:** none.
- **Request body (RPC args):** `{ p_celebrity_id: uuid|null (null when presenter !== 'celebrity'), p_product_name: string, p_product_description: string, p_product_image_url: string (images[0] public URL or ''), p_prompt: v.brief, p_hook_style: string ('' when 'auto'), p_call_to_action: string (custom text or chip label), p_aspect_ratio: string (default '9:16'), p_details: Record<string, unknown> (buildDetails(UGC_ADS_CONFIG, v)) }`
- **Response fields the app reads:** `{ id: string }`.
- **Behaviour notes:** Server computes price (celebrity `service_prices.ugc_ad` or `platform_settings.ugc_ads_price`, discounted), debits wallet, inserts `ugc_ads` (keyed by auth uid — see GET ugc_ads) and returns it. Client calls `wallet.refetch()` afterwards.

---

### Edge functions

#### `POST /functions/v1/generate-message-suggestions`
- **Callers:** `app/wish-celebrity-occasion/[id].tsx:249`, `app/wish-booking/[id].tsx:155` — "Get AI Suggestions" for the wish message.
- **Auth:** user access token (anon fallback).
- **Request body:** `{ celebrityName, celebrity_name, occasionType, occasion, recipientName, recipient_name }` (both camel and snake spellings of the same three values).
- **Response fields the app reads:** `{ suggestions?: string[] }` → first 4 used as chips.
- **Behaviour notes:** failures ignored silently.

#### `POST /functions/v1/suggest-greeting-card-prompts`
- **Callers:** `app/wish-celebrity-occasion/[id].tsx:272`, `app/wish-booking/[id].tsx:183` — "Suggest Prompts" for the AI card.
- **Auth:** user access token (anon fallback).
- **Request body:** `{ celebrityName, celebrity_name, occasionType, occasion, recipientName, recipient_name, [occasion screen only:] message }`.
- **Response fields the app reads:** `{ prompts?: string[] }` → first 4.

#### `POST /functions/v1/create-razorpay-order`
- **Callers:** `app/wish-celebrity-occasion/[id].tsx:491`, `app/wish-booking/[id].tsx:298` — start a Razorpay payment for a wish order. (Also used by wallet deposit — other inventory.)
- **Auth:** user access token.
- **Request body:** `{ amount: finalPrice * 100 (paise, client-computed), currency: 'INR', receipt: ('WISH-' + orderId).slice(0, 40), notes: { orderId } }`.
- **Response fields the app reads:** `{ id: string (razorpay order id), amount: number, currency: string, key_id: string }` → passed to Razorpay checkout (`window.Razorpay` on web, `react-native-razorpay` natively) with `name: 'WishMe'`, `description: 'Wish for <celeb>'`, prefill name/email/contact, theme `#7B5CFA`.
- **Behaviour notes:** **Amount is chosen by the client.** Server should derive the amount from the order row instead.

#### `POST /functions/v1/verify-razorpay-payment`
- **Callers:** `app/wish-celebrity-occasion/[id].tsx:506`, `app/wish-booking/[id].tsx:313`.
- **Auth:** user access token.
- **Request body:** `{ razorpay_payment_id, razorpay_order_id, razorpay_signature, orderId: <wish order id>, orderType: 'wish' }`.
- **Response fields the app reads:** only `res.ok`.
- **Behaviour notes:** After ok, the **client** PATCHes the order to `status 'paid' / payment_status 'completed' / payment_method 'razorpay'` and (AI mode) calls `generate-wish-celebrity-card`. Verification failure shows "Payment received but verification failed. Contact support." The server should mark the order itself on verify.

#### `POST /functions/v1/generate-wish-celebrity-card`
- **Callers:**
  - `app/wish-celebrity-occasion/[id].tsx:612` — right after payment (AI mode) and on "Regenerate".
  - `app/wish-confirmation/[id].tsx:89` — auto-run when `payment_status==='completed' && !generated_card_image_url`, and on "Regenerate Card".
- **Auth:** user access token.
- **Request body:** `{ orderId }`.
- **Response fields the app reads:** `{ success?, card_url? | cardUrl? | card_image_url? | image_url?, greeting_text? | greetingText?, generation_attempts?: number }` (first non-null URL alias wins).
- **Behaviour notes:** Client enforces **max 3 generations** (`generation_attempts >= 3` blocks the button); occasion screen trusts `generation_attempts` from the response, else increments locally; confirmation screen increments locally then reloads the order. Server is expected to persist `generated_card_image_url`, `greeting_text`, `generation_attempts` on the order. Runs through the 20 s `supabaseFetch` timeout.

#### `POST /functions/v1/send-wish-to-celebrity`
- **Callers:** `app/wish-celebrity-occasion/[id].tsx:652`, `app/wish-confirmation/[id].tsx:130` — "Approve & Send" the AI card.
- **Auth:** user access token.
- **Request body:** `{ orderId }`.
- **Response fields the app reads:** only `res.ok`.
- **Behaviour notes:** Server is expected to mark the order `sent` / `card_approved=true`, create the celebrity DM conversation and set `conversation_id` on the order (congratulations screen reads it). Client then clears `AsyncStorage['wishOrderId:<celebId>']` and navigates to `/wish-congratulations?orderId=`.

#### `POST /functions/v1/send-wish-thankyou-dm`
- **Callers:** `app/wish-celebrity-occasion/[id].tsx:670` — "Send Wish" for `upload-card` / `upload-video` orders.
- **Auth:** user access token.
- **Request body:** `{ orderId }`.
- **Response fields the app reads:** only `res.ok`.
- **Behaviour notes:** Afterwards the **client** PATCHes the order `{ status: 'sent' }` (server does not). Then navigates to congratulations.

#### `POST /functions/v1/generate-greeting-card-ai`
- **Callers:** `app/greeting-cards.tsx:300` — standalone AI greeting card (wallet-charged).
- **Auth:** user access token (required by the screen).
- **Request body:** `{ prompt: string (≤500), occasionName: string, recipientName?: string, senderName: string, refinePrompt: boolean, referenceImageSource: 'upload'|'library'|'none', referenceImageUrl?: 'data:image/jpeg;base64,...' (upload) | <generated_image_url of a saved card> (library) }`.
- **Response fields the app reads:** `{ generation?: Generation }` (full row, see table interface). Error handling on non-2xx: body `error ?? message`; `400` containing "insufficient" → wallet message; `429` → rate limit; `402` → AI credits exhausted.
- **Behaviour notes:** If `generation.generated_image_url` is present and **not the sentinel `'base64-returned-to-client'`**, treat as completed; otherwise start polling `GET greeting_card_generations` (3 s × 20). Server does the wallet debit (`amount_charged` on the row; app calls `wallet.refetch()`). Goes through the 20 s client timeout even though the UI says "~30s".

#### `POST /functions/v1/generate-photo-wish`
- **Callers:** `app/photo-wish.tsx:282` — raw `fetch` with `apikey` + `Authorization: Bearer <token from getValidSession()>`, **120 s** AbortController.
- **Auth:** user access token (required).
- **Request body:** `{ originalImageBase64: 'data:image/jpeg;base64,...' (resized to 1200 px wide, 0.8 quality), occasion, recipientName, wishMessage, senderName: string|null, textStyle: 'elegant'|'playful'|'modern'|'classic'|'festive' }`.
- **Response fields the app reads:** `{ success?, photoWishId?, editedImageUrl?, amountCharged?, error? }`; on non-2xx reads `error ?? message`.
- **Behaviour notes:** Server inserts `photo_wishes` and debits the wallet. Then the **client** inserts `payment_transactions` and PATCHes `photo_wishes.wishme_payment_id` (flagged above).

#### `POST /functions/v1/generate-image-promotion`
- **Callers:** `app/image-promotions.tsx:234`.
- **Auth:** user access token (required).
- **Request body:** `{ celebrityId, concept (≤500), brandingDetails?: string (≤300), referenceImageSource: 'upload'|'none', referenceImageUrl: 'data:image/jpeg;base64,...' | null }`.
- **Response fields the app reads:** `{ generation?: ImagePromotion, error? }`; on non-2xx `error ?? message` ("insufficient"/"balance" → add-funds dialog).
- **Behaviour notes:** Only celebrities in the user's favourites are offered (subscription gate). Server inserts `image_promotions` and debits the wallet; **client then writes `payment_transactions` + PATCH `image_promotions.wishme_payment_id`** with `amount = finalPrice` computed client-side (flagged). UI shows a hard-coded "Free Period Active" banner while still charging. 20 s client timeout.

#### `POST /functions/v1/b2-get-signed-url`
- **Callers:** `services/library.ts:190` (`resolveVideoUrl`, used by `app/library.tsx:168,178` and `components/ugc/UgcHistory.tsx:85`). Also called directly from `components/bookings/WishFriendCard.tsx:36` and `components/bookings/CelebCard.tsx:66` (bookings inventory).
- **Auth:** user access token.
- **Request body:** `{ fileKey: string }` (B2 object key stored in `*.video_file_key` / `library_items.file_key`).
- **Response fields the app reads:** `{ signedUrl?: string, url?: string }` → `signedUrl ?? url`.
- **Behaviour notes:** Only called when `fileKey` is set; any failure falls back to the stored `media_url`/`video_url`. Signed URL is fetched on each play/open (no caching).

#### `POST /functions/v1/generate-document`
- **Callers:** `services/documents/generate.ts:111` — raw `fetch` with `apikey` + Bearer, **150 s** timeout.
- **Auth:** user access token (required; 401 → "Please sign in again").
- **Request body:** `{ topic: string, kind: 'report'|'letter'|'notes'|'plan'|'spreadsheet', title?: string, audience?: string, length: 'short'|'medium'|'long' (default 'medium'), language?: string }`.
- **Response fields the app reads:** `{ ok: boolean, kind?, title?, subtitle?: string|null, sections?: { heading, body (markdown: paragraphs, "- bullets", **bold**) }[] | null, sheet?: { columns: string[], rows: unknown[][], notes?: string } | null, wordCount?: number, error?: string }`. Success requires `res.ok && body.ok === true` and at least one of sections/sheet.
- **Behaviour notes:** Pure generation; nothing is persisted server-side by the client. `services/documents/store.ts` keeps the index in `AsyncStorage['documents.index.v1']` and content in `<DOCUMENTS_DIR>/<id>/content.json` — no backend. Comment notes the server returns `503` when the account owner must fix something (AI key).

#### `POST /functions/v1/generate-lyrics`
- **Callers:** `components/music/GenerateSongTab.tsx:57`, `components/music/ImageMusicTab.tsx:38`.
- **Auth:** user access token.
- **Request body:** `{ description: string (falls back to song title / 'a beautiful scene'), genre, mood, language }`.
- **Response fields the app reads:** `{ lyrics?: string }`; errors via `parseApiError`.

#### `POST /functions/v1/generate-music`
- **Callers:** `components/music/GenerateSongTab.tsx:106`.
- **Auth:** user access token.
- **Request body:** `{ song_title: string ('Untitled' default), generation_type: 'with_lyrics'|'instrumental', genre, mood, prompt: string (description || title || '<genre> <mood>'), [with_lyrics:] voice_type: 'any'|'male'|'female', language: string, lyrics?: string; [instrumental:] description?: string }`.
- **Response fields the app reads:** `{ generation_id?: string, task_id?: string, status?: string, error?: string }`; `!res.ok || !generation_id` → error.
- **Behaviour notes:** Cost shown client-side ₹150 full / ₹100 instrumental (`COSTS`), balance pre-checked client-side; server performs the debit (wallet refreshed on completion). Launches async generation; see polling below.

#### `POST /functions/v1/check-music-status`
- **Callers:** `components/music/GenerateSongTab.tsx:125`.
- **Auth:** user access token.
- **Request body:** `{ generation_id }`.
- **Response fields the app reads:** `{ status: string, song_url?: string, download_url?: string, error?: string }`.
- **Behaviour notes:** Polling starts **10 s** after `generate-music` returns, then every **5 000 ms**, max **60 attempts** (~5 min). Ends on `status==='completed' && (song_url || download_url)` (audio = `song_url ?? download_url`, `refreshWallet()`), `status==='failed'` (error = `error ?? 'Music generation failed'`), or timeout. Any network/JSON exception aborts polling with that error.

#### `POST /functions/v1/elevenlabs-image-music-video`
- **Callers:** `components/music/ImageMusicTab.tsx:69`.
- **Auth:** user access token.
- **Request body:** `{ imageBase64: 'data:image/jpeg;base64,...', musicDescription?: string, lyrics?: string, genre, mood, durationSeconds: number (10–60 step 5), language, uploadedAudioBase64: 'data:audio/...;base64,...' | null }`.
- **Response fields the app reads:** `{ success: boolean, audioUrl?: string, b2Url?: string, videoUrl?: string, imageBase64?: string, hasVocals?: boolean, error?: string }`; requires `success && (audioUrl || b2Url)`; audio = `b2Url || audioUrl`.
- **Behaviour notes:** Then client inserts `image_music_generations` (see table). Web builds the MP4 locally from image+audio via canvas/MediaRecorder; native downloads `videoUrl`.

#### `POST /functions/v1/elevenlabs-sound-effects`
- **Callers:** `components/music/SFXTab.tsx:29`.
- **Auth:** user access token.
- **Request body:** `{ text: string, durationSeconds: number (1–22) }`.
- **Response fields the app reads:** `{ success: boolean, audioUrl: string, error? }` (audioUrl may be http(s) or base64 data URI — player handles both).
- **Behaviour notes:** Then client inserts `sound_effect_generations`; `refreshWallet()`.

#### `POST /functions/v1/elevenlabs-speech-to-speech`
- **Callers:** `components/music/VoiceConversionTab.tsx:38`.
- **Auth:** user access token.
- **Request body:** `{ audioBase64: 'data:<mime>;base64,...' (recorded m4a/caf/3gp/wav or picked file), voiceId: string }`.
- **Response fields the app reads:** `{ success, audioUrl, error? }`.
- **Behaviour notes:** Then client inserts `voice_conversion_generations`; `refreshWallet()`.

#### `POST /functions/v1/elevenlabs-clone-voice`
- **Callers:** `components/music/CloneTab.tsx:29`.
- **Auth:** user access token.
- **Request body:** `{ audioBase64: data URI, voiceName: string, voiceDescription: string }`.
- **Response fields the app reads:** `{ success: boolean, voiceId?: string, error? }`.
- **Behaviour notes:** No `*_generations` row is written by the client for cloning. On success calls `ctx.onVoiceCloned()` (re-fetches voices via `get-user-voices`) and `refreshWallet()`. Cost shown ₹150.

#### `POST /functions/v1/elevenlabs-text-to-speech`
- **Callers:** `components/music/TTSTab.tsx:36`.
- **Auth:** user access token.
- **Request body:** `{ text: string (full text, not truncated), voiceId: string }`.
- **Response fields the app reads:** `{ success, audioUrl, error? }`.
- **Behaviour notes:** Then client inserts `tts_generations` (text truncated to 500 there); `refreshWallet()`.

#### `POST /functions/v1/elevenlabs-audio-isolation`
- **Callers:** `components/music/IsolateTab.tsx:24`.
- **Auth:** user access token.
- **Request body:** `{ audioBase64: data URI }`.
- **Response fields the app reads:** `{ success, audioUrl, error? }`.
- **Behaviour notes:** Then client inserts `audio_isolation_generations`; `refreshWallet()`.

#### `POST /functions/v1/get-user-voices`
- **Callers:** `hooks/useVoices.ts:27` — voice list for TTS / Voice Conversion pickers.
- **Auth:** user access token (required; skipped when no session).
- **Request body:** `{}`.
- **Response fields the app reads:** `{ premadeVoices?: VoiceItem[], clonedVoices?: VoiceItem[] }` with `VoiceItem { voice_id: string, name: string, category: string, preview_url?: string }`.
- **Behaviour notes:** If this request throws or is non-2xx, falls back to `elevenlabs-get-user-voices` (below). Tabs default to the first cloned voice, then first premade.

#### `POST /functions/v1/elevenlabs-get-user-voices`
- **Callers:** `hooks/useVoices.ts:40` — legacy fallback for `get-user-voices`.
- **Auth:** user access token.
- **Request body:** `{}`.
- **Response fields the app reads:** same shape as `get-user-voices`.
- **Behaviour notes:** Only reached on failure of the primary; one of the two names can be dropped once the new API has a single voices endpoint.

---

### Storage buckets

#### `POST /storage/v1/object/greeting-card-uploads/<path>`
- **Callers:** `app/wish-celebrity-occasion/[id].tsx:297` (`uploadFileToStorage`) — raw `fetch` with `Authorization: Bearer <session.access_token>`, `Content-Type: <mime>`, `x-upsert: true`, body = Blob of the picked asset. **No `apikey` header is sent.**
- **Auth:** user access token.
- **Request body / path patterns:**
  - AI reference image: `ref-images/<profileId>-<Date.now()>.<ext>` (ext from `image/<ext>`, default jpg)
  - uploaded card: `user-cards/<profileId>-<Date.now()>.<ext>`
  - uploaded video: `user-videos/<profileId>-<Date.now()>.<ext>` (ext from `video/<ext>`, default mp4)
- **Response fields the app reads:** only `res.ok`. The stored URL the app then writes into `wish_celebrity_orders.reference_image_url / user_uploaded_card_url / user_uploaded_video_url` is `${SUPABASE_URL}/storage/v1/object/public/greeting-card-uploads/<path>` → bucket must be **public**.
- **Behaviour notes:** Upload happens inside `createOrGetOrder` before the order INSERT; a failed card/video upload aborts the payment ("Failed to upload ..."); a failed reference-image upload is tolerated (null).

#### `POST /storage/v1/object/promotional-content/<path>`
- **Callers:**
  - `app/wish-friend.tsx:100` — optional reference photo for a UGC video (`supabaseFetch`, `Content-Type: image/jpeg`, Blob body).
  - `components/ugc/FormFields.tsx:106` — `ImageTiles` multi-photo upload in UGC forms (same headers).
- **Auth:** user access token (plus `apikey`, via `supabaseFetch`).
- **Request body / path patterns:**
  - wish-friend: `<authUid>/wish-friend-<Date.now()>.jpg`
  - FormFields: `<authUid>/ugc-<Date.now()>-<5 random base36 chars>.jpg`
- **Response fields the app reads:** `res.ok`; errors via `parseApiError`. Public URL stored/sent to the RPC: `${SUPABASE_URL}/storage/v1/object/public/promotional-content/<path>` (`p_reference_image_url`, `p_product_image_url`, and inside `p_details` as URL arrays) → bucket must be **public**.
- **Behaviour notes:** Path is namespaced by **auth uid** (not profile id). No `x-upsert`, so a path collision fails; timestamps make it unlikely. Uploads are sequential per picked asset; a failed asset shows an alert and is skipped.

---

### Flows

#### Wish a celebrity (order + card generation + send)
1. `GET celebrities` (active list) + `GET celebrity_favorites` → subscribed celebs open `/wish-booking/<id>` (older screen) or, via other routes, `/wish-celebrity-occasion/<id>`.
2. Screen load: `GET celebrities?id=eq.` (price = `service_prices.general_wish`), `GET profiles?user_id=eq.<auth uid>` (wallet_balance, profile id), optional `GET wish_celebrity_orders` restore (AsyncStorage `wishOrderId:<celebId>` or latest order for user+celeb) → may jump straight to the paid/card state.
3. Optional helpers: `generate-message-suggestions`, `suggest-greeting-card-prompts`.
4. Pay via **Wallet**: client checks `walletBalance >= finalPrice` → (occasion screen) upload ref image / card / video to `greeting-card-uploads` → `POST wish_celebrity_orders` with `payment_method 'wallet'`, `payment_status 'completed'`, `status 'pending'` (or PATCH an existing order) → `POST wallet_transactions` (amount `-finalPrice`) → on failure `DELETE` the order; on success `PATCH` order `{status:'paid', payment_status:'completed', payment_method:'wallet'}`.
5. Pay via **Razorpay**: `POST wish_celebrity_orders` (`payment_status 'pending'`) → `create-razorpay-order {amount: paise, currency, receipt, notes.orderId}` → Razorpay checkout (web script `checkout.razorpay.com/v1/checkout.js`, or `react-native-razorpay`; if the native module is missing the order is DELETEd and the user is told to use wallet) → `verify-razorpay-payment {ids, signature, orderId, orderType:'wish'}` → client PATCH order to paid. Cancel → DELETE order.
6. AI card (`card_generation_type 'ai'`): `generate-wish-celebrity-card {orderId}` immediately after payment; "Regenerate" repeats it up to 3 attempts total; "Approve & Send" → `send-wish-to-celebrity {orderId}` → clear AsyncStorage → `/wish-congratulations?orderId=` which `GET`s the order (incl. `conversation_id`) and auto-redirects to `/messages` after 10 s.
7. Upload modes (`upload-card` / `upload-video`, occasion screen only): "Send Wish" → `send-wish-thankyou-dm {orderId}` → client `PATCH {status:'sent'}` → congratulations.
8. `wish-confirmation/[id]` (reached from booking screen or "Continue Wish" in wish-orders): `GET` order with embedded celebrity; auto-calls `generate-wish-celebrity-card` if paid and no card yet; same regenerate/send buttons; shows "sent" banner when `card_approved`.
9. `wish-orders`: `GET wish_celebrity_orders?select=*,celebrities(...)` limit 50, pull-to-refresh; downloads `generated_card_image_url` (B2-prefixed) to the gallery.

**Money written by the client in this flow:** `wish_celebrity_orders.amount_paid/discount_*/payment_method/payment_status/status`, `wallet_transactions` rows, Razorpay `amount`. All of it must move server-side.

#### Wish a friend / UGC video / UGC ad (RPC)
1. `GET platform_settings` (`ugc_video_price` or `ugc_ads_price`) for the fallback price; `useWallet().refetch()`.
2. Celebrity step: debounced `GET celebrities` with `is_active`, consent filter, `name=ilike`, limit 48; price = `service_prices.general_wish` (video_wish) or `service_prices.ugc_ad || fallback` (ugc), discounted via `usePlan().getDiscountedPrice`.
3. Optional photos → `POST /storage/v1/object/promotional-content/<authUid>/...jpg` → public URLs.
4. Submit: `POST rpc/create_wish_friend_order` (video_wish / ugc_video) or `POST rpc/create_ugc_ad_order` (ad). Server owns pricing + wallet debit + insert. Client reads `id` (+ `price_paid` on wish-friend), refetches wallet, clears the AsyncStorage draft, shows confirmation (`useOrderConfirm`).
5. History ("My orders"): `GET wish_friend_orders?order_type=eq.ugc_video&user_id=eq.<profileId>` or `GET ugc_ads?user_id=eq.<authUid>` with embedded `celebrities(name,image_url)`; ready items play via `resolveVideoUrl` (`b2-get-signed-url {fileKey}` → fallback `video_url`) and can be saved with `POST library_items` (upsert).

#### Greeting card generation with polling
1. `GET platform_settings?setting_key=eq.greeting_card_price`; `GET profiles?select=plan_name` → `GET plans?name=eq.<plan>&select=service_discount_percentage`; `GET greeting_card_generations` history (also feeds the "Library" reference picker = rows with `saved_to_library`).
2. Client checks `wallet.balance >= finalPrice`.
3. `POST generate-greeting-card-ai { prompt, occasionName, recipientName?, senderName, refinePrompt, referenceImageSource, referenceImageUrl? (base64 data URI or a saved card's URL) }` → `{ generation }`.
4. If `generation.generated_image_url` is set and ≠ `'base64-returned-to-client'` → done (toast, wallet refetch, history refetch). Else poll `GET greeting_card_generations?id=eq.<id>&select=status,generated_image_url,greeting_text,refined_prompt&limit=1` every 3 s, ≤20 times; stop on `completed`+url or `failed`; timeout → local "failed".
5. Star / unstar: `PATCH greeting_card_generations {saved_to_library}`; download writes the image (URL or data URI) to the device gallery.

#### Photo wish
1. `GET platform_settings?setting_key=eq.photo_wish_price`; `GET photo_wishes` history (profile id).
2. Pick image → resize 1200 px / JPEG 0.8 / base64.
3. Raw `fetch POST generate-photo-wish { originalImageBase64, occasion, recipientName, wishMessage, senderName|null, textStyle }` (120 s timeout) → `{ success, photoWishId, editedImageUrl, amountCharged, error }`.
4. Client then `POST payment_transactions` (`service_type 'photo_wish'`, client `WM-...` id, amount `amountCharged ?? finalPrice`) and `PATCH photo_wishes {wishme_payment_id}`; refetch wallet + history. **Both writes must become server-side.**

#### Image promotion
1. Favourite ids from `useCelebrityFavorites` → `GET celebrities?id=in.(...)`; `GET platform_settings?setting_key=eq.image_promotion_price`; `GET image_promotions` history.
2. `POST generate-image-promotion { celebrityId, concept, brandingDetails?, referenceImageSource, referenceImageUrl (data URI | null) }` → `{ generation }`.
3. Client `POST payment_transactions` (`service_type 'image_promotion'`, amount = client `finalPrice`) and, if ok, `PATCH image_promotions {wishme_payment_id}`; refetch wallet/history; `confirmOrder`. **Both writes must become server-side.**

#### Generate a song (lyrics → music → status polling)
1. Optional `POST generate-lyrics { description, genre, mood, language }` → `lyrics`.
2. Client checks `walletBalance >= cost` (₹150 with lyrics / ₹100 instrumental).
3. `POST generate-music { song_title, generation_type, genre, mood, prompt, voice_type?, language?, lyrics? | description? }` → `generation_id`.
4. Wait 10 s, then `POST check-music-status { generation_id }` every 5 s up to 60× → `status`, `song_url`/`download_url`; `completed` → play `song_url ?? download_url`, `refreshWallet()`; `failed` → error; 60 attempts → "Generation timed out".
5. No client-side `*_generations` insert for songs (server persists).

#### ElevenLabs tabs (what is sent, what is saved)
| Tab | Function + body | Reads | Client then inserts |
|---|---|---|---|
| TTS | `elevenlabs-text-to-speech { text, voiceId }` | `success, audioUrl` | `tts_generations { user_id, text(≤500), voice_id, voice_name, audio_url, status:'completed', credits_used:50 }` |
| Voice Conversion | `elevenlabs-speech-to-speech { audioBase64, voiceId }` | `success, audioUrl` | `voice_conversion_generations { user_id, voice_id, voice_name, audio_url, status, credits_used:75 }` |
| SFX | `elevenlabs-sound-effects { text, durationSeconds }` | `success, audioUrl` | `sound_effect_generations { user_id, description(≤500), duration_seconds, audio_url, status, credits_used:60 }` |
| Clone | `elevenlabs-clone-voice { audioBase64, voiceName, voiceDescription }` | `success, voiceId` | nothing; re-fetches `get-user-voices` |
| Isolate | `elevenlabs-audio-isolation { audioBase64 }` | `success, audioUrl` | `audio_isolation_generations { user_id, original_file_name, audio_url, status, credits_used:40 }` |
| Img+Music | `elevenlabs-image-music-video { imageBase64, musicDescription?, lyrics?, genre, mood, durationSeconds, language, uploadedAudioBase64|null }` | `success, audioUrl, b2Url, videoUrl, imageBase64, hasVocals` | `image_music_generations { user_id, image_url:<base64>, audio_url, video_url, description, lyrics, genre, mood, duration_seconds, has_vocals, amount_charged:150|120, status, completed_at }` |

Voices for TTS/Conversion come from `get-user-voices {}` (fallback `elevenlabs-get-user-voices {}`) → `premadeVoices[]`, `clonedVoices[]`. In every tab the balance is pre-checked client-side against `COSTS` and the server performs the actual debit (`refreshWallet()` after); the generation rows, including `credits_used`/`amount_charged`, are written by the client and should be written by the server instead. `audioUrl` can be a base64 `data:audio/...` URI (stored verbatim in the row) or an http(s) URL.

#### Save to library and signed B2 URL
1. Library grid: `GET greeting_card_generations?saved_to_library=eq.true&status=eq.completed` + `GET library_items` (parallel, limit 60 each), merged and sorted by `created_at`; module-level cache shown instantly on reopen.
2. Save a video (UgcHistory / bookings cards): `POST library_items?on_conflict=user_id,source_type,source_id` with `Prefer: resolution=ignore-duplicates` and `{ user_id, kind:'video', source_type, source_id, title, subtitle, media_url, file_key, thumbnail_url }`; saved-state is pre-loaded once per profile via `GET library_items?kind=eq.video&select=source_id&limit=500`.
3. Play / download / share: `resolveVideoUrl` → if `file_key`, `POST b2-get-signed-url { fileKey }` → `signedUrl ?? url`; otherwise (or on failure) the stored `media_url`. Signed URL requested per open, not cached.
4. Remove: card → `PATCH greeting_card_generations {saved_to_library:false}`; video → `DELETE library_items?id=eq.`.


---

## Domain 5 — Voice assistant, AI calls, Vapi, Hub, travel

Scope: `services/voice/engine.ts`, `services/geminiLive/client.ts`, `services/sarvamLive/client.ts`,
`services/assistant/aiCalls.ts`, `services/assistant/webSearch.ts`, `services/hub/{reminders,calendar,callLogs,notifications}.ts`,
`context/AssistantPersonaContext.tsx`, `app/(tabs)/voice-call.tsx`, `app/voice-call-wish.tsx`, `services/tboService.ts`,
`components/all-services/*` (pay screens), `services/documents/generate.ts`. The Hub screens (`app/reminders.tsx`,
`calendar.tsx`, `call-logs.tsx`, …) and `services/assistant/hubTools.ts` call only these services, never Supabase directly.
`services/home/*` (weather, news, quote, streak), `app/finance.tsx`, `app/news.tsx` and `app/features.tsx` make no Supabase calls.

**Identity note:** `reminders.user_id`, `calendar_events.user_id` and `assistant_settings.user_id` are written with
`user.id` — the **auth user id**, not `profiles.id` — while most other tables key on the profile id. `ai_calls` and
`ai_call_lines` are read without any user filter, so RLS alone scopes them to the caller today.

### Tables

#### `GET /rest/v1/ai_call_lines`
- **Callers:** `services/hub/callLogs.ts:52` — the per-line transcript of one AI call (call-log detail screen).
- **Auth:** user access token.
- **Query / filters:** `select=id,role,message,seq&call_id=eq.<callId>&order=seq.asc`.
- **Response fields the app reads:** array of `{ id: number, role: 'assistant'|'user', message: string, seq: number }`.
- **Behaviour notes:** older calls have no lines; the screen then parses `ai_calls.transcript` ("AI:" / "Them:" prefixes). RLS must restrict lines to calls the caller owns.

#### `GET /rest/v1/ai_calls`
- **Callers:**
  - `services/assistant/aiCalls.ts:104` — `fetchAiCall(id)`: one call, used by the watcher that polls a live call.
  - `services/assistant/aiCalls.ts:120` — `listAiCalls(limit=30)` / `fetchLatestAiCall` (limit 1): Hub call list and the assistant's `get_call_result` tool.
- **Auth:** user access token.
- **Query / filters:** `select=id,to_name,to_phone,purpose,details,status,scheduled_for,duration_seconds,transcript,summary,outcome,next_step,recording_url,error_message,ended_reason,created_at` plus `id=eq.<id>&limit=1`, or `order=created_at.desc&limit=<n>`. **No user filter**: relies on RLS.
- **Response fields the app reads:** the `AiCall` row: `id, to_name, to_phone, purpose, details, status ('queued'|'scheduled'|'ringing'|'in-progress'|'completed'|'no-answer'|'busy'|'voicemail'|'failed'), scheduled_for, duration_seconds, transcript, summary, outcome, next_step, recording_url, error_message, ended_reason, created_at`.
- **Behaviour notes:** the watcher (`createAiCallWatcher`) polls every **6 s** (`FAST_MS`), every **60 s** while `status = scheduled` (`SLOW_MS`), first poll after 1.5 s; it flags a call still `queued` after **75 s** as stalled and stops holding the assistant open after **7 min** (`LIVE_MAX_MS`). Terminal statuses end the watch. The server (Vapi webhooks) is what moves `status` and fills `summary/outcome/next_step/transcript`.

#### `GET|POST /rest/v1/assistant_settings`
- **Callers:**
  - `context/AssistantPersonaContext.tsx:132` — GET: load the assistant persona after login (AsyncStorage cache `@wishme/assistant-persona:<userId>` is shown first).
  - `context/AssistantPersonaContext.tsx:173` — POST upsert: save the persona from setup/settings.
- **Auth:** user access token.
- **Query / filters:** GET `select=*&user_id=eq.<auth user id>&limit=1`. POST `?on_conflict=user_id` with `Prefer: resolution=merge-duplicates,return=minimal`.
- **Request body:** `{ user_id, assistant_name, voice, personality, custom_note|null, language, is_default, updated_at }`.
- **Response fields the app reads:** GET row mapped by `fromRow`: `assistant_name, voice, personality, custom_note, language, is_default`. An empty array means "needs setup".
- **Behaviour notes:** the voice engines read this row server-side too (`voice-token`, `sarvam-voice`) to pick voice and language.

#### `GET|POST|PATCH|DELETE /rest/v1/calendar_events`
- **Callers:** `services/hub/calendar.ts:106` (list), `:112` (fetch one), `:127` (create), `:146` (update), `:159` (delete). Used by `app/calendar.tsx`, `app/event-edit.tsx`, `app/(tabs)/hub.tsx` and the assistant's `add_event` / `list_upcoming` tools (`services/assistant/hubTools.ts`).
- **Auth:** user access token.
- **Query / filters:** list `select=<COLUMNS>&starts_at=lte.<to ISO>&or=(starts_at.gte.<from ISO>,recurrence.neq.none)&order=starts_at.asc` (recurring events are always returned; the phone expands occurrences). Fetch `id=eq.<id>&limit=1`. Update/delete `id=eq.<id>`.
- **Request body:** create: array of one `{ title, notes, location, starts_at, ends_at, all_day, recurrence ('none'|'daily'|'weekly'|'monthly'|'yearly'), recurrence_until, user_id: <auth user id>, timezone: <device IANA zone> }` with `Prefer: return=representation`. Update: partial draft + `updated_at`.
- **Response fields the app reads:** `CalendarEvent`: `id, title, notes, location, starts_at, ends_at, all_day, timezone, recurrence, recurrence_until, colour, source, source_id, created_at, updated_at`.
- **Behaviour notes:** errors are shown from `message` or `hint` of the PostgREST error body. Every change re-syncs the phone's local notifications.

#### `POST /rest/v1/push_tokens`
- **Callers:** `services/hub/notifications.ts:96` — `registerPushToken()`. **Never called anywhere in the app today**, so the table is probably empty.
- **Auth:** user access token.
- **Request body:** `{ token: <Expo push token>, platform: 'android'|'ios', last_seen_at }` with `Prefer: resolution=merge-duplicates` (needs a unique key on `token` or `(user_id, token)`; `user_id` must come from a column default such as `auth.uid()`).
- **Behaviour notes:** meant as the server's backstop channel for reminders when the app is closed. The new API should wire this up (phase H).

#### `GET|POST|PATCH|DELETE /rest/v1/reminders`
- **Callers:** `services/hub/reminders.ts:107` (list), `:122` (between dates), `:133` (fetch one), `:148` (create), `:167` (update), `:186` (done/reopen), `:213` (acknowledge), `:227` (delete). Used by `app/reminders.tsx`, `app/reminder-edit.tsx`, `app/(tabs)/hub.tsx`, the in-app reminder notifications and the assistant's `add_reminder` tool.
- **Auth:** user access token.
- **Query / filters:** list `select=<COLUMNS>&status=in.(pending,done,missed)&order=due_at.asc.nullslast,created_at.desc&limit=200`; between `due_at=gte.<from>&due_at=lte.<to>&status=in.(pending,done,missed)&order=due_at.asc`; one `id=eq.<id>&limit=1`; acknowledge `id=eq.<id>&acknowledged_at=is.null`.
- **Request body:** create: array of one `{ title, notes, due_at, pin_to_timezone, lead_minutes, delivery ('notification'|'call'), style ('alarm'|'reminder'|'quiet'), recurrence, recurrence_until, escalate, escalate_after_minutes, escalate_phone, user_id: <auth user id>, timezone }`, `Prefer: return=representation`. Update: partial draft + `updated_at`, `Prefer: return=minimal`. Done: `{ status: 'done'|'pending', completed_at, updated_at }`. Acknowledge: `{ acknowledged_at }`.
- **Response fields the app reads:** `Reminder`: `id, title, notes, due_at, timezone, pin_to_timezone, lead_minutes, delivery, style, recurrence, recurrence_until, escalate, escalate_after_minutes, escalate_phone, status ('pending'|'done'|'missed'|'cancelled'), completed_at, event_id, call_id, created_at, updated_at`.
- **Behaviour notes:** the phone schedules its own local notifications and re-syncs on launch and foreground. A **server-side dispatcher** must exist for `delivery = 'call'` and for escalation (`escalate`, `escalate_after_minutes`, `escalate_phone`, `acknowledged_at`, `call_id`, status `missed`): it phones the user through the AI-call stack. Find it in the audit (cron function or `pg_cron`).

### Edge functions

#### `POST /functions/v1/voice-token`
- **Callers:**
  - `services/voice/engine.ts:151` — probe: which engine the admin selected. Timeout `PROBE_TIMEOUT_MS`, cached for `RESOLVE_TTL_MS`.
  - `services/geminiLive/client.ts:369` — mint an ephemeral Gemini Live token before each socket.
- **Auth:** user access token (raw `fetch` with `apikey` + `Authorization: Bearer <access token>`).
- **Request body:** probe `{ probe: true, supports: ['gemini','sarvam'] }`; mint `{ want: 'gemini', supports: ['gemini','sarvam'] }`.
- **Response fields the app reads:** `engine ('gemini'|'sarvam')`, `fallback_engine ('gemini'|'sarvam'|null)`, `relay_url` (string, optional: overrides the Sarvam relay URL), and for a mint `token` (Gemini ephemeral auth token) and `model`.
- **Behaviour notes:** the app opens `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=<token>` itself, so the API only has to mint tokens with the server's Gemini key (`authTokens.create`), not relay audio. The engine choice is persisted in AsyncStorage and never switched mid-conversation.

#### `WSS /functions/v1/sarvam-voice` (relay)
- **Callers:** `services/sarvamLive/client.ts:143` (URL), `:171` and `:409` (connect). URL is `relay_url` from `voice-token` if given, else `wss://<supabase host>/functions/v1/sarvam-voice`.
- **Auth:** first frame `{ type: 'auth', token: <user access token> }` (sent early for a pre-warmed "standby" socket).
- **Client → server frames:** `auth`; `start { system, tools (Gemini-style function declarations), voice, language, greeting?, history }`; `audio { data: base64 16 kHz PCM }`; `text { text }`; `notify { text }`; `set_language { language }`; `tool_result { id, result }`; `interrupt`; `ping` (keep-alive on standby sockets); `end`.
- **Server → client frames:** `ready` (relay is set up; the client flushes buffered mic audio and queued frames); `audio { data }` (24 kHz PCM); `transcript { role, text, final }`; `tool_call { id, name, args }`; `interrupted`; `vad { event }`; `turn_complete`; `goaway`; `metrics`; `error { message }`.
- **Behaviour notes:** the relay runs STT → LLM chat with tools → TTS on Sarvam, holding Sarvam's key. It is a long-lived WebSocket, which is why it needs the VPS WebSocket service (phase F).

#### `POST /functions/v1/ai-call-start`
- **Callers:** `services/assistant/aiCalls.ts:89` — the assistant's `ai_call` tool after the user confirmed.
- **Auth:** user access token.
- **Request body:** `{ name?, phone (E.164 +91, validated on the phone: no emergency or premium numbers), purpose, details?, language?, scheduleAt? (ISO), confirmed: true }`.
- **Response fields the app reads:** `callId`, `status` (default `'queued'`), `scheduledFor`, `error`.
- **Behaviour notes:** inserts an `ai_calls` row and places (or schedules) an outbound Vapi call. Webhooks from Vapi then update the row and append `ai_call_lines`. The server must re-validate the number; the phone's check is UX only.

#### `POST /functions/v1/ai-call-recording`
- **Callers:** `services/hub/callLogs.ts:97` — short-lived link to a call recording, requested on every press of play.
- **Auth:** user access token.
- **Request body:** `{ callId }`.
- **Response fields the app reads:** `url` on success; status **404** = no recording, **410** = recording deleted (transcript kept); otherwise `error`.
- **Behaviour notes:** the link is never stored or logged by the app. Recordings are private; signed URLs with a short expiry.

#### `POST /functions/v1/web-search`
- **Callers:** `services/assistant/webSearch.ts:85` (warm-up `{ warm: true }`, answers 204) and `:174` (search).
- **Auth:** user access token (raw `fetch`).
- **Request body:** `{ queries: string[≤3], recency, depth, query: queries[0], kind: 'news'|'general' }`.
- **Response fields the app reads:** `ok`, `results`, `instruction`, `took_ms`, `provider`, `credits`, `cached`; **429** means rate-limited.

#### `POST /functions/v1/vapi-celebrity-call`
- **Callers:** `app/(tabs)/voice-call.tsx:476` — book a call to a friend in a celebrity's cloned voice.
- **Auth:** user access token.
- **Request body:** `{ recipientName, recipientPhone (E.164), occasion, senderName, celebrityId, celebrityName, voiceId (celebrities.vapi_voice_id), price (client-computed), celebrityPhoneId?, customMessage, tone, relationship, language, thingsToAvoid, additionalContext, scheduledAt (ISO|null) }`.
- **Response fields the app reads:** `success`, `error`/`message`, `callId`, `scheduled`, `scheduledAt`.
- **Behaviour notes:** **money**: the price comes from the client and the function is expected to debit the wallet (the screen only calls `wallet.refetch()` afterwards). Writes `voice_call_wishes` (read by the Bookings "Calls" tab). The server must price from `celebrities.service_prices`, not the request.

#### `POST /functions/v1/vapi-get-voices`, `vapi-upload-voice`, `vapi-make-call`
- **Callers:** `app/voice-call-wish.tsx:91`, `:134`, `:173`.
- **Auth:** user access token.
- **Request body:** get-voices `{}`; upload `{ voiceName, audioBase64 }`; make-call `{ recipientName, recipientPhone, occasion, voiceId, voiceName, voiceProvider, language }`.
- **Response fields the app reads:** get-voices `vapiVoices[]`, `userVoices[]` (`id, name, provider`), `error`; upload `error`; make-call `message`, `callId`, `error`.
- **Behaviour notes:** voice cloning uploads base64 audio in a JSON body (large requests: allow ≥10 MB bodies on this route).

#### `POST /functions/v1/tbo-flights`
- **Callers:** `services/tboService.ts:149` (single transport `callTbo`), reached from `components/all-services/FlightResultsScreen.tsx:1357` (search), `FlightAddonsScreen.tsx:76` (seat map via `ssr`), `FlightReviewAndPayScreen.tsx:123` (farequote) and `:131` (book + ticket).
- **Auth:** whatever token the caller passes; the flight screens pass **none**, so these run with the **anon key**.
- **Request body:** `{ action, ...payload }` with actions:
  - `search { origin, destination, departDate, returnDate?, adults?, children?, infants?, cabinClass?, directOnly? }` → `TBOSearchResult` (`traceId` + flights).
  - `farerule { traceId, resultIndex }`.
  - `farequote { traceId, resultIndex }` → `TBOFareQuote` (`isPriceChanged`, `flight.price`).
  - `ssr { traceId, resultIndex }` → `{ seats, meals }` (raw TBO SSR tree; the phone walks it for `SeatNo/Code/RowNo/SeatType/Price/AvailablityType`).
  - `book { traceId, resultIndex, passengers: TBOBookingPassenger[] }` → `{ booking: { PNR, BookingId } }` (non-LCC only).
  - `ticket { traceId, resultIndex, passengers }` (LCC) or `{ traceId, pnr, bookingId }` → `{ ticket: { BookingId, PNR, FlightItinerary: { Passenger[].Ticket.TicketNumber, InvoiceNo, Fare.{PublishedFare,Currency}, InvoiceCreatedOn }, Error.ErrorCode } }`.
  - `bookingdetails { bookingId, pnr?, traceId? }`.
- **Response fields the app reads:** every response must carry `success: true`; otherwise `error` is shown.
- **Behaviour notes:** **money gap**: the review screen re-quotes, then books and tickets, then refreshes the wallet, but the client never charges anything. Either `tbo-flights` debits the wallet server-side or tickets are issued unpaid; the audit must answer which. Flight booking must become: hold price → charge wallet/Razorpay server-side → ticket → refund on failure.

#### `POST /functions/v1/tbo-hotels`
- **Callers:** `services/tboService.ts` actions `citylist { countryCode }`, `hotelcodes { cityCode }`, `search { … }`, `prebook { bookingCode }`, `book { bookingCode, customerDetails[], clientReferenceId?, totalFare?, emailId?, phoneNumber? }`.
- **Behaviour notes:** **no screen calls these today.** The hotel flow uses static data (`components/all-services/hotelData.ts`) and `HotelReviewAndPayScreen.tsx:113` simulates payment with a 1.6 s delay and a random `WMH…` booking id. Bills (`BillPayScreen.tsx`, random `WMB…` id) and buses are also mock. Nothing to migrate for them except the TBO function itself.

#### `POST /functions/v1/generate-document`
- **Callers:** `services/documents/generate.ts:111` — the assistant's `create_document` tool.
- **Auth:** user access token (raw `fetch`, own long timeout instead of the 20 s default).
- **Response fields the app reads:** `ok: true` plus the document structure the phone renders (PDF/XLSX/DOCX-HTML/CSV/TXT/MD); otherwise `error`. Documents never leave the phone after that.

### Third-party endpoints the app calls directly (not Supabase)

- **Gemini Live**: `wss://generativelanguage.googleapis.com/…BidiGenerateContentConstrained?access_token=<ephemeral token>` (token from `voice-token`).
- **Open-Meteo** (weather), **Google News RSS** (news), quote and streak widgets: public, keyless, cached locally (`services/home/*`).
- **Backblaze B2 public files**: `https://f005.backblazeb2.com/file/wishmetoday/…` for celebrity media; private files go through `b2-get-signed-url`.

### Flows

- **Assistant engine start:** `voice-token {probe}` → engine + fallback (+ relay URL) cached → Gemini: `voice-token {want:'gemini'}` → `token`, `model` → open the Google socket and send setup. Sarvam: open the relay socket → `auth` → `start {system, tools, voice, language, greeting, history}` → wait for `ready` → stream `audio`. On a failure the engine falls back to `fallback_engine`.
- **AI phone call:** user confirms → `ai-call-start` → `callId` → watcher polls `ai_calls` every 6 s (60 s if scheduled) → Vapi webhooks move the row through `ringing` → `in-progress` → terminal, appending `ai_call_lines` → assistant reads `summary/outcome/next_step` aloud → Hub shows lines and a fresh `ai-call-recording` link on play.
- **Celebrity voice call (Vapi):** `celebrities` with `vapi_voice_id not null` (`hooks/useVoiceCallCelebrities.ts`) → `vapi-celebrity-call` (now or `scheduledAt`) → wallet refetch → Bookings "Calls" tab reads `voice_call_wishes`.
- **Reminder:** `reminders` POST (user_id = auth id, device timezone) → phone schedules local notification → user ticks it off (`status=done` + `acknowledged_at`) or the server dispatcher escalates by phone call after `escalate_after_minutes`.
- **Flight booking:** `search` → (`ssr` for seats) → `farequote` (abort if `isPriceChanged`) → non-LCC: `book` then `ticket {pnr, bookingId}`; LCC: `ticket {passengers}` → confirmation built from the ticket response.
