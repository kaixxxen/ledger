-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- It creates one private row per user and makes sure people can only touch their own.

create table if not exists public.ledger_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.ledger_data enable row level security;

drop policy if exists "read own data"   on public.ledger_data;
drop policy if exists "insert own data" on public.ledger_data;
drop policy if exists "update own data" on public.ledger_data;
drop policy if exists "delete own data" on public.ledger_data;

create policy "read own data"   on public.ledger_data for select
  using ((select auth.uid()) = user_id);
create policy "insert own data" on public.ledger_data for insert
  with check ((select auth.uid()) = user_id);
create policy "update own data" on public.ledger_data for update
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "delete own data" on public.ledger_data for delete
  using ((select auth.uid()) = user_id);
