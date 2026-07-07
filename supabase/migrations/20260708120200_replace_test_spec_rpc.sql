-- D5/D7/Task5: атомарная замена tests.spec ТОЛЬКО при нуле попыток
-- (TOCTOU-фикс красной команды — проверка "нет attempts" и запись spec в
-- одном SQL-стейтменте, а не select-then-update из JS). security invoker:
-- RLS применяется от имени вызывающего — policy "own tests" на
-- public.tests уже `for all` (покрывает update), отдельная update-policy
-- не нужна (проверено в core_schema.sql: 20260705120100_core_schema.sql).
-- Возвращает true, если строка обновлена; NULL/false, если попытка(и) уже
-- существуют (UPDATE не находит подходящей строки — RETURNING даёт 0 строк,
-- SQL-функция с несет-возвращающим телом возвращает NULL в этом случае).

create or replace function public.replace_test_spec_if_no_attempts(p_test_id uuid, p_spec jsonb)
returns boolean language sql security invoker as $$
  update public.tests t set spec = p_spec
  where t.id = p_test_id
    and not exists (select 1 from public.attempts a where a.test_id = p_test_id)
  returning true;
$$;
