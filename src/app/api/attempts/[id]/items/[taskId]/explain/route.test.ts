import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredAttempt } from "@/features/attempts/repo";
import type { StoredTest } from "@/features/tests/repo";

// Границы: supabase-клиенты + repo-фабрики + createLlm мокаются (паттерн
// submit/route.test.ts и hq/recompute/route.test.ts) — explainMistake и
// explainLimiter остаются РЕАЛЬНЫМИ (429-тест гоняет настоящую корзину,
// уникальный user.id на тест — паттерн exam-profiles/route.test.ts).
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  taskReadClient: vi.fn(),
}));
vi.mock("@/features/attempts/repo", () => ({
  supabaseAttemptRepo: vi.fn(),
}));
vi.mock("@/features/tests/repo", () => ({
  supabaseTestRepo: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  createLlm: vi.fn(),
}));

import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";
import { taskReadClient } from "@/lib/supabase/admin";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { createLlm } from "@/lib/llm";
import { POST, maxDuration } from "./route";

const mockedCookies = vi.mocked(cookies);
const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedTaskReadClient = vi.mocked(taskReadClient);
const mockedAttemptRepo = vi.mocked(supabaseAttemptRepo);
const mockedTestRepo = vi.mocked(supabaseTestRepo);
const mockedCreateLlm = vi.mocked(createLlm);

const ATTEMPT_ID = "attempt-1";
const TASK_ID = "t1";

type QueryResult = { data: unknown; error: unknown };

// Тот же приём, что и в hq/recompute/route.test.ts (chainable builder), но
// дополнительно awaitable БЕЗ .maybeSingle()/.single() — этот роут делает
// `await supabase.from(...).select(...).eq(...).is(...)` напрямую (паттерн
// tests/[testId]/page.tsx openTaskIds-запросов), не завершая цепочку
// single-строчным терминатором.
function chainable(result: QueryResult) {
  const self = Promise.resolve(result) as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  for (const method of ["select", "eq", "in", "is", "limit", "order"]) {
    self[method] = () => self;
  }
  self.maybeSingle = () => Promise.resolve(result);
  self.single = () => Promise.resolve(result);
  return self;
}

function fakeSupabase(opts: {
  user: { id: string } | null;
  openAttempts?: QueryResult;
  openTests?: QueryResult;
}) {
  const tables: Record<string, QueryResult> = {
    attempts: opts.openAttempts ?? { data: [], error: null },
    tests: opts.openTests ?? { data: [], error: null },
  };
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: vi.fn((table: string) => chainable(tables[table] ?? { data: null, error: null })),
  };
}

function attemptFixture(overrides: Partial<StoredAttempt> = {}): StoredAttempt {
  return {
    id: ATTEMPT_ID,
    testId: "test-1",
    userId: "user-1",
    startedAt: new Date("2026-07-07T10:00:00Z"),
    finishedAt: new Date("2026-07-07T10:30:00Z"),
    rawScore: 1,
    scaledScore: 100,
    ...overrides,
  };
}

function testFixture(overrides: Partial<StoredTest> = {}): StoredTest {
  return {
    id: "test-1",
    hqId: "hq-1",
    kind: "diagnostic",
    spec: {
      version: 1,
      kind: "diagnostic",
      language: "kk",
      sections: [{ name: "Математика", taskIds: [TASK_ID] }],
      taskIds: [TASK_ID],
      totalTimeMinutes: null,
      scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
    },
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    type: "single_choice",
    topic: "algebra",
    difficulty: 3,
    language: "kk",
    body: {
      format: "single_choice",
      prompt: "2+2?",
      options: [
        { id: "a", text: "4" },
        { id: "b", text: "5" },
      ],
    },
    answer: { format: "single_choice", correctOptionId: "a" },
    explanation: "because math",
    ...overrides,
  };
}

function stubAuth(user: { id: string } | null, extra: Parameters<typeof fakeSupabase>[0] = { user }) {
  mockedSupabaseServer.mockResolvedValue(fakeSupabase({ ...extra, user }) as never);
}

function stubRepos(opts: {
  attempt: StoredAttempt | null;
  test?: StoredTest | null;
  items?: { taskId: string; response: unknown; timeMs: number | null; isCorrect: boolean | null }[];
}) {
  mockedAttemptRepo.mockReturnValue({
    getAttempt: vi.fn().mockResolvedValue(opts.attempt),
    getItems: vi.fn().mockResolvedValue(opts.items ?? []),
  } as never);
  mockedTestRepo.mockReturnValue({
    getTest: vi.fn().mockResolvedValue(opts.test ?? null),
  } as never);
}

function stubAdmin(row: unknown | null) {
  const from = vi.fn(() => chainable({ data: row, error: null }));
  mockedTaskReadClient.mockReturnValue({ from } as never);
}

function stubCookies(locale?: string) {
  mockedCookies.mockResolvedValue({
    get: vi.fn((name: string) => (name === "NEXT_LOCALE" && locale ? { value: locale } : undefined)),
  } as never);
}

function stubLlmResolves(result: { explanation: string; hint?: string }) {
  const complete = vi.fn().mockResolvedValue(result);
  mockedCreateLlm.mockReturnValue({ complete } as never);
  return complete;
}

function stubLlmRejects(err: Error) {
  const complete = vi.fn().mockRejectedValue(err);
  mockedCreateLlm.mockReturnValue({ complete } as never);
  return complete;
}

