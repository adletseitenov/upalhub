# U-Pal Stage 1 — Exam Profile Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **СТАТУС 2026-07-07:** Tasks 1–8 — ✅ выполнены субагентами (11+ коммитов, 40 юнит-тестов, CI зелёный; финальное ревью пройдено, хардненинг применён: ужесточение RLS exam_profiles, unique-индекс study_hqs, https-only источники + safeParse на публичной странице, таймаут fetchPage). Две новые миграции ждут `db push` в Task 10. ⏸ Tasks 9–10 требуют: TAVILY_API_KEY, Supabase env в .env.local, ключи в Vercel. Бэклог этапа 2 (из финал-ревью): per-user rate limit на LLM-роуты; route-level тесты 401/400/403/404; root middleware для session refresh; продуктовое решение — когда trust повышается до data_refined.

**Goal:** Сердце продукта: пользователь называет любой экзамен → AI ищет его в интернете → структурированный профиль с источниками сохраняется в библиотеку → страница профиля → кнопка «Готовиться» кладёт экзамен в штаб.

**Architecture:** Чистое ядро в `src/features/exam-profile/` (zod-схема профиля, slug, research-пайплайн, сервис) зависит только от адаптеров `lib/llm`/`lib/search` и интерфейса репозитория — всё тестируется на fake'ах без сети. Тонкий API-route (auth-gated, `maxDuration=60`) и два экрана: форма на главной и `/exams/[slug]`. Живые ключи нужны только eval-харнессу и smoke-тесту.

**Tech Stack:** уже в репо: Next.js 16, zod 4, vitest, `lib/llm` (OpenRouter), `lib/search` (Tavily), Supabase (типы `Database` подключены), next-intl RU/KK.

**Мастер-план:** [2026-07-05-u-pal-mvp-roadmap.md](2026-07-05-u-pal-mvp-roadmap.md) (задачи 1.1–1.6) · **Спека:** [../../product-plan.md](../../product-plan.md)

## Global Constraints

- Никаких констант конкретного экзамена в коде — вся специфика приходит из research и живёт в `exam_profiles.spec`.
- LLM только через `src/lib/llm` (OpenRouter), поиск только через `src/lib/search`; юнит-тесты — только на `fakeLlm`/`fakeSearch`, без сети.
- Каждый LLM-выход валидируется zod (ретрай уже в `llmFromRaw`).
- i18n RU/KK на каждом новом экране; ключи двух локалей идентичны (пиннится существующим тестом).
- Дизайн делает партнёр: нейтральный Tailwind-каркас, без палитр и декора.
- Исследование экзамена — только для авторизованных (LLM стоит денег): API возвращает 401 без сессии.
- После каждой задачи: `npm test && npm run typecheck && npm run lint` зелёные → commit → `git push origin main`.
- **Перед началом работы: `git pull origin main`** — Дияр коммитит из своей сессии.

## Предусловия (нужны только к задачам 9–10)

| Что | Где взять |
|---|---|
| `OPENROUTER_API_KEY` | openrouter.ai → Keys |
| `LLM_MODEL` | выбрать по eval-харнессу; кандидаты: `google/gemini-2.5-flash` (рекомендация: дёшево, хороший мультиязык), `deepseek/deepseek-chat`, `qwen/qwen3-235b-a22b` |
| `TAVILY_API_KEY` | tavily.com (free tier 1000 запросов/мес) |

Задачи 1–8 выполняются целиком на fake-адаптерах.

---

### Task 1: Схема профиля экзамена (`ExamProfileSpec`)

**Files:**
- Create: `src/features/exam-profile/spec.ts`
- Test: `src/features/exam-profile/spec.test.ts`

**Interfaces:**
- Produces: `examProfileSpecSchema` (zod), `type ExamProfileSpec`, `sourceRefSchema`, `type SourceRef = { url: string; title: string }`. Это контракт всего продукта — этапы 2–3 будут читать `sections`, `scoring`, `topics` отсюда.

- [ ] **Step 1: Failing test**

```ts
// src/features/exam-profile/spec.test.ts
import { describe, expect, it } from "vitest";
import { examProfileSpecSchema } from "./spec";

const valid = {
  examName: "IELTS Academic",
  language: "en",
  country: "международный",
  description: "Международный экзамен по английскому языку.",
  sections: [
    {
      name: "Listening",
      taskCount: 40,
      timeLimitMinutes: 30,
      taskTypes: ["multiple choice", "matching"],
      topics: ["everyday conversations", "academic lectures"],
    },
  ],
  scoring: { scaleMin: 0, scaleMax: 9, passingScore: null, unit: "band" },
  totalTimeMinutes: 165,
  typicalDates: "круглый год",
};

describe("examProfileSpecSchema", () => {
  it("accepts a complete valid spec", () => {
    expect(examProfileSpecSchema.parse(valid)).toMatchObject({ examName: "IELTS Academic" });
  });
  it("defaults missing taskTypes/topics to empty arrays", () => {
    const spec = examProfileSpecSchema.parse({
      ...valid,
      sections: [{ name: "Writing" }],
    });
    expect(spec.sections[0].taskTypes).toEqual([]);
    expect(spec.sections[0].topics).toEqual([]);
  });
  it("rejects spec without sections", () => {
    expect(() => examProfileSpecSchema.parse({ ...valid, sections: [] })).toThrow();
  });
  it("rejects spec without scoring unit", () => {
    expect(() =>
      examProfileSpecSchema.parse({ ...valid, scoring: { scaleMin: 0, scaleMax: 9 } }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run** `npm test -- spec` → Expected: FAIL (`./spec` не существует).

- [ ] **Step 3: Реализация**

```ts
// src/features/exam-profile/spec.ts
import { z } from "zod";

