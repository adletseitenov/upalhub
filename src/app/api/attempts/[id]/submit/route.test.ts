import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredAttempt } from "@/features/attempts/repo";
import type { StoredTest } from "@/features/tests/repo";

// Границы: supabase-клиенты + repo-фабрики + submitAttempt (реальный сервис
// не мокается напрямую — тест кроет реальный маппинг статусов, паттерн
// items-route.test.ts) + recomputeHqInsights (мокается, чтобы управлять
// success/throw независимо от submitAttempt).
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: vi.fn(),
}));
vi.mock("@/features/attempts/repo", () => ({
  supabaseAttemptRepo: vi.fn(),
}));
vi.mock("@/features/tests/repo", () => ({
  supabaseTestRepo: vi.fn(),
}));
vi.mock("@/features/hq/recompute", () => ({
  recomputeHqInsights: vi.fn(),
  supabaseHqReader: vi.fn(() => ({ __tag: "hq-reader" })),
}));
vi.mock("@/features/knowledge/repo", () => ({
  supabaseKnowledgeRepo: vi.fn(() => ({ __tag: "knowledge-repo" })),
}));
vi.mock("@/features/plan/repo", () => ({
  supabasePlanRepo: vi.fn(() => ({ __tag: "plan-repo" })),
}));
vi.mock("@/features/forecast/repo", () => ({
  supabaseForecastRepo: vi.fn(() => ({ __tag: "forecast-repo" })),
}));

import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { recomputeHqInsights } from "@/features/hq/recompute";
import { POST, maxDuration } from "./route";

const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedSupabaseAdmin = vi.mocked(supabaseAdmin);
const mockedAttemptRepo = vi.mocked(supabaseAttemptRepo);
const mockedTestRepo = vi.mocked(supabaseTestRepo);
const mockedRecompute = vi.mocked(recomputeHqInsights);

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

function testFixture(overrides: Partial<StoredTest> = {}): StoredTest {
  return {
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
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
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

function stubAuth(user: { id: string } | null) {
  mockedSupabaseServer.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
  } as never);
}

function stubRepos(opts: {
  attempt: StoredAttempt | null;
  test?: StoredTest | null;
  finalize?: ReturnType<typeof vi.fn>;
}) {
  const finalize =
    opts.finalize ??
    vi.fn().mockImplementation(async (attemptId: string, patch: unknown) => ({
      ...attemptFixture(),
      id: attemptId,
      finishedAt: (patch as { finishedAt: Date }).finishedAt,
      rawScore: (patch as { rawScore: number }).rawScore,
      scaledScore: (patch as { scaledScore: number }).scaledScore,
    }));
  mockedAttemptRepo.mockReturnValue({
    getAttempt: vi.fn().mockResolvedValue(opts.attempt),
    getItems: vi.fn().mockResolvedValue([]),
    finalize,
  } as never);
  mockedTestRepo.mockReturnValue({
    getTest: vi.fn().mockResolvedValue(opts.test ?? null),
  } as never);
  return { finalize };
}

function stubAdmin(rows: unknown[]) {
  const from = vi.fn(() => ({
    select: () => ({
      in: () => Promise.resolve({ data: rows, error: null }),
    }),
  }));
  mockedSupabaseAdmin.mockReturnValue({ from } as never);
}

function postRequest() {
  return new Request(`http://localhost/api/attempts/${ATTEMPT_ID}/submit`, { method: "POST" });
}

const params = { params: Promise.resolve({ id: ATTEMPT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockedRecompute.mockResolvedValue(undefined);
});

describe("POST /api/attempts/[id]/submit", () => {
  it("401s when there is no authenticated user", async () => {
    stubAuth(null);
    stubRepos({ attempt: attemptFixture() });

    const res = await POST(postRequest(), params);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mockedRecompute).not.toHaveBeenCalled();
  });

  it("404s when the attempt does not exist", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: null });

    const res = await POST(postRequest(), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("403s on someone else's attempt, before any grading/recompute", async () => {
    stubAuth({ id: "intruder" });
    stubRepos({ attempt: attemptFixture({ userId: "user-1" }) });

    const res = await POST(postRequest(), params);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(mockedRecompute).not.toHaveBeenCalled();
  });

  it("404s when the attempt's test does not exist", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: attemptFixture(), test: null });

    const res = await POST(postRequest(), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("submits successfully and calls recomputeHqInsights with the test's hqId", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: attemptFixture(), test: testFixture() });
    stubAdmin([taskRow()]);

    const res = await POST(postRequest(), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ alreadyFinished: false });
    expect(mockedRecompute).toHaveBeenCalledTimes(1);
    const [, args] = mockedRecompute.mock.calls[0];
    expect(args.hqId).toBe("hq-1");
    expect(args.now).toBeInstanceOf(Date);
  });

  it("still responds 200 with the submit result when recomputeHqInsights throws (best-effort, swallowed)", async () => {
    stubAuth({ id: "user-1" });
    stubRepos({ attempt: attemptFixture(), test: testFixture() });
    stubAdmin([taskRow()]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockedRecompute.mockRejectedValue(new Error("recompute blew up"));

    const res = await POST(postRequest(), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ alreadyFinished: false });
    expect(mockedRecompute).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("hq-1");
    warnSpy.mockRestore();
  });

  it("exports maxDuration=60", () => {
    expect(maxDuration).toBe(60);
  });
});
