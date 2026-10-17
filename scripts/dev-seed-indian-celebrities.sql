-- Local development catalogue: well-known Indian celebrities with public facts only (name, field, city, short bio) and
-- NO photos, so the app shows their initials. None of them has signed up to WishMe: every row is marked
-- verification_status = 'consent_pending'. consent_status is 'approved' only so the app lists them for testing.
-- NEVER migrate rows with verification_status = 'consent_pending' to production.
--
-- Also removes the AI-generated and stock photos that came with the migrated catalogue (all but the two signed-up
-- clients, Navami Shetty and Hari Raj Shetty) and marks those stars consent_pending too.
-- Safe to run again: ids are derived from the name.

update public.celebrities
set image_url = null, video_thumbnail_url = null, verification_status = 'consent_pending'
where name in ('A.R. Rahman', 'Alia Bhatt', 'Deepika Padukone', 'Kareena Kapoor Khan', 'Katrina Kaif', 'MS Dhoni',
  'Pankaj Tripathi', 'Priyanka Chopra', 'Ranveer Singh', 'Sania Mirza', 'Shah Rukh Khan', 'Shreya Ghoshal',
  'Vicky Kaushal', 'Virat Kohli', 'Zakir Khan');

with src (name, category, location, bio) as (values
  -- Hindi cinema
  ('Amitabh Bachchan', 'Actor', 'Mumbai', 'Veteran Hindi film actor and long-time host of the quiz show Kaun Banega Crorepati.'),
  ('Aamir Khan', 'Actor', 'Mumbai', 'Hindi film actor and producer known for Lagaan, 3 Idiots and Dangal.'),
  ('Salman Khan', 'Actor', 'Mumbai', 'Hindi film actor known for Bajrangi Bhaijaan and the Tiger films, and host of Bigg Boss.'),
  ('Hrithik Roshan', 'Actor', 'Mumbai', 'Hindi film actor and dancer known for Kaho Naa... Pyaar Hai, the Krrish films and War.'),
  ('Akshay Kumar', 'Actor', 'Mumbai', 'Hindi film actor known for action comedies and films such as Airlift and Pad Man.'),
  ('Ajay Devgn', 'Actor', 'Mumbai', 'Hindi film actor and director known for the Singham films and Drishyam.'),
  ('Ranbir Kapoor', 'Actor', 'Mumbai', 'Hindi film actor known for Barfi!, Sanju and Animal.'),
  ('Ayushmann Khurrana', 'Actor', 'Mumbai', 'Actor and singer known for Vicky Donor, Andhadhun and Badhaai Ho.'),
  ('Rajkummar Rao', 'Actor', 'Mumbai', 'Actor known for Shahid, Newton and Stree.'),
  ('Kartik Aaryan', 'Actor', 'Mumbai', 'Actor known for the Pyaar Ka Punchnama films and Bhool Bhulaiyaa 2.'),
  ('Varun Dhawan', 'Actor', 'Mumbai', 'Actor known for Badlapur, October and Bhediya.'),
  ('Madhuri Dixit', 'Actress', 'Mumbai', 'Actress and dancer known for Hum Aapke Hain Koun..! and Devdas.'),
  ('Kajol', 'Actress', 'Mumbai', 'Actress known for Dilwale Dulhania Le Jayenge and Kuch Kuch Hota Hai.'),
  ('Vidya Balan', 'Actress', 'Mumbai', 'Actress known for Kahaani, The Dirty Picture and Tumhari Sulu.'),
  ('Anushka Sharma', 'Actress', 'Mumbai', 'Actress and producer known for Rab Ne Bana Di Jodi, PK and Sultan.'),
  ('Kriti Sanon', 'Actress', 'Mumbai', 'Actress known for Bareilly Ki Barfi, Luka Chuppi and Mimi.'),
  ('Kiara Advani', 'Actress', 'Mumbai', 'Actress known for Kabir Singh and Shershaah.'),
  ('Shraddha Kapoor', 'Actress', 'Mumbai', 'Actress and singer known for Aashiqui 2 and Stree.'),
  ('Taapsee Pannu', 'Actress', 'Mumbai', 'Actress known for Pink, Thappad and Haseen Dillruba.'),
  ('Janhvi Kapoor', 'Actress', 'Mumbai', 'Actress known for Dhadak and Gunjan Saxena: The Kargil Girl.'),
  -- South Indian cinema
  ('Rajinikanth', 'Actor', 'Chennai', 'Tamil film star known for Baasha, Enthiran and Jailer.'),
  ('Prabhas', 'Actor', 'Hyderabad', 'Telugu film actor known for the Baahubali films and Kalki 2898 AD.'),
  ('Allu Arjun', 'Actor', 'Hyderabad', 'Telugu film actor known for Arya and the Pushpa films.'),
  ('Mahesh Babu', 'Actor', 'Hyderabad', 'Telugu film actor known for Pokiri and Srimanthudu.'),
  ('Ram Charan', 'Actor', 'Hyderabad', 'Telugu film actor known for Magadheera and RRR.'),
  ('N. T. Rama Rao Jr.', 'Actor', 'Hyderabad', 'Telugu film actor known for Temper and RRR.'),
  ('Yash', 'Actor', 'Bengaluru', 'Kannada film actor known for the K.G.F films.'),
  ('Rishab Shetty', 'Actor', 'Bengaluru', 'Kannada actor and director known for Kantara.'),
  ('Vijay', 'Actor', 'Chennai', 'Tamil film actor known for Ghilli, Mersal and Master.'),
  ('Mohanlal', 'Actor', 'Thiruvananthapuram', 'Malayalam film actor known for Drishyam and Lucifer.'),
  ('Dulquer Salmaan', 'Actor', 'Kochi', 'Actor in Malayalam, Tamil, Telugu and Hindi films, known for Charlie and Sita Ramam.'),
  ('Samantha Ruth Prabhu', 'Actress', 'Hyderabad', 'Actress in Telugu and Tamil films, known for Eega and The Family Man season 2.'),
  ('Rashmika Mandanna', 'Actress', 'Bengaluru', 'Actress known for Geetha Govindam and the Pushpa films.'),
  ('Nayanthara', 'Actress', 'Chennai', 'Tamil and Telugu film actress known for Raja Rani and Jawan.'),
  -- Cricket
  ('Sachin Tendulkar', 'Cricketer', 'Mumbai', 'Former India batsman and the leading run-scorer in international cricket.'),
  ('Rohit Sharma', 'Cricketer', 'Mumbai', 'India opening batsman and the only player with three double centuries in ODIs.'),
  ('Jasprit Bumrah', 'Cricketer', 'Ahmedabad', 'India fast bowler known for his unusual action and yorkers.'),
  ('Hardik Pandya', 'Cricketer', 'Vadodara', 'India all-rounder: fast-bowling and big-hitting batting.'),
  ('Ravindra Jadeja', 'Cricketer', 'Jamnagar', 'India all-rounder known for left-arm spin and fielding.'),
  ('Shubman Gill', 'Cricketer', 'Punjab', 'India top-order batsman.'),
  ('KL Rahul', 'Cricketer', 'Bengaluru', 'India batsman and wicketkeeper.'),
  ('Smriti Mandhana', 'Cricketer', 'Sangli', 'India women''s team opening batter.'),
  ('Mithali Raj', 'Cricketer', 'Hyderabad', 'Former India women''s captain and the leading run-scorer in women''s international cricket.'),
  -- Other sports
  ('Neeraj Chopra', 'Athlete', 'Panipat', 'Javelin thrower and Olympic gold medallist at Tokyo 2020.'),
  ('P. V. Sindhu', 'Badminton Player', 'Hyderabad', 'Badminton world champion (2019) and two-time Olympic medallist.'),
  ('Saina Nehwal', 'Badminton Player', 'Hyderabad', 'Badminton player and Olympic bronze medallist (London 2012).'),
  ('Mary Kom', 'Boxer', 'Imphal', 'Six-time world champion boxer and Olympic bronze medallist (London 2012).'),
  ('Sunil Chhetri', 'Footballer', 'Bengaluru', 'Long-time India football captain and the team''s record goal-scorer.'),
  -- Music
  ('Arijit Singh', 'Singer', 'Murshidabad', 'Playback singer known for Tum Hi Ho and Channa Mereya.'),
  ('Sonu Nigam', 'Singer', 'Mumbai', 'Playback singer known for Kal Ho Naa Ho and Sandese Aate Hain.'),
  ('Sunidhi Chauhan', 'Singer', 'Mumbai', 'Playback singer known for Sheila Ki Jawani and Kamli.'),
  ('Neha Kakkar', 'Singer', 'Mumbai', 'Playback singer known for dance hits such as Dilbar and Aankh Marey.'),
  ('Shankar Mahadevan', 'Singer', 'Mumbai', 'Singer and composer, one third of the trio Shankar-Ehsaan-Loy.'),
  ('Armaan Malik', 'Singer', 'Mumbai', 'Singer known for Bol Do Na Zara and Main Rahoon Ya Na Rahoon.'),
  ('Diljit Dosanjh', 'Singer', 'Punjab', 'Punjabi singer and actor known for Udta Punjab and his world tours.'),
  ('Badshah', 'Rapper', 'Delhi', 'Rapper and music producer known for DJ Waley Babu and Genda Phool.'),
  -- Comedy and creators
  ('Kapil Sharma', 'Comedian', 'Mumbai', 'Comedian and host of The Kapil Sharma Show.'),
  ('Bhuvan Bam', 'Content Creator', 'Delhi', 'YouTuber behind BB Ki Vines and actor in Taaza Khabar.'),
  ('CarryMinati', 'Content Creator', 'Faridabad', 'YouTuber (Ajey Nagar) known for roast and comedy videos.'),
  ('Prajakta Koli', 'Content Creator', 'Mumbai', 'YouTuber (MostlySane) and actress in Mismatched.')
),
ins as (
  insert into public.celebrities (id, name, category, location, bio, is_verified, is_active, verification_status,
    consent_status, delivery_time)
  select md5('wishme-dev-celebrity:' || name)::uuid, name, category, location, bio, true, true, 'consent_pending',
    'approved', '24-48 hours'
  from src
  on conflict (id) do update set category = excluded.category, location = excluded.location, bio = excluded.bio,
    is_active = true, verification_status = 'consent_pending'
  returning id
)
insert into public.celebrity_favorite_pricing (celebrity_id, price, is_enabled)
select id, 999, true from ins
where not exists (select 1 from public.celebrity_favorite_pricing p where p.celebrity_id = ins.id);
