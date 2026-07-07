# U-Pal Stage 2.5 — Interview Onboarding, Honest Engine, Audio (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Закрыть фидбэк основателя с прода: AI-интервью при создании штаба (выбор варианта/профильных, дата), «Не тот экзамен» с уточнением, честная сборка (нет пустых секций, «Дособрать»), привязка заданий к секции, работающее аудио для listening (браузерный TTS), качество генерации измеряется eval-судьёй.

**Architecture:** Дизайн — мульти-агентный workflow (3 линзы → судья) + **красная команда из 3 адверсариальных критиков** (16 находок интегрированы в задачи, критические — обязательны). Всё аддитивно: спека профиля получает `modality`/`variants[]`/`selectionGroups[]` с **superRefine-целостностью** (референс по имени секции, chooseCount выполним, имена уникальны); выбор ученика — `study_hqs.config` jsonb; единственная точка истины «config→секции» — чистый `resolveActiveSections` (тотальный: устаревший config деградирует, не 500). Интервью — **0 LLM-вызовов** (шаги строятся из данных). Аудио — Web Speech API: чистая логика в `speech.ts`, транскрипт скрыт в попытке, первоклассный фолбэк.

**Tech Stack:** как этап 2 (Next 16, zod 4, vitest+fakes, lib/llm OpenRouter gemini-2.5-flash, Supabase RLS, next-intl RU/KK).

**Основа:** дизайн-синтез wf_dbcedef6-a69 + красная команда wf_a7e3accd-880 (журналы в сессии). Мастер-план: этап 3 НЕ съедаем (карта знаний/план/прогноз — там; визард расширяем его шагами позже).

## Global Constraints

- Экзамен-агностичность: ноль экзаменных констант; каждое опциональное поле спеки с fallback.
- LLM только `src/lib/llm`; интервью-шаги — НОЛЬ LLM; research/reroll/сборка — только по явному действию юзера и под лимитером.
- **Каждый LLM-роут — с rate limiter'ом** (красная команда: /api/exam-profiles сегодня без лимитера — критично).
- Аддитивность: старые профили/штабы/тесты живут без изменений (регресс-тесты на старых фикстурах); `sections[]` не переструктурируем — референсы только по `name`; стабильность topic-строк = инвариант этапа 3.
- `tasks.answer` не течёт клиенту (инвариант этапа 2). Скрытие транскрипта — честный формат, НЕ анти-чит (passage в props неизбежен для клиентского TTS — фиксируется комментарием).
- Замороженность spec: **мутация tests.spec допустима ТОЛЬКО атомарно при нуле попыток** (RPC с проверкой в одном стейтменте — TOCTOU-фикс красной команды).
- i18n RU/KK паритет (пиннится тестом); нейтральный Tailwind; тексты для партнёра-дизайнера собраны в Open Questions.
- После каждой задачи: `npm test && npm run typecheck && npm run lint` (+`npm run build` для роутов/страниц) → commit → push (автодеплой). Перед началом: `git pull origin main`.
- Миграции на живую БД применяю я (контроллер) через Management API после ревью задачи; `database.types.ts` — вручную в том же коммите.

## Архитектурные решения (ОБЯЗАТЕЛЬНЫЕ; 🔴 = фикс красной команды)

### D1. Интервью-визард (0 LLM)

