# U-Pal Stage 3 — Knowledge Map, Weekly Plan, Forecast, Review (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Леджер: .superpowers/sdd/progress.md (секция Stage 3).

**Goal:** Попытки ученика превращаются в честную карту знаний по темам, понедельный план до даты экзамена, консервативный прогноз балла с диапазоном, разбор ошибок (включая транскрипт аудио) и цель в онбординге — всё на одном дашборде штаба.

**Architecture:** Дизайн — мульти-агентный workflow (линзы: педагогическая честность / корректность данных / цена+UX → судья) + **красная команда (3 критика, 18 находок — все интегрированы, critical обязательны)**. Три pure-модуля без LLM/supabase (mastery, план, прогноз) + один оркестратор пересчёта, вызываемый ТОЛЬКО из write-путей (submit-хук и явный POST) — **никаких записей в GET-рендере** (prefetch не должен мутировать БД). LLM ровно в одной точке — кнопка «почему я ошибся» под лимитером (последняя задача; не блокирует этап при 402).

**Основа:** синтез wf_15074c57-8ed + красная команда wf_28b9d3f4-249 (журналы сессии). Мастер-план: веха C «онбординг → диагностика → карта+план+прогноз».

## Global Constraints

- Экзамен-агностичность: темы/веса/шкала — только из `exam_profiles.spec`; все константы модели — в `src/features/knowledge/constants.ts` (не экзаменные).
- **Ноль LLM в арифметике** (карта/план/прогноз/level-0 разбор — чистые функции); LLM только explain-кнопка под module-level лимитером (проверка ДО спенда, 429-тест).
- **Записи в БД — только из write-путей** (submit-роут, POST recompute, study-hqs POST). Server-component GET не мутирует ничего.
- `tasks.answer`/`explanation` не сериализуются клиенту: (а) для незавершённых попыток, (б) для заданий, входящих в ЛЮБУЮ открытую попытку юзера (кросс-попыточный гейт — красная команда), (в) для «похожих» заданий — только `id, body` проекция.
- Пересчёт: всегда полный recompute из attempt_items (инкременты запрещены); идемпотентен; upsert-ы по unique-ключам; **`study_hqs.last_recomputed_at` — единственный watermark** (не knowledge_states.updated_at).
- Аддитивность: старые профили/штабы/тесты/попытки живут; skipped-items (response=null) не считаются сигналом.
- i18n RU/KK паритет; нейтральный Tailwind; vitest+fakes; TDD в pure-модулях и роутах.
- После каждой задачи: `npm test && npm run typecheck && npm run lint && npm run build` → commit → push. Перед началом: `git pull origin main`. Миграцию применяет контроллер (Management API) после ревью T1.

## Архитектурные решения (ОБЯЗАТЕЛЬНЫЕ; 🔴 = фикс красной команды)

### D1. Карта знаний (pure `computeKnowledgeStates`)

Ключ = PK `knowledge_states(hq_id, topic)` (фактическая схема); секция — производная группировка на чтении. Вход: attempt_items ЗАВЕРШЁННЫХ попыток hq (join attempts→tests.hq_id) + batch tasks (topic, difficulty); только answered (response != null); битые строки скипаются.

Формула (константы в constants.ts):
```
HALF_LIFE_DAYS = 45      // 🔴 было 30: один свежий промах не должен вымывать историю
RECENCY_FLOOR  = 0.15    // 🔴 старые ответы не исчезают в ноль
P0 = 0.3; K = 3          // 🔴 K=3 (было 2): единичный свежий промах не проваливает ниже приора
NMIN = 3; STALE_DAYS = 21
BAND_STRONG = 0.75; BAND_WEAK = 0.40   // 🔴 полуоткрытая конвенция: strong ⇔ level ≥ 0.75;
                                       // shaky ⇔ 0.40 ≤ level < 0.75; weak ⇔ < 0.40 — ЕДИНАЯ
                                       // функция levelToBand, переиспользуется картой И планом.
recency_i = max(0.5^(age_days/45), 0.15); diffW_i = 1 + (clamp(diff,1,5)-1)/4  // [1,2]
g_i = recency_i * diffW_i;  x_i = is_correct ? 1 : 0
level = (Σ g_i·x_i + K·P0) / (Σ g_i + K)
```
Тема с answered < NMIN → строка НЕ пишется («не изведано» = отсутствие строки). Пишем level, `answered_count`, `last_seen_at` (новые колонки). Staleness-бейдж: now − last_seen_at > 21д (на чтении). 🔴 Регресс-тест красной команды: 10 старых (120д) верных diff3 + 1 свежий неверный diff5 → level ≥ 0.40 (амбер, НЕ красный) — проверить арифметикой в тесте.

### D2. Дашборд `/hq/[hqId]` (server, БЕЗ записей)

