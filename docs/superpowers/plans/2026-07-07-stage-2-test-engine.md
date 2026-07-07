# U-Pal Stage 2 — Universal Test Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** По любому профилю экзамена собирается и проходится тест: LLM-генерация заданий с кэшем в общий банк, прохождение с таймером/автосейвом/resume, детерминированный скоринг в шкале экзамена, импорт готовых заданий.

**Architecture:** Дизайн выработан мульти-агентным workflow (3 линзы: экономика LLM / UX ученика / корректность+универсальность → судья-синтез). Чистое доменное ядро (схемы заданий, грейдер, шкала) без единого импорта LLM/сети/Supabase; сервисы над DI-интерфейсами репозиториев; тонкие API-роуты по паттерну этапа 1; UI — нейтральный каркас. Генерация ленивая, батчевая, с жёстким капом стоимости. Всё замороженное (tests.spec со снапшотом шкалы) — детерминизм даже после refine профиля.

**Tech Stack:** уже в репо: Next.js 16 (App Router, `proxy.ts`-конвенция), zod 4, vitest + fakes, `lib/llm` (OpenRouter, gemini-2.5-flash), Supabase (RLS), next-intl RU/KK, Playwright не подключён (e2e — curl/ручной чеклист).

**Мастер-план:** [2026-07-05-u-pal-mvp-roadmap.md](2026-07-05-u-pal-mvp-roadmap.md) (задачи 2.1–2.5) · **Дизайн-синтез:** workflow wf_2fa48ff0-226 (журнал в сессии)

## Global Constraints

- Никаких констант конкретного экзамена в коде — всё из `exam_profiles.spec` и `tests.spec`; fallback на каждое опциональное поле спеки.
- LLM только через `src/lib/llm`; юнит-тесты — только `fakeLlm`/fake-репо, без сети. **Скоринг и грейдинг — НОЛЬ LLM всегда.**
- Каждый LLM-выход валидируется zod; невалидные элементы батча дропаются, дефицит добирается ровно ОДНИМ ретраем; graceful degrade (короче тест, не падение).
- Жёсткий cap: ≤3 LLM-вызова на один запрос сборки теста (`maxDuration=60`).
- **`tasks.answer` НИКОГДА не попадает на клиент**: страницы/роуты прохождения селектят body без answer; грейдинг только на сервере. (RLS select using(true) на tasks остаётся — airtight-split отложен, см. Deferrals.)
- Сервер — единственный источник истины по времени: дедлайн = `started_at + spec.totalTimeMinutes`; клиентский таймер косметический.
- i18n RU/KK на каждом новом экране; ключи локалей идентичны (пиннится тестом).
- Дизайн-нейтральный Tailwind; дизайн делает партнёр.
- После каждой задачи: `npm test && npm run typecheck && npm run lint` → commit → `git push origin main` (автодеплой Vercel).
- Перед началом: `git pull origin main`.

## Архитектурные решения (ОБЯЗАТЕЛЬНЫЕ — исполнители следуют им дословно)

### D1. Задание: экзаменная таксономия + грейдинг-формат

`tasks.type` (колонка) = экзаменная таксономия из `spec.sections[].taskTypes` (напр. «reading_comprehension») — по ней матчатся бакеты сборки. Грейдинг-формат — дискриминант ВНУТРИ `body`/`answer`:

```ts
// src/features/tasks/schema.ts (zod, формы точные)
format: "single_choice" | "multi_choice" | "text_input"

taskBodySchema = discriminatedUnion("format", [
  { format: "single_choice"|"multi_choice", prompt: string.min(1), passage?: string, options: [{ id: string, text: string }].min(2) },
  { format: "text_input", prompt, passage?, inputKind: "number"|"string" },
])
taskAnswerSchema = discriminatedUnion("format", [
  { format: "single_choice", correctOptionId: string },
  { format: "multi_choice", correctOptionIds: string[].min(1) },
  { format: "text_input", accepted: string[].min(1), caseSensitive: boolean.default(false), tolerance?: number },
])
taskResponseSchema = discriminatedUnion("format", [   // то, что шлёт клиент; answer клиенту не течёт
  { format: "single_choice", optionId: string|null },
  { format: "multi_choice", optionIds: string[] },
  { format: "text_input", value: string|null },
])
// Кросс-рефайнменты (superRefine на паре body+answer): answer.format === body.format;
// correctOptionId ∈ options[].id; correctOptionIds ⊆ options[].id.
```

