# U-Pal Stage 5 — Interview, Learning Workspace, Speaking (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Леджер: .superpowers/sdd/progress.md (секция Stage 5).

**Goal:** «Назови экзамен» перестаёт сразу выдавать тесты. Вместо этого: гибрид-интервью строит профиль подхода ученика → воркспейс становится местом ежедневного обучения («чем заняться сегодня», а не голый балл) → спикинг оценивается по аудио через LLM, а не текстовым фейком.

**Architecture:** Три эпика поверх существующих кирпичей этапов 2–3, ноль новых систем с нуля. (A) Интервью — гибрид (4 кнопки + ≤2 открытых вопроса, ровно 1 LLM-вызов на анализ открытых) пишет `study_hqs.approach`. (B) Воркспейс — пересборка дашборда вокруг `DailyFocusCard` + кэшируемые микро-объяснения тем («раз на всех») + топик-таргетированная сборка (закрывает defer этапа 3). (C) Спикинг — запись голоса → аудио прямо в LLM (не браузерный STT — не тянет казахский, легко подделать) → оценка по рубрике экзамена, партиционируется из грейдинга, не ломает шкалу.

**Основа:** дизайн-синтез (3 линзы: опыт обучения / техника спикинга / цена+простота → судья) + красная команда (3 критика: interview-flow / speaking-tech / cost-cache, **2 critical + 9 important + 4 minor — все интегрированы ниже, 🔴**). Полные тексты — в этой сессии; JSON-снапшот синтеза: `docs/superpowers/plans/2026-07-09-stage-5-design-synthesis.json`.

**Скоуп подтверждён основателем:** этот этап — только форматные экзамены (ЕНТ/IELTS/SAT и т.п.). Обобщение «любая цель обучения» (тех-собеседование, «просто учить английский» — без официального формата) — **этап 6**, когда механизм интервью уже обкатан и его можно переиспользовать как основной способ структурирования там, где research бессилен.

## Global Constraints

- Экзамен-агностичность: ноль констант конкретного экзамена (интервью/спикинг работают по любой спеке).
- **LLM-бюджет под контролем**: каждый новый путь — под module-level лимитером ДО спенда. 🔴 Явные ёмкости (красная команда: «капы» без чисел — не капы): `interview-limiter` 3/10мин, `micro-explain-limiter` 10/10мин (дёшево, текст), `speaking-limiter` **5/10мин** (дорогой аудио-путь, красная команда явно требует низкую ёмкость). Суммарный худший случай на юзера/10мин теперь: assembly 15 + explain 10 + research 3 + interview 3 + micro-explain 10 + speaking 5 = **~46 вызовов**, из них до 5 — аудио по ~$0.01–0.05 (≈$0.25/10мин на спикинг одного юзера). Задокументировать как известный предел до платного запуска (durable-лимитер — отдельная волна).
- `tasks.answer`/`explanation` не сериализуются клиенту (инвариант этапов 2–3) — распространяется на speaking-рубрику: критерии (`criteria[]`) это НЕ эталонный ответ, можно отдавать; but аудио-запись — приватный бакет, owner-only.
- Записи в БД только из write-путей (submit/explicit POST) — GET-рендер дашборда/воркспейса не мутирует ничего (инвариант этапа 3, красная команда подтвердила: `DailyFocusCard` его не нарушает).
- Аддитивность: старые профили/штабы/тесты/approach=null живут без изменений.
- i18n RU/KK паритет (пиннится тестом); нейтральный Tailwind; vitest+fakes; TDD.
- Миграции — аддитивны, **RLS в той же миграции, не откладывать на финал** (память проекта: «не откладывать RLS на ред-тим»). Применяет контроллер (Management API) после ревью задачи.
- Хотфикс контекста экзамена (название экзамена на страницах, ссылка «Штаб» с главной) уже на проде (`84c274d`) — Task 6 сверяет diff, не дублирует.
- Перед каждой задачей: `git pull origin main`. После: `npm test && npm run typecheck && npm run lint && npm run build` → commit → push.

## Архитектурные решения (ОБЯЗАТЕЛЬНЫЕ; 🔴 = фикс красной команды)

### D1. Интервью-гибрид

