# Этап 0 — разблокировка последних 2 пунктов DoD (5 минут кликов)

Код, миграции, страницы и тесты готовы (23 теста, CI зелёный). Остались действия,
привязанные к аккаунтам основателя. После них агент доводит этап 0 сам.

## 1. Supabase (~3 мин)

1. supabase.com/dashboard → переключатель организаций (слева сверху) → **New organization**
   (план Free; в организации Foustie у вас нет прав — нужна своя).
2. **New project**: имя `upal`, регион Frankfurt (eu-central-1), сгенерировать пароль БД (сохранить).
3. Authentication → Sign In / Up → Email: включить; в шаблоне письма должен быть `{{ .Token }}`.
4. Прислать агенту одно из двух:
   - **Вариант A (без браузера, быстрее)**: access token `sbp_...`
     (dashboard/account/tokens → Generate new token) + **Project ref**
     (Settings → General) + **anon key** (Settings → API Keys).
   - **Вариант B**: просто написать «supabase готов» — агент запустит
     `npx supabase login`, откроется браузер, подтвердите вход.

Дальше агент сам: `link` → `db push` (миграции уже в repo) → `gen types` → e2e OTP.

## 2. Vercel (~2 мин)

1. vercel.com → Sign Up / Login через GitHub (`adletseitenov`), план Hobby (бесплатный).
2. Прислать одно из двух:
   - **Вариант A**: токен с vercel.com/account/tokens.
   - **Вариант B**: написать «vercel готов» — агент запустит `npx vercel login`.

Дальше агент сам: `link` → env-переменные → `deploy --prod` → подключение Git-интеграции.

## Что произойдёт после разблокировки (остаток плана)

- Task 3: линк проекта, `.env.local`, регенерация типов БД.
- Task 4+7: `npx supabase db push` — обе миграции уже проверены на встраиваемом Postgres.
- Task 5: e2e-проверка входа по email-коду на живом Supabase.
- Task 10: прод-деплой, env в Vercel, финальный verify OTP на прод-URL.

Если доступы появятся нескоро — можно снять цель (`/goal clear`) и поставить её заново
одной строкой, когда всё будет: «доведи этап 0: docs/superpowers/plans/2026-07-05-stage-0-foundation.md, осталось 3–5, 7, 10».