`/onboarding/[slug]` (app, auth): server page грузит профиль по slug, safeParse (провал → notFound), строит шаги детерминированно `buildOnboardingSteps(spec)`: **confirm** (всегда: карточка экзамена, «Да, мой экзамен» / «Не тот экзамен») → **variant** (iff `variants.length>0`: radio) → **selection** (iff `selectionGroups.length>0`: чекбоксы «выбери ровно chooseCount», группы фильтруются пересечением с выбранным вариантом; 🔴 если пул < chooseCount — группа деградирует: авто-включение всех доступных, форма не блокируется) → **date** (всегда, пропускаемый). Прогресс «Шаг X из N». IELTS-путь = confirm+date.
🔴 Финиш и reroll — `router.replace` (не push). 🔴 Server-guard: у юзера уже есть hq на этот профиль → redirect `/hq`. 🔴 Busy-lock на reroll и finish (`if (busy) return`). 🔴 Черновик выбора — localStorage по ключу slug (восстановление после закрытия вкладки).
Входы: `ExamSearchForm` после research → `/onboarding/[slug]`; `PrepareButton` → `router.push('/onboarding/[slug]')` (не POST). Публичная страница `/exams/[slug]` остаётся библиотечной.
Финал: `POST /api/study-hqs {examProfileId, config?, examDate?}` (老 body валиден) → validateHqConfig → 422 `invalid_config`; существующий активный hq → UPDATE (`existed:true`); 🔴 examDate НЕ включается в UPDATE, если шаг даты пропущен (částичный patch — не обнулять дату). → `/hq`.

### D2. Модель данных (аддитивно + целостность)

`src/features/exam-profile/spec.ts`:
```ts
sectionModalitySchema = z.enum(["text", "audio"]);
examSectionSchema += modality: sectionModalitySchema.nullish();          // absent = text
examVariantSchema = { key: min1, label: min1, sectionNames: string[].min(1) };
selectionGroupSchema = { key, title, chooseCount: int positive, sectionNames: string[].min(2) };
examProfileSpecSchema += variants: array(examVariantSchema).default([]),
                         selectionGroups: array(selectionGroupSchema).default([]);
// 🔴 superRefine (целостность — LLM-выход с нарушением НЕ сохраняется, адаптер ретраит):
//  (a) sections[].name уникальны (закрывает и Minor этапа 2 про дубли);
//  (b) variants[].sectionNames ⊆ sections[].name; selectionGroups[].sectionNames ⊆ sections[].name;
//  (c) chooseCount <= |group.sectionNames|; и для каждого варианта, пересекающегося с группой:
//      |group ∩ variant| >= chooseCount ИЛИ группа не входит в вариант целиком (см. D1 деградацию).
```
`src/features/exam-profile/selection.ts` (NEW, pure): `hqConfigSchema = { variantKey: nullish, selectedSectionNames: string[].default([]) }`; `resolveActiveSections(spec, config)` — 🔴 **тотальная**: variantKey не найден → база все секции; несуществующие selectedSectionNames дропаются; config null/{} → все секции (legacy); `validateHqConfig(spec, config)` → `{ok} | {ok:false, error}`. Потребители: buildPlan/assembleTest сейчас, карта знаний этапа 3 потом.
`src/features/tests/spec.ts`: `testSectionSchema += plannedCount: int nonneg nullish, modality: nullish`.
`study_hqs.config` jsonb not null default '{}' (+check jsonb_typeof='object'); `exam_date` уже есть.

### D3. «Не тот экзамен» (reroll)

Расширение `POST /api/exam-profiles`: body `{query, excludeSlug?, clarification? (3..200)}` — старый body валиден. 🔴 **Rate limiter на роуте** (общий для research/reroll): capacity 3 / 10 мин per user, ДО любого спенда, 429 `{error:"rate_limited"}` + route-тест. Reroll: avoid из отвергнутого профиля (`name`,`country`) → строка в research-промпт «пользователь уточнил, что это НЕ …»; `refinedQuery = query + " " + clarification` (без LLM-парса); slug-guard: `newSlug === excludeSlug` → суффикс `-x<sha256(clarification).hex.slice(0,6)>`; коллизия с ДРУГИМ слагом → dedup вернёт существующий (0 LLM, ок). Insert в `exam_profile_reports` (🔴 unique(reported_profile_id, user_id) — one report per user per profile, upsert-latest). Ответ `{slug, created}`; ResearchError → 404.

### D4. Многовариантные экзамены