4 кнопочных вопроса (детерминированно, `deriveApproachFromButtons` — pure, ноль LLM): level [начинаю/средний/добираю баллы]; hoursPerWeek [<3/3–6/7+] → intensity light/steady/intense; **weakSections** — мульти-выбор по **резолвнутым активным секциям** (сильнейший рычаг); explanationStyle [коротко/подробно]. ≤2 открытых вопроса (оба скипаемы): «что не получилось раньше / чего боишься» → concerns; опц. «зачем тебе этот экзамен» → мотивация. Ровно **один** `llm.complete` (`analyzeOpenAnswers`, зеркало `explain.ts`) — только `{concerns[]≤3, tone, summary}`, мержится ПОВЕРХ кнопочных полей; открытые пусты → **ноль** вызовов.

`studentApproachSchema`: `{level, intensity, focusSections: string[], explanationStyle, concerns: string[], tone, summary: string}`. 🔴 **Схема устойчива к дрейфу** (красная команда, Important): каждое поле — `.catch(default)` на уровне поля (как `hqConfigSchema`), НЕ единый `.parse()` на весь объект — одно битое поле не должно стирать валидные `concerns`/`summary`. `DEFAULT_APPROACH` — константа. `parseApproach(raw): StudentApproach` — тотальная, никогда не бросает.

Хранение: **новая колонка** `study_hqs.approach jsonb NULL` (НЕ `config` — `parseHqConfig` стрипает неизвестные ключи, approach молча терялся бы).

Шаг `interview` в `OnboardingStep` — **после** variant/selection (weakSections нужны резолвнутые секции), **до** date. Запись: `POST /api/interview {hqId, buttons, openAnswers}` (auth→ownership hq→interview-limiter→derive+analyze→**partial-merge** approach→recomputeHqInsights), вызывается **после** `POST /api/study-hqs`.

🔴 **Critical-фикс (двухзапросная хрупкость)**: первый POST успел (штаб создан), второй (`/api/interview`) упал по сети (не 402 — реальный network fail/timeout) → approach молча теряется, ХУЖЕ — INSERT-ветка `/api/study-hqs` не звала recompute, значит воркспейс пуст до первой попытки. Фикс (Task 1, фундаментально — не только для интервью): **INSERT-ветка `/api/study-hqs` тоже зовёт `recomputeHqInsights`** (best-effort try/catch, как UPDATE-ветка) — штаб рождается уже пересчитанным с `DEFAULT_APPROACH`, `/api/interview` становится чисто аддитивным обогащением. Плюс: `isHqStale` (dashboard-view.ts) должен считать stale штаб с `last_recomputed_at === null` **даже при нуле попыток** (сейчас `maxFinishedAt===null → false`, кикер не монтируется) — backstop, если INSERT-recompute сам упал.

🔴 **Important-фикс (re-интервью стирает analyze-слой)**: юзер повторно проходит интервью только чтобы поправить часы, открытые скипает → `analyze` не зовётся → пишется `concerns:[], summary:''` **поверх** старых, стирая прежнюю рефлексию молча. Фикс: `/api/interview` делает **частичный merge**, не overwrite колонки — derive-поля (level/intensity/focusSections/explanationStyle) патчатся всегда; analyze-поля (concerns/tone/summary) перезаписываются **только** когда открытые реально непустые в этом запросе, иначе сохраняются из текущего `approach`.

🔴 **Important-фикс (weakSections против неверного набора секций)**: роут валидирует `focusSections ⊆ resolveActiveSections(spec, config)` (НЕ `⊆ spec` — слабее и пропускает секции отменённого варианта). В визарде: `weakSections` реконсилятся не только при загрузке черновика, но и **вперёд**, при смене variant/selection в той же сессии (тот же паттерн, что уже есть для `selected`).

🔴 **Minor-фикс**: `interview-limiter` — module-level, capacity 3/10мин (см. Global Constraints), тест «analyze не вызывается при исчерпанном лимитере И при пустых открытых».

### D2. Персонализация (реальные оси, не декор)

Три проверяемые оси: (1) **план** — `buildStudyPlan(..., approach?)`: темы из `focusSections` получают need-бонус (+0.15), `intensity` → K тем/нед (light=2/steady=3/intense=5); (2) **тон разбора** — `explanationStyle`+`tone` → persona-директива в `SYSTEM_PROMPT` explain.ts + `maxTokens`; НЕ трогает кэшируемые micro-объяснения (там style — клиентский рендер-тоггл, не отдельная генерация — иначе фрагментация кэша); (3) **объём daily** — `intensity` → размер топик-сета (5/8/12). Честно НЕ фабрикуем: `level` не пишет в `knowledge_states` (не портим диагностику) — только рефлексия. Отсутствие approach (`null`) → поведение байт-в-байт как сегодня.