Блоки: «Цель · Прогноз low–high · до цели» → Карта (секции→темы: бар+бэнд; «не изведано» — серый пунктир БЕЗ процента) → Текущая неделя плана → StartTestButton. Фиксированные SELECT'ы (hq+spec safeParse+parseHqConfig+target+exam_date+`last_recomputed_at`; knowledge_states; plan_weeks; последний forecast; max(finished_at)+count). 🔴 Stale-детект (`max(finished_at) > last_recomputed_at`) НЕ пересчитывает в рендере: рендерим что есть + клиентский `<RecomputeKicker/>` делает ОДИН fire-and-forget POST `/api/hq/[hqId]/recompute` → по 200 `router.refresh()` (busy-гард, не в цикле: kicker рендерится только при stale). Пустые состояния → CTA «Пройти диагностику». Мобайл: аккордеоны.

### D3. Понедельный план (pure `buildStudyPlan`)

`weeksLeft = clamp(ceil((examDate − mondayUTC(today))/7), 1, 12)`; examDate=null → 8 недель + баннер «укажите дату»; 🔴 examDate < mondayUTC(today) → план НЕ генерится, состояние `examDatePassed` (баннер «дата экзамена в прошлом — обновите»). need: нет строки → 0.8; иначе (1−level) + 0.1·stale; сортировка desc, tie-break по имени. K=3 темы/неделю, автоповышение ради полного покрытия: 🔴 каждая тема с `band !== 'strong'` (единая конвенция D1) попадает минимум в одну неделю. Последняя неделя: повтор слабейших + `suggestedTest {kind:'mock'}`. `week.topics` jsonb по `planWeekTopicsSchema` (zod, safeParse на чтении). Хранение: 🔴 `week_start` = UTC-date-строка 'yyyy-mm-dd' понедельника (не toISOString с временем); реген = 🔴 DELETE недель `week_start >= текущий понедельник` + INSERT свежего набора (горизонт точно совпадает при переносе даты; прошлые недели заморожены); upsert-защита unique(hq_id, week_start) от гонок. `status` пишется 'planned', display-статус деривируется. 🔴 Реген также при изменении exam_date/config/target (POST /api/study-hqs UPDATE-ветка зовёт recompute).

### D4. Прогноз v0 (pure `computeForecast`)

🔴 NaN-гарды: секции с 0 тем не входят ни в числитель, ни в знаменатель fraction; если активных тем 0 → null. 🔴 Гейт данных: прогноз пишется/показывается ТОЛЬКО если есть ≥1 строка knowledge_states (иначе null + CTA — «прогноз из чистого приора» запрещён). fraction = Σ w_s·meanTopic(levelOrPrior=0.3) / Σ w_s (w_s = taskCount ?? 1; только секции с темами); point = scaleScore(round(fraction·1000), 1000, spec.scoring). 🔴 Mock-калибровка в fraction-пространстве: mockFrac = (mockScaled − snap.scaleMin)/(snap.scaleMax − snap.scaleMin) по СНАПШОТУ той попытки; fractionFinal = α·avg(mockFrac) + (1−α)·fraction, α = min(0.5, 0.25·nMock); затем один scaleScore. halfWidth = span·clamp(0.35·(1−coverage) + 0.25/√max(1,nFinished), 0.05, 0.35), coverage = |темы с answered≥3| / max(1, |активные темы|). Возврат {point, low, high, confidence, coverage}. Insert append-only — 🔴 ТОЛЬКО из recompute (write-путь), с дедупом: если последний forecast совпадает по (point, low, high) — не вставлять.

### D5. Разбор ошибок

Level 0 (0 LLM): страница теста при finished-попытке грузит items + batch tasks; ReviewList рядом с ResultView: ошибки по умолчанию + тумблер «все»; вопрос/ответ юзера/правильный/explanation; audio → AudioPassage reveal=true. 🔴 Кросс-попыточный гейт: перед сериализацией собрать `openTaskIds` юзера (spec.taskIds всех его незавершённых попыток) — для заданий из этого набора answer/explanation НЕ сериализуются (плашка «задание в активном тесте»). 🔴 Похожие: ОДИН батч-запрос по различимым (type,topic) ошибок, проекция `id, body` ONLY, дедуп, cap 2/ошибку и 10 всего, исключить id попытки И openTaskIds.
Level 1 (последняя задача): кнопка «почему я ошибся» → POST `/api/attempts/[id]/items/[taskId]/explain`: auth → ownership → finished-гейт → 🔴 taskId ∉ openTaskIds → explain-limiter (10/10мин, module-level, ДО спенда) → Llm.complete({schema}) на локали юзера. Кэш-таблицы нет (YAGNI).

### D6. Цель в визарде

