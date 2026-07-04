# U-Pal MVP — мастер-план построения

> **For agentic workers:** это мастер-план (декомпозиция). Перед выполнением каждого этапа генерируется детальный executable-план этапа (формат superpowers:writing-plans, с TDD-шагами и кодом) в `docs/superpowers/plans/`. REQUIRED SUB-SKILL при выполнении: superpowers:subagent-driven-development или superpowers:executing-plans.

**Goal:** Работающий MVP U-Pal — экзамен-агностик платформа: пользователь называет любой экзамен → AI исследует его в интернете → профиль экзамена → штаб (план, тесты в формате экзамена, карта знаний, прогноз, отчёт родителю) + открытая библиотека профилей и хабов + запись всех данных под скоринг.

**Architecture:** Next.js-монолит (App Router) поверх Supabase (Postgres + Auth + Storage), деплой Vercel. Вся AI-логика — за двумя адаптерами: `lib/llm` (провайдер LLM) и `lib/search` (веб-поиск), чтобы выбор OpenRouter/Claude API не трогал продуктовый код. Домен разложен по `src/features/*` — по одной фиче на директорию, тонкие route handlers.

**Tech Stack:** Next.js (TypeScript, App Router) · Tailwind · Supabase (Postgres, Auth, Storage) · Vercel · vitest + Playwright · zod · next-intl (RU/KZ) · LLM: OpenRouter **или** Anthropic API (см. Decision Points) · web search: Tavily/Serper **или** Anthropic web search tool.

**Спека:** [../../product-plan.md](../../product-plan.md) — v2, экзамен-агностик.

## Global Constraints

- Экзамен-агностичность: ни одной захардкоженной константы конкретного экзамена в продуктовом коде — всё из `exam_profiles.spec`.
- i18n RU/KZ на каждом экране с первого дня (`next-intl`); язык контента = язык экзамена.
- Каждый ответ на каждое задание пишется в `attempt_items` — с первого дня, без исключений (актив слоя 3).
- Каждый AI-выход валидируется zod-схемой; невалидный выход = ретрай, не падение.
- Каждый AI-созданный профиль экзамена хранит ссылки на источники (`sources`) и метку доверия (`trust`).
- LLM-провайдер и поисковик — только через адаптеры `lib/llm` / `lib/search`; прямых вызовов SDK в фичах нет.
- TDD, коммит на задачу; каждый этап заканчивается работающим срезом в проде.

## Decision Points (решить к указанному этапу)

| Решение | Варианты | Срок |
|---|---|---|
| LLM-провайдер | OpenRouter (гибкость моделей, один API) vs Anthropic API (web search tool из коробки, prompt caching) | этап 0 (адаптер позволяет менять и позже) |
| Web search | Tavily / Serper / Anthropic web search tool | этап 1 |
| Прогретые экзамены (3–5) | кандидаты: ЕНТ, IELTS, DTM, НИШ/КТЛ | этап 1 |
| Платёжный провайдер KZ | Kaspi Pay / Paybox / карта-эквайринг | этап 5 |
| Бренд/домен | — | этап 5 |

---

## Структура кодовой базы

```
upalhub/
  src/
    app/
      (marketing)/page.tsx          # лендинг «Назови свой экзамен»
      (app)/
        onboarding/                 # назвать экзамен → диагностика → план
        hq/[hqId]/                  # штаб: обзор, план, тесты, карта знаний
        hq/[hqId]/test/[testId]/    # прохождение теста
        library/                    # каталог профилей и хабов
        library/hub/[hubId]/
        parent/                     # кабинет родителя
        settings/billing/
      api/                          # route handlers (тонкие)
    features/
      exam-profile/                 # research-пайплайн, схема профиля, trust
      testing/                      # генерация заданий, сборка теста, скоринг
      knowledge-map/                # агрегация attempt_items → карта
      study-plan/                   # генерация/пересчёт плана
      forecast/                     # прогноз v0 (эвристика)
      library/                      # хабы: публикация, клон, звёзды
      family/                       # родитель ↔ ученик, приглашения
      reports/                      # еженедельный отчёт родителю
      billing/                      # freemium-гейты, подписка
    lib/
      llm/                          # интерфейс + провайдеры openrouter|anthropic + fake для тестов
      search/                       # интерфейс + tavily|serper|anthropic + fake
      supabase/                     # клиенты (server/browser), типы БД
      i18n/
  supabase/migrations/
  evals/exam-profiles/              # golden-профили известных экзаменов
  tests/                            # e2e (Playwright)
```