### D3. Воркспейс = место обучения

Дашборд `/hq/[hqId]` пересобирается вокруг `DailyFocusCard` (pure `buildDailyFocus(currentWeek, states, approach, now)` → 1–3 действия `{topic, section, reason, action: learn|practice|review}`), Forecast/Map/Plan — ниже как контекст. Цикл после сабмита: ResultView/ReviewList получают footer next-actions «разбери → похожие → практика по теме» (никакой экран не тупик). Микро-объяснения тем — **кэш «раз на всех»** в новой таблице `topic_explanations (exam_profile_id, topic, locale)` UNIQUE — первый открывший генерит, остальные читают.

🔴 **Important-фикс (гонка cache-miss)**: лимитер пер-юзерный → 30 учеников одного класса открывают тему одновременно → 30 генераций + 29 `unique_violation` → 29×500 после уже потраченного LLM-вызова. Фикс: `INSERT ... ON CONFLICT (exam_profile_id, topic, locale) DO NOTHING`, затем безусловный `SELECT` той же строки — возвращаем победителя всем. Тест: конкурентный промах (два параллельных insert) → одна строка, второй не 500.

🔴 **Important-фикс (отравление кэша без коррекции)**: INSERT только по hq-ownership без валидации содержимого → мусорная строка вечна (нет UPDATE/DELETE ни для кого). Фикс: **DELETE-политика** по тому же hq-ownership гейту (объяснение детерминированно регенерируемо — потерять строку безопасно) — путь эвикции для владельца штаба на этом профиле.

**Топик-сет** (закрывает defer этапа 3): `buildTopicPlan(spec, topic, count, approach?)` — таргетированная сборка по одной теме.

🔴 **Important-фикс (дублирование конвейера)**: `buildTestSpec` приватный, бакеты строятся ВНУТРИ по всем секциям — «переиспользовать тот же конвейер» без рефактора невозможно, приглашает копию round-robin/budget-логики (ровно риск, названный красной командой этапа 3). Фикс: **выделить общее ядро** из `buildTestSpec` — функцию, принимающую ГОТОВЫЙ список бакетов и прогоняющую его через существующий `select→relax→bounded-gen→freeze→budgetedLlm` конвейер; `assembleTest` и `assembleTopicSet` — оба тонкие обёртки над этим ядром (первая строит бакеты по всем активным секциям, вторая — один бакет по теме). `tests.kind` для топик-сета = `'practice'` (существующий enum, без DB-миграции).

🔴 **Minor-фикс (staleness daily-фокуса)**: карточка отражает снимок последнего recompute — это ЖЕ поведение всего дашборда (не баг, задокументировать явно, не «чинить» отдельно). Источник данных для `action:'review'` — явный доп. read-запрос последних неверных items внутри GET (по-прежнему без записей).

### D4. Спикинг (аудио-в-LLM)

Решение архитектора: **аудио прямо в LLM**, не браузерный `SpeechRecognition` (не тянет казахский, судит текст а не речь, подделывается). Адаптер расширяется УЗКО: опц. `audio?: {data: base64, format}` + `model?` override в `LlmCompleteArgs`/`RawComplete`; `openrouter.ts` строит `input_audio`-parts ТОЛЬКО при наличии audio, иначе байт-в-байт строковый путь как сегодня. `SPEAKING_LLM_MODEL` env (дефолтный `LLM_MODEL` может быть text-only).

🔴 **Important-фикс (retry теряет audio)**: `llmFromRaw` ретраит `attempt(prompt)`, реконструируя raw-аргументы БЕЗ audio/model → провал первого парса (вероятен — новая непроверенная zod-рубрика) → ретрай уходит text-only → LLM галлюцинирует правдоподобный транскрипт+оценку без реального аудио → тихий мусорный грейд. Фикс: **прокинуть audio+model через ОБА вызова** `attempt()` в `llmFromRaw` (замыкание должно держать их, не только `prompt`). Тест: audio/model выживают retry-ветку.

🔴 **Important-фикс (openrouter.ts захардкожен на строку)**: `content: prompt` — строка, тип ответа предполагает строковый `content`. Это НЕ «аддитивное» расширение, а структурное. Фикс: `content: string | Part[]` явным union; **два пиннящих теста** — байт-в-байт старое тело без audio (back-compat) и parts-массив с audio. Пометить open question: shape `input_audio` не проверялся против живого OpenRouter — live-smoke после пополнения кредитов, с готовой деградацией на transcript-грейдинг.

