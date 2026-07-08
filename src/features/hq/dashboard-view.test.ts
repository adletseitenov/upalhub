import { describe, expect, it } from "vitest";
import type { ExamSection } from "@/features/exam-profile/spec";
import type { TopicState } from "@/features/knowledge/compute";
import type { Forecast } from "@/features/forecast/compute";
import type { StoredPlanWeek } from "@/features/plan/repo";
import { STALE_DAYS } from "@/features/knowledge/constants";
import {
  buildKnowledgeMapSections,
  computeGoalGap,
  isHqStale,
  isNarrowForecast,
  parseTargetNumber,
  selectCurrentWeek,
} from "./dashboard-view";

const NOW = new Date("2026-07-08T00:00:00Z"); // Wednesday
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

function section(name: string, topics: string[] = []): ExamSection {
  return { name, taskTypes: [], topics };
}

function state(overrides: Partial<TopicState> = {}): TopicState {
  return { level: 0.5, answeredCount: 3, lastSeenAt: NOW, ...overrides };
}

function forecast(overrides: Partial<Forecast> = {}): Forecast {
  return { point: 500, low: 450, high: 550, confidence: "medium", coverage: 0.5, ...overrides };
}

// --- buildKnowledgeMapSections -----------------------------------------------

describe("buildKnowledgeMapSections", () => {
  it("computes band+stale for a topic with a knowledge_states row", () => {
    const states = new Map([["algebra", state({ level: 0.8, lastSeenAt: NOW })]]);
    const sections = buildKnowledgeMapSections([section("Math", ["algebra"])], states, NOW);
    expect(sections).toEqual([
      { name: "Math", topics: [{ topic: "algebra", state: { level: 0.8, band: "strong", stale: false } }] },
    ]);
  });

  it("marks a topic with no row as unexplored (state: null)", () => {
    const sections = buildKnowledgeMapSections([section("Math", ["algebra"])], new Map(), NOW);
    expect(sections).toEqual([{ name: "Math", topics: [{ topic: "algebra", state: null }] }]);
  });

  it("flags stale when lastSeenAt is older than STALE_DAYS", () => {
    const states = new Map([["algebra", state({ lastSeenAt: daysAgo(STALE_DAYS + 1) })]]);
    const sections = buildKnowledgeMapSections([section("Math", ["algebra"])], states, NOW);
    expect(sections[0].topics[0].state?.stale).toBe(true);
  });

  it("does not flag stale within STALE_DAYS", () => {
    const states = new Map([["algebra", state({ lastSeenAt: daysAgo(STALE_DAYS - 1) })]]);
    const sections = buildKnowledgeMapSections([section("Math", ["algebra"])], states, NOW);
    expect(sections[0].topics[0].state?.stale).toBe(false);
  });

  it("falls back to the section name as its sole topic when topics is empty", () => {
    const sections = buildKnowledgeMapSections([section("Grammar")], new Map(), NOW);
    expect(sections).toEqual([{ name: "Grammar", topics: [{ topic: "Grammar", state: null }] }]);
  });

  it("preserves section order and skips no sections (empty input -> empty output)", () => {
    expect(buildKnowledgeMapSections([], new Map(), NOW)).toEqual([]);
  });
});

// --- isHqStale ---------------------------------------------------------------

describe("isHqStale", () => {
  it("is not stale when no attempt has ever finished (maxFinishedAt null)", () => {
    expect(isHqStale(null, null)).toBe(false);
    expect(isHqStale(null, NOW)).toBe(false);
  });

  it("is stale when there is a finished attempt but recompute never ran", () => {
    expect(isHqStale(NOW, null)).toBe(true);
  });

  it("is stale when the latest finished attempt is newer than the last recompute", () => {
    expect(isHqStale(NOW, daysAgo(1))).toBe(true);
  });

  it("is not stale when the last recompute is at or after the latest finished attempt", () => {
    expect(isHqStale(daysAgo(1), NOW)).toBe(false);
    expect(isHqStale(NOW, NOW)).toBe(false); // equal timestamps: watermark already covers it
  });
});

// --- selectCurrentWeek ---------------------------------------------------------

