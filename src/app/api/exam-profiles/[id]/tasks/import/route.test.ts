import { beforeEach, describe, expect, it, vi } from "vitest";

// Мокаются только границы (supabase-клиент, repo-фабрика) — parseImport и
// importTasks остаются НАСТОЯЩИМИ: тест покрывает реальный shape-контракт
// роута (счётчики/errors), а не мок мока (паттерн items-route.test.ts).
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));
// contentHash (real sha256) стаётся настоящим — import.ts импортирует его из
// того же модуля; мокается только supabaseTaskRepo-фабрика.
vi.mock("@/features/tasks/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/tasks/repo")>();
  return { ...actual, supabaseTaskRepo: vi.fn() };
});

import { supabaseServer } from "@/lib/supabase/server";
import { supabaseTaskRepo } from "@/features/tasks/repo";
import { POST } from "./route";

const mockedSupabaseServer = vi.mocked(supabaseServer);
const mockedTaskRepo = vi.mocked(supabaseTaskRepo);

// Валидный по RFC 9562 uuid — паттерн src/app/api/tests/route.test.ts.
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

type QueryResult = { data: unknown; error: unknown };

function chainable(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = () => Promise.resolve(result);
  return builder;
}

function stubSupabase(opts: { user: { id: string } | null; examProfile?: QueryResult }) {
  const tables: Record<string, QueryResult> = {
    exam_profiles: opts.examProfile ?? { data: null, error: null },
  };
  mockedSupabaseServer.mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: vi.fn((table: string) => chainable(tables[table] ?? { data: null, error: null })),
  } as never);
}

function profileRow(createdBy: string) {
  return {
    id: PROFILE_ID,
    slug: "ent",
    title: "ENT",
    language: "kk",
    spec: {},
    sources: [],
    origin: "ai_research",
    trust: "ai_draft",
    created_by: createdBy,
  };
}

function stubTaskRepo(insertManyImpl: (rows: unknown[]) => Promise<{ inserted: unknown[]; skipped: number }>) {
  const insertMany = vi.fn(insertManyImpl);
  mockedTaskRepo.mockReturnValue({ findBucket: vi.fn(), insertMany } as never);
  return insertMany;
}

// Реальный insertMany-заглушка "всё вставилось" — маппит row -> StoredTask
// с искусственным id, как это делает supabaseTaskRepo (Task 2).
async function insertAll(rows: unknown[]) {
  const inserted = rows.map((row, i) => ({ id: `t${i}`, ...(row as object) }));
  return { inserted, skipped: 0 };
}

function validTask(overrides: Record<string, unknown> = {}) {
  return {
    type: "history_kz",
    topic: "Ханы",
    difficulty: 2,
    language: "kk",
    body: {
      format: "single_choice",
      prompt: "В каком веке образовалось Казахское ханство?",
      options: [
        { id: "a", text: "XIII век" },
        { id: "b", text: "XV век" },
      ],
    },
    answer: { format: "single_choice", correctOptionId: "b" },
    explanation: "1465 год, XV век.",
    ...overrides,
  };
}

function postRequest(body: unknown) {
  return new Request(`http://localhost/api/exam-profiles/${PROFILE_ID}/tasks/import`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: PROFILE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/exam-profiles/[id]/tasks/import", () => {
  it("401s when there is no authenticated user", async () => {
    stubSupabase({ user: null });

    const res = await POST(postRequest([validTask()]), params);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("400s on a malformed [id] param (not a uuid)", async () => {
    stubSupabase({ user: { id: "user-1" } });

    const res = await POST(postRequest([validTask()]), { params: Promise.resolve({ id: "not-a-uuid" }) });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("404s when the exam profile does not exist", async () => {
    stubSupabase({ user: { id: "user-1" }, examProfile: { data: null, error: null } });

    const res = await POST(postRequest([validTask()]), params);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("403s for a non-creator, without ever calling insertMany", async () => {
    stubSupabase({
      user: { id: "intruder" },
      examProfile: { data: profileRow("owner-1"), error: null },
    });
    const insertMany = stubTaskRepo(insertAll);

    const res = await POST(postRequest([validTask()]), params);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(insertMany).not.toHaveBeenCalled();
  });

  it("400s a fully invalid array, reporting index + message per element", async () => {
    stubSupabase({
      user: { id: "owner-1" },
      examProfile: { data: profileRow("owner-1"), error: null },
    });
    const insertMany = stubTaskRepo(insertAll);

    const res = await POST(postRequest([{ garbage: true }, { also: "bad" }]), params);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("bad_request");
    expect(body.errors).toHaveLength(2);
    expect(body.errors[0].index).toBe(0);
    expect(body.errors[0].message).toBeTruthy();
    expect(body.errors[1].index).toBe(1);
    expect(insertMany).not.toHaveBeenCalled();
  });

  it("200s a mixed array: valid tasks inserted, counters reflect valid/invalid split", async () => {
    stubSupabase({
      user: { id: "owner-1" },
      examProfile: { data: profileRow("owner-1"), error: null },
    });
    const insertMany = stubTaskRepo(insertAll);

    const res = await POST(
      postRequest([validTask(), { garbage: true }, validTask({ topic: "Жузы" })]),
      params,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBe(2);
    expect(body.skippedDuplicates).toBe(0);
    expect(body.rejected).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].index).toBe(1);

    expect(insertMany).toHaveBeenCalledTimes(1);
    const rows = insertMany.mock.calls[0][0] as Array<{ origin: string; examProfileId: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.origin === "import" && r.examProfileId === PROFILE_ID)).toBe(true);
  });

  it("re-importing the same file: repo reports duplicates via skipped, and skippedDuplicates reflects it", async () => {
    stubSupabase({
      user: { id: "owner-1" },
      examProfile: { data: profileRow("owner-1"), error: null },
    });
    stubTaskRepo(async (rows) => ({ inserted: [], skipped: rows.length }));

    const res = await POST(postRequest([validTask(), validTask({ topic: "Жузы" })]), params);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ inserted: 0, skippedDuplicates: 2, rejected: 0, errors: [] });
  });
});