Шаг `goal` — 🔴 сразу ПОСЛЕ confirm (мотивирующий якорь, не терминальный): confirm → goal → variant? → selection? → date. Ввод балла с подсказкой scaleMin–scaleMax/step + «Пропустить»; Draft.target; partial-patch (`'target' in body`); study_hqs.target (text, есть). 🔴 Gap-копирайт ветками: target ∈ [low, high] → «на пути к цели»; target < low → «цель уже в кармане — поднять планку?»; target > high → «до цели ~Δ» (Δ = target − point, только положительный). target не участвует в математике прогноза.

### D7. Оркестратор и миграция

`recomputeHqInsights({hqId, now}, deps)`: полный пересчёт карта → план → прогноз(с дедупом) → 🔴 `study_hqs.last_recomputed_at = now` ВСЕГДА (даже при 0 строк карты — это и есть watermark; лечит вечный stale sub-NMIN юзеров). Вызовы: (1) submit-роут ПОСЛЕ submitAttempt, `await` в try/catch (сбой/таймаут не валит ответ — 🔴 submit-роут получает `export const maxDuration = 60`); (2) POST `/api/hq/[hqId]/recompute` (auth+ownership, идемпотентный, лёгкий лимитер 6/10мин) — kicker дашборда и ручной backfill; (3) UPDATE-ветка study-hqs (смена config/exam_date/target).

Миграция `20260709120000_stage3_knowledge_plan_forecast.sql` (одна, аддитивная):
```sql
alter table public.knowledge_states add column answered_count int not null default 0;
alter table public.knowledge_states add column last_seen_at timestamptz;
alter table public.study_plan_weeks add constraint study_plan_weeks_hq_week_unique unique (hq_id, week_start);
create index forecasts_hq_created_idx on public.forecasts (hq_id, created_at desc);
alter table public.forecasts add column point numeric;          -- 🔴 колонки point НЕТ в схеме
alter table public.forecasts add column coverage numeric;       -- 🔴 для истории/отладки
alter table public.study_hqs add column last_recomputed_at timestamptz;  -- 🔴 watermark
```
RLS: существующие политики (for all через study_hqs owner) покрывают всё; новых не нужно. database.types.ts вручную тем же коммитом. Upsert knowledge_states обязан явно слать updated_at=now() (🔴 default не срабатывает на conflict-update).

Хвосты 2.5 (в T1): rowToProfile → safeParse (битый spec деградирует, не 500); export parseHqConfig boundary-хелпер; T2-тест-бэклог generate.ts (дроп audio-passage в ретрай-батче; trim-boundary).

---

## Задачи (порядок; свежий исполнитель + ревьюер на каждую)

### Task 1: Фундамент — миграция + хвосты 2.5
**Files:** migration (SQL из D7 дословно), src/lib/supabase/database.types.ts (вручную), src/features/exam-profile/repo.ts (safeParse), selection.ts (+parseHqConfig export), src/features/tasks/generate.test.ts (бэклог-тесты), src/lib/db/migrations.test.ts (ассерты новых колонок/unique/index).
**Acceptance:** PGlite: колонки существуют, unique-конфликт ловится; битая строка exam_profiles не роняет выборку (safeParse-тест); parseHqConfig(мусор) → null; generate-тесты (дроп в ретрай-батче, 49/50+trim) зелёные; 370+ без регресса. TDD.

### Task 2: Ядро карты — pure computeKnowledgeStates
**Files:** src/features/knowledge/constants.ts, compute.ts, compute.test.ts.
**Acceptance:** свежая попытка перевешивает старую; трудное верное > лёгкого; 2/2 верных < 0.75; 🔴 регресс красной команды: 10×(верно, diff3, 120д) + 1×(неверно, diff5, 0д) → level ≥ 0.40; RECENCY_FLOOR: Σg старых ≥ N·0.15; skipped не в счёте; тема вне activeSections не считается; идемпотентность; levelToBand: границы 0.40/0.75 полуоткрыты, тест на точных значениях; ноль llm/supabase-импортов. TDD.

### Task 3: Оркестратор + submit-хук + recompute-роут
**Files:** src/features/knowledge/repo.ts, src/features/hq/recompute.ts, recompute.test.ts, src/app/api/attempts/[id]/submit/route.ts (+maxDuration=60 + try/catch-вызов), src/app/api/hq/[hqId]/recompute/route.ts (+route.test.ts + лимитер 6/10мин в src/features/hq/recompute-limiter.ts).
**Acceptance:** submit отвечает даже при выбросе из recompute; last_recomputed_at обновляется ВСЕГДА (и при 0 строк карты — тест); upsert шлёт updated_at явно (тест payload); recompute-роут: 401/403/404/429, идемпотентен; конкурентные вызовы сходятся. TDD.

