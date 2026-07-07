import { describe, expect, it } from "vitest";
import { fakeLlm } from "@/lib/llm";
import { refineExamSpec } from "./refine";

const current = {
  examName: "ЕНТ",
  language: "kk",
  description: "Тест.",
  sections: [{ name: "Математика", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] }],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

describe("refineExamSpec", () => {
  it("returns refined spec validated by schema", async () => {
    const refined = { ...current, sections: [{ ...current.sections[0], taskCount: 15 }] };
    const llm = fakeLlm([refined]);
    const result = await refineExamSpec({ llm }, current, "Вариант: 15 заданий по математике...");
    expect(result.sections[0].taskCount).toBe(15);
  });
});
