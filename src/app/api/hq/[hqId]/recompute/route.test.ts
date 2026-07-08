import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock calls are hoisted above imports — route.ts constructs
// supabaseHqReader/supabaseKnowledgeRepo from the (mocked) user client, and
// calls the (mocked) recomputeHqInsights — recomputeLimiter itself is NOT
// mocked (429-тест гоняет реальную корзину, паттерн /api/tests).
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

import { supabaseServer } from "@/lib/supabase/server";
import { recomputeHqInsights } from "@/features/hq/recompute";
import { POST, maxDuration } from "./route";

const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedRecompute = vi.mocked(recomputeHqInsights);

const HQ_ID = "11111111-1111-4111-8111-111111111111";

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

function fakeSupabase(opts: { user: { id: string } | null; studyHq?: QueryResult }) {
  const tables: Record<string, QueryResult> = {
    study_hqs: opts.studyHq ?? { data: null, error: null },
  };
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: vi.fn((table: string) => chainable(tables[table] ?? { data: null, error: null })),
  };
}

function postRequest() {
  return new Request(`http://localhost/api/hq/${HQ_ID}/recompute`, { method: "POST" });
}

function callPost() {
  return POST(postRequest(), { params: Promise.resolve({ hqId: HQ_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRecompute.mockResolvedValue(undefined);
});

describe("POST /api/hq/[hqId]/recompute", () => {
  it("401s when there is no authenticated user", async () => {
    mockedSupabaseServer.mockResolvedValue(fakeSupabase({ user: null }) as never);

    const res = await callPost();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mockedRecompute).not.toHaveBeenCalled();
  });

  it("404s when the hq does not belong to (or does not exist for) the caller", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-foreign-hq" },
        studyHq: { data: null, error: null }, // .eq(user_id) отфильтровал чужой/несуществующий hq
      }) as never,
    );

    const res = await callPost();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(mockedRecompute).not.toHaveBeenCalled();
  });

  it("429s once the caller's token bucket (capacity 6) is exhausted, before recomputeHqInsights runs", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-limited" },
        studyHq: { data: { id: HQ_ID }, error: null },
      }) as never,
    );

    for (let i = 0; i < 6; i++) {
      const res = await callPost();
      expect(res.status).toBe(200);
    }

    const res = await callPost();

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(mockedRecompute).toHaveBeenCalledTimes(6);
  });

  it("200s with {recomputed: true} and calls recomputeHqInsights with the resolved hqId + a fresh now", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-success" },
        studyHq: { data: { id: HQ_ID }, error: null },
      }) as never,
    );
    const before = Date.now();

    const res = await callPost();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recomputed: true });
    expect(mockedRecompute).toHaveBeenCalledTimes(1);
    const [, args] = mockedRecompute.mock.calls[0];
    expect(args.hqId).toBe(HQ_ID);
    expect(args.now).toBeInstanceOf(Date);
    expect(args.now.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("propagates a recompute failure as a 500 (no error-shape hack) instead of silently 200ing", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-fails" },
        studyHq: { data: { id: HQ_ID }, error: null },
      }) as never,
    );
    mockedRecompute.mockRejectedValue(new Error("boom"));

    await expect(callPost()).rejects.toThrow("boom");
  });

  it("is idempotent: two sequential calls both recompute and both return {recomputed: true}", async () => {
    mockedSupabaseServer.mockResolvedValue(
      fakeSupabase({
        user: { id: "u-idempotent" },
        studyHq: { data: { id: HQ_ID }, error: null },
      }) as never,
    );

    const first = await callPost();
    const second = await callPost();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual({ recomputed: true });
    expect(await second.json()).toEqual({ recomputed: true });
    expect(mockedRecompute).toHaveBeenCalledTimes(2);
  });

  it("exports maxDuration=60", () => {
    expect(maxDuration).toBe(60);
  });
});
