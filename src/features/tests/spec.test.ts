import { describe, expect, it } from "vitest";
import { testSpecSchema } from "./spec";

const valid = {
  version: 1,
  kind: "diagnostic",
  language: "kk",
  sections: [{ name: "Математика", taskIds: ["t1", "t2"] }],
  taskIds: ["t1", "t2"],
  totalTimeMinutes: 90,
  scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

describe("testSpecSchema", () => {
  it("accepts a complete valid spec", () => {
    expect(testSpecSchema.parse(valid)).toMatchObject({ version: 1, kind: "diagnostic" });
  });

  it("accepts every kind literal", () => {
    for (const kind of ["diagnostic", "practice", "mock"]) {
      expect(testSpecSchema.parse({ ...valid, kind }).kind).toBe(kind);
    }
  });

  it("rejects an unknown kind", () => {
    expect(() => testSpecSchema.parse({ ...valid, kind: "final" })).toThrow();
  });

  it("rejects a version other than 1", () => {
    expect(() => testSpecSchema.parse({ ...valid, version: 2 })).toThrow();
  });

  it("allows totalTimeMinutes to be omitted or null", () => {
    const withoutTime: Record<string, unknown> = { ...valid };
    delete withoutTime.totalTimeMinutes;
    expect(testSpecSchema.parse(withoutTime).totalTimeMinutes).toBeUndefined();
    expect(testSpecSchema.parse({ ...valid, totalTimeMinutes: null }).totalTimeMinutes).toBeNull();
  });

  it("rejects a non-positive totalTimeMinutes", () => {
    expect(() => testSpecSchema.parse({ ...valid, totalTimeMinutes: 0 })).toThrow();
  });

  it("allows sections/taskIds to be empty arrays (tolerance, D3)", () => {
    const spec = testSpecSchema.parse({ ...valid, sections: [], taskIds: [] });
    expect(spec.sections).toEqual([]);
    expect(spec.taskIds).toEqual([]);
  });

  it("accepts a scoringSnapshot without optional passingScore/step (band exam)", () => {
    const spec = testSpecSchema.parse({
      ...valid,
      scoringSnapshot: { scaleMin: 0, scaleMax: 9, unit: "band" },
    });
    expect(spec.scoringSnapshot.passingScore).toBeUndefined();
    expect(spec.scoringSnapshot.step).toBeUndefined();
  });

  it("rejects a spec missing scoringSnapshot", () => {
    const withoutSnapshot: Record<string, unknown> = { ...valid };
    delete withoutSnapshot.scoringSnapshot;
    expect(() => testSpecSchema.parse(withoutSnapshot)).toThrow();
  });

  it("rejects a section without a name", () => {
    expect(() =>
      testSpecSchema.parse({ ...valid, sections: [{ name: "", taskIds: [] }] }),
    ).toThrow();
  });
});
