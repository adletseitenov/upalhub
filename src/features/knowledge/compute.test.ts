import { describe, expect, it } from "vitest";
import { computeKnowledgeStates, isStale } from "./compute";
import type { KnowledgeItem } from "./compute";
import { BAND_STRONG, BAND_WEAK, K, NMIN, P0, RECENCY_FLOOR, STALE_DAYS, levelToBand } from "./constants";

const NOW = new Date("2026-07-08T00:00:00Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

function item(overrides: Partial<KnowledgeItem> & { topic: string }): KnowledgeItem {
  return {
    difficulty: 3,
    isCorrect: true,
    answered: true,
    finishedAt: NOW,
    ...overrides,
  };
}

describe("computeKnowledgeStates: NMIN gating", () => {
  it("does not emit a row for a topic with answeredCount < NMIN", () => {
    const items: KnowledgeItem[] = [
      item({ topic: "algebra", finishedAt: daysAgo(0) }),
      item({ topic: "algebra", finishedAt: daysAgo(1) }),
    ];
    const result = computeKnowledgeStates(items, new Set(["algebra"]), NOW);
    expect(result.has("algebra")).toBe(false);
  });

  it("emits a row once answeredCount reaches NMIN", () => {
    expect(NMIN).toBe(3);
    const items: KnowledgeItem[] = [
      item({ topic: "algebra", finishedAt: daysAgo(0) }),
      item({ topic: "algebra", finishedAt: daysAgo(1) }),
      item({ topic: "algebra", finishedAt: daysAgo(2) }),
    ];
    const result = computeKnowledgeStates(items, new Set(["algebra"]), NOW);
    expect(result.has("algebra")).toBe(true);
    expect(result.get("algebra")?.answeredCount).toBe(3);
  });
});

describe("computeKnowledgeStates: skipped items", () => {
  it("excludes answered=false items from both the level signal and answeredCount", () => {
    const items: KnowledgeItem[] = [
      item({ topic: "algebra", finishedAt: daysAgo(0) }),
      item({ topic: "algebra", finishedAt: daysAgo(1) }),
      item({ topic: "algebra", finishedAt: daysAgo(2) }),
      // skipped: garbage isCorrect/difficulty must not leak into the sums.
      item({
        topic: "algebra",
        finishedAt: daysAgo(0),
        answered: false,
        isCorrect: false,
        difficulty: 5,
      }),
    ];
    const withSkip = computeKnowledgeStates(items, new Set(["algebra"]), NOW);
    const withoutSkip = computeKnowledgeStates(items.slice(0, 3), new Set(["algebra"]), NOW);
    expect(withSkip.get("algebra")?.answeredCount).toBe(3);
    expect(withSkip.get("algebra")?.level).toBeCloseTo(withoutSkip.get("algebra")!.level, 10);
  });
});

describe("computeKnowledgeStates: activeTopics filter", () => {
  it("ignores topics outside activeTopics even with plenty of signal", () => {
    const items: KnowledgeItem[] = [
      item({ topic: "geometry", finishedAt: daysAgo(0) }),
      item({ topic: "geometry", finishedAt: daysAgo(1) }),
      item({ topic: "geometry", finishedAt: daysAgo(2) }),
    ];
    const result = computeKnowledgeStates(items, new Set(["algebra"]), NOW);
    expect(result.has("geometry")).toBe(false);
    expect(result.size).toBe(0);
  });
});

describe("computeKnowledgeStates: difficulty weighting", () => {
  it("weighs a harder correct answer above an easier correct answer (all else equal)", () => {
    const hard: KnowledgeItem[] = [
      item({ topic: "hard", difficulty: 5, finishedAt: daysAgo(0) }),
      item({ topic: "hard", difficulty: 5, finishedAt: daysAgo(0) }),
      item({ topic: "hard", difficulty: 5, finishedAt: daysAgo(0) }),
    ];
    const easy: KnowledgeItem[] = [
      item({ topic: "easy", difficulty: 1, finishedAt: daysAgo(0) }),
      item({ topic: "easy", difficulty: 1, finishedAt: daysAgo(0) }),
      item({ topic: "easy", difficulty: 1, finishedAt: daysAgo(0) }),
    ];
    const result = computeKnowledgeStates([...hard, ...easy], new Set(["hard", "easy"]), NOW);
    const hardLevel = result.get("hard")!.level;
    const easyLevel = result.get("easy")!.level;
    expect(hardLevel).toBeGreaterThan(easyLevel);
    // diffW=2 -> g=2 -> Σg=6; level=(6+K·P0)/(6+K)
    expect(hardLevel).toBeCloseTo((6 + K * P0) / (6 + K), 10);
    // diffW=1 -> g=1 -> Σg=3; level=(3+K·P0)/(3+K)
    expect(easyLevel).toBeCloseTo((3 + K * P0) / (3 + K), 10);
  });
});

describe("computeKnowledgeStates: all-correct-fresh does not auto-jump to strong", () => {
  it("3/3 fresh correct diff=3 stays below BAND_STRONG (Bayesian smoothing via K/P0)", () => {
    const items: KnowledgeItem[] = [
      item({ topic: "algebra", difficulty: 3, finishedAt: daysAgo(0) }),
      item({ topic: "algebra", difficulty: 3, finishedAt: daysAgo(0) }),
      item({ topic: "algebra", difficulty: 3, finishedAt: daysAgo(0) }),
    ];
    const result = computeKnowledgeStates(items, new Set(["algebra"]), NOW);
    const level = result.get("algebra")!.level;
    // recency=1, diffW=1.5 -> g=1.5, Σg=4.5; level=(4.5+0.9)/(4.5+3)=5.4/7.5=0.72
    expect(level).toBeCloseTo(0.72, 10);
    expect(level).toBeLessThan(BAND_STRONG);
  });
});

describe("computeKnowledgeStates: fresh attempts move the level more than old ones", () => {
  it("a fresh wrong answer pulls the level down harder than an equally old wrong answer", () => {
    const base: KnowledgeItem[] = [
      item({ topic: "algebra", difficulty: 3, finishedAt: daysAgo(200) }),
      item({ topic: "algebra", difficulty: 3, finishedAt: daysAgo(200) }),
      item({ topic: "algebra", difficulty: 3, finishedAt: daysAgo(200) }),
    ];
    const freshWrong = item({
      topic: "algebra",
      difficulty: 3,
      isCorrect: false,
      finishedAt: daysAgo(0),
    });
    const oldWrong = item({
      topic: "algebra",
      difficulty: 3,
      isCorrect: false,
      finishedAt: daysAgo(200),
    });

    const withFreshWrong = computeKnowledgeStates([...base, freshWrong], new Set(["algebra"]), NOW);
    const withOldWrong = computeKnowledgeStates([...base, oldWrong], new Set(["algebra"]), NOW);

    const freshLevel = withFreshWrong.get("algebra")!.level;
    const oldLevel = withOldWrong.get("algebra")!.level;

    expect(freshLevel).toBeLessThan(oldLevel);
    // recency at 200d is floored: max(0.5^(200/45),0.15) = 0.15 -> g=0.225 per base item.
    // Σg_base=0.675, Σgx_base=0.675 (all correct).
    // fresh wrong: recency=1, diffW=1.5 -> g=1.5, x=0.
    const freshExpected = (0.675 + K * P0) / (0.675 + 1.5 + K);
    // old wrong: recency=0.15, diffW=1.5 -> g=0.225, x=0.
    const oldExpected = (0.675 + K * P0) / (0.675 + 0.225 + K);
    expect(freshLevel).toBeCloseTo(freshExpected, 6);
    expect(oldLevel).toBeCloseTo(oldExpected, 6);
  });
});

describe("computeKnowledgeStates: RECENCY_FLOOR keeps very old signal above pure prior", () => {
  it("very old (effectively decayed) correct answers still lift level above P0 thanks to the floor", () => {
    const items: KnowledgeItem[] = [
      item({ topic: "algebra", difficulty: 1, finishedAt: daysAgo(400) }),
      item({ topic: "algebra", difficulty: 1, finishedAt: daysAgo(400) }),
      item({ topic: "algebra", difficulty: 1, finishedAt: daysAgo(400) }),
    ];
    const result = computeKnowledgeStates(items, new Set(["algebra"]), NOW);
    const level = result.get("algebra")!.level;
    // recency = max(0.5^(400/45), 0.15) = 0.15 (natural decay is far below the floor).
    // diffW=1 -> g=0.15/item, Σg = 3*0.15 = 0.45 = N·RECENCY_FLOOR.
    const sumG = 3 * RECENCY_FLOOR;
    const expected = (sumG + K * P0) / (sumG + K);
    expect(level).toBeCloseTo(expected, 10);
    expect(level).toBeGreaterThan(P0);
  });
});

describe("computeKnowledgeStates: 🔴 red-team regression (recency floor + K=3 must not tank the band)", () => {
  it("10 old (120d) correct diff=3 + 1 fresh incorrect diff=5 stays amber (>=0.40), not red", () => {
    const items: KnowledgeItem[] = [
      ...Array.from({ length: 10 }, () =>
        item({ topic: "algebra", difficulty: 3, isCorrect: true, finishedAt: daysAgo(120) }),
      ),
      item({ topic: "algebra", difficulty: 5, isCorrect: false, finishedAt: daysAgo(0) }),
    ];
    const result = computeKnowledgeStates(items, new Set(["algebra"]), NOW);
    const level = result.get("algebra")!.level;

    // recency_old = max(0.5^(120/45), 0.15) = 0.1575; diffW_old = 1.5 -> g_old = 0.23625
    const recencyOld = Math.max(0.5 ** (120 / 45), RECENCY_FLOOR);
    expect(recencyOld).toBeCloseTo(0.1575, 3);
    const gOld = recencyOld * 1.5;
    const sumGOld = 10 * gOld;
    const sumGxOld = sumGOld; // all correct

    // fresh wrong: recency=1, diffW=2 -> g_new=2, x=0
    const gNew = 1 * 2;

    const expectedLevel = (sumGxOld + K * P0) / (sumGOld + gNew + K);
    expect(expectedLevel).toBeCloseTo(0.443, 2);

    expect(level).toBeCloseTo(expectedLevel, 10);
    expect(level).toBeGreaterThanOrEqual(BAND_WEAK);
    expect(level).toBeLessThan(BAND_STRONG);
  });
});

describe("computeKnowledgeStates: garbage tolerance", () => {
  it("clamps out-of-range difficulty into [1,5] instead of propagating it raw", () => {
    const overshoot: KnowledgeItem[] = [
      item({ topic: "algebra", difficulty: 10, finishedAt: daysAgo(0) }),
      item({ topic: "algebra", difficulty: 10, finishedAt: daysAgo(0) }),
      item({ topic: "algebra", difficulty: 10, finishedAt: daysAgo(0) }),
    ];
    const clamped: KnowledgeItem[] = [
      item({ topic: "algebra", difficulty: 5, finishedAt: daysAgo(0) }),
      item({ topic: "algebra", difficulty: 5, finishedAt: daysAgo(0) }),
      item({ topic: "algebra", difficulty: 5, finishedAt: daysAgo(0) }),
    ];
    const resultOvershoot = computeKnowledgeStates(overshoot, new Set(["algebra"]), NOW);
    const resultClamped = computeKnowledgeStates(clamped, new Set(["algebra"]), NOW);
    expect(resultOvershoot.get("algebra")!.level).toBeCloseTo(resultClamped.get("algebra")!.level, 10);
  });

  it("never lets NaN difficulty poison the level", () => {
    const items: KnowledgeItem[] = [
      item({ topic: "algebra", difficulty: Number.NaN, finishedAt: daysAgo(0) }),
      item({ topic: "algebra", difficulty: Number.NaN, finishedAt: daysAgo(0) }),
      item({ topic: "algebra", difficulty: Number.NaN, finishedAt: daysAgo(0) }),
    ];
    const result = computeKnowledgeStates(items, new Set(["algebra"]), NOW);
    expect(Number.isNaN(result.get("algebra")!.level)).toBe(false);
  });

  it("treats a future finishedAt as age 0 instead of a negative age boosting recency", () => {
    const future: KnowledgeItem[] = [
      item({ topic: "algebra", finishedAt: new Date(NOW.getTime() + 10 * MS_PER_DAY) }),
      item({ topic: "algebra", finishedAt: new Date(NOW.getTime() + 10 * MS_PER_DAY) }),
      item({ topic: "algebra", finishedAt: new Date(NOW.getTime() + 10 * MS_PER_DAY) }),
    ];
    const fresh: KnowledgeItem[] = [
      item({ topic: "algebra", finishedAt: NOW }),
      item({ topic: "algebra", finishedAt: NOW }),
      item({ topic: "algebra", finishedAt: NOW }),
    ];
    const resultFuture = computeKnowledgeStates(future, new Set(["algebra"]), NOW);
    const resultFresh = computeKnowledgeStates(fresh, new Set(["algebra"]), NOW);
    expect(resultFuture.get("algebra")!.level).toBeCloseTo(resultFresh.get("algebra")!.level, 10);
  });
});

describe("computeKnowledgeStates: idempotency", () => {
  it("calling twice with the same inputs yields the same result", () => {
    const items: KnowledgeItem[] = [
      item({ topic: "algebra", finishedAt: daysAgo(0) }),
      item({ topic: "algebra", finishedAt: daysAgo(5), isCorrect: false }),
      item({ topic: "algebra", finishedAt: daysAgo(10) }),
      item({ topic: "geometry", finishedAt: daysAgo(1) }),
      item({ topic: "geometry", finishedAt: daysAgo(2) }),
    ];
    const active = new Set(["algebra", "geometry"]);
    const first = computeKnowledgeStates(items, active, NOW);
    const second = computeKnowledgeStates(items, active, NOW);
    expect(Array.from(first.entries())).toEqual(Array.from(second.entries()));
  });
});

describe("computeKnowledgeStates: lastSeenAt", () => {
  it("tracks the most recent finishedAt among answered items for the topic", () => {
    const items: KnowledgeItem[] = [
      item({ topic: "algebra", finishedAt: daysAgo(10) }),
      item({ topic: "algebra", finishedAt: daysAgo(0) }),
      item({ topic: "algebra", finishedAt: daysAgo(5) }),
    ];
    const result = computeKnowledgeStates(items, new Set(["algebra"]), NOW);
    expect(result.get("algebra")!.lastSeenAt.getTime()).toBe(daysAgo(0).getTime());
  });
});

describe("isStale", () => {
  it("is not stale exactly at STALE_DAYS", () => {
    expect(STALE_DAYS).toBe(21);
    expect(isStale(daysAgo(21), NOW)).toBe(false);
  });

  it("is stale just past STALE_DAYS", () => {
    expect(isStale(daysAgo(22), NOW)).toBe(true);
  });

  it("is not stale well within the window", () => {
    expect(isStale(daysAgo(5), NOW)).toBe(false);
  });
});

describe("levelToBand: half-open boundaries", () => {
  it("0.75 is strong", () => {
    expect(levelToBand(0.75)).toBe("strong");
  });

  it("0.7499 is shaky (just below the strong boundary)", () => {
    expect(levelToBand(0.7499)).toBe("shaky");
  });

  it("0.40 is shaky (the weak boundary is exclusive)", () => {
    expect(levelToBand(0.4)).toBe("shaky");
  });

  it("0.3999 is weak (just below the weak boundary)", () => {
    expect(levelToBand(0.3999)).toBe("weak");
  });
});