Один профиль/slug, mega-спека: research SYSTEM_PROMPT учит выделять `variants[]` (взаимоисключающие наборы секций; общие секции — в нескольких вариантах), `selectionGroups[]` (ровно N из M), `modality: "audio"` только для аудирования. Graceful degrade: плоский ответ без variants валиден. 🔴 research `maxTokens: 8_000 → 24_000` (mega-спека НИШ на кириллице не влезает в 8k — тот же инцидент, что у generation). Фикстуры (fake llm+search): НИШ → variants≥2; ЕНТ → selectionGroups chooseCount=2; IELTS → variants=[], Listening.modality='audio'.

### D5. Честная сборка + «Дособрать»

`assembleTest` args += `hqConfig`; `activeSections = resolveActiveSections(...)`; 🔴 в POST /api/tests и refill — `validateHqConfig`; провал → 422 `{error:"reconfigure_needed"}` (UI ведёт в /onboarding). Бакеты перед генерацией — **round-robin по секциям** (кап ≤3 распределяется, лечит пустой Reading); 🔴 ротация старта: offset = `refillCount % буккетов` (`testSpec.refillCount: int nullish`, ++ при каждой пересборке) — хвостовые секции получают шанс. Заморозка `plannedCount` (Σ bucket.count секции, **по индексу секции**, не по имени) и `modality`. `partial = Σactual < Σplanned`.
UI: TestRunner фильтрует пустые секции (все пустые → баннер, не фейк); server page: баннер «собран частично N из M» + RefillButton (только partial && attempt===null); 🔴 после пересборки без прогресса (actual не вырос) — баннер «дособрать не удалось, попробуйте позже», кнопка скрыта (сравнение через refillCount+actual в spec).
`POST /api/tests/[testId]/refill`: auth→владение→404/403 → reassembleTest (свежий кап ≤3) → 🔴 **атомарная замена**: RPC `replace_test_spec_if_no_attempts(p_test_id, p_spec)` (SQL: `UPDATE tests SET spec=$2 WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM attempts WHERE test_id=$1)` RETURNING; 0 строк → 409 `attempt_exists`). Общий лимитер сборки `src/features/tests/assembly-limiter.ts` (один инстанс на /api/tests и refill) → 429.

### D6. Качество генерации + привязка к секции

`Bucket += modality, sectionTopics: string[], sectionTaskTypes: string[]` (in-memory). Промпт: блок привязки («задание принадлежит секции X, темы секции: …; ЗАПРЕЩЕНО задания из других разделов») + для `modality==='audio'`: «body.passage ОБЯЗАТЕЛЕН: транскрипт 80–150 слов; вопрос проверяет понимание СОДЕРЖАНИЯ». Enforcement: audio-элемент с passage <50 символов дропается (добор существующим retry, кап не растёт). Ноль exam-if.

### D7. Миграции (аддитивные)

`20260708120000_study_hqs_config.sql` — config jsonb not null default '{}' + check. `20260708120100_exam_profile_reports.sql` — таблица + RLS insert/select own, 🔴 unique(reported_profile_id, user_id), без update/delete. `20260708120200_replace_test_spec_rpc.sql` — 🔴 RPC атомарной замены (security invoker; RLS tests уже гейтит по hq). Свалку НИШ не трогаем (правильная версия — новым слагом через reroll); database.types.ts вручную.

### D8. Аудио (Web Speech, MVP)

По аудио-дизайну красной команды (полный текст в wf_a7e3accd-880):
- `src/features/attempts/speech.ts` (pure, 0 DOM): `primarySubtag`, `pickVoice(voices, language)` (primary-subtag match; приоритет localService→default→localeCompare; нет → null), `resolveCapability(supported, voices, lang)` → `speak|fallback(unsupported|no_voice)`, `chunkText(text, maxChars=200)` (сентенс-сплит + hard-split; лечит Chrome ~15с обрыв).
- `useSpeechSynthesis.ts` (hook): voiceschanged-подписка (async голоса), play() из onClick (iOS gesture), последовательная очередь чанков, keep-alive resume ~10с, `cancel()` на unmount и перед play (singleton), playCount++ на play/replay.
- `AudioPassage.tsx`: mode speak && !reveal → только контролы ▶️/⏸/заново + счётчик, транскрипт СКРЫТ; fallback → note + полный транскрипт (первоклассный — почти весь KK уйдёт сюда); `reveal` prop (default false; разбор — этап 3).
- TestRunner: ветка `section.modality==='audio' && body.passage` → `<AudioPassage text lang={spec.language}/>` вместо blockquote; text-секции — blockquote как сейчас (reading-пассажи видимы!); page.tsx передаёт `language`. i18n namespace `audio` (11 ключей, RU+KK).

