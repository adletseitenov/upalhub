-- Ядро домена U-Pal. Экзамен-агностично: вся специфика экзамена живёт в exam_profiles.spec.

create table public.families (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.family_members (
  family_id uuid not null references public.families(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  primary key (family_id, student_id)
);

create table public.exam_profiles (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  title text not null,
  language text not null,
  spec jsonb not null,
  sources jsonb not null default '[]',
  origin text not null check (origin in ('ai_research', 'uploaded', 'manual')),
  trust text not null default 'ai_draft' check (trust in ('ai_draft', 'data_refined', 'verified')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.hubs (
  id uuid primary key default gen_random_uuid(),
  exam_profile_id uuid not null references public.exam_profiles(id),
  owner_id uuid not null references public.profiles(id),
  title text not null,
  description text,
  origin_hub_id uuid references public.hubs(id),
  visibility text not null default 'draft' check (visibility in ('draft', 'public')),
  stars_count int not null default 0,
  created_at timestamptz not null default now()
);

create table public.hub_stars (
  hub_id uuid not null references public.hubs(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (hub_id, user_id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  exam_profile_id uuid not null references public.exam_profiles(id),
  hub_id uuid references public.hubs(id),
  type text not null,
  topic text not null,
  difficulty int not null,
  language text not null,
  body jsonb not null,
  answer jsonb not null,
  explanation text,
  origin text not null check (origin in ('ai', 'author', 'import')),
  created_at timestamptz not null default now()
);

create table public.study_hqs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  exam_profile_id uuid not null references public.exam_profiles(id),
  exam_date date,
  target text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table public.tests (
  id uuid primary key default gen_random_uuid(),
  hq_id uuid not null references public.study_hqs(id) on delete cascade,
  kind text not null check (kind in ('diagnostic', 'practice', 'mock')),
  spec jsonb not null,
  created_at timestamptz not null default now()
);

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  raw_score numeric,
  scaled_score numeric
);

create table public.attempt_items (
  attempt_id uuid not null references public.attempts(id) on delete cascade,
  task_id uuid not null references public.tasks(id),
  answer jsonb,
  is_correct boolean,
  time_ms int,
  primary key (attempt_id, task_id)
);

create table public.knowledge_states (
  hq_id uuid not null references public.study_hqs(id) on delete cascade,
  topic text not null,
  level numeric not null,
  updated_at timestamptz not null default now(),
  primary key (hq_id, topic)
);

create table public.study_plan_weeks (
  id uuid primary key default gen_random_uuid(),
  hq_id uuid not null references public.study_hqs(id) on delete cascade,
  week_start date not null,
  topics jsonb not null,
  status text not null default 'planned' check (status in ('planned', 'current', 'done'))
);

create table public.forecasts (
  id uuid primary key default gen_random_uuid(),
  hq_id uuid not null references public.study_hqs(id) on delete cascade,
  low numeric not null,
  high numeric not null,
  confidence text not null,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  plan text not null,
  status text not null,
  provider text,
  period_end timestamptz
);

create table public.parent_reports (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  student_id uuid not null references public.profiles(id),
  week_start date not null,
  body jsonb not null,
  sent_at timestamptz
);

-- RLS

alter table public.families enable row level security;
create policy "own family" on public.families
  for all using (parent_id = auth.uid()) with check (parent_id = auth.uid());

alter table public.family_members enable row level security;
create policy "family members readable by parent or student" on public.family_members
  for select using (
    student_id = auth.uid()
    or exists (select 1 from public.families f where f.id = family_id and f.parent_id = auth.uid())
  );
create policy "family members managed by parent" on public.family_members
  for insert with check (
    exists (select 1 from public.families f where f.id = family_id and f.parent_id = auth.uid())
  );
create policy "family members removable by parent" on public.family_members
  for delete using (
    exists (select 1 from public.families f where f.id = family_id and f.parent_id = auth.uid())
  );

alter table public.exam_profiles enable row level security;
create policy "exam profiles public read" on public.exam_profiles
  for select using (true);
create policy "exam profiles authenticated insert" on public.exam_profiles
  for insert with check (auth.uid() is not null);
create policy "exam profiles creator update" on public.exam_profiles
  for update using (created_by = auth.uid());

alter table public.hubs enable row level security;
create policy "hubs readable when public or own" on public.hubs
  for select using (visibility = 'public' or owner_id = auth.uid());
create policy "own hubs write" on public.hubs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.hub_stars enable row level security;
create policy "hub stars readable" on public.hub_stars
  for select using (true);
create policy "own hub stars" on public.hub_stars
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.tasks enable row level security;
create policy "tasks readable" on public.tasks
  for select using (true);
create policy "tasks authenticated insert" on public.tasks
  for insert with check (auth.uid() is not null);

alter table public.study_hqs enable row level security;
create policy "own hq" on public.study_hqs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.tests enable row level security;
create policy "own tests" on public.tests
  for all using (
    exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid())
  );

alter table public.attempts enable row level security;
create policy "own attempts" on public.attempts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.attempt_items enable row level security;
create policy "own attempt items" on public.attempt_items
  for all using (
    exists (select 1 from public.attempts a where a.id = attempt_id and a.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.attempts a where a.id = attempt_id and a.user_id = auth.uid())
  );

alter table public.knowledge_states enable row level security;
create policy "own knowledge states" on public.knowledge_states
  for all using (
    exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid())
  );

alter table public.study_plan_weeks enable row level security;
create policy "own plan weeks" on public.study_plan_weeks
  for all using (
    exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid())
  );

alter table public.forecasts enable row level security;
create policy "own forecasts" on public.forecasts
  for all using (
    exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid())
  ) with check (
    exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid())
  );

alter table public.subscriptions enable row level security;
create policy "own subscriptions" on public.subscriptions
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.parent_reports enable row level security;
create policy "parent reports for family parent" on public.parent_reports
  for select using (
    exists (select 1 from public.families f where f.id = family_id and f.parent_id = auth.uid())
  );