Ключевые интерфейсы адаптеров (фиксируются на этапе 0):

```ts
// lib/llm/index.ts
export interface Llm {
  complete<T>(args: { system?: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<T>
}
// lib/search/index.ts
export interface WebSearch {
  search(query: string, opts?: { limit?: number }): Promise<{ url: string; title: string; snippet: string }[]>
  fetchPage(url: string): Promise<string>   // очищенный текст
}
```

---

## Схема данных (ядро, Postgres)

```sql
-- пользователи: auth.users (Supabase) + расширение
create table profiles (
  id uuid primary key references auth.users,
  display_name text, locale text not null default 'ru',
  is_author boolean not null default false, created_at timestamptz default now()
);

create table families (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references profiles(id), created_at timestamptz default now()
);
create table family_members (
  family_id uuid references families(id), student_id uuid references profiles(id),
  primary key (family_id, student_id)
);

create table exam_profiles (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,                -- 'ent-2027', 'ielts-academic'
  title text not null, language text not null,
  spec jsonb not null,                      -- секции, типы заданий, темы, шкала, тайминг (zod: ExamProfileSpec)
  sources jsonb not null default '[]',      -- [{url, title, fetched_at}]
  origin text not null check (origin in ('ai_research','uploaded','manual')),
  trust text not null default 'ai_draft' check (trust in ('ai_draft','data_refined','verified')),
  created_by uuid references profiles(id), created_at timestamptz default now()
);

create table hubs (
  id uuid primary key default gen_random_uuid(),
  exam_profile_id uuid not null references exam_profiles(id),
  owner_id uuid not null references profiles(id),
  title text not null, description text,
  origin_hub_id uuid references hubs(id),   -- клон чего
  visibility text not null default 'draft' check (visibility in ('draft','public')),
  stars_count int not null default 0, created_at timestamptz default now()
);
create table hub_stars (hub_id uuid references hubs(id), user_id uuid references profiles(id), primary key (hub_id, user_id));

create table tasks (
  id uuid primary key default gen_random_uuid(),
  exam_profile_id uuid not null references exam_profiles(id),
  hub_id uuid references hubs(id),          -- null = платформенный банк профиля
  type text not null, topic text not null, difficulty int not null,
  language text not null, body jsonb not null, answer jsonb not null, explanation text,
  origin text not null check (origin in ('ai','author','import')), created_at timestamptz default now()
);

create table study_hqs (                    -- «штаб» ученика под экзамен
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id),
  exam_profile_id uuid not null references exam_profiles(id),
  exam_date date, target text, status text not null default 'active', created_at timestamptz default now()
);

create table tests (
  id uuid primary key default gen_random_uuid(),
  hq_id uuid not null references study_hqs(id),
  kind text not null check (kind in ('diagnostic','practice','mock')),
  spec jsonb not null,                      -- какие секции/темы/сколько заданий
  created_at timestamptz default now()
);

create table attempts (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references tests(id), user_id uuid not null references profiles(id),
  started_at timestamptz default now(), finished_at timestamptz,
  raw_score numeric, scaled_score numeric   -- в шкале экзамена
);
create table attempt_items (                -- гранулярные данные = будущий скоринг
  attempt_id uuid references attempts(id), task_id uuid references tasks(id),
  answer jsonb, is_correct boolean, time_ms int,
  primary key (attempt_id, task_id)
);

create table knowledge_states (
  hq_id uuid references study_hqs(id), topic text,
  level numeric not null,                   -- 0..1
  updated_at timestamptz default now(), primary key (hq_id, topic)
);

create table study_plan_weeks (
  id uuid primary key default gen_random_uuid(),
  hq_id uuid not null references study_hqs(id),
  week_start date not null, topics jsonb not null,
  status text not null default 'planned' check (status in ('planned','current','done'))
);

create table forecasts (
  id uuid primary key default gen_random_uuid(),
  hq_id uuid not null references study_hqs(id),
  low numeric not null, high numeric not null, confidence text not null,
  created_at timestamptz default now()
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id),  -- родитель или сам готовящийся
  plan text not null, status text not null, provider text, period_end timestamptz
);

create table parent_reports (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id), student_id uuid not null references profiles(id),
  week_start date not null, body jsonb not null, sent_at timestamptz
);
```

RLS: ученик видит свои hq/attempts; родитель — данные детей своей family; публичные exam_profiles и public-хабы видны всем.

