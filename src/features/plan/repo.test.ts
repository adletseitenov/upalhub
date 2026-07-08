import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { PlanWeek } from "./build";
import { supabasePlanRepo } from "./repo";

type QueryResult = { data: unknown; error: unknown };

// Тот же паттерн chainable-стаба, что и src/features/knowledge/repo.test.ts,
// с одним отличием: replaceFutureWeeks зовёт `.from("study_plan_weeks")`
// ДВАЖДЫ за один вызов (отдельно для delete-цепочки и для insert) — поэтому
// `calls` — общий массив на ТАБЛИЦУ (не на builder-инстанс), иначе второй
// .from() перезаписывал бы лог вызовов первого. `result` резолвит
// delete/select thenable-цепочки; `insertResult` (по умолчанию = result)
// резолвит именно .insert() отдельно — нужно, чтобы независимо
// смоделировать "delete ok, insert fails".
function makeBuilder(
  calls: { method: string; args: unknown[] }[],
  result: QueryResult,
  insertResult: QueryResult = result,
) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "gte", "order"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.delete = (...args: unknown[]) => {
    calls.push({ method: "delete", args });
    return builder;
  };
  builder.insert = (...args: unknown[]) => {
    calls.push({ method: "insert", args });
    return Promise.resolve(insertResult);
  };
  // delete()/select() chains are thenable — code under test awaits the
  // chain directly (mirrors knowledge/repo.test.ts convention).
  builder.then = (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder as Record<string, unknown>;
}

function fakeSupabase(
  tableResults: Record<string, QueryResult>,
  tableInsertResults: Record<string, QueryResult> = {},
) {
  const callsByTable: Record<string, { method: string; args: unknown[] }[]> = {};
  const from = vi.fn((table: string) => {
    const result = tableResults[table] ?? { data: null, error: null };
    const insertResult = tableInsertResults[table] ?? result;
    const calls = (callsByTable[table] ??= []);
    return makeBuilder(calls, result, insertResult);
  });
  const builders = new Proxy(
    {},
    { get: (_target, table: string) => ({ calls: callsByTable[table] ?? [] }) },
  ) as Record<string, { calls: { method: string; args: unknown[] }[] }>;
  return { client: { from } as unknown as SupabaseClient<Database>, builders, from };
}

function focusWeek(weekStart: string): PlanWeek {
  return {
    weekStart,
    topics: {
      focus: [{ topic: "algebra", section: "Математика", band: "weak", reason: "weak" }],
      suggestedTest: { kind: "practice" },
    },
  };
}

