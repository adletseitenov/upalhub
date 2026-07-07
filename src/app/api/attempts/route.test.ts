import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredAttempt } from "@/features/attempts/repo";
import type { StoredTest } from "@/features/tests/repo";

// Границы (supabase-клиент, repo-фабрики) мокаются как в items-route.test.ts.
// Сервис @/features/attempts/service мокается ЦЕЛИКОМ (в отличие от
// items-route.test.ts, где saveAnswers настоящий) — эти тесты проверяют
// исключительно роутинг (статусы/shape/ownership-гейт до вызова сервиса),
// а не логику startAttempt/submitAttempt (та уже покрыта service.test.ts, T5).
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));
vi.mock("@/features/attempts/repo", () => ({
  supabaseAttemptRepo: vi.fn(),
}));
vi.mock("@/features/tests/repo", () => ({
  supabaseTestRepo: vi.fn(),
}));
vi.mock("@/features/attempts/service", () => ({
  startAttempt: vi.fn(),
  submitAttempt: vi.fn(),
}));

import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { startAttempt, submitAttempt } from "@/features/attempts/service";
import { POST as startPOST } from "@/app/api/attempts/route";
import { POST as submitPOST } from "@/app/api/attempts/[id]/submit/route";

const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedAttemptRepo = vi.mocked(supabaseAttemptRepo);
const mockedTestRepo = vi.mocked(supabaseTestRepo);
const mockedStartAttempt = vi.mocked(startAttempt);
const mockedSubmitAttempt = vi.mocked(submitAttempt);

// Валидный по RFC 9562 uuid — zod 4 z.uuid() проверяет version/variant-биты
// (паттерн src/app/api/tests/route.test.ts).
const TEST_ID = "11111111-1111-4111-8111-111111111111";
const HQ_ID = "hq-1";
const ATTEMPT_ID = "attempt-1";

function attemptFixture(overrides: Partial<StoredAttempt> = {}): StoredAttempt {
  return {
    id: ATTEMPT_ID,
    testId: TEST_ID,
    userId: "user-1",
    startedAt: new Date("2026-07-07T10:00:00Z"),
    finishedAt: null,
    rawScore: null,
    scaledScore: null,
    ...overrides,
  };
}

function testFixture(): StoredTest {
  return {
    id: TEST_ID,
    hqId: HQ_ID,
    kind: "diagnostic",
    spec: {
      version: 1,
      kind: "diagnostic",
      language: "kk",
      sections: [{ name: "Математика", taskIds: ["t1", "t2"] }],
      taskIds: ["t1", "t2"],
      totalTimeMinutes: null,
      scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
    },
  };
}

// --- fake Supabase query-builder ------------------------------------------
// Chainable + thenable stub (паттерн src/app/api/tests/route.test.ts, расширен
// собственным .then): в submit-роуте `.in(...)` — терминальный вызов без
// .maybeSingle()/.single(), поэтому чейн сам должен быть await-абельным.

type QueryResult = { data: unknown; error: unknown };

function chainable(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "limit", "order"]) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve(result);
  builder.single = () => Promise.resolve(result);
  // Позволяет await-ить чейн напрямую (без .maybeSingle()/.single()), как
  // делает submit-роут для .from("tasks").select("*").in(...).
  builder.then = (
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

function fakeSupabase(opts: {
  user: { id: string } | null;
  studyHq?: QueryResult;
  tasks?: QueryResult;
}) {
  const tables: Record<string, QueryResult> = {
    study_hqs: opts.studyHq ?? { data: null, error: null },
    tasks: opts.tasks ?? { data: [], error: null },
  };
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: vi.fn((table: string) => chainable(tables[table] ?? { data: null, error: null })),
  };
}

function stubSupabase(opts: { user: { id: string } | null; studyHq?: QueryResult; tasks?: QueryResult }) {
  mockedSupabaseServer.mockResolvedValue(fakeSupabase(opts) as never);
}

function stubTestRepo(test: StoredTest | null) {
  mockedTestRepo.mockReturnValue({ getTest: vi.fn().mockResolvedValue(test) } as never);
}

