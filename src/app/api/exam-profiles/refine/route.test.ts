import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock calls are hoisted above imports — safe to reference the mocked
// factories below (route.ts calls researchLimiter.take() at request time,
// but rate-limit сам НЕ мокается: 429-тест гоняет реальную корзину — тот же
// паттерн, что и в src/app/api/exam-profiles/route.test.ts).
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  createLlm: vi.fn(() => ({ complete: vi.fn() })),
}));
vi.mock("@/features/exam-profile/refine", () => ({
  refineExamSpec: vi.fn(),
}));

import { supabaseServer } from "@/lib/supabase/server";
import { refineExamSpec } from "@/features/exam-profile/refine";
import { POST } from "./route";

const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedRefineExamSpec = vi.mocked(refineExamSpec);

function postRequest(body: unknown) {
  return new Request("http://localhost/api/exam-profiles/refine", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// Минимальный chainable-стаб под supabase.from("exam_profiles").select(...)
// .eq(...).maybeSingle() — этого хватает, чтобы запросы, прошедшие лимитер,
// падали на понятном not_found (404), а не на необработанном исключении.
function chainable(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve(result);
  return builder;
}

function stubUser(userId: string | null) {
  const supabase = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }) },
    from: vi.fn(() => chainable({ data: null, error: null })),
  };
  mockedSupabaseServer.mockResolvedValue(supabase as never);
  return supabase;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/exam-profiles/refine", () => {
  // 🔴 final-review Fix2: раньше этот роут тратил LLM без какого-либо
  // rate-limiter. Уникальный user.id, не пересекающийся с другими тестами в
  // этом файле — бакет лимитера живёт на весь файл (module-level singleton).
  it("429s once the caller's token bucket (capacity 3) is exhausted", async () => {
    stubUser("u-refine-limited");

    for (let i = 0; i < 3; i++) {
      const res = await POST(postRequest({ slug: "sat", sampleText: "x".repeat(120) }));
      // Первые 3 запроса проходят лимитер (падают на not_found, потому что
      // supabase-стаб не возвращает профиль) — важен сам факт, что это НЕ 429.
      expect(res.status).toBe(404);
    }

    const res = await POST(postRequest({ slug: "sat", sampleText: "x".repeat(120) }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // 4й вызов не должен даже долетать до refineExamSpec (лимитер стоит
    // раньше любых загрузок/LLM).
    expect(mockedRefineExamSpec).not.toHaveBeenCalled();
  });

  // Backlog wave fix4: examProfileSpecSchema.parse() on a stale/corrupted
  // row.spec used to throw -> unhandled 500. safeParse degrades to a clean
  // 422 instead.
  it("returns 422 profile_spec_invalid instead of throwing when row.spec fails schema validation", async () => {
    const userId = "u-refine-invalid-spec";
    const supabase = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } } }) },
      from: vi.fn(() =>
        chainable({
          data: { created_by: userId, spec: { garbage: true } },
          error: null,
        }),
      ),
    };
    mockedSupabaseServer.mockResolvedValue(supabase as never);

    const res = await POST(postRequest({ slug: "broken-spec", sampleText: "x".repeat(120) }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "profile_spec_invalid" });
    expect(mockedRefineExamSpec).not.toHaveBeenCalled();
  });
});