`gradeAnswer(body, answer, response): boolean` — чистая: single = точный id; multi = set-equality; text_input = нормализация (`trim` + collapse spaces + lower если `!caseSensitive`; для `inputKind==='number'` — parseFloat с поддержкой десятичной ЗАПЯТОЙ, сравнение `|v−x| <= (tolerance ?? 0)` c каждым accepted) и membership. `null`/mismatch → `false`. Эссе/спикинг/аудио — вне MVP (недетерминируемый грейдинг = LLM на каждый сабмит).

### D2. Генерация: лениво, батчами, с капом

Только внутри сборки, только на дефицит бакета. Один `llm.complete` на бакет со схемой `z.array(genTaskSchema).min(1).max(10)` (genTask = body+answer+explanation обязателен+difficulty). Overshoot: добивать батч до 10 даже при меньшем дефиците (банк греется). Промпт строится ТОЛЬКО из спеки: examName, `spec.language` (язык контента!), section.name, topic, difficulty, type. Дедуп: `content_hash = sha256(normalized(prompt) + sorted(options[].text))`; вставка с `origin='ai'`, `hub_id=null`; 23505 → skip. Стоимость: холодная диагностика ≤3 вызова; тёплая — 0 (тест с `fakeLlm([])` это пиннит).

### D3. Сборка: buildPlan → select → generate → freeze

`buildPlan(spec, kind)`: бакеты `{sectionName, type (из taskTypes, fallback "single_choice"-семантика по умолчанию), topic (из topics, fallback [section.name]), difficulty-band, count}`. Квоты: `diagnostic` = breadth по всем секциям, cap **12 заданий суммарно**; `practice` = `section.taskCount ?? 8`; `mock` = полный `taskCount`. Толерантность: отсутствие topics/taskTypes/taskCount/timeLimit НЕ роняет сборку.
`assembleTest`: select банка по бакет-индексу → дефицит → D2 (cap 3 вызова) → re-select → distinct taskIds → insert `tests` c замороженным spec:

```ts
// tests.spec (zod: src/features/tests/spec.ts)
{ version: 1, kind: "diagnostic"|"practice"|"mock", language: string,
  sections: [{ name: string, taskIds: string[] }], taskIds: string[],  // плоский канонический порядок
  totalTimeMinutes?: number,
  scoringSnapshot: { scaleMin: number, scaleMax: number, unit: string, passingScore?: number|null, step?: number|null } }
```

### D4. Попытка: без новых колонок, сервер-авторитарное время

Статус деривируется: `finished_at IS NULL` = открыта. Одна открытая на `(test_id, user_id)` — partial unique; двойной старт/F5 → 23505 → перечитать (паттерн study_hqs/repo.ts). `deadlineAt = started_at + spec.totalTimeMinutes` (null = без таймера). Автосейв: upsert `attempt_items (attempt_id, task_id) → answer(=response json), time_ms, is_correct=NULL`. Resume: открытая попытка + body задач (без answer) + сохранённые items. Submit: guard `finished_at IS NULL`, идемпотентен (повтор → готовый результат); грейд КАЖДОГО taskId из spec (неотвеченные → строка `answer null, is_correct=false`) — контракт карты знаний этапа 3; после дедлайна — финализация строго по сохранённому, без бонус-времени.

### D5. Скоринг: линейно + step + clamp, по снапшоту

`raw = count(is_correct)`, `total = spec.taskIds.length`. `scaleScore(raw, total, snap)`: `scaleMin + (raw/total)*(scaleMax−scaleMin)` → округление к `step` (default: `unit==="band"` ? 0.5 : 1) → clamp. Фикстуры: ЕНТ {0..140}: 14/20→98; IELTS {0..9, band}: 15/20→6.5. `passingScore` — только дисплей. В `exam-profile/spec.ts` добавить ОПЦИОНАЛЬНОЕ `scoring.step` (аддитивно, старые профили парсятся). UI помечает балл «приблизительный».

### D6. Импорт JSON (путь ENTprep)

`parseImport(json)` → `{valid: NewTask[], errors: [{index, message}]}` (реюз taskSchema); `importTasks` → insert `origin='import'` + content_hash-идемпотентность → `{inserted, skippedDuplicates, rejected}`. Роут gated на `exam_profiles.created_by` (403 иначе). CSV — вне MVP.

### D7. Миграция (одна, аддитивная) + ВАЖНО

