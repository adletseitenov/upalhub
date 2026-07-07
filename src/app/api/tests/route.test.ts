import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock calls are hoisted above imports — safe to reference the mocked
// factories below (route.ts calls createRateLimiter() at module load time,
// but rate-limit сам НЕ мокается: 429-тест гоняет реальную корзину).
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  createLlm: vi.fn(() => ({ complete: vi.fn() })),
}));
vi.mock("@/features/tasks/repo", () => ({
  supabaseTaskRepo: vi.fn(() => ({})),
}));
vi.mock("@/features/tests/repo", () => ({
  supabaseTestRepo: vi.fn(() => ({})),
}));
vi.mock("@/features/tests/assemble", () => ({
  assembleTest: vi.fn(),
}));

import { supabaseServer } from "@/lib/supabase/server";
import { assembleTest } from "@/features/tests/assemble";
import { POST, maxDuration } from "./route";

const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedAssembleTest = vi.mocked(assembleTest);

// Валидный по RFC 9562 uuid — zod 4 z.uuid() проверяет version/variant-биты,
// «все единицы» не проходят.
const HQ_ID = "11111111-1111-4111-8111-111111111111";

// --- fake Supabase query-builder ------------------------------------------
// Chainable stub covering the methods this route uses (select/eq/maybeSingle).
// Keyed by table name so each test controls what `.from(table)` resolves to.

type QueryResult = { data: unknown; error: unknown };

function chainable(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "limit"]) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve(result);
  builder.single = () => Promise.resolve(result);
  return builder;
}

