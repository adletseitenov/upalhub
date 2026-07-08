import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { ExamProfileSpec } from "@/features/exam-profile/spec";
import type { HqConfig } from "@/features/exam-profile/selection";
import type { KnowledgeItem } from "@/features/knowledge/compute";
import type { KnowledgeRepo } from "@/features/knowledge/repo";
import type { PlanRepo } from "@/features/plan/repo";
import type { ForecastRepo } from "@/features/forecast/repo";
import { recomputeHqInsights, supabaseHqReader } from "./recompute";
import type { HqContext, HqReader } from "./recompute";

const HQ_ID = "hq-1";
const NOW = new Date("2026-07-08T00:00:00Z");

function makeSpec(overrides: Partial<ExamProfileSpec> = {}): ExamProfileSpec {
  return {
    examName: "ЕНТ",
    language: "kk",
    description: "Единое национальное тестирование.",
    sections: [{ name: "Математика", taskTypes: [], topics: ["algebra"] }],
    variants: [],
    selectionGroups: [],
    scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
    ...overrides,
  } as ExamProfileSpec;
}

// examDate omitted from callers below defaults to null (most tests don't
// care about the plan's examDate branch specifically).
function fakeHqReader(context: Omit<HqContext, "examDate"> & { examDate?: Date | null }): HqReader {
  return {
    loadHqContext: vi.fn().mockResolvedValue({ examDate: null, ...context }),
  };
}

