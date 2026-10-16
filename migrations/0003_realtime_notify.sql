-- Change notifications for the Realtime compat endpoint. A row trigger on each watched table sends a small NOTIFY on
-- channel `wishme_changes` with the table, the operation, the primary key and the filter columns the app subscribes
-- with. No other row data leaves the database this way. Writes made by Supabase (proxied routes, old edge functions)
-- fire the same triggers, so subscribers see every change during the migration.

create or replace function wishme.notify_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  rec   jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  picks jsonb := '{}'::jsonb;
  col   text;
begin
  foreach col in array tg_argv loop
    if rec ? col then
      picks := picks || jsonb_build_object(col, rec -> col);
    end if;
  end loop;
  perform pg_notify('wishme_changes', jsonb_build_object(
    't', tg_table_name,
    'op', tg_op,
    'id', rec -> 'id',
    'f', picks,
    'ts', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  )::text);
  return null;
end $$;

revoke all on function wishme.notify_change() from public;

do $$
declare
  watch record;
begin
  for watch in
    select * from (values
      ('profiles',            array['id']),
      ('bookings',            array['user_id', 'celebrity_id']),
      ('music_generations',   array['user_id']),
      ('wish_friend_orders',  array['user_id']),
      ('image_promotions',    array['celebrity_id', 'user_id']),
      ('celebrity_favorites', array['celebrity_id', 'user_id']),
      ('conversations',       array['celebrity_id', 'user_id']),
      ('messages',            array['conversation_id'])
    ) as w(tbl, cols)
  loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = watch.tbl) then
      execute format('drop trigger if exists wishme_notify_change on public.%I', watch.tbl);
      execute format(
        'create trigger wishme_notify_change after insert or update or delete on public.%I '
        'for each row execute function wishme.notify_change(%s)',
        watch.tbl,
        (select string_agg(quote_literal(c), ', ') from unnest(watch.cols) c)
      );
    else
      raise notice 'realtime: table public.% not found, trigger skipped', watch.tbl;
    end if;
  end loop;
end $$;
