#!/usr/bin/env bash
# Copies the real celebrity catalogue (public columns only) from the production Supabase project into the local
# development database, so WishMe Local shows the same stars and photos as the live app. Read-only on production:
# it uses the same public endpoint and anon key the app itself uses. Photos stay where production hosts them.
#
#   ./scripts/dev-import-celebrities.sh            # uses the URL and anon key from ../wishme-mobile-app
#   PROD_URL=... PROD_ANON_KEY=... ./scripts/dev-import-celebrities.sh
#
# Rows keep their production ids, so running it again updates them. The fictional "Demo ..." rows from
# dev-seed.sql are switched off.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_CONST=../wishme-mobile-app/artifacts/mobile/constants/supabase.ts
PROD_URL=${PROD_URL:-$(grep -oE "https://[a-z0-9]+\.supabase\.co" "$APP_CONST" 2>/dev/null | head -1 || true)}
PROD_ANON_KEY=${PROD_ANON_KEY:-$(grep -oE "eyJ[A-Za-z0-9._-]+" "$APP_CONST" 2>/dev/null | head -1 || true)}
[[ -n "$PROD_URL" && -n "$PROD_ANON_KEY" ]] || { echo "Set PROD_URL and PROD_ANON_KEY (production URL and public anon key)."; exit 1; }

COLS='id,name,category,bio,location,followers,image_url,video_thumbnail_url,rating,review_count,is_verified,delivery_time,service_prices,voice_call_price,celebrity_favorite_pricing!inner(price,is_enabled)'

json=$(curl -fsS --retry 3 --retry-all-errors --max-time 60 -G "$PROD_URL/rest/v1/celebrities" \
  --data-urlencode "select=$COLS" -d "is_active=eq.true" -d "is_verified=eq.true" -d "consent_status=eq.approved" \
  -d "celebrity_favorite_pricing.is_enabled=eq.true" -d "order=rating.desc.nullslast" -d "limit=200" \
  -H "apikey: $PROD_ANON_KEY" -H "Authorization: Bearer $PROD_ANON_KEY")
[[ "$json" == \[* ]] || { echo "Unexpected answer from production: ${json:0:200}"; exit 1; }
[[ "$json" != *'$cat$'* ]] || { echo "Refusing: the data contains the SQL quote marker."; exit 1; }

docker compose -f docker-compose.dev.yml exec -T postgres psql -U postgres -d wishme -v ON_ERROR_STOP=1 -q <<SQL
begin;
create temp table src as
  select * from jsonb_to_recordset(\$cat\$${json}\$cat\$::jsonb) as x(
    id uuid, name text, category text, bio text, location text, followers text, image_url text,
    video_thumbnail_url text, rating numeric, review_count int, is_verified boolean, delivery_time text,
    service_prices jsonb, voice_call_price int, celebrity_favorite_pricing jsonb);

update public.celebrities set is_active = false where name like 'Demo %';

insert into public.celebrities (id, name, category, bio, location, followers, image_url, video_thumbnail_url, rating,
  review_count, is_verified, is_active, verification_status, consent_status, delivery_time, service_prices, voice_call_price)
select id, name, coalesce(category, 'Other'), bio, location, followers, image_url, video_thumbnail_url, coalesce(rating, 0),
  coalesce(review_count, 0), true, true, 'approved', 'approved', coalesce(delivery_time, '24 hours'),
  coalesce(service_prices, '{"general_wish": 5000, "text_message": 2000, "image_promotion": 25000, "video_promotion": 50000}'),
  coalesce(voice_call_price, 500)
from src
on conflict (id) do update set name = excluded.name, category = excluded.category, bio = excluded.bio,
  location = excluded.location, followers = excluded.followers, image_url = excluded.image_url,
  video_thumbnail_url = excluded.video_thumbnail_url, rating = excluded.rating, review_count = excluded.review_count,
  is_active = true, delivery_time = excluded.delivery_time, service_prices = excluded.service_prices,
  voice_call_price = excluded.voice_call_price;

delete from public.celebrity_favorite_pricing where celebrity_id in (select id from src);
insert into public.celebrity_favorite_pricing (celebrity_id, price, is_enabled)
select s.id, (p->>'price')::int, true
from src s, jsonb_array_elements(case jsonb_typeof(s.celebrity_favorite_pricing) when 'array' then s.celebrity_favorite_pricing
                                       else jsonb_build_array(s.celebrity_favorite_pricing) end) p
where (p->>'price') is not null;
commit;
select count(*) || ' celebrities imported' from src;
SQL