🔴 **Important-фикс (fakeLlm не фиксирует вызовы)**: `fakeLlm.complete` не записывает, с чем его позвали → acceptance «audio дошёл до адаптера» неверифицируем. Фикс: `fakeLlm` получает `calls: CallRecord[]` (или `onCall`-спай) — тесты спикинга ассертят, что audio/model реально прокинуты.

Формат `"speaking"` аддитивно в 3 union'а (`schema.ts`): body `{prompt, preparationSeconds?, responseSeconds?}`; answer `{criteria: [{key,label,maxPoints,descriptors?}]}` — рубрика, НЕ эталон, каскад источников task→section.speakingCriteria→generic `{fluency,coherence,vocabulary,grammar,pronunciation}`; response `{transcript, audioRef?, durationMs?}`.

🔴 **Minor-фикс (partition-safety не защищена)**: `gradeAnswer`-switch с `speaking` семантически некорректен (любой boolean неверен), вся защита держится на явной проверке в `submitAttempt` ДО вызова грейдера. Фикс: партиционировать **явно по `task.body.format === 'speaking'`** (не полагаться на дефолтную ветку); если задание отсутствует в банке (`tasksById.get` → undefined) — классифицировать по modality секции спеки, а не молча считать грейдируемым; `gradeAnswer`-ветка для speaking пусть **бросает** при ошибочном вызове (громкий отказ вместо тихого x=0).

`submitAttempt` партиционирует speaking из raw/total, `is_correct=NULL`. Грейдинг **постфактум** per-item: `POST /api/attempts/[id]/speaking {taskId}` (auth→ownership→finished→canUseSpeaking()→speaking-limiter→download→gradeSpeaking→write score/feedback).

🔴 **Critical-фикс (спикинг отравляет карту знаний)**: `knowledge/repo.ts` считает `answered = response !== null` — у speaking-item response (транскрипт) есть СРАЗУ на сабмите, а грейд приходит позже отдельным запросом. Окно между submit и грейдом → тема считается **отвеченной неверно** (is_correct=null трактуется как false) в байесовской карте. И `compute.ts`'s план «x=score/maxPoints» нереализуем — `KnowledgeItem` не несёт score, `repo.ts` не селектит новую колонку. Фикс: **`knowledge/repo.ts` — в скоуп Task 8** (design-синтез его не называл файлом задачи — добавлено): `SELECT attempt_items.score`; `answered` для speaking-item = `score !== null` (НЕ `response !== null`); `x = score/maxPoints` когда есть. `POST /api/attempts/[id]/speaking` зовёт `recomputeHqInsights` ПОСЛЕ записи score (сабмит-recompute был ДО грейда — устарел для speaking).

🔴 **Important-фикс (taskReadClient не для Storage)**: `taskReadClient` создан для колоночных грантов tasks, не для Storage-RLS — переиспользование вслепую конфлирует два разных механизма. Фикс: явный выбор клиента для скачивания записи (service-role если ключ есть, иначе user-клиент — с тестом на owner-RLS путь `auth.uid()::text = (storage.foldername(name))[1]`); подтвердить/добавить UPDATE-грант на `attempt_items.score/feedback` для владельца попытки.

Запись: `recording.ts` (pure: capability/state machine/`pickMime` webm/opus→mp4 для iOS/лимит длительности) + `useSpeechRecording` (MediaRecorder, user-gesture старт, cleanup) + `SpeakingPrompt.tsx` (prep/response-таймеры). Хранение: приватный бакет `speaking-recordings`, path `{user_id}/{attempt_id}/{task_id}`, owner-only RLS. Фолбэк: denied/unsupported → текстовый ответ, грейдится ТОЙ ЖЕ рубрикой content-only (delivery-критерии null, помечено); skip → NULL, тест не ломается. `canUseSpeaking()` — paywall-ready заглушка (=true).

### D5. Честный UX частичного теста

