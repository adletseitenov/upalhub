-- Stage 2: task bank content-hash dedup + bucket lookup + attempt invariants.
-- Аддитивная миграция: ноль изменений RLS, ноль новых таблиц (D7).

alter table public.tasks add column content_hash text;
create unique index tasks_profile_hash_unique on public.tasks (exam_profile_id, content_hash) where content_hash is not null;
create index tasks_bucket_idx on public.tasks (exam_profile_id, type, topic, difficulty);
create unique index attempts_one_open_per_test on public.attempts (test_id, user_id) where finished_at is null;
create index attempt_items_task_idx on public.attempt_items (task_id);
