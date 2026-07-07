import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  createLlm: vi.fn(() => ({ complete: vi.fn() })),
}));
vi.mock("@/lib/search", () => ({
  createSearch: vi.fn(() => ({ search: vi.fn(), fetchPage: vi.fn() })),
}));
vi.mock("@/features/exam-profile/service", () => ({
  findOrCreateExamProfile: vi.fn(),
}));
vi.mock("@/features/exam-profile/repo", () => ({
  supabaseExamProfileRepo: vi.fn(),
}));

import { supabaseServer } from "@/lib/supabase/server";
import { findOrCreateExamProfile } from "@/features/exam-profile/service";
import { supabaseExamProfileRepo } from "@/features/exam-profile/repo";
import { ResearchError } from "@/features/exam-profile/research";
import type { StoredExamProfile } from "@/features/exam-profile/service";
import { POST } from "./route";

const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedFindOrCreate = vi.mocked(findOrCreateExamProfile);
const mockedRepoFactory = vi.mocked(supabaseExamProfileRepo);

function rejectedProfileFixture(overrides: Partial<StoredExamProfile> = {}): StoredExamProfile {
  return {
    id: "profile-sat",
    slug: "sat",
    title: "SAT",
    language: "en",
    spec: {
      examName: "SAT",
      language: "en",
      country: "США",
      description: "d",
      sections: [{ name: "Math", taskTypes: [], topics: [] }],
      variants: [],
      selectionGroups: [],
      scoring: { scaleMin: 0, scaleMax: 1600, unit: "points" },
    },
    sources: [],
    origin: "ai_research",
    trust: "ai_draft",
    ...overrides,
  };
}

function createdProfileFixture(overrides: Partial<StoredExamProfile> = {}): StoredExamProfile {
  return {
    id: "profile-new",
    slug: "ent-2027",
    title: "ЕНТ",
    language: "kk",
    spec: {
      examName: "ЕНТ",
      language: "kk",
      country: null,
      description: "d",
      sections: [{ name: "Математика", taskTypes: [], topics: [] }],
      variants: [],
      selectionGroups: [],
      scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
    },
    sources: [],
    origin: "ai_research",
    trust: "ai_draft",
    ...overrides,
  };
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/exam-profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function stubUser(userId: string | null, upsertResult: { error: unknown } = { error: null }) {
  const upsertMock = vi.fn().mockResolvedValue(upsertResult);
  const supabase = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }) },
    from: vi.fn((table: string) => {
      if (table === "exam_profile_reports") {
        return { upsert: upsertMock };
      }
      return { upsert: vi.fn() };
    }),
  };
  mockedSupabaseServer.mockResolvedValue(supabase as never);
  return { upsertMock };
}

