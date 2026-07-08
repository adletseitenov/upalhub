import { describe, expect, it } from "vitest";
import type { ExamSection } from "@/features/exam-profile/spec";
import type { TopicState } from "@/features/knowledge/compute";
import type { ScoringSnapshot } from "@/features/tests/scoring";
import { computeForecast } from "./compute";
import type { MockResult } from "./compute";

const NOW = new Date("2026-07-08T00:00:00Z");

function section(overrides: Partial<ExamSection> & { name: string }): ExamSection {
  return { taskTypes: [], topics: [], ...overrides } as ExamSection;
}

function state(level: number, answeredCount = 5, lastSeenAt: Date = NOW): TopicState {
  return { level, answeredCount, lastSeenAt };
}

const ENT_SCORING: ScoringSnapshot = { scaleMin: 0, scaleMax: 140, unit: "баллов" };
const PERCENT_SCORING: ScoringSnapshot = { scaleMin: 0, scaleMax: 100, unit: "баллов" };
const IELTS_SCORING: ScoringSnapshot = { scaleMin: 0, scaleMax: 9, unit: "band" };

describe("computeForecast: data gates (D4 🔴 — no forecast from pure prior)", () => {
  it("returns null when the knowledge map is empty (states.size === 0)", () => {
    const result = computeForecast({
      states: new Map(),
      activeSections: [section({ name: "Математика", topics: ["algebra"] })],
      scoring: ENT_SCORING,
      nFinished: 3,
      mocks: [],
    });
    expect(result).toBeNull();
  });

  it("returns null when there are no finished attempts (nFinished === 0), even with a non-empty map", () => {
    const states = new Map([["algebra", state(0.6)]]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "Математика", topics: ["algebra"] })],
      scoring: ENT_SCORING,
      nFinished: 0,
      mocks: [],
    });
    expect(result).toBeNull();
  });
});

describe("computeForecast: NaN guards on empty/fallback sections (D4 🔴)", () => {
  it("a section with topics: [] falls back to its own name as the sole topic — no NaN", () => {
    const states = new Map([["Общий раздел", state(0.6)]]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "Общий раздел", topics: [] })],
      scoring: PERCENT_SCORING,
      nFinished: 2,
      mocks: [],
    });
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.point)).toBe(true);
    expect(Number.isFinite(result!.low)).toBe(true);
    expect(Number.isFinite(result!.high)).toBe(true);
    expect(Number.isNaN(result!.point)).toBe(false);
  });

  it("all active sections empty (activeSections: []) -> null, not NaN", () => {
    const states = new Map([["algebra", state(0.6)]]);
    const result = computeForecast({
      states,
      activeSections: [],
      scoring: PERCENT_SCORING,
      nFinished: 2,
      mocks: [],
    });
    expect(result).toBeNull();
  });

});

describe("computeForecast: fraction across weighted sections", () => {
  it("uses meanTopic(level ?? P0) per section, weighted by taskCount (default 1)", () => {
    // Section A: 1 topic at level 0.8, taskCount 3. Section B: 1 topic at
    // level 0.2 (unexplored -> P0=0.3 would apply only if absent; here it's
    // present), taskCount 1. fraction = (3*0.8 + 1*0.2) / 4 = 0.65.
    const states = new Map([
      ["a1", state(0.8)],
      ["b1", state(0.2)],
    ]);
    const result = computeForecast({
      states,
      activeSections: [
        section({ name: "A", topics: ["a1"], taskCount: 3 }),
        section({ name: "B", topics: ["b1"], taskCount: 1 }),
      ],
      scoring: PERCENT_SCORING,
      nFinished: 1,
      mocks: [],
    });
    expect(result).not.toBeNull();
    // fraction=0.65 -> point = scaleScore(650,1000,{0,100}) = 65.
    expect(result!.point).toBe(65);
  });

  it("a topic absent from the map falls back to the P0 prior inside meanTopic (not 0)", () => {
    const states = new Map([["known", state(1.0, 10)]]);
    const result = computeForecast({
      states,
      // "unknown" has no row in states -> meanTopic uses P0=0.3, not 0.
      activeSections: [section({ name: "S", topics: ["known", "unknown"] })],
      scoring: PERCENT_SCORING,
      nFinished: 1,
      mocks: [],
    });
    // meanTopic = (1.0 + 0.3) / 2 = 0.65 -> point 65.
    expect(result!.point).toBe(65);
  });
});

