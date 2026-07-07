import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(),
}));

import { supabaseServer } from "@/lib/supabase/server";
import { POST } from "./route";

const mockedSupabaseServer = vi.mocked(supabaseServer);

// Валидный по RFC 9562 uuid — паттерн src/app/api/tests/route.test.ts.
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const HQ_ID = "hq-1";

type QueryResult = { data: unknown; error: unknown };

// --- fake Supabase query-builder ------------------------------------------
// study_hqs получает по одной результату из очереди на каждый .from(table)
// вызов (find-existing, затем update ИЛИ insert) — простого статического
// результата на таблицу (как в tests/route.test.ts) не хватает: этот роут
// обращается к study_hqs дважды за один запрос с разными намерениями.

function chainable(
  result: QueryResult,
  onUpdate?: (payload: unknown) => void,
  onInsert?: (payload: unknown) => void,
) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "limit", "order"]) {
    builder[method] = () => builder;
  }
  builder.update = (payload: unknown) => {
    onUpdate?.(payload);
    return builder;
  };
  builder.insert = (payload: unknown) => {
    onInsert?.(payload);
    return builder;
  };
  builder.maybeSingle = () => Promise.resolve(result);
  builder.single = () => Promise.resolve(result);
  builder.then = (
    onFulfilled: (value: QueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(onFulfilled, onRejected);
  return builder;
}

function fakeSupabase(opts: {
  user: { id: string } | null;
  examProfile?: QueryResult;
  studyHqQueue?: QueryResult[];
  captured?: { updates: unknown[]; inserts: unknown[] };
}) {
  const studyHqQueue = [...(opts.studyHqQueue ?? [])];
  const captured = opts.captured ?? { updates: [], inserts: [] };

  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }) },
    from: vi.fn((table: string) => {
      if (table === "exam_profiles") {
        return chainable(opts.examProfile ?? { data: null, error: null });
      }
      if (table === "study_hqs") {
        const result = studyHqQueue.shift() ?? { data: null, error: null };
        return chainable(
          result,
          (payload) => captured.updates.push(payload),
          (payload) => captured.inserts.push(payload),
        );
      }
      return chainable({ data: null, error: null });
    }),
  };
}

