-- Carnival Society International — vehicle donation retention log
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query) for the
-- carnivalsociety-members project. Standalone addition — does not modify schema.sql,
-- but depends on public.is_materials_owner() already existing from that file.

create type public.vehicle_status as enum ('retained', 'sold');

create table public.retained_vehicles (
  id uuid primary key default gen_random_uuid(),
  vehicle text not null,              -- year/make/model
  donor_name text not null,
  vin text,
  intended_use text not null,
  status public.vehicle_status not null default 'retained',
  retained_at date not null default current_date,
  sold_at date,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.retained_vehicles enable row level security;

-- readable by anyone signed in (the fiscal sponsor gets an account like any
-- member — this is the "visibility" half of the retention policy)
create policy "retained vehicles readable by members" on public.retained_vehicles
  for select using (auth.role() = 'authenticated');

-- writable only by the guild owner, same as materials_needed
create policy "retained vehicles managed by owner" on public.retained_vehicles
  for all using (public.is_materials_owner()) with check (public.is_materials_owner());
