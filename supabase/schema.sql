-- Supabase SQL Editor에서 실행하세요. 사용자 데이터는 본인 계정만 조회/수정할 수 있습니다.
create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  study_date date not null default current_date,
  subject text not null,
  study_type text not null,
  minutes integer not null check (minutes > 0),
  memo text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.travel_routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  route text not null,
  minutes integer not null check (minutes > 0),
  note text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.study_courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  title text not null,
  total_lectures integer not null check (total_lectures > 0),
  completed_lectures integer not null default 0 check (completed_lectures >= 0 and completed_lectures <= total_lectures),
  created_at timestamptz not null default now()
);

alter table public.study_sessions enable row level security;
alter table public.travel_routes enable row level security;
alter table public.study_courses enable row level security;

create policy "Users manage their study sessions"
  on public.study_sessions for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users manage their travel routes"
  on public.travel_routes for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users manage their study courses"
  on public.study_courses for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
