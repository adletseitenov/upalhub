import { describe, expect, it, vi } from "vitest";
import type { ExamProfileSpec } from "@/features/exam-profile/spec";
import type { HqConfig } from "@/features/exam-profile/selection";
import type { KnowledgeItem } from "@/features/knowledge/compute";
import type { KnowledgeRepo } from "@/features/knowledge/repo";
import { recomputeHqInsights } from "./recompute";
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

function fakeHqReader(context: HqContext): HqReader {
  return { loadHqContext: vi.fn().mockResolvedValue(context) };
}

function fakeKnowledgeRepo(overrides: Partial<KnowledgeRepo> = {}): KnowledgeRepo {
  return {
    loadKnowledgeInputs: vi.fn().mockResolvedValue({ items: [], nFinished: 0, maxFinishedAt: null }),
    upsertStates: vi.fn().mockResolvedValue(undefined),
    touchWatermark: vi.fn().mockResolvedValue(undefined),
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

    await recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW });

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

    await recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW });

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

    await recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW });

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

    await recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW });

    const [, states] = vi.mocked(knowledgeRepo.upsertStates).mock.calls[0];
    expect(states.size).toBe(0);
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledWith(HQ_ID, NOW);
  });

  it("upserts an empty map and touches the watermark when there are no finished attempts at all", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW });

    const [, states] = vi.mocked(knowledgeRepo.upsertStates).mock.calls[0];
    expect(states.size).toBe(0);
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledWith(HQ_ID, NOW);
  });
});

describe("recomputeHqInsights: spec null", () => {
  it("only touches the watermark — no knowledge read/write at all", async () => {
    const hqReader = fakeHqReader({ spec: null, config: null });
    const knowledgeRepo = fakeKnowledgeRepo();

    await recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW });

    expect(knowledgeRepo.loadKnowledgeInputs).not.toHaveBeenCalled();
    expect(knowledgeRepo.upsertStates).not.toHaveBeenCalled();
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

    await expect(
      recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW }),
    ).rejects.toThrow("db down");
    expect(knowledgeRepo.touchWatermark).not.toHaveBeenCalled();
  });

  it("propagates an error thrown from loadKnowledgeInputs and does NOT touch the watermark", async () => {
    const hqReader = fakeHqReader({ spec: makeSpec(), config: null });
    const knowledgeRepo = fakeKnowledgeRepo({
      loadKnowledgeInputs: vi.fn().mockRejectedValue(new Error("network error")),
    });

    await expect(
      recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW }),
    ).rejects.toThrow("network error");
    expect(knowledgeRepo.upsertStates).not.toHaveBeenCalled();
    expect(knowledgeRepo.touchWatermark).not.toHaveBeenCalled();
  });

  it("propagates an error thrown from loadHqContext and does NOT touch the watermark", async () => {
    const hqReader: HqReader = { loadHqContext: vi.fn().mockRejectedValue(new Error("hq lookup failed")) };
    const knowledgeRepo = fakeKnowledgeRepo();

    await expect(
      recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW }),
    ).rejects.toThrow("hq lookup failed");
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

    await recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW });
    await recomputeHqInsights({ hqReader, knowledgeRepo }, { hqId: HQ_ID, now: NOW });

    const calls = vi.mocked(knowledgeRepo.upsertStates).mock.calls;
    expect(calls).toHaveLength(2);
    expect(Array.from(calls[0][1].entries())).toEqual(Array.from(calls[1][1].entries()));
    expect(knowledgeRepo.touchWatermark).toHaveBeenCalledTimes(2);
  });
});
