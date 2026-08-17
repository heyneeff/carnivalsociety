-- SUPERSEDED — this Supabase draft was never what's actually deployed. The
-- live members app runs on a Cloudflare Worker + D1, not Supabase. See
-- worker/migrations/ for the real schema. Kept for history only.

-- Carnival Society International — members app schema
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query) for the
-- carnivalsociety-members project. Safe to re-run top to bottom on a fresh project.

-- ============================================================
-- CHAPTERS
-- ============================================================
create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now()
);

insert into public.chapters (name, slug) values
  ('Boulder', 'boulder'),
  ('Denver', 'denver'),
  ('Los Angeles', 'los-angeles');

-- ============================================================
-- PROFILES — one row per auth.users, created on signup
-- ============================================================
create type public.guild_rank as enum ('apprentice', 'journeyman', 'master');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  home_chapter_id uuid references public.chapters(id),
  rank public.guild_rank not null default 'apprentice',
  is_ringleader boolean not null default false,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- rank and is_ringleader are earned, not self-granted — any update coming from
-- the client is silently reverted unless the requester is already a Ringleader
-- (or it's the dashboard / service role).
create or replace function public.is_ringleader_user(uid uuid)
returns boolean as $$
  select exists (select 1 from public.profiles where id = uid and is_ringleader = true);
$$ language sql security definer stable;

create or replace function public.protect_profile_privileged_fields()
returns trigger as $$
begin
  if auth.role() <> 'service_role' and not public.is_ringleader_user(auth.uid()) then
    new.rank := old.rank;
    new.is_ringleader := old.is_ringleader;
  end if;
  return new;
end;
$$ language plpgsql security definer;

create trigger protect_profile_privileged_fields
before update on public.profiles
for each row execute function public.protect_profile_privileged_fields();

-- auto-create a profile row when someone signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- reusable check: is this user a Master or a Ringleader (moderation rights)
create or replace function public.is_moderator(uid uuid)
returns boolean as $$
  select exists (
    select 1 from public.profiles
    where id = uid and (rank = 'master' or is_ringleader = true)
  );
$$ language sql security definer stable;

-- ============================================================
-- BOARDS — one guild-wide board (chapter_id null) + one per chapter
-- ============================================================
create table public.boards (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid references public.chapters(id), -- null = guild-wide
  name text not null,
  slug text not null unique,
  description text,
  created_at timestamptz not null default now()
);

insert into public.boards (chapter_id, name, slug, description) values
  (null, 'Guild Hall', 'guild-hall', 'Guild-wide — open to every member, any chapter.'),
  ((select id from public.chapters where slug = 'boulder'), 'Boulder', 'boulder', 'Boulder chapter board.'),
  ((select id from public.chapters where slug = 'denver'), 'Denver', 'denver', 'Denver chapter board.'),
  ((select id from public.chapters where slug = 'los-angeles'), 'Los Angeles', 'los-angeles', 'Los Angeles chapter board.');

-- ============================================================
-- POSTS — top-level posts have title set, replies set parent_id instead
-- ============================================================
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  parent_id uuid references public.posts(id) on delete cascade,
  title text,
  body text not null,
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================
-- DIRECT MESSAGES
-- ============================================================
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table public.conversation_participants (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (conversation_id, user_id)
);

create table public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);

-- security-definer helper to avoid recursive-RLS issues on conversation_participants
create or replace function public.is_conversation_participant(conv_id uuid, uid uuid)
returns boolean as $$
  select exists (
    select 1 from public.conversation_participants
    where conversation_id = conv_id and user_id = uid
  );
$$ language sql security definer stable;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.chapters enable row level security;
alter table public.profiles enable row level security;
alter table public.boards enable row level security;
alter table public.posts enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.direct_messages enable row level security;

-- chapters: publicly readable (needed on the sign-up form, before login exists)
create policy "chapters publicly readable" on public.chapters
  for select using (true);

