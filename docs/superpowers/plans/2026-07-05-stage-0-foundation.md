# U-Pal Stage 0 — Foundation Implementation Plan

> **СТАТУС 2026-07-05:** Tasks 1, 2, 6, 8, 9 — ✅ выполнены (CI зелёный, 20 тестов).
> Офлайн-части Tasks 3, 4, 5, 7 — ✅ код написан: supabase-клиенты + env-guard + proxy (бывш. middleware), страницы /sign-in и /hq (i18n), обе SQL-миграции лежат в `supabase/migrations/`.
> ⏸ Ждут доступов: `supabase login/link/db push/gen types` (Tasks 3–4, 7), e2e-проверка OTP (Task 5), Vercel-деплой (Task 10). Блокер: у основателя нет прав в организации Supabase «Foustie» — нужно создать свою организацию (Free) и проект; Vercel — личный Hobby-аккаунт.
> Примечание: в Next 16 файл middleware переименован в `src/proxy.ts` (конвенция «proxy»).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Живое пустое приложение в проде: Next.js + Supabase, регистрация по email OTP, RU/KZ i18n, все таблицы ядра накатаны, LLM/search-адаптеры покрыты тестами, CI зелёный, деплой на Vercel.

**Architecture:** Next.js-монолит (App Router, TypeScript) поверх Supabase (Postgres + Auth). Вся AI-логика за адаптерами `src/lib/llm` (OpenRouter | Anthropic, выбор через env) и `src/lib/search` (Tavily | fake). Домен позже разложится по `src/features/*`; в этапе 0 — только фундамент.

**Tech Stack:** Next.js (App Router) · TypeScript · Tailwind · vitest · Supabase (`@supabase/ssr`, CLI `supabase`) · next-intl (без locale-роутинга, локаль в cookie) · zod · OpenRouter (REST, без SDK) · Vercel · GitHub Actions.

**Мастер-план:** [2026-07-05-u-pal-mvp-roadmap.md](2026-07-05-u-pal-mvp-roadmap.md) · **Спека:** [../../product-plan.md](../../product-plan.md)

## Global Constraints

- Экзамен-агностичность: никаких констант конкретного экзамена в коде.
- i18n RU/KZ (`ru`, `kk`) с первого экрана; ключи двух локалей идентичны (пиннится тестом).
- LLM/поиск — только через адаптеры; прямых вызовов SDK/fetch в продуктовом коде нет.
- Каждый LLM-выход валидируется zod; невалидный → один ретрай с текстом ошибки.
- LLM-провайдер — **только OpenRouter** (решение основателя: прямой Claude API не подключаем, чтобы не тратить деньги). Модель задаётся `LLM_MODEL` — выбрать дешёвую на OpenRouter при подключении. Новый провайдер позже = один файл-`RawComplete` + ветка в фабрике.
- **Дизайн делает партнёр основателя** — UI в этом этапе строить нейтральным каркасом (простой Tailwind, семантическая разметка), не выдумывать палитры/шрифты/декор; макеты партнёра интегрируются позже заменой токенов и стилей.
- Секреты только в `.env.local` (в `.gitignore`) и Vercel env; в репо — `.env.example` c пустыми значениями.
- После каждой задачи: коммит + `git push origin main`.
- ОС разработчика — Windows: команды в PowerShell-совместимой форме.

## Предусловия (действия основателя, вне плана)

1. Аккаунт Supabase + создать проект `upal` (region ближе к KZ, например Frankfurt) — записать `Project ref`, `anon key`, URL.
2. В Supabase Dashboard → Authentication → Email: включить провайдер Email; в шаблон "Magic Link" добавить `{{ .Token }}` (чтобы письмо содержало 6-значный код).
3. Аккаунт Vercel (Task 10 — интерактивный `vercel login`).
4. Ключ `OPENROUTER_API_KEY` (Task 8 — тесты работают на fake, живой ключ нужен только для smoke; можно отложить).

---

### Task 1: Scaffold Next.js + тулинг

