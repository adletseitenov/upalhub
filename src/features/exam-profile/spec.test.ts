import { describe, expect, it } from "vitest";
import { examProfileSpecSchema, sourceRefSchema } from "./spec";

const valid = {
  examName: "IELTS Academic",
  language: "en",
  country: "международный",
  description: "Международный экзамен по английскому языку.",
  sections: [
    {
      name: "Listening",
      taskCount: 40,
      timeLimitMinutes: 30,
      taskTypes: ["multiple choice", "matching"],
      topics: ["everyday conversations", "academic lectures"],
    },
  ],
  scoring: { scaleMin: 0, scaleMax: 9, passingScore: null, unit: "band" },
  totalTimeMinutes: 165,
  typicalDates: "круглый год",
};

describe("examProfileSpecSchema", () => {
  it("accepts a complete valid spec", () => {
    expect(examProfileSpecSchema.parse(valid)).toMatchObject({ examName: "IELTS Academic" });
  });
  it("defaults missing taskTypes/topics to empty arrays", () => {
    const spec = examProfileSpecSchema.parse({
      ...valid,
      sections: [{ name: "Writing" }],
    });
    expect(spec.sections[0].taskTypes).toEqual([]);
    expect(spec.sections[0].topics).toEqual([]);
  });
  it("rejects spec without sections", () => {
    expect(() => examProfileSpecSchema.parse({ ...valid, sections: [] })).toThrow();
  });
  it("rejects spec without scoring unit", () => {
    expect(() =>
      examProfileSpecSchema.parse({ ...valid, scoring: { scaleMin: 0, scaleMax: 9 } }),
    ).toThrow();
  });
  it("rejects non-http(s) source urls", () => {
    expect(() => sourceRefSchema.parse({ url: "javascript:alert(1)", title: "x" })).toThrow();
    expect(sourceRefSchema.parse({ url: "https://a.example", title: "x" }).url).toBe(
      "https://a.example",
    );
  });
});