```sql
-- supabase/migrations/20260707130000_stage2_tasks_engine.sql
alter table public.tasks add column content_hash text;
create unique index tasks_profile_hash_unique on public.tasks (exam_profile_id, content_hash) where content_hash is not null;
create index tasks_bucket_idx on public.tasks (exam_profile_id, type, topic, difficulty);
create unique index attempts_one_open_per_test on public.attempts (test_id, user_id) where finished_at is null;
create index attempt_items_task_idx on public.attempt_items (task_id);
```

НОЛЬ изменений RLS, ноль новых таблиц. `database.types.ts` регенерируется после `db push` — **но db push этапа 1 ещё не сделан**: до него типы дополнить вручную минимально (content_hash) или регенерировать связкой обеих волн миграций, когда появится sbp/Дияр. `migrations.test.ts` (PGlite) обязан прогонять новую миграцию и ассертить 4 индекса.

**Поправка контроллера к синтезу:** судья предложил «создать root middleware» — он УЖЕ существует: `src/proxy.ts` (конвенция Next 16, session refresh с этапа 0). Задача 6 его НЕ создаёт — только проверяет и пишет route-тесты.

---

## Задачи (порядок исполнения; Files/Deliverable/Acceptance обязательны)

### Task 1: Доменное ядро — схемы заданий + грейдер + шкала (чистое, TDD)

**Files:** Create `src/features/tasks/schema.ts`, `src/features/tasks/schema.test.ts`, `src/features/tasks/grade.ts`, `src/features/tasks/grade.test.ts`, `src/features/tests/scoring.ts`, `src/features/tests/scoring.test.ts`; Modify `src/features/exam-profile/spec.ts` (+`scoring.step` optional) и `spec.test.ts` (+тест step-дефолта).
**Produces:** `taskBodySchema/taskAnswerSchema/taskResponseSchema` + `validateTaskPair(body, answer)` (кросс-рефайнменты), `type TaskBody/TaskAnswer/TaskResponse/NewTask{type,topic,difficulty,language,body,answer,explanation}`, `gradeAnswer(body, answer, response): boolean`, `scaleScore(raw: number, total: number, snap: ScoringSnapshot): number`, `scoringSnapshotSchema`.
**Acceptance:** все 3 формата грейдятся по D1 (set-equality multi; text: caseSensitive, запятая-как-точка, tolerance; unanswered→false; mismatch пар отвергает zod); scaleScore: фикстуры ЕНТ 14/20→98 и IELTS 15/20→6.5, all-correct→scaleMax, all-unanswered→scaleMin, clamp; существующие профили парсятся (step optional). НОЛЬ импортов llm/сети/supabase в этих файлах. TDD: RED→GREEN в отчёте.
**Notes:** главный риск — нормализация text_input для RU/KZ (десятичная запятая, множественные пробелы): покрыть тестами сразу.

### Task 2: Миграция stage2 + репозиторий банка задач (TDD через PGlite)

**Files:** Create `supabase/migrations/20260707130000_stage2_tasks_engine.sql` (SQL из D7 дословно), `src/features/tasks/repo.ts`; Modify `src/lib/db/migrations.test.ts` (ассерты 4 новых индексов + insert-конфликт по content_hash), `src/lib/supabase/database.types.ts` (добавить `content_hash: string | null` в tasks Row/Insert/Update вручную — регенерация после db push).
**Produces:** `interface TaskBankRepo { findBucket(profileId, type, topic, difficulty, limit): Promise<StoredTask[]>; insertMany(tasks: NewTask[] & {contentHash}): Promise<{inserted: StoredTask[], skipped: number}> }`, `supabaseTaskRepo(client): TaskBankRepo` (23505→skip, rowToTask с zod-парсом body/answer, паттерн exam-profile/repo.ts), `contentHash(body): string` (sha256, node:crypto).
**Acceptance:** PGlite-тест: миграция применяется, 4 индекса существуют (pg_indexes), повторная вставка same hash не дублирует; rowToTask отвергает мусорный jsonb; RLS-набор не изменён.

### Task 3: Батчевая генерация (ценовое ядро, TDD)