---

## Задачи

### Task 1: Фундамент — схемы с целостностью + резолвер выбора

**Files:** Modify `src/features/exam-profile/spec.ts`, `spec.test.ts`, `src/features/tests/spec.ts`, `spec.test.ts`; Create `src/features/exam-profile/selection.ts`, `selection.test.ts`.
**Deliverable:** D2 дословно, включая superRefine-целостность (уникальные имена; ⊆ sections; chooseCount выполним) и тотальный resolveActiveSections/validateHqConfig; testSectionSchema.plannedCount/modality/`refillCount` на spec-уровне (testSpecSchema += refillCount int nullish).
**Acceptance:** старые фикстуры парсятся; спека с dangling-именем/дублем имени/chooseCount>|group| ОТВЕРГАЕТСЯ; resolve: {}→все; variant сужает; stale variantKey → все секции (не throw); stale имя дропается; validate ловит все случаи D2. TDD.
**Notes:** блокирует всё. Ни одной ЕНТ-константы.

### Task 2: Генерация — привязка к секции + audio-passage enforcement

**Files:** Modify `src/features/tasks/generate.ts`, `generate.test.ts`.
**Deliverable/Acceptance:** D6 дословно; юниты: промпт содержит имя секции+темы+запрет; audio-бакет требует passage; passage<50 дропается; text не требует; кап ≤2/бакет прежний; ноль exam-if. TDD.

### Task 3: Research — variants/selectionGroups/modality + avoid + maxTokens

**Files:** Modify `src/features/exam-profile/research.ts`, `research.test.ts`.
**Deliverable:** D4 дословно: SYSTEM_PROMPT+skeleton; `researchExam(deps, query, opts?: {avoid?})`; **maxTokens 24_000**; graceful degrade.
**Acceptance:** фикстуры НИШ/ЕНТ/IELTS (fake, без сети) по D4; avoid-строка в промпте при opts.avoid; плоский ответ валиден; спека с нарушением целостности (T1) вызывает ретрай адаптера (fake: первый ответ битый → второй чистый). TDD.

### Task 4: Сборка — активные секции, round-robin+ротация, freeze, reassemble

**Files:** Modify `src/features/tests/assemble.ts`, `assemble.test.ts`, `src/features/tests/repo.ts`, `src/app/api/tests/route.ts`; Create `src/features/tests/assembly-limiter.ts`.
**Deliverable:** D5 (сборочная часть): hqConfig→activeSections; validateHqConfig в роуте → 422 reconfigure_needed; round-robin + offset от refillCount; plannedCount/modality freeze ПО ИНДЕКСУ; `reassembleTest` (переиспользует пайплайн, ++refillCount); `TestRepo.replaceTestSpecIfNoAttempts(testId, spec)` (вызов RPC — сам RPC в T5, до него интерфейс + фейк); лимитер в общий модуль.
**Acceptance:** фейк-юниты: config сужает секции; {}→все (legacy); round-robin даёт каждой секции шанс (нет 0-секции при доступном банке у других); ротация: второй заход начинает с другой секции; plannedCount≥actual при дефиците; существующие тесты зелёные. TDD.

### Task 5: Миграции + API study-hqs/exam-profiles (reroll с лимитером)

