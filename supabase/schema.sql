-- Orbit Escape competitive leaderboard schema.
--
-- Security model: the client NEVER writes directly to active_runs or runs, even for its own
-- rows. Every authoritative state change goes through a protected Edge Function running as
-- service_role (which bypasses RLS by design in Supabase). RLS on these two tables grants
-- authenticated/anon nothing at all -- not even SELECT, since reads go through the read-only
-- views below (owned by the migration-running role, e.g. postgres, which is why those views
-- can see through the RLS lock without granting clients any direct table access). This file is
-- meant to be run once, in the Supabase SQL editor (or `supabase db push`), against a freshly
-- created project.

-- ============================================================================================
-- profiles
-- ============================================================================================
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  display_name_normalized text generated always as (lower(trim(display_name))) stored,
  created_at timestamptz not null default now()
);

-- One row per authenticated identity; normalized name must be unique so nobody can register
-- two different-looking names that collide once trimmed/lowercased. Null display_name is
-- allowed (unset) and multiple nulls don't violate uniqueness (standard Postgres behavior).
create unique index if not exists profiles_display_name_normalized_key
  on profiles (display_name_normalized)
  where display_name_normalized is not null;

alter table profiles enable row level security;

-- A user may create their own profile row on first sign-in and update only their own
-- display_name -- nothing else about competitive integrity depends on this table, so this is
-- the one table where direct client writes to your OWN row are fine.
create policy "profiles: select all" on profiles for select using (true);
create policy "profiles: insert own" on profiles for insert with check (auth.uid() = id);
create policy "profiles: update own" on profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- ============================================================================================
-- active_runs -- one row per in-progress run, server-authoritative
-- ============================================================================================
create table if not exists active_runs (
  run_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  seed bigint not null,
  seed_date date not null,
  rules_version int not null,
  status text not null default 'active' check (status in ('active', 'finished', 'abandoned')),
  started_at timestamptz not null default now(),
  last_checkpoint_at timestamptz not null default now(),
  latest_score int not null default 0,
  latest_distance numeric not null default 0,
  finished_at timestamptz
);

-- Enforced at the database level, not just in application code: a user can only ever have one
-- row with status='active' at a time.
create unique index if not exists active_runs_one_active_per_user
  on active_runs (user_id)
  where status = 'active';

create index if not exists active_runs_live_lookup
  on active_runs (status, last_checkpoint_at)
  where status = 'active';

alter table active_runs enable row level security;
-- No policies granted to authenticated/anon at all -- default-deny. Every read goes through
-- live_board below (which runs with the view owner's privileges), and every write goes
-- through an Edge Function using the service_role key, which bypasses RLS entirely.

-- ============================================================================================
-- runs -- append-only ledger of finished, validated runs
-- ============================================================================================
create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  score int not null,
  duration_ms int not null,
  seed_date date not null,
  rules_version int not null,
  created_at timestamptz not null default now()
);

create index if not exists runs_user_score on runs (user_id, score desc);
create index if not exists runs_seed_date_score on runs (seed_date, score desc);

alter table runs enable row level security;
-- Same as active_runs: no client policies. daily_best / global_best below are the only
-- read path, and only finish-run (service_role) ever inserts here.

-- ============================================================================================
-- Read-only views -- the only way the client ever sees leaderboard data
-- ============================================================================================

-- Live board: anyone whose active run has checkpointed in the last 10 seconds. A disconnected
-- or killed client simply ages out of this view on its own -- no cleanup job required for
-- correctness (a periodic job to flip long-idle rows to 'abandoned' is a hygiene nice-to-have,
-- not load-bearing here).
create or replace view live_board as
select
  ar.run_id,
  ar.user_id,
  coalesce(p.display_name, 'Pilot') as name,
  ar.latest_score as score,
  ar.latest_distance as distance,
  ar.last_checkpoint_at
from active_runs ar
join profiles p on p.id = ar.user_id
where ar.status = 'active'
  and ar.last_checkpoint_at > now() - interval '10 seconds';

-- Daily best: one row per player, their single best finished run seeded today (server UTC
-- date), so nobody occupies multiple leaderboard slots.
create or replace view daily_best as
select distinct on (r.user_id)
  r.user_id,
  coalesce(p.display_name, 'Pilot') as name,
  r.score,
  r.created_at
from runs r
join profiles p on p.id = r.user_id
where r.seed_date = (now() at time zone 'utc')::date
order by r.user_id, r.score desc, r.created_at asc;

-- Global best: one row per player, their single best finished run of all time.
create or replace view global_best as
select distinct on (r.user_id)
  r.user_id,
  coalesce(p.display_name, 'Pilot') as name,
  r.score,
  r.created_at
from runs r
join profiles p on p.id = r.user_id
order by r.user_id, r.score desc, r.created_at asc;

grant select on live_board, daily_best, global_best to authenticated, anon;