---

## Этап 0 — Фундамент (1–2 нед)

**Выход этапа:** пустое, но живое приложение в проде: регистрация, RU/KZ, миграции накатаны, CI зелёный, адаптеры готовы.

| # | Задача | Deliverable / Acceptance |
|---|---|---|
| 0.1 | Scaffold: Next.js + TS + Tailwind + vitest + Playwright + lint/prettier; GitHub Actions (typecheck, lint, test); деплой Vercel | CI зелёный на пустом проекте; прод-URL открывается |
| 0.2 | Supabase: проект, миграционный тулинг, Auth (email OTP + Google), таблица `profiles`, RLS-базис | Можно зарегистрироваться и войти; профиль создаётся триггером |
| 0.3 | i18n-скелет (next-intl, RU/KZ), layout shell (навигация app-зоны, marketing-зоны) | Переключение RU↔KZ работает на всех страницах скелета |
| 0.4 | Миграции ядра: все таблицы из схемы выше + типы БД в `lib/supabase` | `supabase db reset` проходит; типы генерируются |
| 0.5 | Адаптеры `lib/llm` (openrouter + anthropic + fake) и `lib/search` (tavily + fake), конфиг через env | Юнит-тесты на fake; смена провайдера = смена env |

## Этап 1 — Генератор профиля экзамена (2–3 нед) ← сердце продукта

**Выход этапа:** любой названный экзамен превращается в сохранённый профиль с источниками за минуты; повторный запрос находит существующий профиль.

| # | Задача | Deliverable / Acceptance |
|---|---|---|
| 1.1 | zod-схема `ExamProfileSpec` (секции, типы заданий, темы, шкала, тайминг, даты) — контракт всего продукта | Схема покрыта тестами на валидных/невалидных примерах |
| 1.2 | Research-пайплайн: запрос → search → fetch топ-источников → LLM-экстракция → `ExamProfileSpec` + `sources` | На «IELTS Academic» выдаёт профиль с корректной структурой и ≥2 источниками |
| 1.3 | Persist + дедуп: slug-нормализация запроса, поиск существующего профиля перед генерацией | Два пользователя с «ЕНТ 2027» получают один профиль |
| 1.4 | Загрузка примера варианта (PDF/текст) → экстракция → уточнение/создание профиля (`origin='uploaded'`) | Загруженный PDF-вариант повышает полноту профиля |
| 1.5 | UI: лендинг-инпут «Назови свой экзамен» → экран прогресса исследования → страница профиля (структура, шкала, источники, trust-badge) | Путь от инпута до страницы профиля проходится без команды |
| 1.6 | Eval-харнесс `evals/exam-profiles`: golden-профили 5–10 известных экзаменов, скрипт сравнения, отчёт | Запуск evals выдаёт метрику качества; регрессии видны |

## Этап 2 — Универсальный движок тестов (2–3 нед)

**Выход этапа:** по любому профилю можно пройти тест с таймером и получить результат в шкале этого экзамена.

| # | Задача | Deliverable / Acceptance |
|---|---|---|
| 2.1 | Генерация заданий по профилю: LLM → zod-валидация `Task` → кэш в `tasks` (банк профиля) | Повторный тест переиспользует банк, не регенерирует всё |
| 2.2 | Сборка теста из `test.spec`: выборка из банка по секциям/темам/сложности + догенерация недостающего | Диагностический и practice-тест собираются для 2 разных профилей |
| 2.3 | Прохождение: таймер по спеке, автосейв ответов, сабмит, восстановление после перезагрузки | Обновление страницы не теряет ответы |
| 2.4 | Скоринг: проверка ответов → `attempt_items` → raw → шкала профиля → `attempts.scaled_score` | Балл соответствует шкале из профиля (тест на ЕНТ- и IELTS-шкале) |
| 2.5 | Импорт готовых заданий (JSON/CSV) в банк профиля (`origin='import'`) — путь для наработок ENTprep | Импортированные задания попадают в сборку тестов |

## Этап 3 — Штаб: карта, план, AI-слой (2–3 нед)

**Выход этапа:** полный цикл ценности слоя 1: онбординг → диагностика → план → тесты → разборы → прогноз → отчёт родителю.