function fakeKnowledgeRepo(overrides: Partial<KnowledgeRepo> = {}): KnowledgeRepo {
  return {
    loadKnowledgeInputs: vi.fn().mockResolvedValue({ items: [], nFinished: 0, maxFinishedAt: null }),
    upsertStates: vi.fn().mockResolvedValue(undefined),
    touchWatermark: vi.fn().mockResolvedValue(undefined),
    loadMockResults: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function fakePlanRepo(overrides: Partial<PlanRepo> = {}): PlanRepo {
  return {
    replaceFutureWeeks: vi.fn().mockResolvedValue(undefined),
    loadWeeks: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function fakeForecastRepo(overrides: Partial<ForecastRepo> = {}): ForecastRepo {
  return {
    latest: vi.fn().mockResolvedValue(null),
    append: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function answeredItem(overrides: Partial<KnowledgeItem> & { topic: string }): KnowledgeItem {
  return { difficulty: 3, isCorrect: true, answered: true, finishedAt: NOW, ...overrides };
}

describe("recomputeHqInsights: happy path", () => {
  it("computes states from loaded inputs, upserts them, and touches the watermark", async () => {
    const items: KnowledgeItem[] = [
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
    ];
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(knowledgeRepo.upsertStates).toHaveBeenCalledTimes(1);
    const [hqId, states] = vi.mocked(knowledgeRepo.upsertStates).mock.calls[0];
    expect(hqId).toBe(HQ_ID);
    expect(states.has("algebra")).toBe(true);
    expect(states.get("algebra")?.answeredCount).toBe(3);
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledWith(HQ_ID, NOW);
    // Watermark происходит ПОСЛЕ upsert (порядок шагов D7).
    const upsertOrder = vi.mocked(knowledgeRepo.upsertStates).mock.invocationCallOrder[0];
    const touchOrder = vi.mocked(knowledgeRepo.touchWatermark).mock.invocationCallOrder[0];
    expect(upsertOrder).toBeLessThan(touchOrder);
  });

  it("uses the section name as the topic when a section has no explicit topics (mirrors assemble.ts buildPlan)", async () => {
    const spec = makeSpec({ sections: [{ name: "Общий раздел", taskTypes: [], topics: [] }] });
    const items: KnowledgeItem[] = [
      answeredItem({ topic: "Общий раздел" }),
      answeredItem({ topic: "Общий раздел" }),
      answeredItem({ topic: "Общий раздел" }),
    ];
    const hqReader = fakeHqReader({ spec, config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    const [, states] = vi.mocked(knowledgeRepo.upsertStates).mock.calls[0];
    expect(states.has("Общий раздел")).toBe(true);
  });

  it("filters out topics outside the resolved active sections (variant excludes a section)", async () => {
    const spec = makeSpec({
      sections: [
        { name: "A", taskTypes: [], topics: ["alpha"] },
        { name: "B", taskTypes: [], topics: ["beta"] },
      ],
      variants: [{ key: "v1", label: "V1", sectionNames: ["A"] }],
    });
    const config: HqConfig = { variantKey: "v1", selectedSectionNames: [] };
    const items: KnowledgeItem[] = [
      answeredItem({ topic: "alpha" }),
      answeredItem({ topic: "alpha" }),
      answeredItem({ topic: "alpha" }),
      answeredItem({ topic: "beta" }),
      answeredItem({ topic: "beta" }),
      answeredItem({ topic: "beta" }),
    ];
    const hqReader = fakeHqReader({ spec, config });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    const [, states] = vi.mocked(knowledgeRepo.upsertStates).mock.calls[0];
    expect(states.has("alpha")).toBe(true);
    expect(states.has("beta")).toBe(false);
  });
});

describe("recomputeHqInsights: 0 rows below NMIN", () => {
  it("upserts an empty map but still touches the watermark (watermark fires even with no map rows)", async () => {
    const items: KnowledgeItem[] = [answeredItem({ topic: "algebra" })]; // 1 < NMIN(3)
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    const [, states] = vi.mocked(knowledgeRepo.upsertStates).mock.calls[0];
    expect(states.size).toBe(0);
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledWith(HQ_ID, NOW);
  });

  it("upserts an empty map and touches the watermark when there are no finished attempts at all", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo();
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    const [, states] = vi.mocked(knowledgeRepo.upsertStates).mock.calls[0];
    expect(states.size).toBe(0);
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledWith(HQ_ID, NOW);
  });
});

describe("recomputeHqInsights: spec null", () => {
  it("only touches the watermark — no knowledge or plan read/write at all", async () => {
    const hqReader = fakeHqReader({ spec: null, config: null });
    const knowledgeRepo = fakeKnowledgeRepo();
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(knowledgeRepo.loadKnowledgeInputs).not.toHaveBeenCalled();
    expect(knowledgeRepo.upsertStates).not.toHaveBeenCalled();
    expect(planRepo.replaceFutureWeeks).not.toHaveBeenCalled();
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledTimes(1);
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledWith(HQ_ID, NOW);
  });
});

describe("recomputeHqInsights: failure semantics", () => {
  it("propagates an error thrown from upsertStates and does NOT touch the watermark", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      upsertStates: vi.fn().mockRejectedValue(new Error("db down")),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await expect(
      recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW }),
    ).rejects.toThrow("db down");
    expect(knowledgeRepo.touchWatermark).not.toHaveBeenCalled();
    expect(planRepo.replaceFutureWeeks).not.toHaveBeenCalled();
  });

  it("propagates an error thrown from loadKnowledgeInputs and does NOT touch the watermark", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await expect(
      recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW }),
    ).rejects.toThrow("network error");
    expect(knowledgeRepo.upsertStates).not.toHaveBeenCalled();
    expect(knowledgeRepo.touchWatermark).not.toHaveBeenCalled();
    expect(planRepo.replaceFutureWeeks).not.toHaveBeenCalled();
  });

  it("propagates an error thrown from loadHqContext and does NOT touch the watermark", async () => {
    const hqReader: HqReader = { loadHqContext: vi.fn().mockRejectedValue(new Error("hq lookup failed")) };
    const knowledgeRepo = fakeKnowledgeRepo();
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await expect(
      recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW }),
    ).rejects.toThrow("hq lookup failed");
    expect(knowledgeRepo.touchWatermark).not.toHaveBeenCalled();
  });

  it("propagates an error thrown from replaceFutureWeeks and does NOT touch the watermark", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo();
    const planRepo = fakePlanRepo({
      replaceFutureWeeks: vi.fn().mockRejectedValue(new Error("plan write failed")),
    });
    const forecastRepo = fakeForecastRepo();

    await expect(
      recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW }),
    ).rejects.toThrow("plan write failed");
    expect(knowledgeRepo.touchWatermark).not.toHaveBeenCalled();
  });
});

describe("recomputeHqInsights: idempotency", () => {
  it("calling twice with identical inputs writes the same states map contents both times", async () => {
    const items: KnowledgeItem[] = [
      answeredItem({ topic: "algebra", isCorrect: true }),
      answeredItem({ topic: "algebra", isCorrect: false }),
      answeredItem({ topic: "algebra", isCorrect: true }),
    ];
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });
    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    const calls = vi.mocked(knowledgeRepo.upsertStates).mock.calls;
    expect(calls).toHaveLength(2);
    expect(Array.from(calls[0][1].entries())).toEqual(Array.from(calls[1][1].entries()));
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledTimes(2);

    const planCalls = vi.mocked(planRepo.replaceFutureWeeks).mock.calls;
    expect(planCalls).toHaveLength(2);
    expect(planCalls[0][1]).toEqual(planCalls[1][1]);
  });
});

