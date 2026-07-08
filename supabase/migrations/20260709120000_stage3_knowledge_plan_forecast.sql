-- Stage 3 Task 1 (D7): аддитивный фундамент карты знаний/плана/прогноза.
-- Ровно 7 стейтментов из плана, дословно.

alter table public.knowledge_states add column answered_count int not null default 0;
alter table public.knowledge_states add column last_seen_at timestamptz;
alter table public.study_plan_weeks add constraint study_plan_weeks_hq_week_unique unique (hq_id, week_start);
create index forecasts_hq_created_idx on public.forecasts (hq_id, created_at desc);
alter table public.forecasts add column point numeric;          -- 🔴 колонки point НЕТ в схеме
alter table public.forecasts add column coverage numeric;       -- 🔴 для истории/отладки
alter table public.study_hqs add column last_recomputed_at timestamptz;  -- 🔴 watermark