function postRequest(attemptId = ATTEMPT_ID, taskId = TASK_ID) {
  return new Request(`http://localhost/api/attempts/${attemptId}/items/${taskId}/explain`, {
    method: "POST",
  });
}

function callPost(attemptId = ATTEMPT_ID, taskId = TASK_ID) {
  return POST(postRequest(attemptId, taskId), { params: Promise.resolve({ id: attemptId, taskId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubCookies("ru");
});

describe("POST /api/attempts/[id]/items/[taskId]/explain", () => {
  it("401s when there is no authenticated user", async () => {
    stubAuth(null);
    stubRepos({ attempt: attemptFixture() });

    const res = await callPost();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mockedCreateLlm).not.toHaveBeenCalled();
  });

  it("404s when the attempt does not exist", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: null });

    const res = await callPost();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("403s on someone else's attempt", async () => {
    stubAuth({ id: "intruder" });
    stubRepos({ attempt: attemptFixture({ userId: "user-1" }) });

    const res = await callPost();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(mockedCreateLlm).not.toHaveBeenCalled();
  });

  it("403s attempt_not_finished on an open attempt, without calling the LLM", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: attemptFixture({ finishedAt: null }), test: testFixture() });

    const res = await callPost();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "attempt_not_finished" });
    expect(mockedCreateLlm).not.toHaveBeenCalled();
  });

  it("404s when the taskId is not part of the attempt's frozen test spec", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: attemptFixture(), test: testFixture() });

    const res = await callPost(ATTEMPT_ID, "unknown-task");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedCreateLlm).not.toHaveBeenCalled();
  });

  it("🔴 403s task_in_active_attempt when taskId belongs to any other open attempt of this user, without calling the LLM", async () => {
    stubAuth(
      { id: "user-1" },
      {
        user: { id: "user-1" },
        openAttempts: { data: [{ test_id: "other-test" }], error: null },
        openTests: {
          data: [
            {
              id: "other-test",
              spec: {
                version: 1,
                kind: "practice",
                language: "kk",
                sections: [{ name: "S", taskIds: [TASK_ID] }],
                taskIds: [TASK_ID],
                totalTimeMinutes: null,
                scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
              },
            },
          ],
          error: null,
        },
      },
    );
    stubRepos({ attempt: attemptFixture(), test: testFixture() });

    const res = await callPost();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "task_in_active_attempt" });
    expect(mockedCreateLlm).not.toHaveBeenCalled();
  });

  it("🔴 400s with {error: not_a_mistake} when the item.isCorrect is true, without calling the LLM or consuming a limiter token", async () => {
    const userId = "u-correct-answer";
    stubAuth({ id: userId });
    stubRepos({
      attempt: attemptFixture({ userId }),
      test: testFixture(),
      items: [{ taskId: TASK_ID, response: { format: "single_choice", optionId: "a" }, timeMs: null, isCorrect: true }],
    });
    stubAdmin(taskRow());
    const complete = stubLlmResolves({ explanation: "ok" });

    const res = await callPost();

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "not_a_mistake" });
    expect(complete).not.toHaveBeenCalled();

    // Verify limiter token was not consumed: next valid (incorrect) request should succeed
    stubRepos({
      attempt: attemptFixture({ userId }),
      test: testFixture(),
      items: [{ taskId: TASK_ID, response: { format: "single_choice", optionId: "b" }, timeMs: null, isCorrect: false }],
    });
    const res2 = await callPost();
    expect(res2.status).toBe(200);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("200s with {explanation, hint} on the happy path", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({
      attempt: attemptFixture(),
      test: testFixture(),
      items: [{ taskId: TASK_ID, response: { format: "single_choice", optionId: "b" }, timeMs: null, isCorrect: false }],
    });
    stubAdmin(taskRow());
    const complete = stubLlmResolves({ explanation: "потому что 2+2=4", hint: "проверяй арифметику" });

    const res = await callPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ explanation: "потому что 2+2=4", hint: "проверяй арифметику" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("502s with {error: llm_unavailable} (not a raw 500) when the LLM throws (incl. 402)", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({
      attempt: attemptFixture(),
      test: testFixture(),
      items: [{ taskId: TASK_ID, response: { format: "single_choice", optionId: "b" }, timeMs: null, isCorrect: false }],
    });
    stubAdmin(taskRow());
    stubLlmRejects(new Error("OpenRouter 402: insufficient credits"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await callPost();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "llm_unavailable" });
    warnSpy.mockRestore();
  });

  it("429s once the caller's token bucket (capacity 10) is exhausted, before the LLM is ever called", async () => {
    stubAuth({ id: "u-explain-limited" });
    stubRepos({
      attempt: attemptFixture({ userId: "u-explain-limited" }),
      test: testFixture(),
      items: [{ taskId: TASK_ID, response: { format: "single_choice", optionId: "b" }, timeMs: null, isCorrect: false }],
    });
    stubAdmin(taskRow());
    const complete = stubLlmResolves({ explanation: "ok" });

    for (let i = 0; i < 10; i++) {
      const res = await callPost();
      expect(res.status).toBe(200);
    }

    const res = await callPost();

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(complete).toHaveBeenCalledTimes(10);
  });

  it("exports maxDuration=60", () => {
    expect(maxDuration).toBe(60);
  });
});