// D3/Task4: встройка buildStudyPlan в оркестратор — план строится из ТЕХ ЖЕ
// states/activeSections, что и карта (D1), плюс context.examDate из
// расширенного HqReader.
describe("recomputeHqInsights: plan step (Task4 buildStudyPlan wiring)", () => {
  it("writes weeks via replaceFutureWeeks using the states/activeSections computed this run (status ok)", async () => {
    const items: KnowledgeItem[] = [
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
    ];
    const examDate = new Date("2026-09-01T00:00:00Z");
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null, examDate });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(planRepo.replaceFutureWeeks).toHaveBeenCalledTimes(1);
    const [hqId, weeks] = vi.mocked(planRepo.replaceFutureWeeks).mock.calls[0];
    expect(hqId).toBe(HQ_ID);
    expect(weeks.length).toBeGreaterThan(0);
    expect(weeks[0].weekStart).toBe("2026-07-06"); // mondayUtc(NOW=2026-07-08)
  });

  it("still writes 8 weeks via replaceFutureWeeks when examDate is null (status noExamDate)", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null, examDate: null });
    const knowledgeRepo = fakeKnowledgeRepo();
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(planRepo.replaceFutureWeeks).toHaveBeenCalledTimes(1);
    const [, weeks] = vi.mocked(planRepo.replaceFutureWeeks).mock.calls[0];
    expect(weeks).toHaveLength(8);
  });

  it("does NOT call replaceFutureWeeks when examDate has already passed (frozen plan, no writes/deletes)", async () => {
    const pastExamDate = new Date("2026-01-01T00:00:00Z"); // well before NOW=2026-07-08
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null, examDate: pastExamDate });
    const knowledgeRepo = fakeKnowledgeRepo();
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(planRepo.replaceFutureWeeks).not.toHaveBeenCalled();
    // Watermark still fires — examDatePassed only skips the plan write, not
    // the rest of the recompute (D7: watermark always touches on success).
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledWith(HQ_ID, NOW);
  });

  it("plan write happens before the watermark touch (order matches D7's step list)", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null, examDate: null });
    const knowledgeRepo = fakeKnowledgeRepo();
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    const planOrder = vi.mocked(planRepo.replaceFutureWeeks).mock.invocationCallOrder[0];
    const touchOrder = vi.mocked(knowledgeRepo.touchWatermark).mock.invocationCallOrder[0];
    expect(planOrder).toBeLessThan(touchOrder);
  });
});

// D4/Task5: встройка computeForecast + ForecastRepo.append в оркестратор —
// прогноз строится из ТЕХ ЖЕ states/activeSections/scoring, что и карта/план
// выше, плюс loadMockResults(hqId) и inputs.nFinished (переиспользован из
// шага карты — отдельного запроса нет).
describe("recomputeHqInsights: forecast step (Task5 computeForecast wiring)", () => {
  it("appends a forecast via forecastRepo when computeForecast returns non-null (map has >= NMIN rows, >=1 finished attempt)", async () => {
    const items: KnowledgeItem[] = [
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
    ];
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(forecastRepo.append).toHaveBeenCalledTimes(1);
    const [hqId, forecast] = vi.mocked(forecastRepo.append).mock.calls[0];
    expect(hqId).toBe(HQ_ID);
    expect(Number.isFinite(forecast.point)).toBe(true);
  });

  it("does NOT append a forecast when the map is empty (all topics below NMIN -> computeForecast returns null)", async () => {
    const items: KnowledgeItem[] = [answeredItem({ topic: "algebra" })]; // 1 < NMIN(3)
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(forecastRepo.append).not.toHaveBeenCalled();
  });

  it("does NOT append a forecast when there are no finished attempts at all (nFinished === 0)", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo();
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(forecastRepo.append).not.toHaveBeenCalled();
  });

  it("passes loadMockResults(hqId) output through to computeForecast's mock calibration", async () => {
    const items: KnowledgeItem[] = [
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
    ];
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
      loadMockResults: vi.fn().mockResolvedValue([{ scaled: 100, snapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" } }]),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(knowledgeRepo.loadMockResults).toHaveBeenCalledWith(HQ_ID);
    expect(forecastRepo.append).toHaveBeenCalledTimes(1);
  });

  it("forecast append happens AFTER the plan write and BEFORE the watermark touch (order matches D7's step list)", async () => {
    const items: KnowledgeItem[] = [
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
    ];
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    const planOrder = vi.mocked(planRepo.replaceFutureWeeks).mock.invocationCallOrder[0];
    const appendOrder = vi.mocked(forecastRepo.append).mock.invocationCallOrder[0];
    const touchOrder = vi.mocked(knowledgeRepo.touchWatermark).mock.invocationCallOrder[0];
    expect(planOrder).toBeLessThan(appendOrder);
    expect(appendOrder).toBeLessThan(touchOrder);
  });

  it("propagates an error thrown from forecastRepo.append and does NOT touch the watermark", async () => {
    const items: KnowledgeItem[] = [
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
      answeredItem({ topic: "algebra" }),
    ];
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockResolvedValue({ items, nFinished: 1, maxFinishedAt: NOW }),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo({
      append: vi.fn().mockRejectedValue(new Error("forecast write failed")),
    });

    await expect(
      recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW }),
    ).rejects.toThrow("forecast write failed");
    expect(knowledgeRepo.touchWatermark).not.toHaveBeenCalled();
  });

  it("propagates an error thrown from loadMockResults and does NOT touch the watermark", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadMockResults: vi.fn().mockRejectedValue(new Error("mock query failed")),
    });
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await expect(
      recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW }),
    ).rejects.toThrow("mock query failed");
    expect(knowledgeRepo.touchWatermark).not.toHaveBeenCalled();
  });

  it("spec===null short-circuit never touches loadMockResults or forecastRepo.append", async () => {
    const hqReader = fakeHqReader({ spec: null, config: null });
    const knowledgeRepo = fakeKnowledgeRepo();
    const planRepo = fakePlanRepo();
    const forecastRepo = fakeForecastRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo, planRepo, forecastRepo }, { hqId: HQ_ID, now: NOW });

    expect(knowledgeRepo.loadMockResults).not.toHaveBeenCalled();
    expect(forecastRepo.append).not.toHaveBeenCalled();
  });
});