export const examSectionSchema = z.object({
  name: z.string().min(1),
  taskCount: z.number().int().positive().nullish(),
  timeLimitMinutes: z.number().positive().nullish(),
  taskTypes: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
});

export const examProfileSpecSchema = z.object({
  examName: z.string().min(1),
  language: z.string().min(2), // основной язык экзамена: "ru", "kk", "en", ...
  country: z.string().nullish(),
  description: z.string().min(1),
  sections: z.array(examSectionSchema).min(1),
  scoring: z.object({
    scaleMin: z.number(),
    scaleMax: z.number(),
    passingScore: z.number().nullish(),
    unit: z.string().min(1), // «баллов», «band», ...
  }),
  totalTimeMinutes: z.number().positive().nullish(),
  typicalDates: z.string().nullish(),
});

export type ExamProfileSpec = z.infer<typeof examProfileSpecSchema>;

export const sourceRefSchema = z.object({ url: z.url(), title: z.string() });
export type SourceRef = z.infer<typeof sourceRefSchema>;
```

- [ ] **Step 4: Run** `npm test -- spec` → PASS; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit + push**

```powershell
git add src/features; git commit -m "feat: exam profile spec schema (stage 1 contract)"; git push origin main
```

---

### Task 2: Slug запроса (`slugifyExamQuery`)

**Files:**
- Create: `src/features/exam-profile/slug.ts`
- Test: `src/features/exam-profile/slug.test.ts`

**Interfaces:**
- Produces: `slugifyExamQuery(query: string): string` — детерминированный slug для дедупликации («ЕНТ 2027» и «ент 2027» → один профиль).

- [ ] **Step 1: Failing test**

```ts
// src/features/exam-profile/slug.test.ts
import { describe, expect, it } from "vitest";
import { slugifyExamQuery } from "./slug";

describe("slugifyExamQuery", () => {
  it("transliterates russian", () => {
    expect(slugifyExamQuery("ЕНТ 2027")).toBe("ent-2027");
  });
  it("transliterates kazakh-specific letters", () => {
    expect(slugifyExamQuery("ҰБТ")).toBe("ubt");
  });
  it("normalizes latin with punctuation and case", () => {
    expect(slugifyExamQuery("  IELTS  (Academic)! ")).toBe("ielts-academic");
  });
  it("is idempotent for equivalent queries", () => {
    expect(slugifyExamQuery("ент 2027")).toBe(slugifyExamQuery("ЕНТ 2027"));
  });
  it("falls back to 'exam' for empty result", () => {
    expect(slugifyExamQuery("!!!")).toBe("exam");
  });
});
```

- [ ] **Step 2: Run** `npm test -- slug` → FAIL.

- [ ] **Step 3: Реализация**

```ts
// src/features/exam-profile/slug.ts
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ә: "a", ғ: "g", қ: "k", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h", і: "i",
};

export function slugifyExamQuery(query: string): string {
  let out = "";
  for (const ch of query.trim().toLowerCase()) out += TRANSLIT[ch] ?? ch;
  const cleaned = out
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  return cleaned || "exam";
}
```

- [ ] **Step 4: Run** `npm test -- slug` → PASS.

- [ ] **Step 5: Commit + push** (`feat: exam query slugification for profile dedup`)

---

### Task 3: Research-пайплайн (`researchExam`)

**Files:**
- Create: `src/features/exam-profile/research.ts`
- Test: `src/features/exam-profile/research.test.ts`

**Interfaces:**
- Consumes: `Llm` из `@/lib/llm`, `WebSearch` из `@/lib/search`, `examProfileSpecSchema`/`SourceRef` из Task 1.
- Produces: `researchExam(deps: { llm: Llm; search: WebSearch }, query: string): Promise<{ spec: ExamProfileSpec; sources: SourceRef[] }>` и `class ResearchError extends Error`.

- [ ] **Step 1: Failing tests**

```ts
// src/features/exam-profile/research.test.ts
import { describe, expect, it } from "vitest";
import { fakeLlm } from "@/lib/llm";
import { fakeSearch } from "@/lib/search";
import { researchExam, ResearchError } from "./research";