Авто-добор на границе старта: pure `needsRefill(spec)`; если partial и банк догрелся — **тихий** `reassembleTest→replaceTestSpecIfNoAttempts` ДО `insertAttempt` (TOCTOU-safe, попытки ещё нет). Если после добора всё ещё коротко — прозрачный выбор «Начать с N / Подождать». Попытка на partial без успешного добора ИЛИ явного согласия — **недостижима** (пиннится тестом). После старта мёртвый «дособрать нельзя» заменяется форвард-действием в result/review: «Собрать добор-сет по недобранным темам» (топик-сет механика D3). Speaking-секция с 0 заданий деградирует мягко, не блокирует старт.

### D6. Полнота аудирования/спикинга на существующих профилях

`sectionModalitySchema` аддитивно `['text','audio','speaking']`, absent=text; опц. `section.speakingCriteria`. **Скрипт** `scripts/backfill-modality.ts` (НЕ миграция — спеки живые данные): dry-run по умолчанию печатает diff → ревью основателем → `--apply`; эвристика по именам секций (ru/kk/en: Listening/Аудирование/Тыңдалым→audio; Speaking/Говорение/Сөйлеу→speaking), идемпотентно (только absent/text). research/refine-промпты эмитят modality для новых профилей.

### D7. Миграции

Две, после `20260709150000` (ждёт применения):
```sql
-- 20260710120000_stage5_learning.sql
alter table public.study_hqs add column approach jsonb;
alter table public.study_hqs add constraint study_hqs_approach_is_object
  check (approach is null or jsonb_typeof(approach) = 'object');

create table public.topic_explanations (
  id uuid primary key default gen_random_uuid(),
  exam_profile_id uuid not null references public.exam_profiles(id),
  topic text not null,
  locale text not null,
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  created_at timestamptz not null default now(),
  unique (exam_profile_id, topic, locale)
);
alter table public.topic_explanations enable row level security;
create policy "topic explanations readable" on public.topic_explanations
  for select using (true);
create policy "topic explanations insert by hq owner" on public.topic_explanations
  for insert with check (
    auth.uid() is not null
    and exists (select 1 from public.study_hqs h
                where h.exam_profile_id = topic_explanations.exam_profile_id
                  and h.user_id = auth.uid())
  );
-- 🔴 путь коррекции (красная команда): без DELETE отравленная строка вечна.
create policy "topic explanations delete by hq owner" on public.topic_explanations
  for delete using (
    exists (select 1 from public.study_hqs h
            where h.exam_profile_id = topic_explanations.exam_profile_id
              and h.user_id = auth.uid())
  );

-- 20260710120100_stage5_speaking.sql
alter table public.attempt_items add column score numeric;
alter table public.attempt_items add column feedback jsonb;
alter table public.attempt_items add constraint attempt_items_feedback_is_object
  check (feedback is null or jsonb_typeof(feedback) = 'object');
-- Storage: bucket speaking-recordings (private) + owner-only policies
-- (insert into storage.buckets; create policy ... using (auth.uid()::text = (storage.foldername(name))[1]))
```
Деплой-порядок: stage-5 миграции — ЗА ждущими `130000`/`140000`/`150000` + `SUPABASE_SECRET_KEY` на Vercel (существующая очередь). Фичевый код stage 5 НЕ зависит от service-role ключа (`topic_explanations` INSERT — user-клиент под RLS).

---

## Задачи (порядок; свежий исполнитель + ревьюер на каждую)

### Task 1: Фундамент — миграции + modality + backfill + recompute-на-insert
**Files:** 2 миграции (D7 дословно), `src/features/exam-profile/spec.ts` (+modality speaking, +speakingCriteria), `research.ts`+`refine.ts` (эмиссия modality), `scripts/backfill-modality.ts`, 🔴 `src/app/api/study-hqs/route.ts` (INSERT-ветка → recomputeHqInsights best-effort), 🔴 `src/features/hq/dashboard-view.ts` (isHqStale: null last_recomputed_at → stale даже при 0 попыток).
**Acceptance:** старые спеки/tests.spec парсятся без изменений; RLS-чеклист (ownership-в-роуте ПЛЮС RLS) зелёный ДО фичевого кода; backfill dry-run печатает diff, apply идемпотентен; 🔴 новый штаб (INSERT-путь) получает recompute — тест: fake-recompute вызван внутри INSERT-ветки, сбой не блокирует 200; 🔴 isHqStale(null, 0 attempts) === true (тест на регрессию).
**TDD.**