**Files:** Create `src/features/tasks/generate.ts`, `src/features/tasks/generate.test.ts`.
**Produces:** `generateForBucket(deps: {llm: Llm, repo: TaskBankRepo}, examSpec: ExamProfileSpec, bucket: Bucket): Promise<StoredTask[]>` — по D2: один complete на батч `z.array(genTaskSchema).min(1).max(10)`, genTask с обязательным explanation, drop-invalid + 1 ретрай на дефицит, overshoot до 10, insert origin='ai', graceful degrade.
**Acceptance:** fakeLlm: батч 10 = РОВНО один вызов; невалидный элемент → дроп, дефицит → ровно один ретрай; тёплый банк → `fakeLlm([])` не тронут; недобор после ретрая → частичный результат без throw; промпт содержит spec.language и не содержит экзаменных констант кода.

### Task 4: Сборка теста + freeze testSpec (TDD)

**Files:** Create `src/features/tests/spec.ts`, `spec.test.ts`, `src/features/tests/assemble.ts`, `assemble.test.ts`, `src/features/tests/repo.ts`.
**Produces:** `testSpecSchema` (D3 дословно), `buildPlan(spec: ExamProfileSpec, kind): Bucket[]` (квоты D3, fallbacks), `assembleTest(deps: {taskRepo, testRepo, llm}, args: {hqId, examProfile: StoredExamProfile, kind}): Promise<StoredTest>` (cap 3 генвызова, distinct taskIds, freeze scoringSnapshot из профиля), `interface TestRepo { insertTest(hqId, kind, spec): Promise<StoredTest>; getTest(id): Promise<StoredTest|null> }` + supabase impl.
**Acceptance:** фикстуры ЕНТ (points) и IELTS (band) собираются одним код-путём; diagnostic cap 12 суммарно; спека без topics/taskTypes/taskCount не роняет; ни один taskId не повторён; предзасеянный fake-банк → `fakeLlm([])`; snapshot скопирован на момент сборки (последующее изменение профиля не влияет).

### Task 5: Жизненный цикл попытки (TDD)

**Files:** Create `src/features/attempts/service.ts`, `service.test.ts`, `src/features/attempts/repo.ts`.
**Produces:** `startAttempt(deps, {testId, userId})` (идемпотентный: 23505→reread открытой), `computeDeadline(spec, startedAt): Date|null`, `saveAnswers(deps, {attemptId, userId, items: [{taskId, response, timeMs}]})` (batch upsert, is_correct=NULL, guard: только открытая своя попытка, taskId ∈ spec.taskIds), `submitAttempt(deps, {attemptId, userId})` → `{raw, scaled, total}` по D4/D5 (идемпотентный; строка на КАЖДЫЙ taskId; экспирация без бонуса), `interface AttemptRepo` + supabase impl (upsert attempt_items).
**Acceptance:** на fake-репо: resume отдаёт сохранённые ответы; двойной старт = та же попытка; двойной сабмит = тот же результат; сабмит после дедлайна финализирует по persisted; скоринг совпадает с фикстурами Task 1; неотвеченные записаны с is_correct=false.

### Task 6: API-роуты + rate limit + route-тесты (закрытие бэклога этапа 1)

**Files:** Create `src/app/api/tests/route.ts` (POST {hqId, kind} → assembleTest; maxDuration=60; rate-limited), `src/app/api/attempts/route.ts` (POST {testId} → startAttempt → {attemptId, deadlineAt, spec-без-answers}), `src/app/api/attempts/[id]/items/route.ts` (PATCH автосейв), `src/app/api/attempts/[id]/submit/route.ts` (POST), `src/lib/rate-limit.ts` + `rate-limit.test.ts` (in-memory token bucket per-user: napр. 5 сборок/10 мин), route-тесты `src/app/api/tests/route.test.ts` + `src/app/api/attempts/route.test.ts` (моки supabaseServer/сервисов — первые route-level тесты 401/400/403/404/429 в репо).
**Consumes:** паттерн auth→zod→сервис→`{error: snake_case}` из `src/app/api/exam-profiles/route.ts`; hq-принадлежность проверяется через study_hqs (свой hq) перед сборкой.
**Acceptance:** без сессии 401 на всех; кривое тело 400; чужой hq/attempt 403/404; превышение лимита 429; ответы роутов НИКОГДА не содержат `answer` (тест на shape); `src/proxy.ts` существует и не тронут (session refresh уже есть — НЕ создавать middleware). Плюс: создать `docs/decisions/trust-promotion.md` с открытым вопросом основателю (см. Open Questions) и вариантами — решение НЕ принимать.

### Task 7: UI прохождения + запуск из штаба (RU/KK)

