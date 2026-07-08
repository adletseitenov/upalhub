import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock calls are hoisted above imports — safe to reference the mocked
// factories below (assemblyLimiter сам НЕ мокается: 429-тест гоняет
// реальную корзину, общую с /api/tests по модулю, но КАЖДЫЙ тест-файл в
// vitest получает свежий реестр модулей, поэтому состояние лимитера здесь
// не пересекается с src/app/api/tests/route.test.ts).
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));
// D-security1 fix: tasks-репо для дособорки (банк читает answer/
// explanation) получает service-role клиент, не supabaseServer() — мокается
// отдельно (паттерн @/lib/supabase/server рядом).
vi.mock("@/lib/supabase/admin", () => ({
  taskReadClient: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  createLlm: vi.fn(() => ({ complete: vi.fn() })),
}));
vi.mock("@/features/tasks/repo", () => ({
  supabaseTaskRepo: vi.fn(() => ({})),
}));
vi.mock("@/features/tests/repo", () => ({
  supabaseTestRepo: vi.fn(),
}));
vi.mock("@/features/tests/assemble", () => ({
  reassembleTest: vi.fn(),
}));

import { supabaseServer } from "@/lib/supabase/server";
import { taskReadClient } from "@/lib/supabase/admin";
import { supabaseTestRepo } from "@/features/tests/repo";
import type { StoredTest, TestRepo } from "@/features/tests/repo";
import { supabaseTaskRepo } from "@/features/tasks/repo";
import { reassembleTest } from "@/features/tests/assemble";
import type { TestSpec } from "@/features/tests/spec";
import { POST, maxDuration } from "./route";

const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedTaskReadClient = vi.mocked(taskReadClient);
const mockedTestRepoFactory = vi.mocked(supabaseTestRepo);
const mockedTaskRepoFactory = vi.mocked(supabaseTaskRepo);
const mockedReassembleTest = vi.mocked(reassembleTest);

// Sentinel — доказывает, что supabaseTaskRepo() был вызван именно с
// результатом taskReadClient(), а не с user-клиентом (fakeSupabase ниже).
const ADMIN_CLIENT = { __tag: "admin-client" };

// Валидный по RFC 9562 uuid — zod 4 z.uuid() проверяет version/variant-биты.
const TEST_ID = "22222222-2222-4222-8222-222222222222";

// --- fake Supabase query-builder (тот же паттерн, что и в
// src/app/api/tests/route.test.ts) — покрывает study_hqs/exam_profiles;
// testRepo (getTest/replaceTestSpecIfNoAttempts) мокается отдельно, роут не
// зовёт .from("tests") напрямую. ---------------------------------------

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

function postRequest() {
  return new Request(`http://localhost/api/tests/${TEST_ID}/refill`, { method: "POST" });
}

function callPost() {
  return POST(postRequest(), { params: Promise.resolve({ testId: TEST_ID }) });
}

function validSpec(overrides: Partial<TestSpec> = {}): TestSpec {
  return {
    version: 1,
    kind: "diagnostic",
    language: "kk",
    sections: [{ name: "Математика", taskIds: ["t1"], plannedCount: 3, modality: null }],
    taskIds: ["t1"],
    totalTimeMinutes: null,
    scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
    refillCount: 0,
    ...overrides,
  };
}