### Task 2: Интервью-гибрид — pure-ядро → 1 LLM-вызов → роут → визард
**Files:** `src/features/onboarding/steps.ts`, `src/features/interview/approach.ts` (+field-level-catch schema 🔴), `analyze.ts`, `interview-limiter.ts`, `src/app/api/interview/route.ts` (🔴 partial-merge + focusSections ⊆ resolveActiveSections), `OnboardingWizard.tsx` (🔴 forward-reconcile weakSections).
**Acceptance:** полный путь экзамен→интервью→approach; skip → 0 LLM; открытые пусты → 0 вызовов (fake-llm счётчик); падение analyze НЕ блокирует создание штаба; 429 покрыт; focusSections вне активных секций отсеяны; 🔴 re-интервью со скипнутыми открытыми сохраняет старые concerns/tone/summary (regression-тест); 🔴 смена варианта в сессии реконсилит weakSections вперёд; 🔴 битое поле approach не стирает валидные соседние поля.
**TDD.**

### Task 3: Персонализация — approach → план / тон разбора / порядок секций
**Files:** `src/features/plan/build.ts`, `src/features/hq/recompute.ts`, `src/features/review/explain.ts`, `src/features/hq/dashboard-view.ts`.
**Acceptance:** два контрастных approach на одном экзамене → видимо разные планы (K/фокус) и разный prompt разбора (fake-llm захват); отсутствие approach → байт-в-байт как сегодня; level НЕ пишет в knowledge_states.
**TDD.**

### Task 4: Микро-объяснения тем — кэш «раз на всех» с гонкой и коррекцией
**Files:** `src/features/learn/micro-explain.ts`, `micro-explain-limiter.ts` (capacity 10/10мин), `src/app/api/topics/explain/route.ts` (🔴 ON CONFLICT DO NOTHING + reread; 🔴 DELETE-эндпоинт/ветка по hq-ownership), i18n.
**Acceptance:** повторное открытие темы — cache-hit, LLM не тратится; 🔴 конкурентный промах (два параллельных insert одного ключа) → одна строка, второй не 500 (тест с двумя параллельными вызовами); 🔴 владелец штаба может удалить отравленную строку (regen на следующий заход); ru/kk на языке интерфейса; ноль экзамен-специфичных констант.
**TDD.**

### Task 5: Топик-сет — таргетированная сборка через общее ядро (не копия)
**Files:** 🔴 `src/features/tests/assemble.ts` (выделить ядро select/relax/bounded-gen/freeze из `buildTestSpec`, `assembleTest` и новый `assembleTopicSet` — оба тонкие обёртки), `start-test-button.tsx`, `src/app/api/tests/route.ts`.
**Acceptance:** сет по одной теме собирается через ТОТ ЖЕ конвейер (тест на переиспользование — не дублирование бюджета/round-robin); 🔴 явный тест «assembleTest и assembleTopicSet используют одну и ту же функцию ядра» (например, через spy/структурный тест); пустой банк → короткий сет, не падение; recompute после сета двигает карту.
**TDD.**

### Task 6: Воркспейс — daily-фокус + цикл после сабмита + история
**Files:** `src/features/hq/daily-focus.ts`, `dashboard-view.ts`, `src/app/(app)/hq/[hqId]/page.tsx`, `ResultView.tsx`, `ReviewList.tsx`.
**Acceptance:** полный цикл балл→разбор→похожие→топик-сет→обновлённая карта без тупиков; GET `/hq/[hqId]` по-прежнему ноль записей; 🔴 review-действие явно специфицировано (доп. read последних ошибок в GET, задокументировано, не «баг»); сверить diff уже задеплоенного хотфикса контекста экзамена (`84c274d`) — не дублировать.
**TDD.**

### Task 7: Спикинг-фундамент — audio-адаптер + формат + партиция + запись
**Files:** `src/lib/llm/types.ts`+`openrouter.ts`(🔴 union content, 2 pin-теста)+`provider.ts`(🔴 audio/model через retry)+`fake.ts`(🔴 calls[]-захват)+`index.ts`, `src/features/tasks/schema.ts`, `grade.ts`(🔴 явная партиция по format, defensive throw), `src/features/attempts/service.ts`, `recording.ts`, `useSpeechRecording.ts`, `SpeakingPrompt.tsx`.
**Acceptance:** все прежние llm-тесты зелёные + 🔴 pin back-compat строкового пути; 🔴 audio+model выживают retry-ветку (тест); 🔴 fakeLlm.calls фиксирует переданный audio; speaking-задание не дефлейтит raw/scaled; recording.test — все capability/mime/view-ветки; профиль без speaking-modality — секция не появляется.
**TDD. Полностью на fakes — не ждёт OpenRouter-кредитов.**