**Files:**
- Create: весь скелет Next.js (create-next-app в корне репо; `docs/` и `.git` в allowlist — не мешают)
- Create: `vitest.config.ts`, `.prettierrc`, `src/lib/health.ts`, `src/lib/health.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: команды `npm run dev|build|lint|test|typecheck`; алиас `@/*` → `src/*`.

- [ ] **Step 1: Scaffold**

```powershell
npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes
```

Expected: проект создан в текущей директории без ошибок (существующие `docs/`, `.git` допустимы).

- [ ] **Step 2: Dev-зависимости и скрипты**

```powershell
npm i -D vitest prettier
npm i zod
```

В `package.json` → `scripts` добавить:

```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 3: vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

- [ ] **Step 4: Первый тест (проверка пайплайна)**

`src/lib/health.ts`:

```ts
export const APP_NAME = "U-Pal";
export function healthcheck(): { ok: true; app: string } {
  return { ok: true, app: APP_NAME };
}
```

`src/lib/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { healthcheck } from "./health";

describe("healthcheck", () => {
  it("returns ok", () => {
    expect(healthcheck()).toEqual({ ok: true, app: "U-Pal" });
  });
});
```

- [ ] **Step 5: Проверить всё**

```powershell
npm run typecheck; npm run lint; npm test; npm run build
```

Expected: все четыре команды зелёные.

- [ ] **Step 6: Commit + push**

```powershell
git add -A; git commit -m "feat: scaffold Next.js app with vitest tooling"; git push origin main
```

---

### Task 2: CI (GitHub Actions)

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: CI на каждый push/PR в `main`: typecheck → lint → test → build.

- [ ] **Step 1: Workflow**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

- [ ] **Step 2: Commit + push, проверить зелёный прогон**

```powershell
git add .github; git commit -m "ci: typecheck, lint, test, build on push"; git push origin main
gh run watch
```

Expected: workflow завершился `success`.

---

### Task 3: Supabase — линк проекта, env, клиенты

**Files:**
- Create: `supabase/` (CLI init), `.env.local`, `.env.example`
- Create: `src/lib/supabase/browser.ts`, `src/lib/supabase/server.ts`, `src/middleware.ts`

**Interfaces:**
- Produces: `supabaseBrowser(): SupabaseClient` (client components), `supabaseServer(): Promise<SupabaseClient>` (server components/route handlers); middleware, освежающий сессию.
- Consumes: env `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

- [ ] **Step 1: CLI и линк** (интерактивно — потребуется логин основателя)

```powershell
npm i -D supabase
npm i @supabase/supabase-js @supabase/ssr
npx supabase init
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
```

- [ ] **Step 2: env-файлы**

`.env.example` (коммитится):

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
LLM_PROVIDER=openrouter
LLM_MODEL=
OPENROUTER_API_KEY=
TAVILY_API_KEY=
```

`.env.local` — те же ключи с реальными значениями Supabase. Проверить, что `.env*` в `.gitignore` (create-next-app добавляет `.env*`; убедиться, что `!.env.example` разрешён или переименовать в `env.example`).

- [ ] **Step 3: Клиенты**

`src/lib/supabase/browser.ts`:

```ts
import { createBrowserClient } from "@supabase/ssr";

export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

`src/lib/supabase/server.ts`:

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function supabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (all) => {
          try {
            all.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // вызвано из Server Component — сессию обновит middleware
          }
        },
      },
    },
  );
}
```

`src/middleware.ts` (стандартный supabase session refresh):

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (all) => {
          all.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          all.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );
  await supabase.auth.getUser(); // освежает токен, если истёк
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
```

- [ ] **Step 4: Проверка**

```powershell
npm run typecheck; npm run build
```

Expected: зелёно (клиенты пока никем не используются — это нормально).

- [ ] **Step 5: Commit + push**

```powershell
git add -A; git commit -m "feat: supabase clients, session middleware, env plumbing"; git push origin main
```

---

### Task 4: Миграция profiles + auth-триггер + RLS

**Files:**
- Create: `supabase/migrations/<timestamp>_profiles.sql`

**Interfaces:**
- Produces: таблица `public.profiles` (создаётся автоматически при регистрации), базовые RLS-политики.

- [ ] **Step 1: Миграция**

```powershell
npx supabase migration new profiles
```

Содержимое файла:

```sql
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  locale text not null default 'ru',
  is_author boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "own profile read" on public.profiles
  for select using (auth.uid() = id);
create policy "own profile update" on public.profiles
  for update using (auth.uid() = id);

create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

- [ ] **Step 2: Накатить и сгенерировать типы**

```powershell
npx supabase db push
npx supabase gen types typescript --linked | Out-File -Encoding utf8 src/lib/supabase/database.types.ts
```

Expected: `db push` применил миграцию; файл типов содержит `profiles`.

- [ ] **Step 3: Commit + push**

```powershell
git add -A; git commit -m "feat: profiles table with auth trigger and RLS"; git push origin main
```

---

### Task 5: Auth — email OTP, защищённая зона

**Files:**
- Create: `src/app/(marketing)/sign-in/page.tsx`, `src/app/(app)/hq/page.tsx`, `src/app/(app)/layout.tsx`
- Modify: `src/app/page.tsx` (ссылка на /sign-in)

**Interfaces:**
- Consumes: `supabaseBrowser()` (Task 3).
- Produces: маршрут `/sign-in` (email → код → сессия), `/hq` — редирект на `/sign-in`, если нет пользователя.

- [ ] **Step 1: Страница входа**

`src/app/(marketing)/sign-in/page.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true },
    });
    if (error) setError(error.message);
    else setStage("code");
  }

  async function verify() {
    setError(null);
    const { error } = await supabaseBrowser().auth.verifyOtp({
      email,
      token: code,
      type: "email",
    });
    if (error) setError(error.message);
    else router.push("/hq");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      {stage === "email" ? (
        <>
          <input
            className="rounded border p-2"
            type="email"
            placeholder="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="rounded bg-black p-2 text-white" onClick={sendCode}>
            Получить код
          </button>
        </>
      ) : (
        <>
          <input
            className="rounded border p-2"
            inputMode="numeric"
            placeholder="код из письма"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="rounded bg-black p-2 text-white" onClick={verify}>
            Войти
          </button>
        </>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 2: Защищённая зона**

`src/app/(app)/layout.tsx`:

```tsx
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/sign-in");
  return <>{children}</>;
}
```

`src/app/(app)/hq/page.tsx`:

```tsx
import { supabaseServer } from "@/lib/supabase/server";

export default async function HqPage() {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  return (
    <main className="p-6">
      <h1 className="text-xl font-semibold">Штаб</h1>
      <p className="text-sm text-gray-500">{data.user?.email}</p>
    </main>
  );
}
```

- [ ] **Step 3: Ручная проверка**

```powershell
npm run dev
```

Пройти: `/sign-in` → email → код из письма → редирект на `/hq` с email на экране. Открыть `/hq` в приватном окне → редирект на `/sign-in`. Проверить в Supabase Dashboard, что в `profiles` появилась строка (триггер Task 4).

- [ ] **Step 4: Commit + push**

```powershell
git add -A; git commit -m "feat: email OTP sign-in and protected app shell"; git push origin main
```

---

### Task 6: i18n RU/KZ (next-intl, локаль в cookie)

**Files:**
- Create: `messages/ru.json`, `messages/kk.json`, `src/i18n/request.ts`, `src/i18n/locales.ts`, `src/i18n/messages.test.ts`, `src/components/locale-switcher.tsx`, `src/app/actions/set-locale.ts`
- Modify: `next.config.ts`, `src/app/layout.tsx`, страницы из Task 5 (тексты через `useTranslations`/`getTranslations`)

**Interfaces:**
- Produces: `t("...")` во всех компонентах; смена локали — server action `setLocale(locale)` пишет cookie `NEXT_LOCALE`.

- [ ] **Step 1: Failing test — паритет ключей локалей**

`src/i18n/messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import ru from "../../messages/ru.json";
import kk from "../../messages/kk.json";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v !== null && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("locale messages", () => {
  it("ru and kk have identical key sets", () => {
    expect(keys(kk).sort()).toEqual(keys(ru).sort());
  });
  it("has at least the shell keys", () => {
    expect(keys(ru)).toEqual(expect.arrayContaining(["shell.appName", "auth.getCode", "auth.signIn"]));
  });
});
```

Run: `npm test` → Expected: FAIL (файлов messages нет).

- [ ] **Step 2: Установка и конфигурация**

```powershell
npm i next-intl
```

`messages/ru.json`:

```json
{
  "shell": { "appName": "U-Pal" },
  "auth": { "getCode": "Получить код", "signIn": "Войти", "emailPlaceholder": "email", "codePlaceholder": "код из письма" },
  "hq": { "title": "Штаб" }
}
```

`messages/kk.json`:

```json
{
  "shell": { "appName": "U-Pal" },
  "auth": { "getCode": "Код алу", "signIn": "Кіру", "emailPlaceholder": "email", "codePlaceholder": "хаттағы код" },
  "hq": { "title": "Штаб" }
}
```

`src/i18n/locales.ts`:

```ts
export const locales = ["ru", "kk"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "ru";
```

`src/i18n/request.ts`:

```ts
import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { defaultLocale, locales, type Locale } from "./locales";

export default getRequestConfig(async () => {
  const store = await cookies();
  const fromCookie = store.get("NEXT_LOCALE")?.value;
  const locale: Locale = locales.includes(fromCookie as Locale)
    ? (fromCookie as Locale)
    : defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
```

`next.config.ts`:

```ts
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
const nextConfig: NextConfig = {};

export default withNextIntl(nextConfig);
```

`src/app/layout.tsx` — обернуть в провайдер:

```tsx
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Переключатель локали**

`src/app/actions/set-locale.ts`:

```ts
"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { locales, type Locale } from "@/i18n/locales";

export async function setLocale(locale: Locale) {
  if (!locales.includes(locale)) return;
  (await cookies()).set("NEXT_LOCALE", locale, { maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/");
}
```

`src/components/locale-switcher.tsx`:

```tsx
"use client";
import { useLocale } from "next-intl";
import { setLocale } from "@/app/actions/set-locale";
import { locales, type Locale } from "@/i18n/locales";

export function LocaleSwitcher() {
  const current = useLocale();
  return (
    <div className="flex gap-2 text-sm">
      {locales.map((l) => (
        <button
          key={l}
          className={l === current ? "font-bold underline" : ""}
          onClick={() => setLocale(l as Locale)}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Перевести страницы Task 5 на `useTranslations("auth")` / `getTranslations("hq")` и добавить `<LocaleSwitcher />` в оба layout.**

- [ ] **Step 5: Проверка**

```powershell
npm test; npm run typecheck; npm run build
```

Expected: тест паритета зелёный; вручную — переключение RU↔KK меняет тексты на `/sign-in` и `/hq`.

- [ ] **Step 6: Commit + push**

```powershell
git add -A; git commit -m "feat: RU/KZ i18n with cookie locale and switcher"; git push origin main
```

---

### Task 7: Миграция ядра (все таблицы домена)

**Files:**
- Create: `supabase/migrations/<timestamp>_core_schema.sql`

**Interfaces:**
- Produces: все таблицы из мастер-плана; типы в `database.types.ts` обновлены.

- [ ] **Step 1: Миграция**

```powershell
npx supabase migration new core_schema
```

Содержимое — SQL «Схема данных (ядро)» из мастер-плана **дословно**, за вычетом `profiles` (уже есть): `families`, `family_members`, `exam_profiles`, `hubs`, `hub_stars`, `tasks`, `study_hqs`, `tests`, `attempts`, `attempt_items`, `knowledge_states`, `study_plan_weeks`, `forecasts`, `subscriptions`, `parent_reports`. Плюс RLS:

```sql
alter table public.exam_profiles enable row level security;
create policy "public exam profiles" on public.exam_profiles for select using (true);
create policy "authenticated create exam profiles" on public.exam_profiles
  for insert with check (auth.uid() is not null);

alter table public.hubs enable row level security;
create policy "public hubs readable" on public.hubs
  for select using (visibility = 'public' or owner_id = auth.uid());
create policy "own hubs write" on public.hubs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.study_hqs enable row level security;
create policy "own hq" on public.study_hqs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.attempts enable row level security;
create policy "own attempts" on public.attempts
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
-- остальные таблицы: включить RLS + политики по владельцу через связку с study_hqs/families
-- (tests, attempt_items, knowledge_states, study_plan_weeks, forecasts — через exists(select 1 from study_hqs ...))
```

Для каждой из связанных таблиц написать явную политику вида:

```sql
alter table public.tests enable row level security;
create policy "own tests" on public.tests
  for all using (exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid()))
  with check (exists (select 1 from public.study_hqs h where h.id = hq_id and h.user_id = auth.uid()));
```

(аналогично `attempt_items` через `attempts`, `knowledge_states`/`study_plan_weeks`/`forecasts` через `study_hqs`, `family_members`/`parent_reports` через `families.parent_id = auth.uid()`, `hub_stars` по `user_id = auth.uid()`, `tasks` — select для всех, insert для аутентифицированных, `subscriptions` по `owner_id`).

- [ ] **Step 2: Накатить, обновить типы, проверить**

```powershell
npx supabase db push
npx supabase gen types typescript --linked | Out-File -Encoding utf8 src/lib/supabase/database.types.ts
npm run typecheck
```

Expected: миграция применена; в типах есть `exam_profiles`, `attempt_items` и остальные.

- [ ] **Step 3: Commit + push**

```powershell
git add -A; git commit -m "feat: core domain schema (exam profiles, hubs, attempts, forecasts)"; git push origin main
```

---

### Task 8: Адаптер `lib/llm` (TDD)

**Files:**
- Create: `src/lib/llm/types.ts`, `src/lib/llm/fake.ts`, `src/lib/llm/json.ts`, `src/lib/llm/provider.ts`, `src/lib/llm/openrouter.ts`, `src/lib/llm/index.ts`
- Test: `src/lib/llm/json.test.ts`, `src/lib/llm/provider.test.ts`, `src/lib/llm/fake.test.ts`, `src/lib/llm/index.test.ts`

**Interfaces:**
- Produces:
  - `interface Llm { complete<T>(args: { system?: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<T> }`
  - `createLlm(env?: NodeJS.ProcessEnv): Llm` — сейчас единственный провайдер `openrouter`; модель из `LLM_MODEL`.
  - `fakeLlm(responses: unknown[]): Llm` — для тестов всех будущих фич.
- Consumes: env `LLM_PROVIDER`, `LLM_MODEL`, `OPENROUTER_API_KEY`.

- [ ] **Step 1: Типы**

`src/lib/llm/types.ts`:

```ts
import type { z } from "zod";

export interface LlmCompleteArgs<T> {
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface Llm {
  complete<T>(args: LlmCompleteArgs<T>): Promise<T>;
}

export type RawComplete = (args: {
  system?: string;
  prompt: string;
  maxTokens?: number;
}) => Promise<string>;
```

- [ ] **Step 2: Failing tests — extractJson**

`src/lib/llm/json.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { extractJson } from "./json";

describe("extractJson", () => {
  it("parses bare json object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses json wrapped in prose and code fences", () => {
    expect(extractJson('Вот ответ:\n```json\n{"a":1}\n```\nготово')).toEqual({ a: 1 });
  });
  it("parses arrays", () => {
    expect(extractJson("prefix [1,2,3] suffix")).toEqual([1, 2, 3]);
  });
  it("throws when no json present", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});
```

Run: `npm test` → Expected: FAIL (`./json` не существует).

- [ ] **Step 3: Реализация extractJson**

`src/lib/llm/json.ts`:

```ts
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = fenced ? fenced[1] : text;
  const match = source.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error("no JSON found in LLM output");
  return JSON.parse(match[0]);
}
```

Run: `npm test` → Expected: PASS.

- [ ] **Step 4: Failing tests — provider wrapper (валидация + один ретрай)**

`src/lib/llm/provider.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { llmFromRaw } from "./provider";

const schema = z.object({ name: z.string() });

describe("llmFromRaw", () => {
  it("parses valid output on first try", async () => {
    const raw = vi.fn().mockResolvedValue('{"name":"ЕНТ"}');
    const llm = llmFromRaw(raw);
    await expect(llm.complete({ prompt: "p", schema })).resolves.toEqual({ name: "ЕНТ" });
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("retries once with error feedback on invalid output", async () => {
    const raw = vi
      .fn()
      .mockResolvedValueOnce('{"wrong":true}')
      .mockResolvedValueOnce('{"name":"IELTS"}');
    const llm = llmFromRaw(raw);
    await expect(llm.complete({ prompt: "p", schema })).resolves.toEqual({ name: "IELTS" });
    expect(raw).toHaveBeenCalledTimes(2);
    expect(raw.mock.calls[1][0].prompt).toContain("не прошёл валидацию");
  });

  it("throws after second invalid output", async () => {
    const raw = vi.fn().mockResolvedValue("garbage");
    const llm = llmFromRaw(raw);
    await expect(llm.complete({ prompt: "p", schema })).rejects.toThrow();
    expect(raw).toHaveBeenCalledTimes(2);
  });
});
```

Run: `npm test` → Expected: FAIL.

- [ ] **Step 5: Реализация wrapper**

`src/lib/llm/provider.ts`:

```ts
import type { Llm, LlmCompleteArgs, RawComplete } from "./types";
import { extractJson } from "./json";

export function llmFromRaw(raw: RawComplete): Llm {
  return {
    async complete<T>({ system, prompt, schema, maxTokens }: LlmCompleteArgs<T>): Promise<T> {
      const attempt = async (p: string): Promise<T> =>
        schema.parse(extractJson(await raw({ system, prompt: p, maxTokens })));
      try {
        return await attempt(prompt);
      } catch (e) {
        const reason = e instanceof Error ? e.message.slice(0, 300) : "unknown";
        return await attempt(
          `${prompt}\n\nПредыдущий ответ не прошёл валидацию (${reason}). Верни СТРОГО валидный JSON нужной структуры, без пояснений и без markdown.`,
        );
      }
    },
  };
}
```

Run: `npm test` → Expected: PASS.

- [ ] **Step 6: Fake + тест**

`src/lib/llm/fake.ts`:

```ts
import type { Llm } from "./types";

export function fakeLlm(responses: unknown[]): Llm {
  let i = 0;
  return {
    async complete({ schema }) {
      if (i >= responses.length) throw new Error("fakeLlm: no more queued responses");
      return schema.parse(responses[i++]);
    },
  };
}
```

`src/lib/llm/fake.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeLlm } from "./fake";

describe("fakeLlm", () => {
  it("returns queued responses validated by schema", async () => {
    const llm = fakeLlm([{ n: 1 }, { n: 2 }]);
    const schema = z.object({ n: z.number() });
    expect(await llm.complete({ prompt: "a", schema })).toEqual({ n: 1 });
    expect(await llm.complete({ prompt: "b", schema })).toEqual({ n: 2 });
    await expect(llm.complete({ prompt: "c", schema })).rejects.toThrow("no more");
  });
});
```

Run: `npm test` → Expected: PASS.

- [ ] **Step 7: Провайдер OpenRouter**

`src/lib/llm/openrouter.ts` (OpenAI-совместимый REST, без SDK):

```ts
import type { RawComplete } from "./types";

export function openRouterRaw(opts: { apiKey: string; model: string }): RawComplete {
  return async ({ system, prompt, maxTokens }) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: maxTokens ?? 16000,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0].message.content;
  };
}
```

- [ ] **Step 8: Failing test — фабрика**

`src/lib/llm/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createLlm } from "./index";

const okEnv = {
  LLM_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "k",
  LLM_MODEL: "some/model",
} as NodeJS.ProcessEnv;

describe("createLlm", () => {
  it("creates openrouter llm from env", () => {
    expect(() => createLlm(okEnv)).not.toThrow();
  });
  it("defaults provider to openrouter when unset", () => {
    expect(() =>
      createLlm({ OPENROUTER_API_KEY: "k", LLM_MODEL: "some/model" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
  it("throws on missing key", () => {
    expect(() =>
      createLlm({ LLM_PROVIDER: "openrouter", LLM_MODEL: "some/model" } as NodeJS.ProcessEnv),
    ).toThrow("OPENROUTER_API_KEY");
  });
  it("throws on missing model", () => {
    expect(() =>
      createLlm({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" } as NodeJS.ProcessEnv),
    ).toThrow("LLM_MODEL");
  });
  it("throws on unknown provider", () => {
    expect(() => createLlm({ LLM_PROVIDER: "gpt" } as NodeJS.ProcessEnv)).toThrow("LLM_PROVIDER");
  });
});
```

Run: `npm test` → Expected: FAIL.

- [ ] **Step 9: Фабрика**

`src/lib/llm/index.ts`:

```ts
import { llmFromRaw } from "./provider";
import { openRouterRaw } from "./openrouter";
import type { Llm } from "./types";

export type { Llm, LlmCompleteArgs } from "./types";
export { fakeLlm } from "./fake";

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function createLlm(env: NodeJS.ProcessEnv = process.env): Llm {
  const provider = env.LLM_PROVIDER ?? "openrouter";
  if (provider === "openrouter") {
    return llmFromRaw(
      openRouterRaw({
        apiKey: required(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY"),
        model: required(env.LLM_MODEL, "LLM_MODEL"),
      }),
    );
  }
  // новый провайдер = файл с RawComplete + ветка здесь
  throw new Error(`unknown LLM_PROVIDER: ${provider}`);
}
```

Run: `npm test` → Expected: PASS. `npm run typecheck` → PASS.

- [ ] **Step 10: Commit + push**

```powershell
git add -A; git commit -m "feat: provider-agnostic LLM adapter (openrouter/anthropic) with zod validation"; git push origin main
```

---

### Task 9: Адаптер `lib/search` (TDD)

**Files:**
- Create: `src/lib/search/types.ts`, `src/lib/search/fake.ts`, `src/lib/search/strip-html.ts`, `src/lib/search/tavily.ts`, `src/lib/search/index.ts`
- Test: `src/lib/search/strip-html.test.ts`, `src/lib/search/fake.test.ts`

**Interfaces:**
- Produces:
  - `interface WebSearch { search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>; fetchPage(url: string): Promise<string> }` где `SearchResult = { url: string; title: string; snippet: string }`
  - `createSearch(env?): WebSearch` (Tavily), `fakeSearch(results, pages): WebSearch`
- Consumes: env `TAVILY_API_KEY`.

- [ ] **Step 1: Типы**

`src/lib/search/types.ts`:

```ts
export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface WebSearch {
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
  fetchPage(url: string): Promise<string>;
}
```

- [ ] **Step 2: Failing tests — stripHtml**

`src/lib/search/strip-html.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { stripHtml } from "./strip-html";

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Формат   <b>ЕНТ</b></p>\n<div>2027</div>")).toBe("Формат ЕНТ 2027");
  });
  it("drops script and style content entirely", () => {
    expect(stripHtml("<style>a{}</style>x<script>alert(1)</script>y")).toBe("x y");
  });
  it("decodes basic entities", () => {
    expect(stripHtml("a&nbsp;b &amp; c")).toBe("a b & c");
  });
});
```

Run: `npm test` → Expected: FAIL.

- [ ] **Step 3: Реализация**

`src/lib/search/strip-html.ts`:

```ts
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
```

Run: `npm test` → Expected: PASS.

- [ ] **Step 4: Fake + тест**

`src/lib/search/fake.ts`:

```ts
import type { SearchResult, WebSearch } from "./types";

export function fakeSearch(
  results: SearchResult[],
  pages: Record<string, string> = {},
): WebSearch {
  return {
    async search(_query, opts) {
      return results.slice(0, opts?.limit ?? results.length);
    },
    async fetchPage(url) {
      const page = pages[url];
      if (page === undefined) throw new Error(`fakeSearch: no page for ${url}`);
      return page;
    },
  };
}
```

`src/lib/search/fake.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fakeSearch } from "./fake";

const results = [
  { url: "https://a", title: "A", snippet: "sa" },
  { url: "https://b", title: "B", snippet: "sb" },
];

describe("fakeSearch", () => {
  it("returns limited results and pages", async () => {
    const s = fakeSearch(results, { "https://a": "text A" });
    expect(await s.search("q", { limit: 1 })).toEqual([results[0]]);
    expect(await s.fetchPage("https://a")).toBe("text A");
    await expect(s.fetchPage("https://x")).rejects.toThrow("no page");
  });
});
```

Run: `npm test` → Expected: PASS.

- [ ] **Step 5: Tavily + фабрика**

`src/lib/search/tavily.ts`:

```ts
import type { SearchResult, WebSearch } from "./types";
import { stripHtml } from "./strip-html";

export function tavilySearch(opts: { apiKey: string }): WebSearch {
  return {
    async search(query, { limit = 5 } = {}): Promise<SearchResult[]> {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, max_results: limit }),
      });
      if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as {
        results: { url: string; title: string; content: string }[];
      };
      return data.results.map((r) => ({ url: r.url, title: r.title, snippet: r.content }));
    },
    async fetchPage(url) {
      const res = await fetch(url, { headers: { "User-Agent": "U-Pal research bot" } });
      if (!res.ok) throw new Error(`fetchPage ${res.status} for ${url}`);
      return stripHtml(await res.text()).slice(0, 50_000);
    },
  };
}
```

`src/lib/search/index.ts`:

```ts
import { tavilySearch } from "./tavily";
import type { WebSearch } from "./types";

export type { WebSearch, SearchResult } from "./types";
export { fakeSearch } from "./fake";

export function createSearch(env: NodeJS.ProcessEnv = process.env): WebSearch {
  const key = env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set");
  return tavilySearch({ apiKey: key });
}
```

Run: `npm test; npm run typecheck` → Expected: PASS.

- [ ] **Step 6: Commit + push**

```powershell
git add -A; git commit -m "feat: web search adapter (tavily + fake) with html stripping"; git push origin main
```

---

### Task 10: Деплой на Vercel

**Files:**
- Create: `vercel.json` (не обязателен — только если нужны настройки), настройка через CLI

**Interfaces:**
- Produces: прод-URL; env-переменные Supabase/LLM/Tavily в Vercel.

- [ ] **Step 1: Линк и env** (интерактивно — логин основателя)

```powershell
npx vercel login
npx vercel link
npx vercel env add NEXT_PUBLIC_SUPABASE_URL production
npx vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
npx vercel env add LLM_PROVIDER production
npx vercel env add OPENROUTER_API_KEY production
npx vercel env add TAVILY_API_KEY production
```

(значения — из `.env.local`; ключи, которых ещё нет, можно добавить позже)

- [ ] **Step 2: Прод-деплой**

```powershell
npx vercel deploy --prod
```

Expected: URL выдан, открывается; `/sign-in` работает против прод-Supabase (прийти код на email, войти, увидеть `/hq`).

- [ ] **Step 3: Подключить Git-интеграцию** — в Vercel Dashboard привязать репозиторий `adletseitenov/upalhub`, чтобы каждый push в `main` деплоился автоматически.

- [ ] **Step 4: Commit + push** (если появились файлы конфигурации)

```powershell
git add -A; git commit -m "chore: vercel deployment config"; git push origin main
```

---

## Definition of Done (этап 0)

1. `npm run typecheck && npm run lint && npm test && npm run build` — зелёные локально и в CI.
2. Прод-URL открывается; регистрация по email OTP работает end-to-end; `/hq` защищён.
3. RU ↔ KZ переключается на всех экранах; тест паритета ключей зелёный.
4. `supabase db push` идемпотентен; в базе все таблицы ядра с RLS; строка в `profiles` создаётся при регистрации.
5. `createLlm`/`createSearch` собираются из env; вся логика адаптеров покрыта юнит-тестами на fake (без сетевых вызовов в тестах).