function week(weekStart: string): StoredPlanWeek {
  return { weekStart, topics: { focus: [], suggestedTest: { kind: "practice" } }, status: "planned" };
}

describe("selectCurrentWeek", () => {
  it("picks the week whose [weekStart, weekStart+7d) window contains today", () => {
    // NOW = 2026-07-08 (Wed); its Monday is 2026-07-06.
    const weeks = [week("2026-06-29"), week("2026-07-06"), week("2026-07-13")];
    expect(selectCurrentWeek(weeks, NOW)?.weekStart).toBe("2026-07-06");
  });

  it("returns null when no week covers today (empty plan)", () => {
    expect(selectCurrentWeek([], NOW)).toBeNull();
  });

  it("returns null when all weeks are in the past (exam date passed, horizon frozen)", () => {
    const weeks = [week("2026-06-01"), week("2026-06-08")];
    expect(selectCurrentWeek(weeks, NOW)).toBeNull();
  });

  it("returns null when all weeks are in the future", () => {
    const weeks = [week("2026-08-03")];
    expect(selectCurrentWeek(weeks, NOW)).toBeNull();
  });

  it("picks the most recent matching week if ranges overlap (defensive, regen artifact)", () => {
    const weeks = [week("2026-07-02"), week("2026-07-06")];
    expect(selectCurrentWeek(weeks, NOW)?.weekStart).toBe("2026-07-06");
  });

  it("ignores a week with an unparseable weekStart rather than throwing", () => {
    const weeks = [week("not-a-date"), week("2026-07-06")];
    expect(selectCurrentWeek(weeks, NOW)?.weekStart).toBe("2026-07-06");
  });
});

// --- computeGoalGap (D6, all 4 branches) --------------------------------------

describe("computeGoalGap", () => {
  it("branch: target inside [low, high] -> onTrack", () => {
    expect(computeGoalGap(500, forecast({ low: 450, high: 550 }))).toEqual({ kind: "onTrack" });
  });

  it("branch: target at exactly low or high -> onTrack (closed interval)", () => {
    expect(computeGoalGap(450, forecast({ low: 450, high: 550 }))).toEqual({ kind: "onTrack" });
    expect(computeGoalGap(550, forecast({ low: 450, high: 550 }))).toEqual({ kind: "onTrack" });
  });

  it("branch: target below low -> above (goal already in the bag)", () => {
    expect(computeGoalGap(400, forecast({ low: 450, high: 550 }))).toEqual({ kind: "above" });
  });

  it("branch: target above high -> gap with positive delta from point", () => {
    expect(computeGoalGap(650, forecast({ point: 500, low: 450, high: 550 }))).toEqual({
      kind: "gap",
      delta: 150,
    });
  });

  it("branch: no target or no forecast -> none (gap hidden)", () => {
    expect(computeGoalGap(null, forecast())).toEqual({ kind: "none" });
    expect(computeGoalGap(500, null)).toEqual({ kind: "none" });
    expect(computeGoalGap(null, null)).toEqual({ kind: "none" });
  });
});

describe("parseTargetNumber", () => {
  it("parses a plain numeric string", () => {
    expect(parseTargetNumber("540")).toBe(540);
    expect(parseTargetNumber("6.5")).toBe(6.5);
  });

  it("trims surrounding whitespace", () => {
    expect(parseTargetNumber("  540  ")).toBe(540);
  });

  it("returns null for null, empty, and non-numeric text", () => {
    expect(parseTargetNumber(null)).toBeNull();
    expect(parseTargetNumber("")).toBeNull();
    expect(parseTargetNumber("   ")).toBeNull();
    expect(parseTargetNumber("поступить в топ-вуз")).toBeNull();
  });
});

// --- isNarrowForecast ----------------------------------------------------------

describe("isNarrowForecast", () => {
  it("is true when low === high (degenerate range collapses to the point)", () => {
    expect(isNarrowForecast(forecast({ point: 9, low: 9, high: 9 }))).toBe(true);
  });

  it("is false when low !== high", () => {
    expect(isNarrowForecast(forecast({ low: 450, high: 550 }))).toBe(false);
  });
});