function fakeSupabase(opts: {
  user: { id: string } | null;
  studyHq?: QueryResult;
  examProfile?: QueryResult;
}) {
  const tables: Record<string, QueryResult> = {
    study_hqs: opts.studyHq ?? { data: null, error: null },
    exam_profiles: opts.examProfile ?? { data: null, error: null },
  };
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: vi.fn((table: string) => chainable(tables[table] ?? { data: null, error: null })),
  };
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/tests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function validProfileRow() {
  return {
    id: "profile-1",
    slug: "ent",
    title: "ENT",
    language: "kk",
    spec: {
      examName: "ENT",
      language: "kk",
      description: "d",
      sections: [{ name: "Математика", taskTypes: [], topics: [] }],
      scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
    },
    sources: [],
    origin: "ai_research",
    trust: "ai_draft",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ВАЖНО: rate limiter в route.ts — модульный синглтон, его состояние живёт
// весь файл. Каждый тест использует СВОЙ user.id (у каждого своя корзина) —
// тесты не зависят от порядка выполнения.

describe("POST /api/tests", () => {
  it("401s when there is no authenticated user", async () => {
    mockedSupabaseServer.mockResolvedValue(fakeSupabase({ user: null }) as never);

    const res = await POST(postRequest({ hqId: HQ_ID, kind: "diagnostic" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("400s on a malformed body (bad uuid, missing kind)", async () => {
    mockedSupabaseServer.mockResolvedValue(fakeSupabase({ user: { id: "u-badbody" } }) as never);

    const res = await POST(postRequest({ hqId: "not-a-uuid" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("400s on an unknown kind", async () => {
    mockedSupabaseServer.mockResolvedValue(fakeSupabase({ user: { id: "u-badkind" } }) as never);

    const res = await POST(postRequest({ hqId: HQ_ID, kind: "final-boss" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("404s when the hq does not belong to (or does not exist for) the caller", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-foreign-hq" },
        studyHq: { data: null, error: null }, // .eq(user_id) отфильтровал чужой hq
      }) as never,
    );

    const res = await POST(postRequest({ hqId: HQ_ID, kind: "diagnostic" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedAssembleTest).not.toHaveBeenCalled();
  });

  it("429s once the caller's token bucket (capacity 5) is exhausted", async () => {
    mockedSupabaseServer.mockResolvedValue(fakeSupabase({ user: { id: "u-limited" } }) as never);

    // Первые 5 запросов проходят лимитер (и умирают дальше на 404 — hq не
    // замокан); шестой упирается в пустую корзину.
    for (let i = 0; i < 5; i++) {
      const res = await POST(postRequest({ hqId: HQ_ID, kind: "diagnostic" }));
      expect(res.status).toBe(404);
    }

    const res = await POST(postRequest({ hqId: HQ_ID, kind: "diagnostic" }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(mockedAssembleTest).not.toHaveBeenCalled();
  });

  it("assembles a test and returns only {testId} — no task/answer data leaks", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-success" },
        studyHq: { data: { id: "hq-1", exam_profile_id: "profile-1" }, error: null },
        examProfile: { data: validProfileRow(), error: null },
      }) as never,
    );
    mockedAssembleTest.mockResolvedValue({
      id: "test-1",
      hqId: "hq-1",
      kind: "diagnostic",
      spec: {
        version: 1,
        kind: "diagnostic",
        language: "kk",
        sections: [{ name: "Математика", taskIds: ["t1"] }],
        taskIds: ["t1"],
        totalTimeMinutes: null,
        scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
      },
    });

    const res = await POST(postRequest({ hqId: HQ_ID, kind: "diagnostic" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ testId: "test-1" });
    // Shape-гарантия: ответ сборки не содержит ни заданий, ни ответов.
    expect(JSON.stringify(body)).not.toContain("answer");
    expect(mockedAssembleTest).toHaveBeenCalledTimes(1);
  });

  it("exports maxDuration=60 for the long-running assembly path", () => {
    expect(maxDuration).toBe(60);
  });

  // D5: study_hqs.config колонки ещё нет в БД до миграции T5 — hq без поля
  // config ведёт себя как legacy (валидация пропускается), что уже покрыто
  // тестом выше ("assembles a test..." использует studyHq без config).

  it("422s with reconfigure_needed when hq.config fails validateHqConfig against the profile spec", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-badconfig" },
        studyHq: {
          data: {
            id: "hq-1",
            exam_profile_id: "profile-1",
            config: { selectedSectionNames: ["Несуществующая секция"] },
          },
          error: null,
        },
        examProfile: { data: validProfileRow(), error: null },
      }) as never,
    );

    const res = await POST(postRequest({ hqId: HQ_ID, kind: "diagnostic" }));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "reconfigure_needed" });
    expect(mockedAssembleTest).not.toHaveBeenCalled();
  });

  it("passes a non-empty, valid hq.config through to assembleTest as hqConfig", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-goodconfig" },
        studyHq: {
          data: {
            id: "hq-1",
            exam_profile_id: "profile-1",
            config: { selectedSectionNames: ["Математика"] },
          },
          error: null,
        },
        examProfile: { data: validProfileRow(), error: null },
      }) as never,
    );
    mockedAssembleTest.mockResolvedValue({
      id: "test-1",
      hqId: "hq-1",
      kind: "diagnostic",
      spec: {
        version: 1,
        kind: "diagnostic",
        language: "kk",
        sections: [{ name: "Математика", taskIds: ["t1"] }],
        taskIds: ["t1"],
        totalTimeMinutes: null,
        scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
      },
    });

    const res = await POST(postRequest({ hqId: HQ_ID, kind: "diagnostic" }));

    expect(res.status).toBe(200);
    expect(mockedAssembleTest).toHaveBeenCalledTimes(1);
    const [, args] = mockedAssembleTest.mock.calls[0];
    expect(args).toMatchObject({ hqConfig: { selectedSectionNames: ["Математика"] } });
  });

  it("treats an unparsable (e.g. array) hq.config as legacy null instead of 500ing", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-arrayconfig" },
        studyHq: {
          data: { id: "hq-1", exam_profile_id: "profile-1", config: ["not", "an", "object"] },
          error: null,
        },
        examProfile: { data: validProfileRow(), error: null },
      }) as never,
    );
    mockedAssembleTest.mockResolvedValue({
      id: "test-1",
      hqId: "hq-1",
      kind: "diagnostic",
      spec: {
        version: 1,
        kind: "diagnostic",
        language: "kk",
        sections: [{ name: "Математика", taskIds: ["t1"] }],
        taskIds: ["t1"],
        totalTimeMinutes: null,
        scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
      },
    });

    const res = await POST(postRequest({ hqId: HQ_ID, kind: "diagnostic" }));

    expect(res.status).toBe(200);
    const [, args] = mockedAssembleTest.mock.calls[0];
    expect(args).toMatchObject({ hqConfig: null });
  });
});