function testFixture(overrides: Partial<StoredTest> = {}): StoredTest {
  return { id: TEST_ID, hqId: "hq-1", kind: "diagnostic", spec: validSpec(), ...overrides };
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

function mockTestRepo(overrides: Partial<TestRepo> = {}): TestRepo {
  const repo: TestRepo = {
    insertTest: vi.fn(),
    getTest: vi.fn().mockResolvedValue(testFixture()),
    replaceTestSpecIfNoAttempts: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as TestRepo;
  mockedTestRepoFactory.mockReturnValue(repo);
  return repo;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedTaskReadClient.mockReturnValue(ADMIN_CLIENT as never);
});

describe("POST /api/tests/[testId]/refill", () => {
  it("401s when there is no authenticated user", async () => {
    mockedSupabaseServer.mockResolvedValue(fakeSupabase({ user: null }) as never);

    const res = await callPost();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("404s when the test does not exist", async () => {
    mockedSupabaseServer.mockResolvedValue(fakeSupabase({ user: { id: "u-refill-notfound" } }) as never);
    mockTestRepo({ getTest: vi.fn().mockResolvedValue(null) });

    const res = await callPost();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedReassembleTest).not.toHaveBeenCalled();
    expect(mockedTaskReadClient).not.toHaveBeenCalled();
  });

  it("404s when the test's hq does not belong to (or does not exist for) the caller", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-refill-foreign" },
        studyHq: { data: null, error: null }, // .eq(user_id) отфильтровал чужой hq
      }) as never,
    );
    mockTestRepo();

    const res = await callPost();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedReassembleTest).not.toHaveBeenCalled();
  });

  it("429s once the caller's token bucket (shared with /api/tests, capacity 5) is exhausted", async () => {
    mockedSupabaseServer.mockResolvedValue(fakeSupabase({ user: { id: "u-refill-limited" } }) as never);
    mockTestRepo({ getTest: vi.fn().mockResolvedValue(null) });

    // Первые 5 запросов проходят лимитер (и умирают дальше на 404 — тест не
    // замокан); шестой упирается в пустую корзину.
    for (let i = 0; i < 5; i++) {
      const res = await callPost();
      expect(res.status).toBe(404);
    }

    const res = await callPost();

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(mockedReassembleTest).not.toHaveBeenCalled();
  });

  it("422s with reconfigure_needed when hq.config fails validateHqConfig against the profile spec", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-refill-badconfig" },
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
    mockTestRepo();

    const res = await callPost();

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "reconfigure_needed" });
    expect(mockedReassembleTest).not.toHaveBeenCalled();
  });

  it("409s with attempt_exists when the atomic RPC replace finds an existing attempt", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-refill-attemptexists" },
        studyHq: { data: { id: "hq-1", exam_profile_id: "profile-1" }, error: null },
        examProfile: { data: validProfileRow(), error: null },
      }) as never,
    );
    mockedReassembleTest.mockResolvedValue(validSpec({ taskIds: ["t1", "t2"] }));
    mockTestRepo({ replaceTestSpecIfNoAttempts: vi.fn().mockResolvedValue(false) });

    const res = await callPost();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "attempt_exists" });
  });

  it("200s with {taskCount, previousTaskCount} — no task/answer data leaks", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-refill-success" },
        studyHq: { data: { id: "hq-1", exam_profile_id: "profile-1" }, error: null },
        examProfile: { data: validProfileRow(), error: null },
      }) as never,
    );
    const newSpec = validSpec({
      taskIds: ["t1", "t2"],
      sections: [{ name: "Математика", taskIds: ["t1", "t2"], plannedCount: 3, modality: null }],
      refillCount: 1,
    });
    mockedReassembleTest.mockResolvedValue(newSpec);
    const repo = mockTestRepo();

    const res = await callPost();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ taskCount: 2, previousTaskCount: 1 });
    expect(JSON.stringify(body)).not.toContain("answer");
    expect(repo.replaceTestSpecIfNoAttempts).toHaveBeenCalledWith(TEST_ID, newSpec);

    // D-security1 fix: банк заданий для дособорки читается через
    // taskReadClient (service-role, если ключ задан), не напрямую через
    // user-клиент.
    expect(mockedTaskReadClient).toHaveBeenCalledTimes(1);
    expect(mockedTaskRepoFactory).toHaveBeenCalledWith(ADMIN_CLIENT);
  });

  it("exports maxDuration=60 for the long-running reassembly path", () => {
    expect(maxDuration).toBe(60);
  });
});
