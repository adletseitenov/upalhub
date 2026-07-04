# /goal промпт — этап 0 (Foundation)

Скопируйте блок ниже в Claude Code (через `/goal` или просто первым сообщением сессии), когда будете готовы начать строить.

---

```
/goal Построить этап 0 (Foundation) MVP U-Pal до полного Definition of Done.

КОНТЕКСТ
- Repo: C:\Users\adlet\OneDrive\Документы\upalhub (origin = github.com/adletseitenov/upalhub, ветка main).
- Прочитай перед началом, в этом порядке:
  1. docs/product-plan.md — спека продукта (v2, экзамен-агностик);
  2. docs/superpowers/plans/2026-07-05-u-pal-mvp-roadmap.md — мастер-план билда;
  3. docs/superpowers/plans/2026-07-05-stage-0-foundation.md — executable-план этапа 0. ЕГО И ВЫПОЛНЯЙ, задача за задачей (Task 1 → Task 10), отмечая чекбоксы.

КАК ВЫПОЛНЯТЬ
- Используй superpowers:executing-plans (или subagent-driven-development) — план уже написан, брейнштормить заново не нужно.
- ПОРЯДОК ПРИ БЛОКЕРАХ: если Supabase/Vercel ещё недоступны, сначала выполни всё, что от них не зависит: Task 1 → 2 → 6 (i18n) → 8 (llm) → 9 (search). Задачи 3–5, 7 (Supabase) и 10 (Vercel) выполняй, когда я скажу, что доступ появился. Auth-страницы Task 5 можно сверстать заранее — без живого Supabase они просто не проверяются end-to-end.
- TDD там, где план даёт тесты: сначала failing test, потом реализация.
- После каждой задачи: typecheck + lint + test зелёные → commit → git push origin main.
- Перед завершением этапа прогони verify: полный путь регистрации через email OTP на прод-URL.

ЖЁСТКИЕ ОГРАНИЧЕНИЯ
- Никаких констант конкретного экзамена в коде (экзамен-агностичность).
- LLM — ТОЛЬКО через адаптер src/lib/llm; единственный провайдер — OpenRouter. Прямой Claude API / Anthropic SDK НЕ подключать (решение основателя — экономия).
- Веб-поиск — только через адаптер src/lib/search.
- Все LLM-выходы валидируются zod (один ретрай с текстом ошибки).
- i18n RU/KZ на каждом экране; ключи локалей идентичны (пиннится тестом).
- ДИЗАЙН ДЕЛАЕТ ПАРТНЁР ОСНОВАТЕЛЯ: строй нейтральный функциональный каркас (простой Tailwind), НЕ выдумывай палитры, шрифты и декор — макеты придут позже и накатятся заменой токенов/стилей.
- Секреты не коммитить: .env.local в .gitignore, в репо только .env.example.
- Юнит-тесты не ходят в сеть — только fake-адаптеры.

БЛОКЕРЫ, ГДЕ НУЖЕН Я (спроси и жди)
- Supabase: логин CLI, project ref, anon key (Task 3).
- Vercel: логин CLI (Task 10).
- OPENROUTER_API_KEY и выбор LLM_MODEL (можно отложить — тесты работают на fake).
- TAVILY_API_KEY (можно отложить).

DEFINITION OF DONE (из плана этапа 0)
1. typecheck + lint + test + build зелёные локально и в CI.
2. Прод-URL на Vercel открывается; email OTP регистрация работает end-to-end; /hq защищён.
3. RU ↔ KZ переключается; тест паритета ключей зелёный.
4. Все таблицы ядра в Supabase с RLS; profiles создаётся триггером при регистрации.
5. createLlm/createSearch собираются из env; адаптеры покрыты тестами на fake.
```