**Files:** Create `supabase/migrations/20260708120000_study_hqs_config.sql`, `20260708120100_exam_profile_reports.sql`, `20260708120200_replace_test_spec_rpc.sql`; Modify `src/app/api/study-hqs/route.ts` (+route.test.ts), `src/app/api/exam-profiles/route.ts` (+route.test.ts), `src/features/exam-profile/slug.ts`, `src/lib/supabase/database.types.ts`, `src/lib/db/migrations.test.ts`.
**Deliverable:** D7 миграции (включая unique(reported,user) и RPC); study-hqs: config/examDate + validateHqConfig→422 + UPDATE existed:true + 🔴 частичный patch (examDate отсутствует в body → колонка не трогается); exam-profiles: 🔴 лимитер 3/10мин ДО спенда + reroll-ветка (avoid, slug-guard -x<hash6>, report upsert).
**Acceptance:** старые body валидны; 401/400/422/429 route-тесты; slug-guard юнит (никогда === excludeSlug); PGlite: колонка config с default, таблица reports + unique, RPC существует и работает (вставил attempt → RPC возвращает 0 строк); 🔴 429-тест reroll. TDD.
**Notes:** после ревью контроллер применяет миграции к живой БД (Management API) и регенерирует types.

### Task 6: Refill-роут + UI честности

**Files:** Create `src/app/api/tests/[testId]/refill/route.ts`, `route.test.ts`, `src/components/refill-button.tsx`; Modify `src/app/(app)/hq/[hqId]/tests/[testId]/TestRunner.tsx`, `page.tsx`, `messages/ru.json`, `kk.json`.
**Deliverable:** D5 (UI+refill): фильтр пустых секций (все пустые → баннер); partial-баннер N/M + RefillButton (busy-lock); refill-роут 401/403/404/**409 через RPC-атомарность**/429 (общий лимитер); 🔴 «дособрать не удалось» после пересборки без прогресса — кнопка скрыта.
**Acceptance:** route-тесты все коды; 409-тест: мок RPC вернул no-rows; старые spec без plannedCount → без баннера; паритет i18n; существующие тесты зелёные. TDD.

### Task 7: Онбординг-визард + перепроводка входов

**Files:** Create `src/app/(app)/onboarding/[slug]/page.tsx`, `OnboardingWizard.tsx`, `buildOnboardingSteps` (в page-модуле или steps.ts + steps.test.ts); Modify `src/components/exam-search-form.tsx`, `prepare-button.tsx`, `messages/ru.json`, `kk.json`.
**Deliverable:** D1 дословно, ВКЛЮЧАЯ все 🔴: server-guard существующего hq → redirect /hq; router.replace на финише/reroll; busy-lock оба сабмита; localStorage-черновик; date-skip не шлёт examDate; деградация неудовлетворимой группы; ResearchPending при reroll.
**Acceptance:** buildOnboardingSteps — чистые юниты (IELTS → confirm+date; вариантный → +variant; selectable → +selection; неудовлетворимая группа → деградация); финиш заблокирован до валидного выбора; 0 LLM в шагах; паритет ключей; build зелёный. TDD (steps), UI — рендер-логика через чистые функции.

### Task 8: Аудио — Web Speech

**Files:** Create `src/features/attempts/speech.ts`, `speech.test.ts`, `useSpeechSynthesis.ts`, `AudioPassage.tsx`, `AudioPassage.test.tsx`; Modify `TestRunner.tsx`, `page.tsx` (language prop), `messages/ru.json`, `kk.json` (ns `audio`, 11 ключей).
**Deliverable/Acceptance:** D8 дословно (полный acceptance — 9 пунктов аудио-дизайна wf_a7e3accd-880: pickVoice/chunkText/resolveCapability юниты; скрытый транскрипт в attempt; первоклассный фолбэк; cancel-на-unmount; счётчик; паритет). TDD для speech.ts; AudioPassage — рендер-тесты с мок-хуком.
**Notes:** kk-голосов почти нет → фолбэк-транскрипт (ожидание согласовано с основателем). Комментарий «hidden = honest format, NOT anti-cheat» обязателен.

### Task 9: Eval качества заданий (обещание «максимального качества»)