-- profiles: readable by anyone signed in; editable by the owner (their own
-- display_name/chapter/avatar — rank/is_ringleader are protected by the trigger
-- above) or by a Ringleader editing anyone's row (rank/permissions management)
create policy "profiles readable by members" on public.profiles
  for select using (auth.role() = 'authenticated');
create policy "profiles editable by owner" on public.profiles
  for update using (id = auth.uid());
create policy "profiles editable by ringleaders" on public.profiles
  for update using (public.is_ringleader_user(auth.uid()));

-- boards: readable by anyone signed in (chapter is a label, not a wall — welcome
-- anywhere); creating/editing/deleting boards is a moderator action
create policy "boards readable by members" on public.boards
  for select using (auth.role() = 'authenticated');
create policy "boards managed by moderators" on public.boards
  for all using (public.is_moderator(auth.uid())) with check (public.is_moderator(auth.uid()));

-- posts: readable by anyone signed in; anyone can post; authors edit/delete their
-- own posts; moderators (Masters, Ringleaders) can edit/delete (and pin) any post
create policy "posts readable by members" on public.posts
  for select using (auth.role() = 'authenticated');
create policy "posts insertable by author" on public.posts
  for insert with check (author_id = auth.uid());
create policy "posts editable by author" on public.posts
  for update using (author_id = auth.uid());
create policy "posts deletable by author" on public.posts
  for delete using (author_id = auth.uid());
create policy "posts moderatable" on public.posts
  for all using (public.is_moderator(auth.uid())) with check (public.is_moderator(auth.uid()));

-- conversations + participants: visible only to participants
create policy "conversations visible to participants" on public.conversations
  for select using (public.is_conversation_participant(id, auth.uid()));
create policy "conversations insertable by members" on public.conversations
  for insert with check (auth.role() = 'authenticated');

create policy "participants visible to co-participants" on public.conversation_participants
  for select using (public.is_conversation_participant(conversation_id, auth.uid()));
create policy "participants insertable by members" on public.conversation_participants
  for insert with check (auth.role() = 'authenticated');

-- direct messages: only participants can read or send
create policy "dms visible to participants" on public.direct_messages
  for select using (public.is_conversation_participant(conversation_id, auth.uid()));
create policy "dms insertable by participants" on public.direct_messages
  for insert with check (
    sender_id = auth.uid()
    and public.is_conversation_participant(conversation_id, auth.uid())
  );

-- ============================================================
-- EVENTS — publicly readable (shown on the marketing homepage, no login),
-- managed only by Masters and Ringleaders
-- ============================================================
create table public.events (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid references public.chapters(id), -- null = guild-wide
  title text not null,
  description text,
  location text,
  starts_at timestamptz not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.events enable row level security;

create policy "events publicly readable" on public.events
  for select using (true);
create policy "events managed by moderators" on public.events
  for all using (public.is_moderator(auth.uid())) with check (public.is_moderator(auth.uid()));

-- ============================================================
-- MATERIALS NEEDED — Guild Hall right-column list. Readable by every
-- signed-in member; editable only by the guild owner specifically (not
-- any Ringleader — see is_materials_owner below).
-- ============================================================
create table public.materials_needed (
  id uuid primary key default gen_random_uuid(),
  item text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.materials_needed enable row level security;

-- security definer runs with this function's owner's privileges (whoever
-- runs this migration in the SQL editor), which is how it's allowed to
-- read auth.users — the authenticated/anon roles can't query that table
-- directly. The email is baked in at migration time, not read per-request.
create or replace function public.is_materials_owner()
returns boolean as $$
  select auth.uid() = (select id from auth.users where email = 'heyneeff@gmail.com' limit 1);
$$ language sql stable security definer;

create policy "materials needed readable by members" on public.materials_needed
  for select using (auth.role() = 'authenticated');
create policy "materials needed managed by owner" on public.materials_needed
  for all using (public.is_materials_owner()) with check (public.is_materials_owner());