function stubAttemptRepo(attempt: StoredAttempt | null) {
  mockedAttemptRepo.mockReturnValue({ getAttempt: vi.fn().mockResolvedValue(attempt) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/attempts (start)", () => {
  function startRequest(body: unknown) {
    return new Request("http://localhost/api/attempts", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  it("401s when there is no authenticated user", async () => {
    stubSupabase({ user: null });

    const res = await startPOST(startRequest({ testId: TEST_ID }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("400s on a malformed body (missing/invalid testId)", async () => {
    stubSupabase({ user: { id: "user-1" } });

    const res = await startPOST(startRequest({ testId: "not-a-uuid" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("404s when the test does not exist", async () => {
    stubSupabase({ user: { id: "user-1" } });
    stubTestRepo(null);

    const res = await startPOST(startRequest({ testId: TEST_ID }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedStartAttempt).not.toHaveBeenCalled();
  });

  it("404s when the test belongs to someone else's hq (study_hqs check misses)", async () => {
    stubSupabase({ user: { id: "intruder" }, studyHq: { data: null, error: null } });
    stubTestRepo(testFixture());

    const res = await startPOST(startRequest({ testId: TEST_ID }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedStartAttempt).not.toHaveBeenCalled();
  });

  it("200s with {attemptId, deadlineAt, startedAt, finishedAt, spec} and no answer leak", async () => {
    stubSupabase({ user: { id: "user-1" }, studyHq: { data: { id: HQ_ID }, error: null } });
    stubTestRepo(testFixture());
    mockedAttemptRepo.mockReturnValue({} as never);
    mockedStartAttempt.mockResolvedValue({
      attempt: attemptFixture(),
      deadlineAt: new Date("2026-07-07T11:00:00Z"),
    });

    const res = await startPOST(startRequest({ testId: TEST_ID }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      attemptId: ATTEMPT_ID,
      deadlineAt: "2026-07-07T11:00:00.000Z",
      startedAt: "2026-07-07T10:00:00.000Z",
      finishedAt: null,
      spec: {
        kind: "diagnostic",
        sections: [{ name: "Математика", taskIds: ["t1", "t2"] }],
        taskIds: ["t1", "t2"],
        totalTimeMinutes: null,
      },
    });
    // Shape-гарантия: start никогда не отдаёт ответы заданий.
    expect(JSON.stringify(body)).not.toContain('"answer"');
  });
});

describe("POST /api/attempts/[id]/submit", () => {
  function submitRequest() {
    return new Request(`http://localhost/api/attempts/${ATTEMPT_ID}/submit`, { method: "POST" });
  }

  const submitParams = { params: Promise.resolve({ id: ATTEMPT_ID }) };

  it("401s when there is no authenticated user", async () => {
    stubSupabase({ user: null });

    const res = await submitPOST(submitRequest(), submitParams);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("404s when the attempt does not exist", async () => {
    stubSupabase({ user: { id: "user-1" } });
    stubAttemptRepo(null);

    const res = await submitPOST(submitRequest(), submitParams);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedSubmitAttempt).not.toHaveBeenCalled();
  });

  it("403s (forbidden) on someone else's existing attempt, before submitAttempt is ever invoked", async () => {
    stubSupabase({ user: { id: "intruder" } });
    stubAttemptRepo(attemptFixture({ userId: "user-1" }));

    const res = await submitPOST(submitRequest(), submitParams);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    // Ownership-гейт живёт в роуте (требование ревью T5) — сервис,
    // единственный код, который видит tasks.answer, не должен был вызываться.
    expect(mockedSubmitAttempt).not.toHaveBeenCalled();
  });

  it("200s with {raw, scaled, total, alreadyFinished} shape and no answer leak", async () => {
    stubSupabase({ user: { id: "user-1" }, tasks: { data: [], error: null } });
    stubAttemptRepo(attemptFixture({ userId: "user-1" }));
    stubTestRepo(testFixture());
    mockedSubmitAttempt.mockResolvedValue({ raw: 1, scaled: 70, total: 2, alreadyFinished: false });

    const res = await submitPOST(submitRequest(), submitParams);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ raw: 1, scaled: 70, total: 2, alreadyFinished: false });
    // Shape-гарантия: submit — единственный роут, читающий tasks.answer,
    // но наружу отдаёт только агрегированный счёт, без единого answer-поля.
    expect(JSON.stringify(body)).not.toContain('"answer"');

    expect(mockedSubmitAttempt).toHaveBeenCalledTimes(1);
    const [, args] = mockedSubmitAttempt.mock.calls[0];
    expect(args.attemptId).toBe(ATTEMPT_ID);
    expect(args.userId).toBe("user-1");
    expect(args.test.id).toBe(TEST_ID);
    expect(args.now).toBeInstanceOf(Date);
  });

  it("a resubmit of an already-finished attempt returns alreadyFinished: true", async () => {
    stubSupabase({ user: { id: "user-1" }, tasks: { data: [], error: null } });
    stubAttemptRepo(attemptFixture({ userId: "user-1", finishedAt: new Date("2026-07-07T11:00:00Z") }));
    stubTestRepo(testFixture());
    mockedSubmitAttempt.mockResolvedValue({ raw: 1, scaled: 70, total: 2, alreadyFinished: true });

    const res = await submitPOST(submitRequest(), submitParams);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ raw: 1, scaled: 70, total: 2, alreadyFinished: true });
  });
});
