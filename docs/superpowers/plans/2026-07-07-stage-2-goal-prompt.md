# /goal промпт — этап 2 (Universal Test Engine)

Скопируйте блок ниже в `/goal`.

---

```
Построить этап 2 U-Pal (универсальный движок тестов) до полного Definition of Done, задачами-субагентами.

КОНТЕКСТ
- Repo: C:\Users\adlet\OneDrive\Документы\upalhub (origin = github.com/adletseitenov/upalhub, main; Vercel автодеплой с пуша).
- ПЕРЕД началом: git pull origin main (Дияр коммитит из своей сессии).
- Выполняй план: docs/superpowers/plans/2026-07-07-stage-2-test-engine.md — Task 1 → Task 8 по порядку (Task 8 можно раньше 5–7 для сидинга банка). Раздел «Архитектурные решения D1–D7» ОБЯЗАТЕЛЕН дословно — это синтез мульти-агентного дизайна, не пересматривать.

КАК ВЫПОЛНЯТЬ
- superpowers:subagent-driven-development: свежий исполнитель на задачу + ревьюер на задачу + финальное whole-branch ревью (модель посильнее). Леджер: .superpowers/sdd/progress.md (продолжить существующий, секция stage 2).
- TDD везде, где логика (Task 1-6, 8): RED→GREEN с доказательствами в отчёте.
- После каждой задачи: npm test && npm run typecheck && npm run lint зелёные → commit → git push origin main.
- Модели исполнителей: haiku для транскрипции по точным схемам, sonnet для интеграционных (4-7); ревьюеры sonnet; финал — fable/opus.

ЖЁСТКИЕ ОГРАНИЧЕНИЯ (дублируют план)
- Экзамен-агностичность: всё из exam_profiles.spec / tests.spec, fallback на каждое опциональное поле.
- LLM только src/lib/llm; юнит-тесты на fakes без сети; СКОРИНГ И ГРЕЙДИНГ — НОЛЬ LLM.
- ≤3 LLM-вызова на сборку теста; тёплый банк = 0 (пиннится тестом fakeLlm([])).
- tasks.answer НИКОГДА не течёт на клиент (ни в API-ответах, ни в props).
- Дедлайн попытки авторитетен на сервере; идемпотентность: старт, сабмит, импорт.
- i18n RU/KK, паритет ключей; нейтральный Tailwind (дизайн — у партнёра).
- src/proxy.ts уже существует (session refresh) — middleware НЕ создавать.
- Секреты в .env.local; ключи уже там (OpenRouter+gemini-2.5-flash, Tavily, Supabase).

БЛОКЕРЫ, ГДЕ НУЖЕН ОСНОВАТЕЛЬ (спроси и жди)
- db push миграций (этап 1 ×2 + этап 2 ×1) — нужен sbp_-токен или Дияр; до него: database.types.ts дополнять вручную, unique-гарантии попыток на живой БД не активны — прод-анонс фич этапа 2 не делать.
- Ответы на Open Questions плана (trust-критерий, cap диагностики, band-шкалы) — не блокируют, фиксировать варианты в docs/decisions/.

DEFINITION OF DONE — раздел «Definition of Done (этап 2)» плана, все 8 пунктов. Прод-часть пункта 2 проверяется после db push; остальное — полностью.

ПОСЛЕ КАЖДОЙ КРУПНОЙ ВЕХИ: запись в C:\Users\adlet\OneDrive\Документы\Projects\upal\Журнал вех.md (правило AGENTS.md).
```
