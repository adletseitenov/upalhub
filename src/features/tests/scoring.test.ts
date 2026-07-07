import { describe, expect, it } from "vitest";
import { scaleScore, scoringSnapshotSchema } from "./scoring";

describe("scoringSnapshotSchema", () => {
  it("accepts a full snapshot with step", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 140,
      unit: "баллы",
      passingScore: 70,
      step: 1,
    });
    expect(snap.step).toBe(1);
  });

  it("accepts a snapshot without optional passingScore/step", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 9,
      unit: "band",
    });
    expect(snap.passingScore).toBeUndefined();
    expect(snap.step).toBeUndefined();
  });
});

describe("scaleScore fixtures (D5)", () => {
  it("ENT-style {0,140,'баллы'}: 14/20 -> 98", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 140,
      unit: "баллы",
    });
    expect(scaleScore(14, 20, snap)).toBe(98);
  });

  it("IELTS-style {0,9,'band'}: 15/20 -> 6.5", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 9,
      unit: "band",
    });
    expect(scaleScore(15, 20, snap)).toBe(6.5);
  });
});

describe("scaleScore edge behavior", () => {
  it("total === 0 returns scaleMin", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 140,
      unit: "баллы",
    });
    expect(scaleScore(0, 0, snap)).toBe(0);
  });

  it("all-correct returns scaleMax (points scale)", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 140,
      unit: "баллы",
    });
    expect(scaleScore(20, 20, snap)).toBe(140);
  });

  it("all-correct returns scaleMax (band scale)", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 9,
      unit: "band",
    });
    expect(scaleScore(20, 20, snap)).toBe(9);
  });

  it("all-unanswered (raw=0) returns scaleMin", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 140,
      unit: "баллы",
    });
    expect(scaleScore(0, 20, snap)).toBe(0);
  });

  it("all-unanswered (raw=0) returns scaleMin (band scale)", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 9,
      unit: "band",
    });
    expect(scaleScore(0, 20, snap)).toBe(0);
  });

  it("clamps a result that would otherwise exceed scaleMax", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 140,
      unit: "баллы",
    });
    // raw > total is a defensive/pathological input; clamp must still hold.
    expect(scaleScore(21, 20, snap)).toBe(140);
  });

  it("clamps a result that would otherwise fall below scaleMin", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 140,
      unit: "баллы",
    });
    expect(scaleScore(-5, 20, snap)).toBe(0);
  });

  it("respects an explicit step override instead of the unit-based default", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 100,
      unit: "баллы",
      step: 5,
    });
    // 33/40 -> linear 82.5 -> nearest multiple of 5 (round-half-down) -> 80
    expect(scaleScore(33, 40, snap)).toBe(80);
  });

  it("defaults step to 1 for non-band units", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 140,
      unit: "баллы",
    });
    const result = scaleScore(13, 20, snap);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("defaults step to 0.5 for band units", () => {
    const snap = scoringSnapshotSchema.parse({
      scaleMin: 0,
      scaleMax: 9,
      unit: "band",
    });
    const result = scaleScore(13, 20, snap);
    // must be a multiple of 0.5
    expect(Math.round(result * 2)).toBe(result * 2);
  });
});
