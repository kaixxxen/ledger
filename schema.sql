-- 1. Create split_groups table
create table if not exists public.split_groups (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  emoji text default '👥' not null,
  invite_code text unique not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. Create group_members table (links users to groups)
create table if not exists public.group_members (
  id uuid default gen_random_uuid() primary key,
  group_id uuid references public.split_groups(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  display_name text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  unique(group_id, user_id)
);

-- 3. Create group_expenses table
create table if not exists public.group_expenses (
  id uuid default gen_random_uuid() primary key,
  group_id uuid references public.split_groups(id) on delete cascade not null,
  title text not null,
  amount numeric(10,2) not null check (amount > 0),
  paid_by_name text not null,
  paid_by_user_id uuid references auth.users(id) on delete cascade,
  date date not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 4. Create ledger_data table for personal user sync
create table if not exists public.ledger_data (
  user_id uuid references auth.users(id) on delete cascade primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on all tables
alter table public.split_groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_expenses enable row level security;
alter table public.ledger_data enable row level security;

-- Policies for split_groups
create policy "Users can view groups" on public.split_groups
  for select using (auth.role() = 'authenticated');

create policy "Users can create split groups" on public.split_groups
  for insert with check (auth.role() = 'authenticated');

create policy "Members can update group details" on public.split_groups
  for update using (
    exists (
      select 1 from public.group_members m 
      where m.group_id = public.split_groups.id and m.user_id = auth.uid()
    )
  );

-- Policies for group_members
create policy "Members can view member list" on public.group_members
  for select using (
    group_id in (select m.group_id from public.group_members m where m.user_id = auth.uid())
  );

create policy "Users can join groups" on public.group_members
  for insert with check (auth.uid() = user_id);

-- Policies for group_expenses
create policy "Members can view expenses" on public.group_expenses
  for select using (
    exists (
      select 1 from public.group_members m 
      where m.group_id = public.group_expenses.group_id and m.user_id = auth.uid()
    )
  );

create policy "Members can add expenses" on public.group_expenses
  for insert with check (
    exists (
      select 1 from public.group_members m 
      where m.group_id = public.group_expenses.group_id and m.user_id = auth.uid()
    )
  );

create policy "Members can update expenses" on public.group_expenses
  for update using (
    exists (
      select 1 from public.group_members m 
      where m.group_id = public.group_expenses.group_id and m.user_id = auth.uid()
    )
  );

create policy "Members can delete expenses" on public.group_expenses
  for delete using (
    exists (
      select 1 from public.group_members m 
      where m.group_id = public.group_expenses.group_id and m.user_id = auth.uid()
    )
  );

-- Policies for ledger_data
create policy "Users can view their own ledger" on public.ledger_data
  for select using (auth.uid() = user_id);

create policy "Users can create their own ledger" on public.ledger_data
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own ledger" on public.ledger_data
  for update using (auth.uid() = user_id);

-- Enable Supabase Realtime
begin;
  drop publication if exists supabase_realtime;
  create publication supabase_realtime for table public.split_groups, public.group_members, public.group_expenses;
commit;