function stubSupabase(opts: {
  user: { id: string } | null;
  examProfile?: QueryResult;
  studyHqQueue?: QueryResult[];
  captured?: { updates: unknown[]; inserts: unknown[] };
}) {
  mockedSupabaseServer.mockResolvedValue(fakeSupabase(opts) as never);
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/study-hqs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function variantProfileSpec() {
  return {
    examName: "Вариантный экзамен",
    language: "kk",
    description: "d",
    sections: [
      { name: "Математика", taskTypes: [], topics: [] },
      { name: "Физика", taskTypes: [], topics: [] },
    ],
    variants: [{ key: "phys", label: "Физика", sectionNames: ["Математика", "Физика"] }],
    selectionGroups: [],
    scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/study-hqs", () => {
  it("401s when there is no authenticated user", async () => {
    stubSupabase({ user: null });

    const res = await POST(postRequest({ examProfileId: PROFILE_ID }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("400s on a malformed body (missing/invalid examProfileId)", async () => {
    stubSupabase({ user: { id: "user-1" } });

    const res = await POST(postRequest({ examProfileId: "not-a-uuid" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("400s when config is an array (Array.isArray guard)", async () => {
    stubSupabase({ user: { id: "user-1" } });

    const res = await POST(postRequest({ examProfileId: PROFILE_ID, config: [] }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("400s when config fails hqConfigSchema.safeParse", async () => {
    stubSupabase({ user: { id: "user-1" } });

    const res = await POST(
      postRequest({ examProfileId: PROFILE_ID, config: { selectedSectionNames: "not-an-array" } }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("422s with invalid_config when config fails validateHqConfig against the profile spec", async () => {
    stubSupabase({
      user: { id: "user-1" },
      examProfile: { data: { spec: variantProfileSpec() }, error: null },
      studyHqQueue: [],
    });

    const res = await POST(
      postRequest({ examProfileId: PROFILE_ID, config: { selectedSectionNames: [] } }), // variantKey missing
    );

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid_config" });
  });

  it("old body {examProfileId} is valid: existing hq -> {id, existed:true}, no update call", async () => {
    const captured = { updates: [] as unknown[], inserts: [] as unknown[] };
    stubSupabase({
      user: { id: "user-1" },
      studyHqQueue: [{ data: { id: HQ_ID }, error: null }],
      captured,
    });

    const res = await POST(postRequest({ examProfileId: PROFILE_ID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: HQ_ID, existed: true });
    expect(captured.updates).toHaveLength(0);
  });

  it("old body {examProfileId} is valid: no existing hq -> insert with minimal payload, existed:false", async () => {
    const captured = { updates: [] as unknown[], inserts: [] as unknown[] };
    stubSupabase({
      user: { id: "user-1" },
      studyHqQueue: [
        { data: null, error: null }, // find-existing: none
        { data: { id: "new-hq" }, error: null }, // insert result
      ],
      captured,
    });

    const res = await POST(postRequest({ examProfileId: PROFILE_ID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "new-hq", existed: false });
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0]).toEqual({ user_id: "user-1", exam_profile_id: PROFILE_ID });
  });

  it("existing hq + config only (examDate absent) -> update payload has config but no exam_date key", async () => {
    const captured = { updates: [] as unknown[], inserts: [] as unknown[] };
    stubSupabase({
      user: { id: "user-1" },
      examProfile: { data: { spec: variantProfileSpec() }, error: null },
      studyHqQueue: [
        { data: { id: HQ_ID }, error: null }, // find-existing
        { data: null, error: null }, // update
      ],
      captured,
    });

    const res = await POST(
      postRequest({
        examProfileId: PROFILE_ID,
        config: { variantKey: "phys", selectedSectionNames: [] },
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: HQ_ID, existed: true });
    expect(captured.updates).toHaveLength(1);
    const payload = captured.updates[0] as Record<string, unknown>;
    expect(payload).toHaveProperty("config");
    expect(payload).not.toHaveProperty("exam_date");
  });

  it("existing hq + examDate: null present -> update payload writes exam_date: null", async () => {
    const captured = { updates: [] as unknown[], inserts: [] as unknown[] };
    stubSupabase({
      user: { id: "user-1" },
      studyHqQueue: [
        { data: { id: HQ_ID }, error: null },
        { data: null, error: null },
      ],
      captured,
    });

    const res = await POST(postRequest({ examProfileId: PROFILE_ID, examDate: null }));

    expect(res.status).toBe(200);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]).toEqual({ exam_date: null });
  });

  it("existing hq + examDate: 'YYYY-MM-DD' present -> update payload writes the date", async () => {
    const captured = { updates: [] as unknown[], inserts: [] as unknown[] };
    stubSupabase({
      user: { id: "user-1" },
      studyHqQueue: [
        { data: { id: HQ_ID }, error: null },
        { data: null, error: null },
      ],
      captured,
    });

    const res = await POST(postRequest({ examProfileId: PROFILE_ID, examDate: "2026-08-01" }));

    expect(res.status).toBe(200);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]).toEqual({ exam_date: "2026-08-01" });
  });

  it("no hq + config + examDate -> insert payload includes both", async () => {
    const captured = { updates: [] as unknown[], inserts: [] as unknown[] };
    stubSupabase({
      user: { id: "user-1" },
      examProfile: { data: { spec: variantProfileSpec() }, error: null },
      studyHqQueue: [
        { data: null, error: null }, // find-existing: none
        { data: { id: "new-hq" }, error: null }, // insert result
      ],
      captured,
    });

    const res = await POST(
      postRequest({
        examProfileId: PROFILE_ID,
        config: { variantKey: "phys", selectedSectionNames: [] },
        examDate: "2026-09-01",
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "new-hq", existed: false });
    expect(captured.inserts).toHaveLength(1);
    const payload = captured.inserts[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      user_id: "user-1",
      exam_profile_id: PROFILE_ID,
      exam_date: "2026-09-01",
    });
    expect(payload).toHaveProperty("config");
  });

  it("races a 23505 insert conflict to the winning row, still existed:true", async () => {
    const captured = { updates: [] as unknown[], inserts: [] as unknown[] };
    stubSupabase({
      user: { id: "user-1" },
      studyHqQueue: [
        { data: null, error: null }, // find-existing: none (raced)
        { data: null, error: { code: "23505" } }, // insert races and loses
        { data: { id: "raced-hq" }, error: null }, // re-select finds the winner
      ],
      captured,
    });

    const res = await POST(postRequest({ examProfileId: PROFILE_ID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "raced-hq", existed: true });
  });
});