**Files:** Create `evals/task-quality/generation.eval.ts` (+ судья-промпт в файле), опц. `evals/task-quality/README.md`.
**Deliverable:** живой eval (вне CI, паттерн evals/live-smoke): для фикстур-профилей (ЕНТ math, IELTS listening c modality=audio, НИШ-вариант) прогнать generateForBucket живым LLM → каждый элемент оценивает LLM-судья (тот же адаптер) по рубрике: (1) вопрос по теме секции? (2) ключ ответа корректен? (3) язык = spec.language? (4) для audio: вопрос отвечаем ТОЛЬКО по passage? — score 0/1 каждый, отчёт в консоль+файл. Прогнать для `google/gemini-2.5-flash` и `google/gemini-2.5-pro` (env-переключение модели), таблица сравнения качество/цена.
**Acceptance:** eval запускается `npm run eval:tasks`; flash после T2-промптов даёт ≥80% по «по теме секции»; отчёт с рекомендацией модели для генерации записан в `docs/decisions/generation-model.md` (решение — основателю).
**Notes:** судья ≠ генератор темплейтно (разные промпты); при провале рубрики — итерация T2-промпта (fix-loop с контроллером).

### Task 10: Публичный профиль + финальная регрессия

**Files:** Modify `src/app/exams/[slug]/page.tsx`, `messages/*`; финальный прогон.
**Deliverable:** группировка секций по вариантам + бейджи «на выбор (N из M)» / «аудирование»; полный спектр остаётся (профиль — библиотечный актив).
**Acceptance:** all-green (245+ тестов ожидаемо); прод-smoke чеклист: (1) IELTS → confirm+date → штаб → тест с озвучкой Listening (en) и скрытым транскриптом; (2) selectable-профиль → выбор → тест только из выбранных; (3) reroll даёт новый slug, лимитер бьёт 429 на 4-й подряд; (4) частичный тест → Дособрать → прогресс или честное «не удалось»; (5) kk-passage → фолбэк-транскрипт. Веха в Обсидиан-журнал.

## Definition of Done

1. Все 10 задач с ревью; 3 critical красной команды закрыты кодом и тестами (лимитер+429; superRefine-целостность; RPC-атомарный refill).
2. Прод: интервью-путь от «назови экзамен» до сконфигурированного штаба; «Не тот экзамен» реролит; тест — только выбранные секции, без пустых, с честным partial-статусом; listening озвучивается (en), kk — читаемый фолбэк.
3. Eval качества заданий прогнан на двух моделях, отчёт с рекомендацией в docs/decisions/.
4. Миграции применены к живой БД; старые профили/штабы/тесты работают (регресс-фикстуры).
5. Клик-тест основателя.

## Open Questions (основателю)

1. Reroll-профили публикуются в общую библиотеку сразу (лимитер спасает от потопа, но мусорные -x-слаги видны) — ок для беты, или staging/unlisted до подтверждения (сложнее, этап 4)?
2. Sybil/global cap на LLM-роуты (per-instance лимитер обходится мульти-аккаунтами) — принимаем как известный бета-риск до durable-лимитера?
3. Тексты партнёру-дизайнеру: «Аудио: задание по транскрипту» (фолбэк), «Тест собран частично: N из M», «Не тот экзамен», «Собираем профиль ~30–60 сек», подсказка аудио-плеера.
4. chooseCount «ровно N» (диапазон — аддитивно позже) — подтверждено?
5. Пере-онбординг перезаписывает config (тесты старого набора остаются в БД) — предупреждение в UI достаточно позже, MVP: redirect-guard закрывает случайный путь.

## Deferrals

Карта знаний/план/прогноз/разбор ошибок + reveal-транскрипт после сабмита (этап 3, surface разбора там); серверный TTS (следующий уровень аудио); staging/unlisted reroll-профилей и модерация (этап 4); durable rate limiter (Redis) — до платного запуска; LLM-парс уточнения; профиль-на-вариант; ретро-фикс свалки НИШ (новым слагом через reroll); анти-чит passage; всё из Deferrals этапа 2.