function stubRepo(findBySlug: (slug: string) => Promise<StoredExamProfile | null>) {
  const repo = { findBySlug: vi.fn(findBySlug), insert: vi.fn() };
  mockedRepoFactory.mockReturnValue(repo as never);
  return repo;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/exam-profiles", () => {
  it("401s when there is no authenticated user", async () => {
    stubUser(null);
    stubRepo(async () => null);

    const res = await POST(postRequest({ query: "ЕНТ 2027" }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("400s on a malformed body (query too short)", async () => {
    stubUser("u-badbody");
    stubRepo(async () => null);

    const res = await POST(postRequest({ query: "a" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("resolves the normal path (no excludeSlug) with {slug, created}", async () => {
    stubUser("u-normal");
    stubRepo(async () => null);
    mockedFindOrCreate.mockResolvedValue({ profile: createdProfileFixture(), created: true });

    const res = await POST(postRequest({ query: "ЕНТ 2027" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: "ent-2027", created: true });
    expect(mockedFindOrCreate).toHaveBeenCalledTimes(1);
    const [, calledQuery, calledOpts] = mockedFindOrCreate.mock.calls[0];
    expect(calledQuery).toBe("ЕНТ 2027");
    expect(calledOpts).toBeUndefined();
  });

  it("404s when findOrCreateExamProfile throws ResearchError", async () => {
    stubUser("u-notfound");
    stubRepo(async () => null);
    mockedFindOrCreate.mockRejectedValue(new ResearchError("ничего не найдено"));

    const res = await POST(postRequest({ query: "неизвестный экзамен" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("429s once the caller's token bucket (capacity 3) is exhausted", async () => {
    stubUser("u-limited");
    stubRepo(async () => null);
    mockedFindOrCreate.mockResolvedValue({ profile: createdProfileFixture(), created: true });

    for (let i = 0; i < 3; i++) {
      const res = await POST(postRequest({ query: "ЕНТ 2027" }));
      expect(res.status).toBe(200);
    }

    const res = await POST(postRequest({ query: "ЕНТ 2027" }));

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    // 4th call never reaches findOrCreateExamProfile.
    expect(mockedFindOrCreate).toHaveBeenCalledTimes(3);
  });

  describe("reroll (excludeSlug)", () => {
    it("looks up the rejected profile, forwards avoid + slugOverride, and upserts a report", async () => {
      const { upsertMock } = stubUser("u-reroll");
      const repo = stubRepo(async (slug) => (slug === "sat" ? rejectedProfileFixture() : null));
      mockedFindOrCreate.mockResolvedValue({ profile: createdProfileFixture(), created: true });

      const res = await POST(
        postRequest({ query: "ЕНТ 2027", excludeSlug: "sat", clarification: "это казахстанский экзамен" }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slug: "ent-2027", created: true });

      expect(repo.findBySlug).toHaveBeenCalledWith("sat");

      expect(mockedFindOrCreate).toHaveBeenCalledTimes(1);
      const [, calledQuery, calledOpts] = mockedFindOrCreate.mock.calls[0];
      expect(calledQuery).toBe("ЕНТ 2027 это казахстанский экзамен");
      expect(calledOpts).toMatchObject({ avoid: { name: "SAT", country: "США" } });
      expect(calledOpts?.slugOverride).toBeTruthy();

      expect(upsertMock).toHaveBeenCalledTimes(1);
      const [payload, options] = upsertMock.mock.calls[0];
      expect(payload).toMatchObject({
        reported_profile_id: "profile-sat",
        user_id: "u-reroll",
        clarification: "это казахстанский экзамен",
        new_slug: "ent-2027",
      });
      expect(options).toEqual({ onConflict: "reported_profile_id,user_id" });
    });

    it("falls back to the normal path when excludeSlug does not resolve to an existing profile", async () => {
      const { upsertMock } = stubUser("u-reroll-miss");
      const repo = stubRepo(async () => null);
      mockedFindOrCreate.mockResolvedValue({ profile: createdProfileFixture(), created: false });

      const res = await POST(postRequest({ query: "ЕНТ 2027", excludeSlug: "ghost-slug" }));

      expect(res.status).toBe(200);
      expect(repo.findBySlug).toHaveBeenCalledWith("ghost-slug");
      expect(mockedFindOrCreate).toHaveBeenCalledTimes(1);
      const [, calledQuery, calledOpts] = mockedFindOrCreate.mock.calls[0];
      expect(calledQuery).toBe("ЕНТ 2027");
      expect(calledOpts).toBeUndefined();
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it("does not fail the 200 response when the report upsert returns an error", async () => {
      stubUser("u-report-fails", { error: { message: "RLS violation" } });
      stubRepo(async (slug) => (slug === "sat" ? rejectedProfileFixture() : null));
      mockedFindOrCreate.mockResolvedValue({ profile: createdProfileFixture(), created: true });

      const res = await POST(
        postRequest({ query: "ЕНТ 2027", excludeSlug: "sat", clarification: "уточнение" }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slug: "ent-2027", created: true });
    });

    it("does not fail the 200 response when the report upsert call throws", async () => {
      stubUser("u-report-throws");
      stubRepo(async (slug) => (slug === "sat" ? rejectedProfileFixture() : null));
      mockedFindOrCreate.mockResolvedValue({ profile: createdProfileFixture(), created: true });
      mockedSupabaseServer.mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({ data: { user: { id: "u-report-throws" } } }),
        },
        from: vi.fn(() => ({
          upsert: vi.fn().mockRejectedValue(new Error("network down")),
        })),
      } as never);

      const res = await POST(
        postRequest({ query: "ЕНТ 2027", excludeSlug: "sat", clarification: "уточнение" }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slug: "ent-2027", created: true });
    });
  });
});
