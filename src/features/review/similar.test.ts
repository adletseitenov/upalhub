import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { TaskBody } from "@/features/tasks/schema";
import { loadSimilarTasks, pickSimilar } from "./similar";
import type { SimilarTaskRow } from "./similar";

function body(prompt: string): TaskBody {
  return {
    format: "single_choice",
    prompt,
    passage: null,
    options: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
    ],
  };
}

function row(id: string, type: string, topic: string, prompt = id): SimilarTaskRow {
  return { id, type, topic, body: body(prompt) };
}

describe("pickSimilar", () => {
  it("returns [] when buckets is empty (no query worth making)", () => {
    const rows = [row("t1", "grammar", "verbs")];
    expect(pickSimilar(rows, [], new Set(), { capPerBucket: 2, capTotal: 10 })).toEqual([]);
  });

  it("returns [] when no rows match any bucket", () => {
    const rows = [row("t1", "grammar", "verbs")];
    const result = pickSimilar(rows, [{ type: "reading", topic: "main-idea" }], new Set(), {
      capPerBucket: 2,
      capTotal: 10,
    });
    expect(result).toEqual([]);
  });

  it("matches rows to their (type, topic) bucket", () => {
    const rows = [row("t1", "grammar", "verbs"), row("t2", "reading", "main-idea")];
    const result = pickSimilar(rows, [{ type: "grammar", topic: "verbs" }], new Set(), {
      capPerBucket: 2,
      capTotal: 10,
    });
    expect(result.map((r) => r.id)).toEqual(["t1"]);
  });

  it("caps picks per bucket at capPerBucket", () => {
    const rows = [
      row("t1", "grammar", "verbs"),
      row("t2", "grammar", "verbs"),
      row("t3", "grammar", "verbs"),
    ];
    const result = pickSimilar(rows, [{ type: "grammar", topic: "verbs" }], new Set(), {
      capPerBucket: 2,
      capTotal: 10,
    });
    expect(result.map((r) => r.id)).toEqual(["t1", "t2"]);
  });

  it("caps total picks across all buckets at capTotal", () => {
    const rows = [
      row("t1", "grammar", "verbs"),
      row("t2", "grammar", "verbs"),
      row("t3", "reading", "main-idea"),
      row("t4", "reading", "main-idea"),
    ];
    const result = pickSimilar(
      rows,
      [
        { type: "grammar", topic: "verbs" },
        { type: "reading", topic: "main-idea" },
      ],
      new Set(),
      { capPerBucket: 2, capTotal: 3 },
    );
    expect(result.map((r) => r.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("excludes ids in excludeIds", () => {
    const rows = [row("t1", "grammar", "verbs"), row("t2", "grammar", "verbs")];
    const result = pickSimilar(rows, [{ type: "grammar", topic: "verbs" }], new Set(["t1"]), {
      capPerBucket: 2,
      capTotal: 10,
    });
    expect(result.map((r) => r.id)).toEqual(["t2"]);
  });

  it("gives each bucket occurrence its own budget (two errors on the same topic each get up to capPerBucket)", () => {
    // buckets holds one entry per erroneous item (D5: "cap 2/ошибку") — two
    // errors on the same (type, topic) each earn their own capPerBucket
    // slots, as long as there are enough distinct candidates to fill them.
    const rows = [row("t1", "grammar", "verbs"), row("t2", "grammar", "verbs")];
    const buckets = [
      { type: "grammar", topic: "verbs" },
      { type: "grammar", topic: "verbs" },
    ];
    const result = pickSimilar(rows, buckets, new Set(), { capPerBucket: 1, capTotal: 10 });
    expect(result.map((r) => r.id)).toEqual(["t1", "t2"]);
  });

  it("dedupes a candidate that would otherwise be picked twice across overlapping bucket occurrences", () => {
    // Only ONE candidate exists for a topic that appears twice in buckets —
    // the second occurrence must NOT re-pick the same task id.
    const rows = [row("t1", "grammar", "verbs")];
    const buckets = [
      { type: "grammar", topic: "verbs" },
      { type: "grammar", topic: "verbs" },
    ];
    const result = pickSimilar(rows, buckets, new Set(), { capPerBucket: 1, capTotal: 10 });
    expect(result.map((r) => r.id)).toEqual(["t1"]);
  });

  it("default caps are capPerBucket=2, capTotal=10 when omitted", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`t${i}`, "grammar", "verbs"));
    const result = pickSimilar(rows, [{ type: "grammar", topic: "verbs" }], new Set());
    expect(result).toHaveLength(2);
  });
});

type QueryResult = { data: unknown; error: unknown };

function makeBuilder(result: QueryResult) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = { calls };
  for (const method of ["select", "eq", "in"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder as Record<string, unknown> & { calls: { method: string; args: unknown[] }[] };
}

function fakeSupabase(tableResults: Record<string, QueryResult>) {
  const builders: Record<string, ReturnType<typeof makeBuilder>> = {};
  const from = vi.fn((table: string) => {
    const builder = makeBuilder(tableResults[table] ?? { data: null, error: null });
    builders[table] = builder;
    return builder;
  });
  return { client: { from } as unknown as SupabaseClient<Database>, builders, from };
}

describe("loadSimilarTasks", () => {
  it("returns [] and makes no query when buckets is empty", async () => {
    const { client, from } = fakeSupabase({});

    const result = await loadSimilarTasks(client, {
      profileId: "profile-1",
      buckets: [],
      excludeIds: new Set(),
    });

    expect(result).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("makes exactly ONE batch query against tasks, scoped to profileId + distinct type/topic", async () => {
    const { client, builders, from } = fakeSupabase({
      tasks: {
        data: [
          { id: "t1", type: "grammar", topic: "verbs", body: body("t1") },
          { id: "t2", type: "grammar", topic: "verbs", body: body("t2") },
        ],
        error: null,
      },
    });

    const result = await loadSimilarTasks(client, {
      profileId: "profile-1",
      buckets: [{ type: "grammar", topic: "verbs" }],
      excludeIds: new Set(),
    });

    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("tasks");
    const selectCall = builders.tasks.calls.find((c) => c.method === "select");
    expect(selectCall?.args).toEqual(["id, type, topic, body"]);
    const eqCall = builders.tasks.calls.find((c) => c.method === "eq");
    expect(eqCall?.args).toEqual(["exam_profile_id", "profile-1"]);
    expect(result.map((r) => r.id)).toEqual(["t1", "t2"]);
  });

  it("never selects answer/explanation columns", async () => {
    const { client, builders } = fakeSupabase({ tasks: { data: [], error: null } });

    await loadSimilarTasks(client, {
      profileId: "profile-1",
      buckets: [{ type: "grammar", topic: "verbs" }],
      excludeIds: new Set(),
    });

    const selectCall = builders.tasks.calls.find((c) => c.method === "select");
    const projection = String(selectCall?.args[0] ?? "");
    expect(projection).not.toMatch(/answer|explanation/);
  });

  it("skips a malformed body row without throwing", async () => {
    const { client } = fakeSupabase({
      tasks: {
        data: [
          { id: "t-bad", type: "grammar", topic: "verbs", body: { garbage: true } },
          { id: "t-good", type: "grammar", topic: "verbs", body: body("t-good") },
        ],
        error: null,
      },
    });

    const result = await loadSimilarTasks(client, {
      profileId: "profile-1",
      buckets: [{ type: "grammar", topic: "verbs" }],
      excludeIds: new Set(),
    });

    expect(result.map((r) => r.id)).toEqual(["t-good"]);
  });

  it("applies excludeIds/caps via pickSimilar (respects capTotal default of 10)", async () => {
    const data = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      type: "grammar",
      topic: "verbs",
      body: body(`t${i}`),
    }));
    const { client } = fakeSupabase({ tasks: { data, error: null } });

    const result = await loadSimilarTasks(client, {
      profileId: "profile-1",
      buckets: [{ type: "grammar", topic: "verbs" }],
      excludeIds: new Set(),
      capPerBucket: 20,
    });

    expect(result).toHaveLength(10);
  });

  it("throws (does not swallow) a genuine query error", async () => {
    const { client } = fakeSupabase({ tasks: { data: null, error: { message: "boom" } } });

    await expect(
      loadSimilarTasks(client, {
        profileId: "profile-1",
        buckets: [{ type: "grammar", topic: "verbs" }],
        excludeIds: new Set(),
      }),
    ).rejects.toEqual({ message: "boom" });
  });

  it("similar rows never carry an 'answer' or 'explanation' key (structural safety net)", async () => {
    const { client } = fakeSupabase({
      tasks: {
        data: [{ id: "t1", type: "grammar", topic: "verbs", body: body("t1") }],
        error: null,
      },
    });

    const result = await loadSimilarTasks(client, {
      profileId: "profile-1",
      buckets: [{ type: "grammar", topic: "verbs" }],
      excludeIds: new Set(),
    });

    expect(JSON.stringify(result)).not.toContain("answer");
    expect(JSON.stringify(result)).not.toContain("explanation");
  });
});