**Files:** Create `src/app/(app)/hq/[hqId]/tests/[testId]/page.tsx` (server: getTest + body задач БЕЗ answer + открытая попытка + deadlineAt), `TestRunner.tsx` (client: пер-формат инпуты, debounce ~1.5с автосейв + flush на blur/visibilitychange, косметический countdown от deadlineAt с пересчётом на focus, автосабмит при нуле), `GeneratingState.tsx`, `ResultView.tsx` (шкала/unit из snapshot, «приблизительно», переживает null passingScore); Create `src/components/start-test-button.tsx` (client: POST /api/tests {hqId, kind:'diagnostic'} → POST /api/attempts → push на страницу теста; busy-состояние «Собираем тест… до минуты»); Modify `src/app/(app)/hq/page.tsx` (кнопка «Пройти диагностику» у каждого экзамена — **дополнение контроллера: без точки запуска движок недостижим из UI**); Modify `messages/ru.json` + `kk.json` (namespace `testRunner`, `testResult`, ключи кнопок; паритет!).
**Acceptance:** ручной чеклист на живом Supabase: старт диагностики из /hq → GeneratingState → тест открылся; F5 посреди теста сохраняет ответы и остаток времени; ответы отсутствуют в network-ответах и props (проверка DevTools/curl); сабмит → результат в шкале экзамена; RU/KK переключается; i18n-паритет зелёный; чистая логика (debounce/оставшееся время) вынесена в функции с юнит-тестами, компоненты не тестируются (конвенция).

### Task 8: Импорт JSON заданий (TDD)

**Files:** Create `src/features/tasks/import.ts`, `import.test.ts`, `src/app/api/exam-profiles/[id]/tasks/import/route.ts`, route-тест.
**Produces:** `parseImport(json: unknown): {valid: NewTask[], errors: [{index, message}]}` (реюз schema Task 1), `importTasks(deps: {repo}, profileId, tasks): Promise<{inserted, skippedDuplicates, rejected}>`; роут: auth → 403 не-создателю профиля → отчёт.
**Acceptance:** валидные строки попадают в банк и в сборку с `fakeLlm([])` (0 LLM — acceptance 2.5); невалидные отвергнуты с index+message; реимпорт файла = 0 новых; не-создатель 403; прогнан на сэмпле из 5+ заданий формата ЕНТ (сочинить в тесте).
**Notes:** задача независима от 5–7 — можно выполнить раньше для сидинга банка под ручной чеклист Task 7.

---

## Definition of Done (этап 2)

1. Юнит- и route-тесты этапа зелёные (без сети), CI зелёный; общее число тестов заметно выросло (>70).
2. На проде: пользователь жмёт «Пройти диагностику» у экзамена в штабе → тест в формате экзамена (≤12 заданий, секции из профиля) → таймер → сабмит → балл в шкале экзамена («приблизительно»). Холодный профиль ≤3 LLM-вызова, тёплый — 0.
3. F5/закрытие вкладки посреди теста не теряет ответы; двойной старт не создаёт вторую попытку; двойной сабмит не меняет результат.
4. `attempt_items` содержит строку на каждый taskId завершённой попытки (вход этапа 3).
5. Ответы заданий не наблюдаемы клиентом ни в одном ответе API/props.
6. Импорт JSON кладёт задания в банк без LLM; повторный импорт идемпотентен.
7. Rate limit на сборке: 429 при злоупотреблении; route-тесты 401/400/403/404/429 в репо.
8. Одна аддитивная миграция готова; PGlite-тест ассертит индексы. (Применение на живой БД — вместе с волной этапа 1, когда будет sbp/Дияр; прод-фичи этапа 2 до db push НЕ анонсировать: unique-гарантии попыток зависят от индекса.)

## Open Questions (основателю, не блокируют)

1. Trust → data_refined: критерий повышения (после refine создателем? после N успешных попыток?) — зафиксировать в docs/decisions/trust-promotion.md.
2. Диагностика cap 12: достаточно для стартовой карты знаний этапа 3 или поднимаем ценой ожидания/стоимости?
3. Band-экзамены: линейная шкала + пометка «приблизительно» — ок до появления официальных таблиц конверсии?

## Deferrals (осознанно отложено)

task_answers-split (airtight ответы) → перед платными mock; CSV; нелинейные шкалы (bands lookup); секционные таймеры (enforcement); фоновый pre-warm; адаптивная сборка/IRT и запись knowledge_states → этап 3; UI импорта и модерация банка → этап 4; semantic-дедуп; анти-чит/partial credit/веса; durable rate limit (Redis/таблица); эссе/спикинг и любой LLM-грейдинг.
