-- Харденинг: handle_new_user() — триггер-функция, не должна вызываться напрямую через API.
-- Отзываем EXECUTE у anon/authenticated (триггер продолжает работать — он не зависит от гранта роли).
-- Закрывает security-advisors 0028/0029 (SECURITY DEFINER function executable via /rest/v1/rpc).
revoke execute on function public.handle_new_user() from anon, authenticated, public;
