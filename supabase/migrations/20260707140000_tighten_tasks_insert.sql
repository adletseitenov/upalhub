-- Банк заданий: вставлять может только создатель профиля экзамена
-- (роуты и так гейтят; это закрывает прямой PostgREST-обход анон-ключом).
drop policy "tasks authenticated insert" on public.tasks;
create policy "tasks insert by profile creator" on public.tasks
  for insert with check (
    auth.uid() is not null
    and exists (
      select 1 from public.exam_profiles p
      where p.id = exam_profile_id and p.created_by = auth.uid()
    )
  );

-- Серверная ai-генерация (сборка теста) вставляет tasks через
-- supabase-клиент С СЕССИЕЙ ТЕКУЩЕГО ПОЛЬЗОВАТЕЛЯ, а не создателя профиля —
-- прогрев чужого профиля иначе сломался бы политикой выше. origin='ai'
-- формируется только нашим серверным кодом (generate.ts), body не приходит
-- от клиента напрямую — poisoning-вектор (произвольный origin='import'/
-- 'manual' в чужой профиль) закрыт первой политикой.
create policy "tasks ai insert by any authenticated" on public.tasks
  for insert with check (auth.uid() is not null and origin = 'ai');
