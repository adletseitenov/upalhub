-- D3/D7/Task5: «Не тот экзамен» — учёт репортов на профиль от юзера (reroll).
-- Один репорт на пару (профиль, юзер) — first-report-wins: повторный report
-- того же юзера на тот же отвергнутый профиль молча игнорируется (ON
-- CONFLICT DO NOTHING через upsert(..., {ignoreDuplicates: true}) на стороне
-- приложения) — НЕ обновляет уже сохранённую строку и не плодит новые.
-- 🔴 final-review Fix4: этот комментарий раньше говорил "обновляет (upsert)" —
-- неверно, поведение всегда было first-report-wins (см. api/exam-profiles/route.ts,
-- ignoreDuplicates: true); правка ТОЛЬКО комментария, миграция уже применена
-- к живой БД.
-- Только insert/select own; без update/delete-политик (D7 дословно) — apiшный
-- upsert на конфликт может не пройти RLS после первого report, это
-- best-effort и намеренно проглатывается роутом (см. api/exam-profiles/route.ts).

create table public.exam_profile_reports (
  id uuid primary key default gen_random_uuid(),
  reported_profile_id uuid not null references public.exam_profiles(id),
  user_id uuid not null references public.profiles(id),
  clarification text,
  new_slug text,
  created_at timestamptz not null default now(),
  unique (reported_profile_id, user_id)
);

alter table public.exam_profile_reports enable row level security;

create policy "own exam profile reports insert" on public.exam_profile_reports
  for insert with check (user_id = auth.uid());

create policy "own exam profile reports select" on public.exam_profile_reports
  for select using (user_id = auth.uid());