const specFixture = {
  examName: "ЕНТ",
  language: "kk",
  description: "Единое национальное тестирование Казахстана.",
  sections: [{ name: "Математическая грамотность", taskCount: 10 }],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

const results = [
  { url: "https://a.example", title: "A", snippet: "формат ЕНТ" },
  { url: "https://b.example", title: "B", snippet: "структура ЕНТ" },
];

describe("researchExam", () => {
  it("returns validated spec with page sources on happy path", async () => {
    const deps = {
      llm: fakeLlm([specFixture]),
      search: fakeSearch(results, {
        "https://a.example": "подробный текст страницы A про формат экзамена ".repeat(10),
        "https://b.example": "подробный текст страницы B про структуру экзамена ".repeat(10),
      }),
    };
    const { spec, sources } = await researchExam(deps, "ЕНТ");
    expect(spec.examName).toBe("ЕНТ");
    expect(sources).toEqual([
      { url: "https://a.example", title: "A" },
      { url: "https://b.example", title: "B" },
    ]);
  });

  it("falls back to snippets when pages are unreachable", async () => {
    const deps = {
      llm: fakeLlm([specFixture]),
      search: fakeSearch(results, {}), // fetchPage бросает для любого url
    };
    const { sources } = await researchExam(deps, "ЕНТ");
    expect(sources.map((s) => s.url)).toEqual(["https://a.example", "https://b.example"]);
  });

  it("throws ResearchError when search finds nothing", async () => {
    const deps = { llm: fakeLlm([specFixture]), search: fakeSearch([]) };
    await expect(researchExam(deps, "abcdefg")).rejects.toThrow(ResearchError);
  });
});
```

- [ ] **Step 2: Run** `npm test -- research` → FAIL.

- [ ] **Step 3: Реализация**

```ts
// src/features/exam-profile/research.ts
import type { Llm } from "@/lib/llm";
import type { WebSearch, SearchResult } from "@/lib/search";
import { examProfileSpecSchema, type ExamProfileSpec, type SourceRef } from "./spec";

const MAX_PAGES = 3;
const PAGE_CHARS = 8_000;

export class ResearchError extends Error {}

const SYSTEM_PROMPT = `Ты — исследователь экзаменов. По материалам из интернета ты составляешь
структурированный профиль экзамена. Отвечай ТОЛЬКО валидным JSON без markdown и пояснений.
Если чего-то нет в материалах — используй null, не выдумывай точные числа.`;

function buildPrompt(query: string, context: string): string {
  return `Составь профиль экзамена по запросу: "${query}".

Материалы из интернета:
${context}

Верни JSON строго такой структуры:
{
  "examName": "официальное название экзамена",
  "language": "основной язык экзамена (код: ru/kk/en/uz/...)",
  "country": "страна или 'международный' (или null)",
  "description": "1-2 предложения: что это за экзамен и для чего",
  "sections": [{
    "name": "название секции/предмета",
    "taskCount": число заданий или null,
    "timeLimitMinutes": лимит времени секции в минутах или null,
    "taskTypes": ["типы заданий"],
    "topics": ["основные темы"]
  }],
  "scoring": { "scaleMin": число, "scaleMax": число, "passingScore": число или null, "unit": "единица шкалы" },
  "totalTimeMinutes": общее время в минутах или null,
  "typicalDates": "когда обычно проводится (или null)"
}`;
}

async function collectPages(search: WebSearch, results: SearchResult[]) {
  const pages: { url: string; title: string; text: string }[] = [];
  for (const r of results) {
    if (pages.length >= MAX_PAGES) break;
    try {
      const text = (await search.fetchPage(r.url)).slice(0, PAGE_CHARS);
      if (text.length > 200) pages.push({ url: r.url, title: r.title, text });
    } catch {
      // страница не открылась — пробуем следующую
    }
  }
  return pages;
}

export async function researchExam(
  deps: { llm: Llm; search: WebSearch },
  query: string,
): Promise<{ spec: ExamProfileSpec; sources: SourceRef[] }> {
  const queries = [
    `${query} формат структура экзамена`,
    `${query} exam format structure scoring`,
  ];
  const found = (
    await Promise.all(queries.map((q) => deps.search.search(q, { limit: 5 })))
  ).flat();
  const unique = [...new Map(found.map((r) => [r.url, r])).values()];
  if (unique.length === 0) throw new ResearchError(`ничего не найдено по запросу: ${query}`);

  const pages = await collectPages(deps.search, unique);
  const usedSnippets = pages.length === 0;
  const context = usedSnippets
    ? unique
        .slice(0, 8)
        .map((r, i) => `### Сниппет ${i + 1}: ${r.title}\n${r.url}\n${r.snippet}`)
        .join("\n\n")
    : pages
        .map((p, i) => `### Источник ${i + 1}: ${p.title}\n${p.url}\n${p.text}`)
        .join("\n\n");

  const spec = await deps.llm.complete({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(query, context),
    schema: examProfileSpecSchema,
    maxTokens: 8_000,
  });

  const sources: SourceRef[] = (usedSnippets ? unique.slice(0, 8) : pages).map((p) => ({
    url: p.url,
    title: p.title,
  }));
  return { spec, sources };
}
```

- [ ] **Step 4: Run** `npm test -- research` → PASS (все 3 теста).

- [ ] **Step 5: Commit + push** (`feat: exam research pipeline (search -> fetch -> llm -> spec)`)

---

### Task 4: Репозиторий и сервис (`findOrCreateExamProfile`)

**Files:**
- Create: `src/features/exam-profile/service.ts`, `src/features/exam-profile/repo.ts`
- Test: `src/features/exam-profile/service.test.ts`

**Interfaces:**
- Consumes: `researchExam`, `slugifyExamQuery`, типы Task 1.
- Produces:
  - `interface ExamProfileRepo { findBySlug(slug: string): Promise<StoredExamProfile | null>; insert(p: NewExamProfile): Promise<StoredExamProfile> }`
  - `type StoredExamProfile = NewExamProfile & { id: string }`; `type NewExamProfile = { slug: string; title: string; language: string; spec: ExamProfileSpec; sources: SourceRef[]; origin: "ai_research" | "uploaded" | "manual"; trust: "ai_draft" | "data_refined" | "verified" }`
  - `findOrCreateExamProfile(deps: { llm; search; repo }, rawQuery: string): Promise<{ profile: StoredExamProfile; created: boolean }>`
  - `supabaseExamProfileRepo(client, userId?): ExamProfileRepo` (тонкий, без юнит-тестов — проверяется typecheck'ом и smoke).

- [ ] **Step 1: Failing tests**

```ts
// src/features/exam-profile/service.test.ts
import { describe, expect, it } from "vitest";
import { fakeLlm } from "@/lib/llm";
import { fakeSearch } from "@/lib/search";
import { findOrCreateExamProfile, type ExamProfileRepo, type StoredExamProfile } from "./service";

const specFixture = {
  examName: "ЕНТ",
  language: "kk",
  description: "Тест.",
  sections: [{ name: "Математика" }],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

function memoryRepo(seed: StoredExamProfile[] = []): ExamProfileRepo & { rows: StoredExamProfile[] } {
  const rows = [...seed];
  return {
    rows,
    async findBySlug(slug) {
      return rows.find((r) => r.slug === slug) ?? null;
    },
    async insert(p) {
      const stored = { ...p, id: `id-${rows.length + 1}` } as StoredExamProfile;
      rows.push(stored);
      return stored;
    },
  };
}

const liveDeps = () => ({
  llm: fakeLlm([specFixture]),
  search: fakeSearch(
    [{ url: "https://a.example", title: "A", snippet: "формат" }],
    { "https://a.example": "длинный текст страницы про формат экзамена ".repeat(10) },
  ),
});

describe("findOrCreateExamProfile", () => {
  it("researches and stores a new profile", async () => {
    const repo = memoryRepo();
    const { profile, created } = await findOrCreateExamProfile({ ...liveDeps(), repo }, "ЕНТ 2027");
    expect(created).toBe(true);
    expect(profile.slug).toBe("ent-2027");
    expect(profile.origin).toBe("ai_research");
    expect(profile.trust).toBe("ai_draft");
    expect(repo.rows).toHaveLength(1);
  });

  it("returns existing profile without calling llm", async () => {
    const existing = {
      id: "id-1", slug: "ent-2027", title: "ЕНТ", language: "kk",
      spec: specFixture, sources: [], origin: "ai_research", trust: "ai_draft",
    } as unknown as StoredExamProfile;
    const repo = memoryRepo([existing]);
    const llm = fakeLlm([]); // бросит, если сервис его вызовет
    const { profile, created } = await findOrCreateExamProfile(
      { llm, search: fakeSearch([]), repo },
      "ент 2027",
    );
    expect(created).toBe(false);
    expect(profile.id).toBe("id-1");
  });
});
```

- [ ] **Step 2: Run** `npm test -- service` → FAIL.

- [ ] **Step 3: Реализация сервиса**

```ts
// src/features/exam-profile/service.ts
import type { Llm } from "@/lib/llm";
import type { WebSearch } from "@/lib/search";
import { researchExam } from "./research";
import { slugifyExamQuery } from "./slug";
import type { ExamProfileSpec, SourceRef } from "./spec";

export type NewExamProfile = {
  slug: string;
  title: string;
  language: string;
  spec: ExamProfileSpec;
  sources: SourceRef[];
  origin: "ai_research" | "uploaded" | "manual";
  trust: "ai_draft" | "data_refined" | "verified";
};
export type StoredExamProfile = NewExamProfile & { id: string };

export interface ExamProfileRepo {
  findBySlug(slug: string): Promise<StoredExamProfile | null>;
  insert(p: NewExamProfile): Promise<StoredExamProfile>;
}

export async function findOrCreateExamProfile(
  deps: { llm: Llm; search: WebSearch; repo: ExamProfileRepo },
  rawQuery: string,
): Promise<{ profile: StoredExamProfile; created: boolean }> {
  const slug = slugifyExamQuery(rawQuery);
  const existing = await deps.repo.findBySlug(slug);
  if (existing) return { profile: existing, created: false };

  const { spec, sources } = await researchExam(deps, rawQuery);
  const profile = await deps.repo.insert({
    slug,
    title: spec.examName,
    language: spec.language,
    spec,
    sources,
    origin: "ai_research",
    trust: "ai_draft",
  });
  return { profile, created: true };
}
```

- [ ] **Step 4: Supabase-реализация репозитория**

```ts
// src/features/exam-profile/repo.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { examProfileSpecSchema, sourceRefSchema } from "./spec";
import type { ExamProfileRepo, NewExamProfile, StoredExamProfile } from "./service";
import { z } from "zod";

type Row = Database["public"]["Tables"]["exam_profiles"]["Row"];

function rowToProfile(row: Row): StoredExamProfile {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    language: row.language,
    spec: examProfileSpecSchema.parse(row.spec),
    sources: z.array(sourceRefSchema).parse(row.sources ?? []),
    origin: row.origin as StoredExamProfile["origin"],
    trust: row.trust as StoredExamProfile["trust"],
  };
}

export function supabaseExamProfileRepo(
  client: SupabaseClient<Database>,
  userId?: string,
): ExamProfileRepo {
  const repo: ExamProfileRepo = {
    async findBySlug(slug) {
      const { data, error } = await client
        .from("exam_profiles")
        .select("*")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToProfile(data) : null;
    },
    async insert(p: NewExamProfile) {
      const { data, error } = await client
        .from("exam_profiles")
        .insert({
          slug: p.slug,
          title: p.title,
          language: p.language,
          spec: p.spec as unknown as Json,
          sources: p.sources as unknown as Json,
          origin: p.origin,
          trust: p.trust,
          created_by: userId ?? null,
        })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") {
          // гонка по unique slug — профиль создан параллельно, забираем его
          const existing = await repo.findBySlug(p.slug);
          if (existing) return existing;
        }
        throw error;
      }
      return rowToProfile(data);
    },
  };
  return repo;
}
```

Примечание: если в `database.types.ts` тип `Json` не экспортируется под этим именем — посмотреть фактический экспорт в начале файла и использовать его.

- [ ] **Step 5: Run** `npm test; npm run typecheck` → PASS.

- [ ] **Step 6: Commit + push** (`feat: exam profile service with dedup and supabase repo`)

---

### Task 5: API `POST /api/exam-profiles`

**Files:**
- Create: `src/app/api/exam-profiles/route.ts`

**Interfaces:**
- Consumes: `findOrCreateExamProfile`, `supabaseExamProfileRepo`, `createLlm`, `createSearch`, `supabaseServer`.
- Produces: `POST /api/exam-profiles` body `{ query: string }` → `200 { slug, created }` | `401` | `400` | `404 { error: "not_found" }`.

- [ ] **Step 1: Реализация**

```ts
// src/app/api/exam-profiles/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { createLlm } from "@/lib/llm";
import { createSearch } from "@/lib/search";
import { findOrCreateExamProfile } from "@/features/exam-profile/service";
import { supabaseExamProfileRepo } from "@/features/exam-profile/repo";
import { ResearchError } from "@/features/exam-profile/research";

