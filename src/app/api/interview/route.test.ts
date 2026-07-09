import { beforeEach, describe, expect, it, vi } from "vitest";

// Границы: supabase-клиенты + repo-фабрики + createLlm мокаются (паттерн
// explain/route.test.ts и study-hqs/route.test.ts) — деривация/merge/
// analyzeOpenAnswers/resolveActiveSections остаются РЕАЛЬНЫМИ,
// interviewLimiter — реальный module-level singleton (429-тест гоняет
// настоящую корзину, уникальный user.id на тест, как в explain route test).
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
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
vi.mock("@/lib/llm", () => ({
  createLlm: vi.fn(),
}));

import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";
import { recomputeHqInsights } from "@/features/hq/recompute";
import { createLlm } from "@/lib/llm";
import { DEFAULT_APPROACH } from "@/features/interview/approach";
import { POST, maxDuration } from "./route";

const mockedCookies = vi.mocked(cookies);
const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedRecompute = vi.mocked(recomputeHqInsights);
const mockedCreateLlm = vi.mocked(createLlm);

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const HQ_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "user-1";

type QueryResult = { data: unknown; error: unknown };

// Тот же приём, что и study-hqs/route.test.ts: study_hqs обслуживает ДВЕ
// разные операции за один запрос (select ownership, затем update) —
// каждый .from("study_hqs") забирает следующий элемент очереди.
function chainable(result: QueryResult, onUpdate?: (payload: unknown) => void) {
  const self = Promise.resolve(result) as unknown as Record<string, unknown> & PromiseLike<QueryResult>;
  for (const method of ["select", "eq", "in", "is", "limit", "order"]) {
    self[method] = () => self;
  }
  self.update = (payload: unknown) => {
    onUpdate?.(payload);
    return self;
  };
  self.maybeSingle = () => Promise.resolve(result);
  self.single = () => Promise.resolve(result);
  return self;
}

function fakeSupabase(opts: {
  user: { id: string } | null;
  studyHqQueue?: QueryResult[];
  examProfile?: QueryResult;
  captured?: { updates: unknown[] };
}) {
  const queue = [...(opts.studyHqQueue ?? [])];
  const captured = opts.captured ?? { updates: [] };
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: vi.fn((table: string) => {
      if (table === "study_hqs") {
        const result = queue.shift() ?? { data: null, error: null };
        return chainable(result, (payload) => captured.updates.push(payload));
      }
      if (table === "exam_profiles") {
        return chainable(opts.examProfile ?? { data: null, error: null });
      }
      return chainable({ data: null, error: null });
    }),
  };
}

function stubSupabase(opts: {
  user: { id: string } | null;
  studyHqQueue?: QueryResult[];
  examProfile?: QueryResult;
  captured?: { updates: unknown[] };
}) {
  mockedSupabaseServer.mockResolvedValue(fakeSupabase(opts) as never);
}

function stubCookies(locale?: string) {
  mockedCookies.mockResolvedValue({
    get: vi.fn((name: string) => (name === "NEXT_LOCALE" && locale ? { value: locale } : undefined)),
  } as never);
}

function stubLlmResolves(result: { concerns: string[]; tone: string; summary: string }) {
  const complete = vi.fn().mockResolvedValue(result);
  mockedCreateLlm.mockReturnValue({ complete } as never);
  return complete;
}

function stubLlmRejects(err: Error) {
  const complete = vi.fn().mockRejectedValue(err);
  mockedCreateLlm.mockReturnValue({ complete } as never);
  return complete;
}

function ownerRow(overrides: Partial<{ user_id: string; exam_profile_id: string; config: unknown; approach: unknown }> = {}) {
  return {
    data: {
      user_id: OWNER_ID,
      exam_profile_id: PROFILE_ID,
      config: null,
      approach: null,
      ...overrides,
    },
    error: null,
  };
}

function repeat(item: QueryResult, times: number): QueryResult[] {
  return Array.from({ length: times }, () => item);
}

// 🔴 interviewLimiter is a REAL module-level singleton (capacity 3/10min) —
// any test that reaches past the ownership check consumes one of its
// tokens. Tests that don't specifically exercise the 429 path must use a
// FRESH per-test user id (own bucket), or they'd spuriously exhaust each
// other's shared "user-1" bucket (only the dedicated 429 test below is
// meant to drain a bucket on purpose).
let ownerCounter = 0;
function freshOwnerId(): string {
  ownerCounter += 1;
  return `owner-${ownerCounter}`;
}