describe("supabasePlanRepo.replaceFutureWeeks", () => {
  it("is a no-op (no network call) when weeks is empty", async () => {
    const { client, from } = fakeSupabase({});

    await supabasePlanRepo(client).replaceFutureWeeks("hq-1", []);

    expect(from).not.toHaveBeenCalled();
  });

  it("deletes existing rows with week_start >= the earliest incoming weekStart, then inserts the fresh set", async () => {
    const { client, builders } = fakeSupabase({
      study_plan_weeks: { data: null, error: null },
    });
    const weeks = [focusWeek("2026-07-06"), focusWeek("2026-07-13"), focusWeek("2026-07-20")];

    await supabasePlanRepo(client).replaceFutureWeeks("hq-1", weeks);

    const calls = builders.study_plan_weeks.calls;
    const deleteCall = calls.find((c) => c.method === "delete");
    const eqCall = calls.find((c) => c.method === "eq");
    const gteCall = calls.find((c) => c.method === "gte");
    const insertCall = calls.find((c) => c.method === "insert");

    expect(deleteCall).toBeDefined();
    expect(eqCall?.args).toEqual(["hq_id", "hq-1"]);
    expect(gteCall?.args).toEqual(["week_start", "2026-07-06"]);
    expect(insertCall).toBeDefined();

    const rows = insertCall!.args[0] as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      hq_id: "hq-1",
      week_start: "2026-07-06",
      topics: weeks[0].topics,
      status: "planned",
    });
    expect(rows.every((r) => r.status === "planned")).toBe(true);
  });

  it("delete happens before insert (order matters: avoid unique-conflict with the row about to be replaced)", async () => {
    const { client, builders } = fakeSupabase({
      study_plan_weeks: { data: null, error: null },
    });

    await supabasePlanRepo(client).replaceFutureWeeks("hq-1", [focusWeek("2026-07-06")]);

    const methods = builders.study_plan_weeks.calls.map((c) => c.method);
    expect(methods.indexOf("delete")).toBeLessThan(methods.indexOf("insert"));
  });

  it("derives the delete threshold as the MINIMUM incoming weekStart (not insertion order)", async () => {
    const { client, builders } = fakeSupabase({
      study_plan_weeks: { data: null, error: null },
    });
    // Deliberately out of chronological order.
    const weeks = [focusWeek("2026-08-03"), focusWeek("2026-07-06"), focusWeek("2026-07-20")];

    await supabasePlanRepo(client).replaceFutureWeeks("hq-1", weeks);

    const gteCall = builders.study_plan_weeks.calls.find((c) => c.method === "gte");
    expect(gteCall?.args).toEqual(["week_start", "2026-07-06"]);
  });

  it("throws when the delete fails (and does not attempt the insert)", async () => {
    const { client, builders } = fakeSupabase({
      study_plan_weeks: { data: null, error: { message: "delete failed" } },
    });

    await expect(
      supabasePlanRepo(client).replaceFutureWeeks("hq-1", [focusWeek("2026-07-06")]),
    ).rejects.toEqual({ message: "delete failed" });
    expect(builders.study_plan_weeks.calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("throws when the insert fails (delete having already succeeded)", async () => {
    const { client, builders } = fakeSupabase(
      { study_plan_weeks: { data: null, error: null } },
      { study_plan_weeks: { data: null, error: { message: "insert failed" } } },
    );

    await expect(
      supabasePlanRepo(client).replaceFutureWeeks("hq-1", [focusWeek("2026-07-06")]),
    ).rejects.toEqual({ message: "insert failed" });
    expect(builders.study_plan_weeks.calls.some((c) => c.method === "delete")).toBe(true);
  });

  // Backlog wave fix6: concurrent recompute of the same hq (submit-hook vs.
  // POST recompute racing) can DELETE-then-INSERT twice; the loser of the
  // race hits a unique(hq_id, week_start) violation (23505) on INSERT. Since
  // buildStudyPlan is deterministic, the winner already wrote identical
  // rows — this must resolve quietly instead of surfacing as a 500.
  it("does not throw when the insert fails with a 23505 unique violation (concurrent replaceFutureWeeks)", async () => {
    const { client } = fakeSupabase(
      { study_plan_weeks: { data: null, error: null } },
      { study_plan_weeks: { data: null, error: { code: "23505", message: "duplicate key" } } },
    );

    await expect(
      supabasePlanRepo(client).replaceFutureWeeks("hq-1", [focusWeek("2026-07-06")]),
    ).resolves.toBeUndefined();
  });
});

describe("supabasePlanRepo.loadWeeks", () => {
  it("returns weeks ordered by week_start ascending, with topics safeParsed", async () => {
    const week = focusWeek("2026-07-06");
    const { client, builders } = fakeSupabase({
      study_plan_weeks: {
        data: [{ week_start: "2026-07-06", topics: week.topics, status: "planned" }],
        error: null,
      },
    });

    const result = await supabasePlanRepo(client).loadWeeks("hq-1");

    expect(result).toEqual([{ weekStart: "2026-07-06", topics: week.topics, status: "planned" }]);
    const orderCall = builders.study_plan_weeks.calls.find((c) => c.method === "order");
    expect(orderCall?.args).toEqual(["week_start", { ascending: true }]);
  });

  it("skips a row whose topics fail planWeekTopicsSchema.safeParse without throwing", async () => {
    const goodWeek = focusWeek("2026-07-13");
    const { client } = fakeSupabase({
      study_plan_weeks: {
        data: [
          { week_start: "2026-07-06", topics: { garbage: true }, status: "planned" },
          { week_start: "2026-07-13", topics: goodWeek.topics, status: "planned" },
        ],
        error: null,
      },
    });

    const result = await supabasePlanRepo(client).loadWeeks("hq-1");

    expect(result).toEqual([{ weekStart: "2026-07-13", topics: goodWeek.topics, status: "planned" }]);
  });

  it("returns an empty array when there are no rows", async () => {
    const { client } = fakeSupabase({ study_plan_weeks: { data: [], error: null } });

    const result = await supabasePlanRepo(client).loadWeeks("hq-1");

    expect(result).toEqual([]);
  });

  it("throws when the select fails", async () => {
    const { client } = fakeSupabase({
      study_plan_weeks: { data: null, error: { message: "db down" } },
    });

    await expect(supabasePlanRepo(client).loadWeeks("hq-1")).rejects.toEqual({ message: "db down" });
  });
});
