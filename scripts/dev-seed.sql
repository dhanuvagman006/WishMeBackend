-- Demo catalogue for local development only (loaded once by scripts/dev-setup.sh). Fictional names, no real people.
-- Prices are in whole rupees, as in production.

insert into public.plans (name, price, original_price, discount_percentage, features, referral_commission_l1,
  referral_commission_l2, service_discount_percentage, is_popular)
values
  ('Basic', 0, null, 0, '["Book celebrity wishes", "Wallet and referrals"]', 5, 2, 0, false),
  ('Silver', 499, 999, 50, '["10% off every service", "Higher referral commission", "Priority support"]', 10, 4, 10, true),
  ('Gold', 999, 1999, 50, '["20% off every service", "Top referral commission", "Early access to new stars"]', 15, 6, 20, false);

insert into public.celebrity_categories (name, description)
values ('Singer', 'Playback and independent singers'), ('Actor', 'Film and TV actors'),
       ('Comedian', 'Stand-up and sketch comedians'), ('Influencer', 'Creators and influencers');

insert into public.celebrities (name, category, bio, location, rating, review_count, followers, is_verified, is_active,
  verification_status, consent_status, delivery_time)
values
  ('Demo Singer Asha', 'Singer', 'A fictional singer for local testing.', 'Mumbai', 4.8, 120, '1.2M', true, true, 'approved', 'approved', '24 hours'),
  ('Demo Actor Ravi', 'Actor', 'A fictional actor for local testing.', 'Hyderabad', 4.6, 85, '850K', true, true, 'approved', 'approved', '48 hours'),
  ('Demo Comic Meera', 'Comedian', 'A fictional comedian for local testing.', 'Bengaluru', 4.9, 64, '420K', true, true, 'approved', 'approved', '24 hours');

insert into public.occasions (name, description, date, is_active, is_featured)
values ('Diwali', 'Festival of lights', make_date(extract(year from now())::int, 11, 8), true, true),
       ('Christmas', 'Season''s greetings', make_date(extract(year from now())::int, 12, 25), true, false),
       ('New Year', 'A fresh start', make_date(extract(year from now())::int + 1, 1, 1), true, false);

-- Subscription pricing: the app's celebrity list inner-joins enabled pricing, so a celebrity without it is hidden.
insert into public.celebrity_favorite_pricing (celebrity_id, price, is_enabled)
select id, 999, true from public.celebrities where name like 'Demo %';

-- Stock portraits (Unsplash, already used by production's demo rows) so cards and pages have photos.
update public.celebrities set image_url = 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=800&h=800&fit=crop&q=80' where name = 'Demo Singer Asha';
update public.celebrities set image_url = 'https://images.unsplash.com/photo-1568602471122-7832951cc4c5?w=800&h=800&fit=crop&q=80' where name = 'Demo Actor Ravi';
update public.celebrities set image_url = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=800&h=800&fit=crop&q=80' where name = 'Demo Comic Meera';