describe("computeForecast: mock calibration (D4 🔴 fraction-space blending)", () => {
  it("a mock on a 0-9 band scale does NOT collapse the forecast when the exam profile is 0-100 (red-team regression)", () => {
    // fraction=0.6 (constructed below), mock scaled=7 on band(0-9) ->
    // mockFrac=7/9≈0.7778, alpha=min(0.5,0.25*1)=0.25,
    // blended=0.25*0.7778+0.75*0.6=0.64444 -> point≈64, NOT a naive
    // points-space average (7 out of 9 blended with a 0-100 score would
    // otherwise crater the result to ~46 if done in raw-points space).
    const states = new Map([["reading", state(0.6, 5)]]);
    const mocks: MockResult[] = [{ scaled: 7, snapshot: { scaleMin: 0, scaleMax: 9, unit: "band" } }];

    const result = computeForecast({
      states,
      activeSections: [section({ name: "Reading", topics: ["reading"] })],
      scoring: PERCENT_SCORING,
      nFinished: 2,
      mocks,
    });

    expect(result).not.toBeNull();
    expect(result!.point).toBe(64);
  });

  it("averages multiple valid mocks and skips a mock with a degenerate (zero-span) snapshot", () => {
    const states = new Map([["reading", state(0.5, 5)]]);
    const mocks: MockResult[] = [
      { scaled: 5, snapshot: { scaleMin: 0, scaleMax: 10, unit: "баллов" } }, // frac 0.5
      { scaled: 9, snapshot: { scaleMin: 0, scaleMax: 10, unit: "баллов" } }, // frac 0.9
      { scaled: 100, snapshot: { scaleMin: 50, scaleMax: 50, unit: "баллов" } }, // span 0 -> skipped
    ];

    const result = computeForecast({
      states,
      activeSections: [section({ name: "Reading", topics: ["reading"] })],
      scoring: PERCENT_SCORING,
      nFinished: 2,
      mocks,
    });

    // nMock=2 (third skipped) -> alpha=min(0.5,0.5)=0.5, avgMockFrac=(0.5+0.9)/2=0.7
    // fraction=0.5 (single topic at 0.5) -> blended=0.5*0.7+0.5*0.5=0.6 -> point 60.
    expect(result!.point).toBe(60);
  });

  it("falls back to the raw fraction (no blending) when there are no mocks at all", () => {
    const states = new Map([["reading", state(0.5, 5)]]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "Reading", topics: ["reading"] })],
      scoring: PERCENT_SCORING,
      nFinished: 2,
      mocks: [],
    });
    expect(result!.point).toBe(50);
  });
});

