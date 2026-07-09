-- Stage 5 Task 1 (D7): аддитивный фундамент спикинг-грейдинга (attempt_items
-- score/feedback) + приватный Storage-бакет для аудио-записей. Дословно из
-- плана docs/superpowers/plans/2026-07-09-stage-5-interview-workspace-speaking.md,
-- секция D7 (attempt_items часть); Storage часть в плане была наброском
-- ("insert into storage.buckets; create policy ... using (auth.uid()::text =
-- (storage.foldername(name))[1])") — здесь дописана как реально исполняемый
-- SQL, обёрнутый DO-блоком: storage.* существует только на платформе
-- Supabase, не в чистом Postgres/PGlite (см. migrations.test.ts — эта часть
-- там документированно пропускается), поэтому блок no-op локально и в тестах
-- и реально создаёт бакет+политики на проде.

alter table public.attempt_items add column score numeric;
alter table public.attempt_items add column feedback jsonb;
alter table public.attempt_items add constraint attempt_items_feedback_is_object
  check (feedback is null or jsonb_typeof(feedback) = 'object');

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'storage' and table_name = 'buckets'
  ) then
    insert into storage.buckets (id, name, public)
    values ('speaking-recordings', 'speaking-recordings', false)
    on conflict (id) do nothing;

    -- owner-only: path convention {user_id}/{attempt_id}/{task_id} (D4) — first
    -- path segment is the owning user's id.
    create policy "speaking recordings insert by owner" on storage.objects
      for insert with check (
        bucket_id = 'speaking-recordings'
        and auth.uid()::text = (storage.foldername(name))[1]
      );

    create policy "speaking recordings select by owner" on storage.objects
      for select using (
        bucket_id = 'speaking-recordings'
        and auth.uid()::text = (storage.foldername(name))[1]
      );
  end if;
end $$;
