import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { Forecast } from "./compute";
import { supabaseForecastRepo } from "./repo";

type QueryResult = { data: unknown; error: unknown };

// Тот же паттерн chainable-стаба, что и src/features/knowledge/repo.test.ts /
// src/features/plan/repo.test.ts: одна таблица держит свой стаб через
// from(table); latest() зовёт select/eq/order/limit/maybeSingle, append()
// зовёт latest() (тот же стаб под select-цепочку) + отдельно insert().
function makeBuilder(calls: { method: string; args: unknown[] }[], selectResult: QueryResult, insertResult: QueryResult) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.maybeSingle = () => {
    calls.push({ method: "maybeSingle", args: [] });
    return Promise.resolve(selectResult);
  };
  builder.insert = (...args: unknown[]) => {
    calls.push({ method: "insert", args });
    return Promise.resolve(insertResult);
  };
  return builder as Record<string, unknown>;
}

function fakeSupabase(selectResult: QueryResult, insertResult: QueryResult = { data: null, error: null }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const from = vi.fn(() => makeBuilder(calls, selectResult, insertResult));
  return { client: { from } as unknown as SupabaseClient<Database>, calls, from };
}

function forecast(overrides: Partial<Forecast> = {}): Forecast {
  return { point: 65, low: 55, high: 75, confidence: "medium", coverage: 0.5, ...overrides };
}

describe("supabaseForecastRepo.latest", () => {
  it("returns null when there are no rows", async () => {
    const { client } = fakeSupabase({ data: null, error: null });

    const result = await supabaseForecastRepo(client).latest("hq-1");

    expect(result).toBeNull();
  });

  it("returns null when the latest row is legacy (point === null, pre-migration row)", async () => {
    const { client } = fakeSupabase({ data: { point: null, low: 50, high: 70 }, error: null });

    const result = await supabaseForecastRepo(client).latest("hq-1");

    expect(result).toBeNull();
  });

  it("returns {point, low, high} of the most recent row, ordered by created_at desc, limit 1", async () => {
    const { client, calls } = fakeSupabase({ data: { point: 65, low: 55, high: 75 }, error: null });

    const result = await supabaseForecastRepo(client).latest("hq-1");

    expect(result).toEqual({ point: 65, low: 55, high: 75 });
    const orderCall = calls.find((c) => c.method === "order");
    expect(orderCall?.args).toEqual(["created_at", { ascending: false }]);
    const limitCall = calls.find((c) => c.method === "limit");
    expect(limitCall?.args).toEqual([1]);
    const eqCall = calls.find((c) => c.method === "eq");
    expect(eqCall?.args).toEqual(["hq_id", "hq-1"]);
  });

  it("throws when the select fails", async () => {
    const { client } = fakeSupabase({ data: null, error: { message: "db down" } });

    await expect(supabaseForecastRepo(client).latest("hq-1")).rejects.toEqual({ message: "db down" });
  });
});

describe("supabaseForecastRepo.append", () => {
  it("inserts when there is no prior forecast", async () => {
    const { client, calls } = fakeSupabase({ data: null, error: null });

    await supabaseForecastRepo(client).append("hq-1", forecast());

    const insertCall = calls.find((c) => c.method === "insert");
    expect(insertCall).toBeDefined();
    expect(insertCall!.args[0]).toEqual({
      hq_id: "hq-1",
      point: 65,
      low: 55,
      high: 75,
      confidence: "medium",
      coverage: 0.5,
    });
  });

  it("🔴 dedup: skips the insert when the latest forecast matches on (point, low, high)", async () => {
    const { client, calls } = fakeSupabase({ data: { point: 65, low: 55, high: 75 }, error: null });

    await supabaseForecastRepo(client).append("hq-1", forecast({ point: 65, low: 55, high: 75, confidence: "high", coverage: 0.9 }));

    expect(calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("inserts when point differs from the latest (even if low/high match)", async () => {
    const { client, calls } = fakeSupabase({ data: { point: 60, low: 55, high: 75 }, error: null });

    await supabaseForecastRepo(client).append("hq-1", forecast({ point: 65, low: 55, high: 75 }));

    expect(calls.some((c) => c.method === "insert")).toBe(true);
  });

  it("inserts when low differs from the latest", async () => {
    const { client, calls } = fakeSupabase({ data: { point: 65, low: 50, high: 75 }, error: null });

    await supabaseForecastRepo(client).append("hq-1", forecast({ point: 65, low: 55, high: 75 }));

    expect(calls.some((c) => c.method === "insert")).toBe(true);
  });

  it("inserts when high differs from the latest", async () => {
    const { client, calls } = fakeSupabase({ data: { point: 65, low: 55, high: 70 }, error: null });

    await supabaseForecastRepo(client).append("hq-1", forecast({ point: 65, low: 55, high: 75 }));

    expect(calls.some((c) => c.method === "insert")).toBe(true);
  });

  it("inserts (does not dedup) when the latest row is legacy (point === null)", async () => {
    const { client, calls } = fakeSupabase({ data: { point: null, low: 55, high: 75 }, error: null });

    await supabaseForecastRepo(client).append("hq-1", forecast({ point: 65, low: 55, high: 75 }));

    expect(calls.some((c) => c.method === "insert")).toBe(true);
  });

  it("throws when the insert fails", async () => {
    const { client } = fakeSupabase({ data: null, error: null }, { data: null, error: { message: "insert failed" } });

    await expect(supabaseForecastRepo(client).append("hq-1", forecast())).rejects.toEqual({
      message: "insert failed",
    });
  });

  it("throws (propagates) when the latest() lookup inside append fails", async () => {
    const { client } = fakeSupabase({ data: null, error: { message: "db down" } });

    await expect(supabaseForecastRepo(client).append("hq-1", forecast())).rejects.toEqual({
      message: "db down",
    });
  });
});