function flatSpec() {
  return {
    examName: "Флэт экзамен",
    language: "ru",
    description: "d",
    sections: [
      { name: "Математика", taskTypes: [], topics: [] },
      { name: "Физика", taskTypes: [], topics: [] },
    ],
    variants: [],
    selectionGroups: [],
    scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
  };
}

function validButtons(overrides: Record<string, unknown> = {}) {
  return {
    level: "beginner",
    hoursPerWeek: "3-6",
    weakSections: ["Математика"],
    explanationStyle: "concise",
    ...overrides,
  };
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/interview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubCookies("ru");
  mockedRecompute.mockResolvedValue(undefined);
});

describe("POST /api/interview", () => {
  it("401s when there is no authenticated user", async () => {
    stubSupabase({ user: null });

    const res = await POST(postRequest({ hqId: HQ_ID, buttons: validButtons() }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mockedCreateLlm).not.toHaveBeenCalled();
  });

  it("400s on a malformed body (missing buttons)", async () => {
    stubSupabase({ user: { id: OWNER_ID } });

    const res = await POST(postRequest({ hqId: HQ_ID }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("400s on a malformed body (invalid level enum)", async () => {
    stubSupabase({ user: { id: OWNER_ID } });

    const res = await POST(postRequest({ hqId: HQ_ID, buttons: validButtons({ level: "expert" }) }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("404s when the hq does not exist", async () => {
    stubSupabase({ user: { id: OWNER_ID }, studyHqQueue: [{ data: null, error: null }] });

    const res = await POST(postRequest({ hqId: HQ_ID, buttons: validButtons() }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedCreateLlm).not.toHaveBeenCalled();
  });

  it("404s when the hq belongs to a different user (ownership, not 403)", async () => {
    stubSupabase({
      user: { id: "intruder" },
      studyHqQueue: [ownerRow({ user_id: OWNER_ID })],
    });

    const res = await POST(postRequest({ hqId: HQ_ID, buttons: validButtons() }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedCreateLlm).not.toHaveBeenCalled();
  });

  it("400s with invalid_weak_sections when a weakSection is outside resolveActiveSections", async () => {
    const userId = freshOwnerId();
    stubSupabase({
      user: { id: userId },
      studyHqQueue: [ownerRow({ user_id: userId })],
      examProfile: { data: { spec: flatSpec() }, error: null },
    });

    const res = await POST(
      postRequest({ hqId: HQ_ID, buttons: validButtons({ weakSections: ["Не существует"] }) }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_weak_sections" });
    expect(mockedCreateLlm).not.toHaveBeenCalled();
  });

  it("200s on the happy path with buttons only: derives approach, 0 llm calls, updates approach column", async () => {
    const userId = freshOwnerId();
    const captured = { updates: [] as unknown[] };
    stubSupabase({
      user: { id: userId },
      studyHqQueue: [ownerRow({ user_id: userId }), { data: null, error: null }],
      examProfile: { data: { spec: flatSpec() }, error: null },
      captured,
    });
    const complete = stubLlmResolves({ concerns: [], tone: "neutral", summary: "" });

    const res = await POST(
      postRequest({ hqId: HQ_ID, buttons: validButtons({ level: "confident", hoursPerWeek: "7+" }) }),
    );

    expect(res.status).toBe(200);
    expect(complete).not.toHaveBeenCalled();
    const body = (await res.json()) as { approach: Record<string, unknown> };
    expect(body.approach).toEqual({
      level: "confident",
      intensity: "intense",
      focusSections: ["Математика"],
      explanationStyle: "concise",
      concerns: [],
      tone: "neutral",
      summary: "",
    });
    expect(captured.updates).toHaveLength(1);
    expect((captured.updates[0] as { approach: unknown }).approach).toEqual(body.approach);
    expect(mockedRecompute).toHaveBeenCalledTimes(1);
    const [, args] = mockedRecompute.mock.calls[0];
    expect(args.hqId).toBe(HQ_ID);
  });

  it("openAnswers non-empty -> calls the llm exactly once and merges concerns/tone/summary", async () => {
    const userId = freshOwnerId();
    stubSupabase({
      user: { id: userId },
      studyHqQueue: [ownerRow({ user_id: userId }), { data: null, error: null }],
      examProfile: { data: { spec: flatSpec() }, error: null },
    });
    const complete = stubLlmResolves({ concerns: ["боюсь устной"], tone: "reassuring", summary: "нервничает" });

    const res = await POST(
      postRequest({
        hqId: HQ_ID,
        buttons: validButtons(),
        openAnswers: { concern: "боюсь устной части" },
      }),
    );

    expect(res.status).toBe(200);
    expect(complete).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { approach: Record<string, unknown> };
    expect(body.approach).toMatchObject({
      concerns: ["боюсь устной"],
      tone: "reassuring",
      summary: "нервничает",
    });
  });

  // 🔴 D1 Acceptance: an analyze failure must not block writing the
  // (derive-only) approach — the route degrades to analyzed=null, same as
  // if openAnswers had been empty.
  it("🔴 llm failure during analyze does not block the 200 response (analyze-only fields fall back to existing)", async () => {
    const userId = freshOwnerId();
    stubSupabase({
      user: { id: userId },
      studyHqQueue: [
        ownerRow({ user_id: userId, approach: { ...DEFAULT_APPROACH, concerns: ["старый страх"], summary: "старое" } }),
        { data: null, error: null },
      ],
      examProfile: { data: { spec: flatSpec() }, error: null },
    });
    stubLlmRejects(new Error("OpenRouter 402: insufficient credits"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await POST(
      postRequest({ hqId: HQ_ID, buttons: validButtons(), openAnswers: { concern: "боюсь устной" } }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { approach: Record<string, unknown> };
    expect(body.approach.concerns).toEqual(["старый страх"]);
    expect(body.approach.summary).toBe("старое");
    warnSpy.mockRestore();
  });

  // 🔴 D1 regression pin: re-interview with SKIPPED open answers must
  // preserve the existing concerns/tone/summary, not wipe them.
  it("🔴 re-интервью со скипнутыми открытыми сохраняет старые concerns/tone/summary", async () => {
    const userId = freshOwnerId();
    stubSupabase({
      user: { id: userId },
      studyHqQueue: [
        ownerRow({
          user_id: userId,
          approach: {
            level: "beginner",
            intensity: "light",
            focusSections: ["Старое"],
            explanationStyle: "concise",
            concerns: ["старый страх"],
            tone: "challenging",
            summary: "старое резюме",
          },
        }),
        { data: null, error: null },
      ],
      examProfile: { data: { spec: flatSpec() }, error: null },
    });
    const complete = stubLlmResolves({ concerns: [], tone: "neutral", summary: "" });

    const res = await POST(
      postRequest({
        hqId: HQ_ID,
        buttons: validButtons({ level: "confident", hoursPerWeek: "7+" }),
        // openAnswers omitted entirely -> analyze must not be called
      }),
    );

    expect(res.status).toBe(200);
    expect(complete).not.toHaveBeenCalled();
    const body = (await res.json()) as { approach: Record<string, unknown> };
    expect(body.approach.concerns).toEqual(["старый страх"]);
    expect(body.approach.tone).toBe("challenging");
    expect(body.approach.summary).toBe("старое резюме");
    // derive-поля патчатся ВСЕГДА
    expect(body.approach.level).toBe("confident");
    expect(body.approach.intensity).toBe("intense");
  });

  it("swallows a recompute failure: the response is still 200 (best-effort)", async () => {
    const userId = freshOwnerId();
    mockedRecompute.mockRejectedValue(new Error("recompute boom"));
    stubSupabase({
      user: { id: userId },
      studyHqQueue: [ownerRow({ user_id: userId }), { data: null, error: null }],
      examProfile: { data: { spec: flatSpec() }, error: null },
    });
    stubLlmResolves({ concerns: [], tone: "neutral", summary: "" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await POST(postRequest({ hqId: HQ_ID, buttons: validButtons() }));

    expect(res.status).toBe(200);
    expect(mockedRecompute).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("429s once the caller's token bucket (capacity 3) is exhausted, before the profile is ever fetched", async () => {
    const userId = "u-interview-limited";
    stubSupabase({
      user: { id: userId },
      studyHqQueue: repeat(ownerRow({ user_id: userId }), 20),
      examProfile: { data: { spec: flatSpec() }, error: null },
    });
    const complete = stubLlmResolves({ concerns: [], tone: "neutral", summary: "" });

    for (let i = 0; i < 3; i++) {
      const res = await POST(postRequest({ hqId: HQ_ID, buttons: validButtons() }));
      expect(res.status).toBe(200);
    }

    const res = await POST(postRequest({ hqId: HQ_ID, buttons: validButtons() }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(complete).toHaveBeenCalledTimes(0); // openAnswers omitted in every call above -> analyze never calls llm anyway
  });

  it("exports maxDuration=60", () => {
    expect(maxDuration).toBe(60);
  });
});
