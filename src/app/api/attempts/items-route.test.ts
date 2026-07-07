import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredAttempt, AttemptItemRow } from "@/features/attempts/repo";
import type { StoredTest } from "@/features/tests/repo";

// Мокаются только границы (supabase-клиент и repo-фабрики); сервис
// saveAnswers — НАСТОЯЩИЙ: тест покрывает реальный маппинг его ошибок на
// HTTP-статусы, а не мок мока.
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));
vi.mock("@/features/attempts/repo", () => ({
  supabaseAttemptRepo: vi.fn(),
}));
vi.mock("@/features/tests/repo", () => ({
  supabaseTestRepo: vi.fn(),
}));

import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { PATCH } from "./[id]/items/route";

const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedAttemptRepo = vi.mocked(supabaseAttemptRepo);
const mockedTestRepo = vi.mocked(supabaseTestRepo);

const ATTEMPT_ID = "attempt-1";

function attemptFixture(overrides: Partial<StoredAttempt> = {}): StoredAttempt {
  return {
    id: ATTEMPT_ID,
    testId: "test-1",
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
    id: "test-1",
    hqId: "hq-1",
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

function stubAuth(user: { id: string } | null) {
  mockedSupabaseServer.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
  } as never);
}

function stubRepos(opts: { attempt: StoredAttempt | null; test?: StoredTest | null }) {
  const upsertItems = vi.fn().mockResolvedValue(undefined);
  mockedAttemptRepo.mockReturnValue({
    getAttempt: vi.fn().mockResolvedValue(opts.attempt),
    upsertItems,
  } as never);
  mockedTestRepo.mockReturnValue({
    getTest: vi.fn().mockResolvedValue(opts.test ?? null),
  } as never);
  return { upsertItems };
}

function patchRequest(body: unknown) {
  return new Request(`http://localhost/api/attempts/${ATTEMPT_ID}/items`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: ATTEMPT_ID }) };

const validItems = {
  items: [{ taskId: "t1", response: { format: "single_choice", optionId: "a" }, timeMs: 900 }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/attempts/[id]/items", () => {
  it("401s when there is no authenticated user", async () => {
    stubAuth(null);
    stubRepos({ attempt: attemptFixture() });

    const res = await PATCH(patchRequest(validItems), params);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("400s on a malformed body (items missing)", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: attemptFixture() });

    const res = await PATCH(patchRequest({ nonsense: true }), params);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("404s when the attempt does not exist", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: null });

    const res = await PATCH(patchRequest(validItems), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("403s (forbidden, not 404/409) on someone else's attempt, before any write", async () => {
    stubAuth({ id: "intruder" });
    const { upsertItems } = stubRepos({ attempt: attemptFixture({ userId: "user-1" }), test: testFixture() });

    const res = await PATCH(patchRequest(validItems), params);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    // Ownership-гейт живёт в роуте (требование ревью T5) — до записи дело не дошло.
    expect(upsertItems).not.toHaveBeenCalled();
  });

  it("409s with attempt_closed when the attempt is already finished", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({
      attempt: attemptFixture({ finishedAt: new Date("2026-07-07T11:00:00Z") }),
      test: testFixture(),
    });

    const res = await PATCH(patchRequest(validItems), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "attempt_closed" });
  });

  it("400s when a taskId is outside the test spec (InvalidTaskError)", async () => {
    stubAuth({ id: "user-1" });
    const { upsertItems } = stubRepos({ attempt: attemptFixture(), test: testFixture() });

    const res = await PATCH(
      patchRequest({
        items: [{ taskId: "not-in-spec", response: { format: "single_choice", optionId: "a" } }],
      }),
      params,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
    expect(upsertItems).not.toHaveBeenCalled();
  });

  it("400s when the response shape fails taskResponseSchema", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: attemptFixture(), test: testFixture() });

    const res = await PATCH(
      patchRequest({ items: [{ taskId: "t1", response: { garbage: true } }] }),
      params,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("saves valid items and returns {saved: n} with no answer field in the response", async () => {
    stubAuth({ id: "user-1" });
    const { upsertItems } = stubRepos({ attempt: attemptFixture(), test: testFixture() });

    const res = await PATCH(
      patchRequest({
        items: [
          { taskId: "t1", response: { format: "single_choice", optionId: "a" }, timeMs: 900 },
          { taskId: "t2", response: { format: "single_choice", optionId: "b" } },
        ],
      }),
      params,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ saved: 2 });
    // Shape-гарантия: автосейв никогда не возвращает ответы заданий.
    expect(JSON.stringify(body)).not.toContain("answer");

    expect(upsertItems).toHaveBeenCalledTimes(1);
    const [attemptId, rows] = upsertItems.mock.calls[0] as [string, AttemptItemRow[]];
    expect(attemptId).toBe(ATTEMPT_ID);
    // Автосейв никогда не трогает is_correct (грейдинг только на submit).
    expect(rows.every((row) => row.isCorrect === null)).toBe(true);
  });
});