export const maxDuration = 60; // research может идти десятки секунд

const bodySchema = z.object({ query: z.string().min(2).max(200) });

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const { profile, created } = await findOrCreateExamProfile(
      {
        llm: createLlm(),
        search: createSearch(),
        repo: supabaseExamProfileRepo(supabase, data.user.id),
      },
      parsed.data.query,
    );
    return NextResponse.json({ slug: profile.slug, created });
  } catch (e) {
    if (e instanceof ResearchError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    throw e;
  }
}
```

- [ ] **Step 2: Проверка без ключей** — `npm run build` PASS; `npm run dev`, затем:

```powershell
curl.exe -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/exam-profiles -H "Content-Type: application/json" -d '{\"query\":\"IELTS\"}'
```

Expected: `401` (нет сессии — гейт работает).

- [ ] **Step 3: Commit + push** (`feat: auth-gated exam profile research endpoint`)

---

### Task 6: UI — форма на главной и страница `/exams/[slug]`

**Files:**
- Create: `src/components/exam-search-form.tsx`, `src/app/(marketing)/exams/[slug]/page.tsx`
- Modify: `src/app/page.tsx` (CTA → форма), `messages/ru.json`, `messages/kk.json`

**Interfaces:**
- Consumes: `POST /api/exam-profiles` (Task 5), `supabaseServer` + типы для чтения профиля.
- Produces: маршрут `/exams/[slug]` (публичный — RLS разрешает select всем).

- [ ] **Step 1: i18n-ключи** — добавить в ОБА файла локалей (тест паритета упадёт, если разъедутся):

`messages/ru.json` — добавить:

```json
"home": {
  "tagline": "Назови свой экзамен — получи штаб подготовки",
  "cta": "Начать",
  "searchPlaceholder": "например: ЕНТ 2027, IELTS Academic",
  "search": "Создать профиль экзамена",
  "searching": "Исследуем экзамен… обычно до минуты",
  "notFound": "Не удалось найти такой экзамен. Попробуйте сформулировать иначе.",
  "error": "Что-то пошло не так, попробуйте ещё раз."
},
"profile": {
  "trust_ai_draft": "Черновик AI — проверьте по источникам",
  "trust_data_refined": "Уточнён данными",
  "trust_verified": "Верифицирован",
  "sections": "Структура",
  "tasks": "заданий",
  "minutes": "мин",
  "scoring": "Шкала",
  "passing": "проходной",
  "totalTime": "Общее время",
  "dates": "Когда проводится",
  "sources": "Источники",
  "prepare": "Готовиться к этому экзамену",
  "preparing": "Создаём штаб…"
}
```

`messages/kk.json` — те же ключи по-казахски:

```json
"home": {
  "tagline": "Емтиханыңды ата — дайындық штабын ал",
  "cta": "Бастау",
  "searchPlaceholder": "мысалы: ҰБТ 2027, IELTS Academic",
  "search": "Емтихан профилін құру",
  "searching": "Емтиханды зерттеп жатырмыз… әдетте бір минутқа дейін",
  "notFound": "Мұндай емтихан табылмады. Басқаша тұжырымдап көріңіз.",
  "error": "Бірдеңе дұрыс болмады, қайталап көріңіз."
},
"profile": {
  "trust_ai_draft": "AI жобасы — дереккөздер бойынша тексеріңіз",
  "trust_data_refined": "Деректермен нақтыланған",
  "trust_verified": "Верификацияланған",
  "sections": "Құрылымы",
  "tasks": "тапсырма",
  "minutes": "мин",
  "scoring": "Шкала",
  "passing": "өту балы",
  "totalTime": "Жалпы уақыт",
  "dates": "Қашан өткізіледі",
  "sources": "Дереккөздер",
  "prepare": "Осы емтиханға дайындалу",
  "preparing": "Штаб құрылуда…"
}
```

- [ ] **Step 2: Форма поиска (client)**

```tsx
// src/components/exam-search-form.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function ExamSearchForm() {
  const router = useRouter();
  const t = useTranslations("home");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || query.trim().length < 2) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/exam-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query.trim() }),
    });
    if (res.status === 401) return router.push("/sign-in");
    if (res.ok) {
      const { slug } = (await res.json()) as { slug: string };
      return router.push(`/exams/${slug}`);
    }
    setError(res.status === 404 ? t("notFound") : t("error"));
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-xl flex-col gap-3">
      <input
        className="rounded border p-3"
        placeholder={t("searchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <button className="rounded border px-6 py-3 font-medium" disabled={busy}>
        {busy ? t("searching") : t("search")}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 3: Главная** — в `src/app/page.tsx` заменить ссылку-CTA на `<ExamSearchForm />` (заголовок-tagline остаётся).

- [ ] **Step 4: Страница профиля (server)**

```tsx
// src/app/(marketing)/exams/[slug]/page.tsx
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";
import { examProfileSpecSchema } from "@/features/exam-profile/spec";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { PrepareButton } from "@/components/prepare-button";

export default async function ExamProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await getTranslations("profile");
  const supabase = await supabaseServer();
  const { data: row } = await supabase
    .from("exam_profiles")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (!row) notFound();
  const spec = examProfileSpecSchema.parse(row.spec);
  const sources = (row.sources ?? []) as { url: string; title: string }[];

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{spec.examName}</h1>
        <LocaleSwitcher />
      </header>
      <p className="rounded border px-3 py-1 text-sm">{t(`trust_${row.trust}`)}</p>
      <p>{spec.description}</p>

      <section>
        <h2 className="mb-2 font-semibold">{t("sections")}</h2>
        <ul className="flex flex-col gap-2">
          {spec.sections.map((s) => (
            <li key={s.name} className="rounded border p-3">
              <p className="font-medium">{s.name}</p>
              <p className="text-sm text-gray-500">
                {[
                  s.taskCount ? `${s.taskCount} ${t("tasks")}` : null,
                  s.timeLimitMinutes ? `${s.timeLimitMinutes} ${t("minutes")}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {s.topics.length > 0 && (
                <p className="text-sm text-gray-500">{s.topics.join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="text-sm">
        <p>
          <span className="font-semibold">{t("scoring")}:</span> {spec.scoring.scaleMin}–
          {spec.scoring.scaleMax} {spec.scoring.unit}
          {spec.scoring.passingScore != null &&
            ` (${t("passing")}: ${spec.scoring.passingScore})`}
        </p>
        {spec.totalTimeMinutes != null && (
          <p>
            <span className="font-semibold">{t("totalTime")}:</span> {spec.totalTimeMinutes}{" "}
            {t("minutes")}
          </p>
        )}
        {spec.typicalDates && (
          <p>
            <span className="font-semibold">{t("dates")}:</span> {spec.typicalDates}
          </p>
        )}
      </section>

      <PrepareButton examProfileId={row.id} />

      <section>
        <h2 className="mb-2 font-semibold">{t("sources")}</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {sources.map((s) => (
            <li key={s.url}>
              <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title || s.url}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
```

(`PrepareButton` появится в Task 7 — до него можно временно закомментировать импорт и элемент, но проще выполнять задачи по порядку и собрать всё в Task 7.)

- [ ] **Step 5: Проверки** — `npm test` (паритет локалей!), `npm run typecheck`, `npm run lint`, `npm run build` → PASS.

- [ ] **Step 6: Commit + push** (`feat: exam search form and public exam profile page`)

---

### Task 7: Мостик к штабу — `POST /api/study-hqs`, кнопка, список в `/hq`

**Files:**
- Create: `src/app/api/study-hqs/route.ts`, `src/components/prepare-button.tsx`
- Modify: `src/app/(app)/hq/page.tsx`, `messages/ru.json`, `messages/kk.json`

**Interfaces:**
- Produces: `POST /api/study-hqs` body `{ examProfileId: string }` → `200 { id, existed: boolean }` | `401`; штаб показывает список экзаменов пользователя.

- [ ] **Step 1: i18n** — добавить в `hq` обоих локалей:

```json
// ru: "hq": { "title": "Штаб", "myExams": "Мои экзамены", "empty": "Пока пусто — назовите свой экзамен на главной", "addExam": "Добавить экзамен" }
// kk: "hq": { "title": "Штаб", "myExams": "Менің емтихандарым", "empty": "Әзірге бос — басты бетте емтиханыңды ата", "addExam": "Емтихан қосу" }
```

- [ ] **Step 2: API**

```ts
// src/app/api/study-hqs/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";

const bodySchema = z.object({ examProfileId: z.uuid() });

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const { data: existing, error: findError } = await supabase
    .from("study_hqs")
    .select("id")
    .eq("user_id", data.user.id)
    .eq("exam_profile_id", parsed.data.examProfileId)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return NextResponse.json({ id: existing.id, existed: true });

  const { data: created, error } = await supabase
    .from("study_hqs")
    .insert({ user_id: data.user.id, exam_profile_id: parsed.data.examProfileId })
    .select("id")
    .single();
  if (error) throw error;
  return NextResponse.json({ id: created.id, existed: false });
}
```

- [ ] **Step 3: Кнопка**

```tsx
// src/components/prepare-button.tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export function PrepareButton({ examProfileId }: { examProfileId: string }) {
  const router = useRouter();
  const t = useTranslations("profile");
  const [busy, setBusy] = useState(false);

  async function prepare() {
    setBusy(true);
    const res = await fetch("/api/study-hqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ examProfileId }),
    });
    if (res.status === 401) return router.push("/sign-in");
    if (res.ok) return router.push("/hq");
    setBusy(false);
  }

  return (
    <button onClick={prepare} disabled={busy} className="rounded border px-6 py-3 font-medium">
      {busy ? t("preparing") : t("prepare")}
    </button>
  );
}
```

- [ ] **Step 4: Штаб со списком** — заменить `src/app/(app)/hq/page.tsx`:

```tsx
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";
import { LocaleSwitcher } from "@/components/locale-switcher";

export default async function HqPage() {
  const t = await getTranslations("hq");
  const supabase = await supabaseServer();
  const { data: hqs } = await supabase
    .from("study_hqs")
    .select("id, exam_profiles(slug, title)")
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <LocaleSwitcher />
      </header>
      <h2 className="font-medium">{t("myExams")}</h2>
      {!hqs || hqs.length === 0 ? (
        <p className="text-sm text-gray-500">
          {t("empty")} — <Link className="underline" href="/">{t("addExam")}</Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {hqs.map((hq) => (
            <li key={hq.id} className="rounded border p-3">
              <Link className="underline" href={`/exams/${hq.exam_profiles?.slug}`}>
                {hq.exam_profiles?.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 5: Проверки** — `npm test && npm run typecheck && npm run lint && npm run build` → PASS.

- [ ] **Step 6: Commit + push** (`feat: study hq bridge - prepare button and exam list in hq`)

---

### Task 8: Уточнение профиля текстом примера (1.4-lite)

PDF-загрузку откладываем (нужен парсер — этап 2+); в этапе 1 создатель профиля может вставить **текст** примера варианта, и профиль пересобирается с учётом материала.

**Files:**
- Create: `src/features/exam-profile/refine.ts`, `src/components/refine-form.tsx`, `src/app/api/exam-profiles/refine/route.ts`
- Modify: `src/app/(marketing)/exams/[slug]/page.tsx` (форма для создателя), локали
- Test: `src/features/exam-profile/refine.test.ts`

**Interfaces:**
- Produces: `refineExamSpec(deps: { llm: Llm }, current: ExamProfileSpec, sampleText: string): Promise<ExamProfileSpec>`; `POST /api/exam-profiles/refine` body `{ slug, sampleText }` (только создатель — RLS update и так пускает только его).

- [ ] **Step 1: Failing test**

```ts
// src/features/exam-profile/refine.test.ts
import { describe, expect, it } from "vitest";
import { fakeLlm } from "@/lib/llm";
import { refineExamSpec } from "./refine";

const current = {
  examName: "ЕНТ",
  language: "kk",
  description: "Тест.",
  sections: [{ name: "Математика", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] }],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

describe("refineExamSpec", () => {
  it("returns refined spec validated by schema", async () => {
    const refined = { ...current, sections: [{ ...current.sections[0], taskCount: 15 }] };
    const llm = fakeLlm([refined]);
    const result = await refineExamSpec({ llm }, current, "Вариант: 15 заданий по математике...");
    expect(result.sections[0].taskCount).toBe(15);
  });
});
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Реализация**

```ts
// src/features/exam-profile/refine.ts
import type { Llm } from "@/lib/llm";
import { examProfileSpecSchema, type ExamProfileSpec } from "./spec";

export async function refineExamSpec(
  deps: { llm: Llm },
  current: ExamProfileSpec,
  sampleText: string,
): Promise<ExamProfileSpec> {
  return deps.llm.complete({
    system:
      "Ты уточняешь профиль экзамена по реальному примеру варианта. Отвечай ТОЛЬКО валидным JSON той же структуры, что и текущий профиль. Сохраняй всё верное, исправляй и дополняй по примеру.",
    prompt: `Текущий профиль экзамена (JSON):\n${JSON.stringify(current, null, 2)}\n\nРеальный пример варианта экзамена:\n${sampleText.slice(0, 20_000)}\n\nВерни уточнённый профиль той же JSON-структуры.`,
    schema: examProfileSpecSchema,
    maxTokens: 8_000,
  });
}
```

- [ ] **Step 4: API** — `src/app/api/exam-profiles/refine/route.ts`: авторизация как в Task 5; body `{ slug: z.string(), sampleText: z.string().min(100).max(50_000) }`; загрузить строку по slug, `refineExamSpec`, затем `update exam_profiles set spec=..., origin='uploaded' where slug=...` (RLS пропустит только создателя; если `update` вернул 0 строк — ответить 403). `export const maxDuration = 60;`.

- [ ] **Step 5: UI** — `refine-form.tsx` (client): textarea + кнопка; показывать на странице профиля только если `row.created_by === user.id` (получить пользователя в page.tsx через `supabase.auth.getUser()`). Ключи локалей: `profile.refineTitle` («Вставьте текст примера варианта — профиль станет точнее» / «Нақты нұсқа мәтінін қойыңыз — профиль дәлірек болады»), `profile.refineSubmit` («Уточнить профиль» / «Профильді нақтылау»), `profile.refining` («Уточняем…» / «Нақтылануда…»).

- [ ] **Step 6: Проверки + commit + push** (`feat: refine exam profile from pasted sample text`)

---

### Task 9: Eval-харнесс качества профилей

**Files:**
- Create: `vitest.evals.config.ts`, `evals/exam-profiles/profiles.eval.ts`
- Modify: `package.json` (script), `.gitignore` (`evals/**/out/`)

**Interfaces:**
- Produces: `npm run eval:profiles` — гоняет живой research по списку экзаменов, пишет JSON-профили в `evals/exam-profiles/out/`, падает при структурных провалах. НЕ входит в CI и в `npm test`.

- [ ] **Step 1: Конфиг**

```ts
// vitest.evals.config.ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    testTimeout: 180_000,
    hookTimeout: 30_000,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
```

`package.json` → scripts: `"eval:profiles": "vitest run --config vitest.evals.config.ts"`.
`.gitignore` → добавить строку `evals/**/out/`.

- [ ] **Step 2: Eval**

```ts
// evals/exam-profiles/profiles.eval.ts
import { describe, expect, it, beforeAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLlm } from "@/lib/llm";
import { createSearch } from "@/lib/search";
import { researchExam } from "@/features/exam-profile/research";
import { slugifyExamQuery } from "@/features/exam-profile/slug";

const EXAMS = ["ЕНТ Казахстан", "IELTS Academic", "DTM Узбекистан", "SAT"];
const OUT = join(process.cwd(), "evals", "exam-profiles", "out");

beforeAll(() => {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // нет .env.local — ключи должны быть в окружении
  }
  mkdirSync(OUT, { recursive: true });
});

describe("exam profile quality eval (live)", () => {
  for (const exam of EXAMS) {
    it(`researches: ${exam}`, async () => {
      const { spec, sources } = await researchExam(
        { llm: createLlm(), search: createSearch() },
        exam,
      );
      writeFileSync(
        join(OUT, `${slugifyExamQuery(exam)}.json`),
        JSON.stringify({ spec, sources }, null, 2),
        "utf8",
      );
      // структурный минимум; качество содержания оцениваем глазами по out/*.json
      expect(spec.sections.length).toBeGreaterThan(0);
      expect(spec.scoring.scaleMax).toBeGreaterThan(spec.scoring.scaleMin);
      expect(sources.length).toBeGreaterThanOrEqual(2);
      console.log(
        `${exam}: ${spec.sections.length} секций, шкала ${spec.scoring.scaleMin}-${spec.scoring.scaleMax} ${spec.scoring.unit}, ${sources.length} источников`,
      );
    });
  }
});
```

- [ ] **Step 3: Проверить, что обычный `npm test` НЕ подхватывает eval** (include в основном конфиге — только `src/**/*.test.ts`): `npm test` → по-прежнему только юнит-тесты.

- [ ] **Step 4: Commit + push** (`feat: live eval harness for exam profile quality`)

---

### Task 10: Ключи, выбор модели, live smoke, прод

**Требуются: `OPENROUTER_API_KEY`, `TAVILY_API_KEY` от основателя.**

- [ ] **Step 1:** Вписать ключи в `.env.local`, `LLM_MODEL=google/gemini-2.5-flash` (первый кандидат).
- [ ] **Step 2:** `npm run eval:profiles` → все 4 экзамена прошли; открыть `evals/exam-profiles/out/*.json`, глазами проверить адекватность (особенно ЕНТ: секции, шкала 140, казахский контекст). При слабом качестве повторить с другими `LLM_MODEL`-кандидатами и выбрать лучший по цене/качеству; решение записать в Decision Points мастер-плана.
- [ ] **Step 3:** Локальный e2e: `npm run dev` → войти → на главной ввести «IELTS Academic» → дождаться профиля → «Готовиться» → экзамен в штабе.
- [ ] **Step 4:** Прод: добавить `OPENROUTER_API_KEY`, `LLM_MODEL`, `TAVILY_API_KEY` в Vercel (дашборд → Settings → Environment Variables; сделает Дияр или основатель) → redeploy → повторить e2e на https://upalhub.vercel.app.
- [ ] **Step 5: Smoke-чеклист (обязателен — компенсирует отложенные тесты, из финального ревью):**
  - anon без сессии → 401 на `POST /api/exam-profiles` И `POST /api/exam-profiles/refine`;
  - refine чужого профиля → 403 (не тратит LLM);
  - двойной клик «Готовиться» → в штабе одна строка (unique-индекс);
  - повторный research того же экзамена → `created:false`, LLM не вызывается;
  - `db push` применил обе новые миграции (tighten RLS + unique index) без конфликтов;
  - длинная сессия: вход → 1+ час → действие (проверка отсутствия root-middleware, N6).

- [ ] **Step 6:** Обновить статус-блок этого плана и мастер-плана; commit + push.

---

## Definition of Done (этап 1)

1. Юнит-тесты этапа (schema, slug, research, service, refine) зелёные, без сети; CI зелёный.
2. Авторизованный пользователь на проде: вводит название ЛЮБОГО экзамена → в течение ~минуты открывается `/exams/[slug]` с секциями, шкалой, источниками и trust-беджем «Черновик AI».
3. Повторный запрос того же экзамена (в т.ч. в другом регистре) НЕ вызывает research — открывается существующий профиль.
4. Кнопка «Готовиться» кладёт экзамен в штаб; `/hq` показывает список экзаменов пользователя; пустой штаб показывает подсказку.
5. Неавторизованный: API отвечает 401, форма уводит на `/sign-in`; страницы профилей публично читаемы.
6. `npm run eval:profiles` на выбранной модели проходит по 4 экзаменам; JSON-профили глазами адекватны; `LLM_MODEL` зафиксирован.
7. RU/KK на всех новых экранах; тест паритета ключей зелёный.
