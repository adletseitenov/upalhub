import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { TopicState } from "./compute";
import { supabaseKnowledgeRepo } from "./repo";

type QueryResult = { data: unknown; error: unknown };

// Тот же паттерн chainable-стаба, что и в других repo.test.ts /
// route.test.ts этого репо, но с записью аргументов вызовов (нужно
// проверить onConflict/updated_at payload и что "in"-фильтры получают
// правильные id). Каждая таблица держит свой стаб через from(table).
function makeBuilder(result: QueryResult) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = { calls };
  for (const method of ["select", "eq", "in", "not", "limit"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.update = (...args: unknown[]) => {
    calls.push({ method: "update", args });
    return builder;
  };
  builder.upsert = (...args: unknown[]) => {
    calls.push({ method: "upsert", args });
    return Promise.resolve(result);
  };
  builder.maybeSingle = () => Promise.resolve(result);
  builder.single = () => Promise.resolve(result);
  // supabase-js query builders are thenable — code under test awaits the
  // chain directly (no .maybeSingle()) for list queries.
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

describe("supabaseKnowledgeRepo.loadKnowledgeInputs", () => {
  it("returns empty inputs (no queries past tests) when the hq has no tests", async () => {
    const { client, from } = fakeSupabase({ tests: { data: [], error: null } });

    const result = await supabaseKnowledgeRepo(client).loadKnowledgeInputs("hq-1");

    expect(result).toEqual({ items: [], nFinished: 0, maxFinishedAt: null });
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("tests");
  });

  it("returns empty inputs when the hq has tests but no finished attempts", async () => {
    const { client, from } = fakeSupabase({
      tests: { data: [{ id: "test-1" }], error: null },
      attempts: { data: [], error: null },
    });

    const result = await supabaseKnowledgeRepo(client).loadKnowledgeInputs("hq-1");

    expect(result).toEqual({ items: [], nFinished: 0, maxFinishedAt: null });
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("joins attempts + tasks into KnowledgeItem[], computes nFinished/maxFinishedAt, and skips a broken row (task missing from the batch)", async () => {
    const { client } = fakeSupabase({
      tests: { data: [{ id: "test-1" }], error: null },
      attempts: {
        data: [
          { id: "attempt-1", finished_at: "2026-07-01T00:00:00.000Z" },
          { id: "attempt-2", finished_at: "2026-07-05T00:00:00.000Z" },
        ],
        error: null,
      },
      attempt_items: {
        data: [
          { attempt_id: "attempt-1", task_id: "task-good", answer: { optionId: "a" }, is_correct: true },
          // response=null -> answered=false, but still a valid row (not skipped).
          { attempt_id: "attempt-2", task_id: "task-good", answer: null, is_correct: false },
          // task-missing is absent from the tasks batch below -> skipped (broken row).
          { attempt_id: "attempt-2", task_id: "task-missing", answer: { optionId: "b" }, is_correct: false },
        ],
        error: null,
      },
      tasks: {
        data: [{ id: "task-good", topic: "algebra", difficulty: 3 }],
        error: null,
      },
    });

    const result = await supabaseKnowledgeRepo(client).loadKnowledgeInputs("hq-1");

    expect(result.nFinished).toBe(2);
    expect(result.maxFinishedAt).toEqual(new Date("2026-07-05T00:00:00.000Z"));
    expect(result.items).toHaveLength(2);
    expect(result.items).toEqual([
      {
        topic: "algebra",
        difficulty: 3,
        isCorrect: true,
        answered: true,
        finishedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      {
        topic: "algebra",
        difficulty: 3,
        isCorrect: false,
        answered: false,
        finishedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
    ]);
  });

  it("throws (does not swallow) a genuine query error at any step", async () => {
    const { client } = fakeSupabase({
      tests: { data: null, error: { message: "boom" } },
    });

    await expect(supabaseKnowledgeRepo(client).loadKnowledgeInputs("hq-1")).rejects.toEqual({
      message: "boom",
    });
  });
});

describe("supabaseKnowledgeRepo.upsertStates", () => {
  it("is a no-op (no network call) when the states map is empty", async () => {
    const { client, from } = fakeSupabase({});

    await supabaseKnowledgeRepo(client).upsertStates("hq-1", new Map());

    expect(from).not.toHaveBeenCalled();
  });

  it("upserts rows with an explicit updated_at and onConflict hq_id,topic", async () => {
    const { client, builders } = fakeSupabase({ knowledge_states: { data: null, error: null } });
    const states = new Map<string, TopicState>([
      ["algebra", { level: 0.62, answeredCount: 5, lastSeenAt: new Date("2026-07-01T00:00:00.000Z") }],
    ]);

    const before = Date.now();
    await supabaseKnowledgeRepo(client).upsertStates("hq-1", states);
    const after = Date.now();

    const upsertCall = builders.knowledge_states.calls.find((c) => c.method === "upsert");
    expect(upsertCall).toBeDefined();
    const [rows, opts] = upsertCall!.args as [Record<string, unknown>[], { onConflict: string }];
    expect(opts).toEqual({ onConflict: "hq_id,topic" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hq_id: "hq-1",
      topic: "algebra",
      level: 0.62,
      answered_count: 5,
      last_seen_at: "2026-07-01T00:00:00.000Z",
    });
    // явный updated_at — не полагаемся на column default (не срабатывает при conflict-update).
    expect(typeof rows[0].updated_at).toBe("string");
    const updatedAtMs = new Date(rows[0].updated_at as string).getTime();
    expect(updatedAtMs).toBeGreaterThanOrEqual(before);
    expect(updatedAtMs).toBeLessThanOrEqual(after);
  });

  it("throws when the upsert fails", async () => {
    const { client } = fakeSupabase({ knowledge_states: { data: null, error: { message: "conflict" } } });
    const states = new Map<string, TopicState>([
      ["algebra", { level: 0.5, answeredCount: 3, lastSeenAt: new Date() }],
    ]);

    await expect(supabaseKnowledgeRepo(client).upsertStates("hq-1", states)).rejects.toEqual({
      message: "conflict",
    });
  });
});

describe("supabaseKnowledgeRepo.touchWatermark", () => {
  it("updates study_hqs.last_recomputed_at to now.toISOString() for the given hqId", async () => {
    const { client, builders } = fakeSupabase({ study_hqs: { data: null, error: null } });
    const now = new Date("2026-07-08T12:00:00.000Z");

    await supabaseKnowledgeRepo(client).touchWatermark("hq-1", now);

    const updateCall = builders.study_hqs.calls.find((c) => c.method === "update");
    expect(updateCall?.args).toEqual([{ last_recomputed_at: "2026-07-08T12:00:00.000Z" }]);
    const eqCall = builders.study_hqs.calls.find((c) => c.method === "eq");
    expect(eqCall?.args).toEqual(["id", "hq-1"]);
  });

  it("throws when the update fails", async () => {
    const { client } = fakeSupabase({ study_hqs: { data: null, error: { message: "db down" } } });

    await expect(supabaseKnowledgeRepo(client).touchWatermark("hq-1", new Date())).rejects.toEqual({
      message: "db down",
    });
  });
});

describe("supabaseKnowledgeRepo.loadMockResults", () => {
  function mockTestSpec(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      kind: "mock",
      language: "kk",
      sections: [],
      taskIds: [],
      scoringSnapshot: { scaleMin: 0, scaleMax: 9, unit: "band" },
      ...overrides,
    };
  }

  it("returns [] (no queries past tests) when the hq has no mock tests", async () => {
    const { client, from } = fakeSupabase({ tests: { data: [], error: null } });

    const result = await supabaseKnowledgeRepo(client).loadMockResults("hq-1");

    expect(result).toEqual([]);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("tests");
  });

  it("filters tests by kind='mock' and hq_id", async () => {
    const { client, builders } = fakeSupabase({ tests: { data: [], error: null } });

    await supabaseKnowledgeRepo(client).loadMockResults("hq-1");

    const eqCalls = builders.tests.calls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["hq_id", "hq-1"] });
    expect(eqCalls).toContainEqual({ method: "eq", args: ["kind", "mock"] });
  });

  it("returns [] when mock tests exist but have no finished attempts with a scaled_score", async () => {
    const { client, from } = fakeSupabase({
      tests: { data: [{ id: "test-1", spec: mockTestSpec() }], error: null },
      attempts: { data: [], error: null },
    });

    const result = await supabaseKnowledgeRepo(client).loadMockResults("hq-1");

    expect(result).toEqual([]);
    expect(from).toHaveBeenCalledTimes(2);
  });

  it("joins attempts to mock tests, pairing scaled_score with that test's frozen scoringSnapshot", async () => {
    const snapshot1 = { scaleMin: 0, scaleMax: 9, unit: "band" };
    const snapshot2 = { scaleMin: 0, scaleMax: 140, unit: "баллов" };
    const { client } = fakeSupabase({
      tests: {
        data: [
          { id: "test-1", spec: mockTestSpec({ scoringSnapshot: snapshot1 }) },
          { id: "test-2", spec: mockTestSpec({ scoringSnapshot: snapshot2 }) },
        ],
        error: null,
      },
      attempts: {
        data: [
          { test_id: "test-1", scaled_score: 7 },
          { test_id: "test-2", scaled_score: 110 },
        ],
        error: null,
      },
    });

    const result = await supabaseKnowledgeRepo(client).loadMockResults("hq-1");

    expect(result).toEqual([
      { scaled: 7, snapshot: snapshot1 },
      { scaled: 110, snapshot: snapshot2 },
    ]);
  });

  it("skips a mock test row whose spec fails testSpecSchema (malformed/legacy) without throwing", async () => {
    const goodSnapshot = { scaleMin: 0, scaleMax: 9, unit: "band" };
    const { client } = fakeSupabase({
      tests: {
        data: [
          { id: "test-broken", spec: { garbage: true } },
          { id: "test-good", spec: mockTestSpec({ scoringSnapshot: goodSnapshot }) },
        ],
        error: null,
      },
      attempts: {
        data: [
          { test_id: "test-broken", scaled_score: 5 },
          { test_id: "test-good", scaled_score: 6.5 },
        ],
        error: null,
      },
    });

    const result = await supabaseKnowledgeRepo(client).loadMockResults("hq-1");

    expect(result).toEqual([{ scaled: 6.5, snapshot: goodSnapshot }]);
  });

  it("filters out unfinished/scoreless attempts at the query level (not.is.null on finished_at and scaled_score)", async () => {
    const { client, builders } = fakeSupabase({
      tests: { data: [{ id: "test-1", spec: mockTestSpec() }], error: null },
      attempts: { data: [], error: null },
    });

    await supabaseKnowledgeRepo(client).loadMockResults("hq-1");

    const notCalls = builders.attempts.calls.filter((c) => c.method === "not");
    expect(notCalls).toContainEqual({ method: "not", args: ["finished_at", "is", null] });
    expect(notCalls).toContainEqual({ method: "not", args: ["scaled_score", "is", null] });
  });

  it("throws (does not swallow) a genuine query error at any step", async () => {
    const { client } = fakeSupabase({ tests: { data: null, error: { message: "boom" } } });

    await expect(supabaseKnowledgeRepo(client).loadMockResults("hq-1")).rejects.toEqual({
      message: "boom",
    });
  });
});
