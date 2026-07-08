-- ПРИМЕНЯТЬ только после деплоя кода с supabaseAdmin (src/lib/supabase/admin.ts)
-- И добавления SUPABASE_SECRET_KEY в Vercel env — иначе грейдинг/сборка тестов
-- сломаются (весь серверный код работает через supabaseServer(), anon key +
-- сессия = роль authenticated, у которой после этой миграции нет select на
-- tasks.answer/tasks.explanation).
--
-- D-security1 (mega-review wave): tasks readable using(true) — намеренно
-- (банк общий), но Supabase-платформа даёт anon/authenticated SELECT на ВСЕ
-- колонки таблицы по умолчанию (как и exam_profiles до миграции
-- 20260707120000). Без колоночного grant прямой PostgREST-запрос
-- (GET /tasks?select=id,answer,explanation, публичный anon-ключ) отдаёт
-- правильный ответ и объяснение до сдачи попытки — полный обход грейдинга.
-- Row-policy using(true) остаётся (банк общий по дизайну); сужаем только
-- набор читаемых колонок.
revoke select on public.tasks from anon, authenticated;
grant select (
  id, exam_profile_id, hub_id, type, topic, difficulty, language, body, origin, created_at, content_hash
) on public.tasks to anon, authenticated;
