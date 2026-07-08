-- D-security6 (mega-review wave): "tasks ai insert by any authenticated"
-- (with check: auth.uid() is not null and origin = 'ai') был единственным
-- условием — exam_profile_id/body/answer/topic/type/difficulty оставались
-- полностью подконтрольны атакующему. Банк общий на exam_profile_id
-- (findBucket селектит по exam_profile_id/type/topic/difficulty, БЕЗ
-- owner/hub-фильтра, см. features/tasks/repo.ts) -> любой authenticated мог
-- прямым PostgREST-запросом вставить в ЧУЖОЙ exam_profile_id задание с
-- origin='ai' и заведомо неверным answer/explanation, отравив банк для всех
-- держателей штаба этого профиля.
--
-- Единственный легитимный caller AI-инсерта — assembleTest (сборка теста),
-- который ВСЕГДА действует от имени владельца study_hq для того же
-- exam_profile_id. Сужаем insert до этого отношения вместо голого origin='ai'.
drop policy "tasks ai insert by any authenticated" on public.tasks;
create policy "tasks ai insert by hq owner" on public.tasks
  for insert with check (
    auth.uid() is not null
    and origin = 'ai'
    and exists (
      select 1 from public.study_hqs h
      where h.exam_profile_id = tasks.exam_profile_id and h.user_id = auth.uid()
    )
  );
