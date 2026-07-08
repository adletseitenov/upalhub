-- Backlog wave (mega-review minors): "exam profiles authenticated insert"
-- (row check: auth.uid() is not null and created_by = auth.uid()) не
-- порезан на уровне грантов колонок — как и `tasks`/`update` ранее
-- (20260707120000, 20260709140000), Supabase платформенным дефолтом даёт
-- anon/authenticated INSERT на ВСЕ колонки. Row-policy не проверяет trust,
-- поэтому любой authenticated мог вставить exam_profiles строку с
-- trust='verified' напрямую через PostgREST, минуя AI-контур (create/refine
-- всегда пишет trust через default 'ai_draft', см. core_schema.sql).
--
-- Применять вместе с волной 20260709130000/20260709140000 (tasks
-- column-level security wave) — тот же паттерн column-level revoke/grant.
-- Колонки перечислены по database.types.ts (все, кроме id/created_at/trust):
-- slug, title, language, spec, sources, origin, created_by.
revoke insert on public.exam_profiles from anon, authenticated;
grant insert (slug, title, language, spec, sources, origin, created_by)
  on public.exam_profiles to authenticated;