| # | Задача | Deliverable / Acceptance |
|---|---|---|
| 3.1 | Онбординг: экзамен (поиск/создание профиля) → дата+цель → создание `study_hq` → диагностика | Новый пользователь доходит до первого плана ≤15 мин |
| 3.2 | Knowledge map: агрегация `attempt_items` по темам → `knowledge_states`; экран карты (не знает/нестабильно/владеет) | Карта меняется после каждого теста |
| 3.3 | Study plan: генерация понедельного плана (карта × темы профиля × время до даты); пересчёт после теста | План покрывает все слабые темы до даты экзамена |
| 3.4 | AI-разбор ошибок: по `attempt_items` — объяснение на языке пользователя + похожие задания на закрепление | Разбор доступен для каждой ошибки завершённой попытки |
| 3.5 | Forecast v0: эвристика (карта × веса тем × калибровка на mock-результатах) → диапазон + уверенность | Прогноз показывается диапазоном, сужается с числом попыток |
| 3.6 | Family + отчёт: приглашение родителя, дашборд родителя, еженедельный отчёт (cron → `parent_reports` → email) | Родитель получает письмо с отчётом за неделю |

## Этап 4 — Библиотека (2 нед)

**Выход этапа:** автор публикует хаб; пользователь находит экзамен в каталоге вместо создания заново.

| # | Задача | Deliverable / Acceptance |
|---|---|---|
| 4.1 | Каталог: публичные профили экзаменов + хабы, поиск и фильтры (экзамен, язык) | Профиль, созданный одним пользователем, находится другим через каталог |
| 4.2 | Страница хаба + звёзды | Звезда меняет `stars_count`, сортировка по звёздам |
| 4.3 | Клонирование хаба (метаданные + задания, `origin_hub_id`) | Клон редактируем независимо от оригинала |
| 4.4 | Редактор хаба: метаданные + CRUD заданий (`origin='author'`) + публикация | Внешний автор публикует хаб без помощи команды |
| 4.5 | Trust-механика профилей: badge (AI-черновик / уточнён данными / верифицирован), «открыт пользователем X» | Badge виден в каталоге и на странице профиля |

## Этап 5 — Монетизация и запуск (2 нед)

**Выход этапа:** MVP в проде, можно вести платный трафик.

| # | Задача | Deliverable / Acceptance |
|---|---|---|
| 5.1 | Freemium-гейты: открыть экзамен + диагностика бесплатно; план/разборы/прогноз/отчёты — по подписке | Бесплатный пользователь упирается в paywall в нужных местах |
| 5.2 | Платёжный провайдер (по Decision Point) + вебхуки → `subscriptions` | Тестовая оплата активирует подписку, отмена — деактивирует |
| 5.3 | Кабинет подписки (родитель платит за ученика через family) | Родитель управляет подпиской ребёнка |
| 5.4 | Лендинг «Назови свой экзамен» + SEO-страницы публичных профилей | Страницы профилей индексируемы (SSR, метатеги) |
| 5.5 | Продуктовая аналитика (PostHog): воронка онбординга, retention, конверсия в оплату | События воронки видны в дашборде |

## Этап 6 — Закрытая бета (2–4 нед, параллельно с 5)

Операционный этап, не кодовый: 10–30 пользователей (семьи из аудитории ENTprep + 2–3 не-ЕНТ экзамена для проверки универсальности), еженедельные интервью, итерации по воронке, первые платящие. Вход — после этапа 3 (ценность штаба целиком).

---

## Порядок и вехи

```
Этап 0 → 1 → 2 → 3 → [бета стартует] → 4 → 5 → публичный запуск
нед:  1-2   3-5   6-8   9-11              12-13  14-15
```

- **Веха A (нед ~5):** «любой экзамен → профиль» работает — главная гипотеза продукта проверяема.
- **Веха B (нед ~8):** тест по любому профилю — можно показывать пользователям.
- **Веха C (нед ~11):** полный штаб — старт закрытой беты.
- **Веха D (нед ~15):** paywall + запуск — старт проверки CAC/LTV.

Критерии успеха MVP — в спеке ([product-plan.md](../../product-plan.md) §4); продуктовый план после MVP — там же, §6 (экономика KZ → рейтинг по исходам → DTM/UZ → per-seat центры → скоринг v1).

## Как выполняется этот план

Перед стартом каждого этапа: по этому мастер-плану пишется детальный executable-план этапа (superpowers:writing-plans — TDD-шаги, полный код, точные команды) → выполняется задача за задачей (superpowers:subagent-driven-development или executing-plans) → verify → commit. Первый на очереди — executable-план этапа 0, пишется по команде основателя «начинаем строить».