### Task 8: Спикинг-live — грейдер по рубрике + Storage + роут + карта
**Files:** `src/features/speaking/grade-speaking.ts`, `scale-speaking.ts`, `speaking-limiter.ts` (capacity 5/10мин 🔴), `paywall.ts`, `src/app/api/attempts/[id]/speaking/route.ts` (🔴 явный выбор клиента для Storage, не taskReadClient), 🔴 **`src/features/knowledge/repo.ts`** (SELECT score, answered-гейт по score для speaking), `compute.ts` (x=score/maxPoints), `assemble.ts`+`generate.ts` (speaking-бакеты), `TestRunner.tsx`, `ResultView.tsx`.
**Acceptance:** полный цикл запись→транскрипт→оценка по критериям spec→scaled+фидбэк; attempt_items записаны; 🔴 карта: ungraded speaking-item НЕ считается answered (тест: response есть, score=null → topic не в knowledge_states до грейда); 🔴 после грейда — recompute зовётся заново, карта отражает score/maxPoints; 429 покрыт, порядок гейтов пиннится; text-fallback грейдится content-only; аудио-модель недоступна+есть transcript → деградация; Storage-доступ только владельцу (тест на owner-RLS путь).
**TDD.**

### Task 9: Частичный UX + i18n + бюджет-документация + финал READY + live-smoke
**Files:** `src/app/api/attempts/route.ts`, `start-test-button.tsx`, `ResultView.tsx`, i18n, 🔴 `docs/decisions/generation-model.md` (или новый `docs/decisions/llm-budget.md` — зафиксировать суммарный бюджет из Global Constraints).
**Acceptance:** «начатый тест с недобором без явного выбора» недостижим (тест); авто-добор-до-старта покрыт; i18n-паритет зелёный; счётчик тестов вырос от 660; 🔴 суммарный LLM-бюджет задокументирован явно (не только в плане — в repo); финальное whole-branch ревью READY; live-smoke (интервью/микро-объяснение-кэш/спикинг) — после снятия внешних блокеров.

## Definition of Done

1. Все 9 задач с ревью; **оба critical** красной команды закрыты тестами (INSERT-recompute+isHqStale backstop; knowledge_states не дефлейтится ungraded speaking).
2. Живой цикл (код-комплит, до live-smoke): «назови экзамен» → интервью (не анкета, гибрид) → воркспейс с daily-фокусом (не голый тест) → тест со спикингом (если формат) → оценка по критериям → карта/план двигаются.
3. Обещание из фидбэка основателя выполнено буквально: «где мне учиться» отвечается за 5 секунд на дашборде.
4. Миграции — файлы готовы, применение — в очереди контроллера после `130000/140000/150000` + ключа.
5. Клик-тест основателя после live-smoke.

## Open Questions (основателю)

1. `SPEAKING_LLM_MODEL` — подтвердить модель на OpenRouter (кандидаты gemini-2.5-flash / gpt-4o-audio-preview) и потолок цены ≤$0.05/ответ — live-smoke после пополнения.
2. Retention аудио-записей: храним бессрочно в MVP (голос — biometric-adjacent PII) — ок, или нужен ручной TTL как fast-follow?
3. Полностью пропущенное интервью → DEFAULT_APPROACH без персонализации — приемлемый дефолт?
4. Параллельно этапу 5 — закрытая бета (риск: этап удлиняет путь до paywall на 2–3 недели)?

## Deferrals

Эссе/writing-грейдинг (deferral этапа 2 остаётся); realtime разговорный AI-агент (спикинг асинхронный); waveform/транскоды/retention-cron; анти-чит спикинга; предгенерация micro-объяснений в банк; per-topic level-over-time таблица (история из attempts+forecasts); level из интервью не биасит сложность сборки; полный content-parts union в адаптере (только узкое audio+model); paywall на спикинге (canUseSpeaking=true заглушка); durable/Redis-лимитер; adaptive/IRT; **этап 3.6** (family/родительский отчёт) — отдельная волна; **библиотека** (design-синтез `4edb21b` переиспользуется при возврате); голосовой ввод в интервью/микро-объяснениях; **этап 6 — «любая цель обучения»** (тех-собеседования, языковые цели без формального экзамена — интервью-механизм этого этапа станет основой).
