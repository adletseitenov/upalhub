-- Stage 5 Task 1 (D7): аддитивный фундамент интервью-подхода (study_hqs.approach)
-- и кэша микро-объяснений тем (topic_explanations). Дословно из плана
-- docs/superpowers/plans/2026-07-09-stage-5-interview-workspace-speaking.md,
-- секция D7.

alter table public.study_hqs add column approach jsonb;
alter table public.study_hqs add constraint study_hqs_approach_is_object
  check (approach is null or jsonb_typeof(approach) = 'object');

create table public.topic_explanations (
  id uuid primary key default gen_random_uuid(),
  exam_profile_id uuid not null references public.exam_profiles(id),
  topic text not null,
  locale text not null,
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  created_at timestamptz not null default now(),
  unique (exam_profile_id, topic, locale)
);
alter table public.topic_explanations enable row level security;
create policy "topic explanations readable" on public.topic_explanations
  for select using (true);
create policy "topic explanations insert by hq owner" on public.topic_explanations
  for insert with check (
    auth.uid() is not null
    and exists (select 1 from public.study_hqs h
                where h.exam_profile_id = topic_explanations.exam_profile_id
                  and h.user_id = auth.uid())
  );
-- 🔴 путь коррекции (красная команда): без DELETE отравленная строка вечна.
create policy "topic explanations delete by hq owner" on public.topic_explanations
  for delete using (
    exists (select 1 from public.study_hqs h
            where h.exam_profile_id = topic_explanations.exam_profile_id
              and h.user_id = auth.uid())
  );
