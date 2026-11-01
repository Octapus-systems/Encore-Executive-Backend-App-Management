-- Live chauffeur positions (server/live.js). Run once in the Supabase SQL editor.
-- Same protection as the snapshot functions: only callers holding ENCORE_SYNC_SECRET.
create table if not exists public.encore_live_location (
  leg_id bigint primary key,
  driver_id bigint not null,
  lat double precision not null,
  lng double precision not null,
  heading real,
  speed real,
  accuracy real,
  updated_at timestamptz not null default now()
);
alter table public.encore_live_location enable row level security;
revoke all on public.encore_live_location from anon, authenticated;

create or replace function public.encore_loc_put(p_secret text, p_leg bigint, p_driver bigint, p_lat double precision, p_lng double precision, p_heading real, p_speed real, p_accuracy real)
returns void language plpgsql security definer set search_path to 'public', 'extensions' as $$
begin
  perform public.encore_check(p_secret);
  insert into public.encore_live_location (leg_id, driver_id, lat, lng, heading, speed, accuracy, updated_at)
  values (p_leg, p_driver, p_lat, p_lng, p_heading, p_speed, p_accuracy, now())
  on conflict (leg_id) do update set driver_id = excluded.driver_id, lat = excluded.lat, lng = excluded.lng,
    heading = excluded.heading, speed = excluded.speed, accuracy = excluded.accuracy, updated_at = now();
end $$;

create or replace function public.encore_loc_get(p_secret text, p_legs bigint[])
returns table (leg_id bigint, lat double precision, lng double precision, heading real, speed real, accuracy real, updated_at timestamptz)
language plpgsql security definer set search_path to 'public', 'extensions' as $$
begin
  perform public.encore_check(p_secret);
  return query select l.leg_id, l.lat, l.lng, l.heading, l.speed, l.accuracy, l.updated_at
    from public.encore_live_location l
    where l.leg_id = any (p_legs) and l.updated_at > now() - interval '10 minutes';
end $$;