describe("computeForecast: coverage + confidence range", () => {
  it("coverage counts only topics with answeredCount >= NMIN among ACTIVE topics", () => {
    const states = new Map([
      ["t1", state(0.5, 5)], // covered (>= NMIN 3)
      ["t2", state(0.5, 1)], // below NMIN -> not covered (still contributes to fraction via level)
    ]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "S", topics: ["t1", "t2"] })],
      scoring: PERCENT_SCORING,
      nFinished: 1,
      mocks: [],
    });
    expect(result!.coverage).toBeCloseTo(0.5, 10); // 1/2
  });

  it("range narrows as coverage and nFinished both increase (halfWidth is monotonically decreasing)", () => {
    // 5 topics; coverage 0.2 (1 covered) vs coverage 0.8 (4 covered).
    const topics = ["t1", "t2", "t3", "t4", "t5"];
    const sectionLow = section({ name: "S", topics });
    const lowCoverageStates = new Map<string, TopicState>([["t1", state(0.5, 5)]]);
    const highCoverageStates = new Map<string, TopicState>([
      ["t1", state(0.5, 5)],
      ["t2", state(0.5, 5)],
      ["t3", state(0.5, 5)],
      ["t4", state(0.5, 5)],
    ]);

    const narrow = computeForecast({
      states: lowCoverageStates,
      activeSections: [sectionLow],
      scoring: PERCENT_SCORING,
      nFinished: 1,
      mocks: [],
    })!;
    const wide = computeForecast({
      states: highCoverageStates,
      activeSections: [sectionLow],
      scoring: PERCENT_SCORING,
      nFinished: 5,
      mocks: [],
    })!;

    expect(narrow.coverage).toBeCloseTo(0.2, 10);
    expect(wide.coverage).toBeCloseTo(0.8, 10);
    expect(wide.high - wide.low).toBeLessThan(narrow.high - narrow.low);
  });

  it("confidence 'high': coverage >= 0.6 AND nFinished >= 3", () => {
    const states = new Map([
      ["t1", state(0.5, 5)],
      ["t2", state(0.5, 5)],
    ]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "S", topics: ["t1", "t2"] })], // coverage 1.0
      scoring: PERCENT_SCORING,
      nFinished: 3,
      mocks: [],
    });
    expect(result!.confidence).toBe("high");
  });

  it("confidence 'medium': coverage >= 0.3 (even with low nFinished)", () => {
    // 1 of 3 topics covered -> coverage=1/3≈0.333, just over the 0.3 gate;
    // nFinished=1 alone would never qualify for 'medium'.
    const states = new Map([["t1", state(0.5, 5)]]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "S", topics: ["t1", "t2", "t3"] })],
      scoring: PERCENT_SCORING,
      nFinished: 1,
      mocks: [],
    });
    expect(result!.coverage).toBeCloseTo(1 / 3, 10);
    expect(result!.confidence).toBe("medium");
  });

  it("confidence 'medium': nFinished >= 2 (even with low coverage)", () => {
    const states = new Map([
      ["t1", state(0.5, 1)], // below NMIN -> not covered
      ["t2", state(0.5, 1)],
    ]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "S", topics: ["t1", "t2"] })], // coverage 0
      scoring: PERCENT_SCORING,
      nFinished: 2,
      mocks: [],
    });
    expect(result!.confidence).toBe("medium");
  });

  it("confidence 'low': low coverage AND nFinished < 2", () => {
    const states = new Map([["t1", state(0.5, 1)]]); // below NMIN
    const result = computeForecast({
      states,
      activeSections: [section({ name: "S", topics: ["t1"] })], // coverage 0
      scoring: PERCENT_SCORING,
      nFinished: 1,
      mocks: [],
    });
    expect(result!.confidence).toBe("low");
  });
});

describe("computeForecast: scale-aware rounding (step)", () => {
  it("IELTS band scale (0-9, default step 0.5) rounds point/low/high to the nearest 0.5", () => {
    const states = new Map([["reading", state(0.63, 5)]]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "Reading", topics: ["reading"] })],
      scoring: IELTS_SCORING,
      nFinished: 3,
      mocks: [],
    })!;

    for (const v of [result.point, result.low, result.high]) {
      expect(Number.isInteger(v * 2)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it("ЕНТ scale (0-140, default step 1) rounds point/low/high to integers", () => {
    const states = new Map([["algebra", state(0.63, 5)]]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "Математика", topics: ["algebra"] })],
      scoring: ENT_SCORING,
      nFinished: 3,
      mocks: [],
    })!;

    for (const v of [result.point, result.low, result.high]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(140);
    }
  });

  it("low/high stay within [scaleMin, scaleMax] even at the extremes of the halfWidth range", () => {
    // Very low coverage/nFinished -> halfWidth clamps to its max (0.35),
    // pushing low/high toward (and clamped at) the scale edges.
    const states = new Map([["t1", state(0.05, 1)]]);
    const result = computeForecast({
      states,
      activeSections: [section({ name: "S", topics: ["t1"] })],
      scoring: PERCENT_SCORING,
      nFinished: 1,
      mocks: [],
    })!;
    expect(result.low).toBeGreaterThanOrEqual(0);
    expect(result.high).toBeLessThanOrEqual(100);
    expect(result.low).toBeLessThanOrEqual(result.point);
    expect(result.high).toBeGreaterThanOrEqual(result.point);
  });
});
