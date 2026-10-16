# Which file owns which table, RPC and function

Every `/rest/v1` table has exactly one policy, every RPC and edge function exactly one handler.

## Table policies (`src/compat/postgrest/policies/`)

| File | Tables |
| --- | --- |
| `accounts.ts` | `profiles`, `plans`, `platform_settings`, `wallet_transactions`, `payment_transactions`, `referral_transactions`, `bank_details`, `payout_requests`, `celebrity_wallet_transactions`, `push_tokens`, `celebrity_applications`, `celebrity_categories` |
| `celebrities.ts` | `celebrities`, `celebrity_events`, `celebrity_favorites`, `celebrity_favorite_pricing`, `celebrity_media`, `celebrity_occasions`, `celebrity_reviews`, `celebrity_settings`, `bookings`, `conversations`, `messages`, `loved_ones`, `occasion_alerts`, `occasion_bookings`, `occasion_wishes`, `occasions` |
| `content.ts` | `wish_celebrity_orders`, `wish_friend_orders`, `ugc_ads`, `image_promotions`, `photo_wishes`, `greeting_card_generations`, `library_items`, `music_generations`, `tts_generations`, `sound_effect_generations`, `voice_conversion_generations`, `audio_isolation_generations`, `image_music_generations`, `voice_call_wishes` |
| `hub.ts` | `ai_calls`, `ai_call_lines`, `assistant_settings`, `calendar_events`, `reminders` |

## RPCs

| File | RPCs |
| --- | --- |
| `accounts.ts` | `validate_referral_code`, `get_my_referrals`, `get_my_referral_history` |
| `celebrities.ts` | `purchase_celebrity_subscription` |
| `content.ts` | `create_wish_friend_order`, `create_ugc_ad_order` |

## Edge functions (`src/compat/functions/handlers/`)

| File | Functions |
| --- | --- |
| `auth.ts` | `send-email-otp`, `verify-email-otp` |
| `payments.ts` | `create-razorpay-order`, `verify-razorpay-payment` |
| `messaging.ts` | `send-whatsapp-welcome`, `trigger-message-event`, `send-celebrity-subscription-email`, `send-wish-to-celebrity`, `send-wish-thankyou-dm`, `celebrity-conversation-auto-reply`, `celebrity-ai-message`, `generate-occasion-auto-reply` |
| `content-ai.ts` | `generate-message-suggestions`, `suggest-greeting-card-prompts`, `generate-wish-celebrity-card`, `generate-greeting-card-ai`, `generate-greeting-card`, `generate-photo-wish`, `generate-image-promotion`, `generate-document`, `generate-script`, `heygen-get-languages`, `generate-occasion-video` |
| `audio.ts` | `generate-lyrics`, `generate-music`, `check-music-status`, `elevenlabs-text-to-speech`, `elevenlabs-speech-to-speech`, `elevenlabs-sound-effects`, `elevenlabs-clone-voice`, `elevenlabs-audio-isolation`, `elevenlabs-image-music-video`, `get-user-voices`, `elevenlabs-get-user-voices`, `b2-get-signed-url` |
| `voice.ts` | `voice-token`, `sarvam-voice` (WebSocket relay), `ai-call-start`, `ai-call-recording`, `web-search`, `vapi-celebrity-call`, `vapi-get-voices`, `vapi-upload-voice`, `vapi-make-call` |
| `travel.ts` | `tbo-flights`, `tbo-hotels` |

## Payment purposes (`src/domains/payments/purposes/`)

| File | Purposes |
| --- | --- |
| built in (`service.ts`) | `wallet_deposit`, `plan_purchase` |
| `celebrities.ts` | celebrity subscriptions, bookings paid with Razorpay |
| `content.ts` | wish orders (wish-booking, wish-celebrity-occasion) paid with Razorpay |

## Job processors (`src/jobs/processors/`)

| File | Owner |
| --- | --- |
| `maintenance.ts`, `payments.ts` | core |
| `reminders.ts`, `calls.ts` | voice and hub |
| `content.ts` | content and audio |
| `notifications.ts` | messaging |