### Task 4: План — pure buildStudyPlan + реген + вызов из study-hqs UPDATE
**Files:** src/features/plan/build.ts, build.test.ts, repo.ts, src/features/hq/recompute.ts (встройка), src/app/api/study-hqs/route.ts (UPDATE-ветка → recompute).
**Acceptance:** каждая non-strong тема минимум в одной неделе; детерминизм; examDate в прошлом → examDatePassed без недель; null → 8 недель+флаг; 🔴 перенос даты раньше → DELETE future+INSERT, ghost-недель нет (тест); week_start = 'yyyy-mm-dd' UTC-понедельник (тест на TZ-независимость); реген при UPDATE config/exam_date. TDD.

### Task 5: Прогноз — pure computeForecast + append с дедупом
**Files:** src/features/forecast/compute.ts, compute.test.ts, repo.ts, src/features/hq/recompute.ts (встройка).
**Acceptance:** 🔴 секция topics=[] не даёт NaN (тест!); все секции пустые → null; 🔴 0 строк карты → null (прогноз из приора запрещён); 🔴 mock-блендинг в fraction-пространстве: mock 7.0/band(0–9) при переходе профиля на 0–100 НЕ обваливает прогноз (тест из красной команды); диапазон сужается с nFinished и coverage; low/high в [scaleMin,scaleMax] с step; дедуп повторного insert. TDD.

### Task 6: Дашборд /hq/[hqId] (read-only) + RecomputeKicker
**Files:** src/app/(app)/hq/[hqId]/page.tsx, KnowledgeMap.tsx, WeekPlanCard.tsx, ForecastCard.tsx, RecomputeKicker.tsx, src/app/(app)/hq/page.tsx (линк), messages/*.
**Acceptance:** 🔴 НОЛЬ записей из рендера (нет вызова recompute в page.tsx — только kicker-POST с клиента при stale); пустые состояния → CTA; «не изведано» без процента; gap-копирайт тремя ветками; неактивные секции скрыты; StartTestButton получает 🔴 kind-проп (default diagnostic); i18n паритет; build зелёный.

### Task 7: Разбор level 0 — ReviewList + похожие + reveal
**Files:** src/app/(app)/hq/[hqId]/tests/[testId]/page.tsx, ReviewList.tsx, src/features/review/similar.ts (+test).
**Acceptance:** 🔴 тест-инвариант: в props НЕТ answer/explanation ни для (а) незавершённой попытки, (б) заданий из openTaskIds юзера, (в) похожих (только id+body); похожие — один батч, дедуп, cap 10; каждая ошибка завершённой попытки имеет разбор (вкл. неотвеченные и отсутствующие в банке — деградация); AudioPassage reveal=true только тут; ownership 403/404. TDD (similar+гейты).

### Task 8: Шаг цели в визарде (после confirm)
**Files:** src/features/onboarding/steps.ts (+test), OnboardingWizard.tsx, src/app/api/study-hqs/route.ts (+target), messages/*.
**Acceptance:** порядок confirm→goal→…; skip не шлёт target (partial-patch тест); мусор → 400; NaN у читателя → gap скрыт; существующие тесты визарда живы. TDD.

### Task 9: AI-explain по кнопке (стретч; блокируется 402)
**Files:** src/features/review/explain.ts (+test), explain-limiter.ts, src/app/api/attempts/[id]/items/[taskId]/explain/route.ts (+route.test.ts), ReviewList.tsx (кнопка).
**Acceptance:** 429 ДО спенда (fakeLlm не вызван); открытая попытка/чужая → 403 без LLM; 🔴 taskId в openTaskIds → 403; ответ на локали; graceful при 402. TDD.

## Definition of Done
1. Все задачи с ревью; 4 critical красной команды закрыты тестами (NaN-гард; forecasts.point в схеме; watermark last_recomputed_at + ноль записей в GET; body-only похожие + кросс-попыточный гейт).
2. Живой цикл: диагностика → карта с честными состояниями → план недель → прогноз с диапазоном (или честный null) на дашборде; разбор ошибок с транскриптом аудио.
3. Миграция применена к живой БД; legacy-попытки подхвачены kicker-backfill'ом.
4. Прод-smoke + клик-тест основателя (после пополнения OpenRouter — полный, до него — всё кроме генерации новых тестов/explain).

## Open Questions (основателю)
1. Константы модели (полураспад 45д, приор 0.3, NMIN=3, бэнды 0.40/0.75) — ревизия после клик-теста на реальных данных.
2. Волна 3.6 (отчёт родителю): email-провайдер + Vercel Cron — отдельное решение.
3. OpenRouter-кредиты (T9 + прод-генерация).

## Deferrals
3.6 family/отчёты (отдельная волна); топик-таргетированная сборка; кэш explain; IRT/ML; decay-cron; DELETE неактивных строк карты; ручное редактирование плана; экстраполяция тренда; всё из Deferrals 2/2.5.
