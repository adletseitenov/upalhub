-- Ужесточение RLS exam_profiles: прямой PostgREST-доступ анон-ключом не должен
-- позволять чужой created_by, самоверификацию trust или смену slug.

drop policy "exam profiles authenticated insert" on public.exam_profiles;
create policy "exam profiles authenticated insert" on public.exam_profiles
  for insert with check (auth.uid() is not null and created_by = auth.uid());

drop policy "exam profiles creator update" on public.exam_profiles;
create policy "exam profiles creator update" on public.exam_profiles
  for update using (created_by = auth.uid()) with check (created_by = auth.uid());

-- Клиентские роли могут менять только контентные колонки; trust/slug/created_by — нет.
revoke update on public.exam_profiles from anon, authenticated;
grant update (spec, sources, origin, title, language) on public.exam_profiles to authenticated;