// D3/Task4: supabaseHqReader теперь также читает study_hqs.exam_date.
describe("supabaseHqReader: exam_date parsing", () => {
  type QueryResult = { data: unknown; error: unknown };

  function chainable(result: QueryResult) {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "eq"]) {
      builder[method] = () => builder;
    }
    builder.maybeSingle = () => Promise.resolve(result);
    return builder;
  }

  function fakeSupabase(opts: { studyHq: QueryResult; examProfile?: QueryResult }) {
    const from = vi.fn((table: string) => {
      if (table === "study_hqs") return chainable(opts.studyHq);
      if (table === "exam_profiles") return chainable(opts.examProfile ?? { data: null, error: null });
      return chainable({ data: null, error: null });
    });
    return { from } as unknown as SupabaseClient<Database>;
  }

  function specRow() {
    return {
      spec: {
        examName: "ЕНТ",
        language: "kk",
        description: "d",
        sections: [{ name: "Математика", taskTypes: [], topics: ["algebra"] }],
        variants: [],
        selectionGroups: [],
        scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
      },
    };
  }

  it("parses a 'YYYY-MM-DD' exam_date into a Date (UTC midnight)", async () => {
    const client = fakeSupabase({
      studyHq: { data: { exam_profile_id: "p1", config: null, exam_date: "2026-09-01" }, error: null },
      examProfile: { data: specRow(), error: null },
    });

    const context = await supabaseHqReader(client).loadHqContext("hq-1");

    expect(context.examDate).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });

  it("maps a null exam_date to examDate: null", async () => {
    const client = fakeSupabase({
      studyHq: { data: { exam_profile_id: "p1", config: null, exam_date: null }, error: null },
      examProfile: { data: specRow(), error: null },
    });

    const context = await supabaseHqReader(client).loadHqContext("hq-1");

    expect(context.examDate).toBeNull();
  });

  it("returns examDate: null when the hq itself does not exist (spec: null short-circuit)", async () => {
    const client = fakeSupabase({ studyHq: { data: null, error: null } });

    const context = await supabaseHqReader(client).loadHqContext("hq-1");

    expect(context).toEqual({ spec: null, config: null, examDate: null });
  });

  it("still surfaces examDate even when the exam profile row is missing/broken (spec: null)", async () => {
    const client = fakeSupabase({
      studyHq: { data: { exam_profile_id: "p1", config: null, exam_date: "2026-09-01" }, error: null },
      examProfile: { data: null, error: null }, // profile missing
    });

    const context = await supabaseHqReader(client).loadHqContext("hq-1");

    expect(context.spec).toBeNull();
    expect(context.examDate).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });
});
