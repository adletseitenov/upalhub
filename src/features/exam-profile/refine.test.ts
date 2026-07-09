import { describe, expect, it } from "vitest";
import { fakeLlm, type Llm } from "@/lib/llm";
import { refineExamSpec } from "./refine";

// Mirrors research.test.ts's spyLlm helper — captures system/prompt sent to
// the model without asserting on maxTokens (refine has none).
type RecordedCall = { system?: string; prompt: string };
function spyLlm(response: unknown): { llm: Llm; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const llm: Llm = {
    async complete(args) {
      calls.push({ system: args.system, prompt: args.prompt });
      return args.schema.parse(response);
    },
  };
  return { llm, calls };
}

const current = {
  examName: "ЕНТ",
  language: "kk",
  description: "Тест.",
  sections: [{ name: "Математика", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] }],
  variants: [],
  selectionGroups: [],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

describe("refineExamSpec", () => {
  it("returns refined spec validated by schema", async () => {
    const refined = { ...current, sections: [{ ...current.sections[0], taskCount: 15 }] };
    const llm = fakeLlm([refined]);
    const result = await refineExamSpec({ llm }, current, "Вариант: 15 заданий по математике...");
    expect(result.sections[0].taskCount).toBe(15);
  });

  // D6 (Stage5 Task1): refine's SYSTEM_PROMPT must teach the model to emit
  // modality (incl. "speaking") the same way research.ts does, mirroring T3
  // of stage 2.5's audio instruction.
  it("instructs the model about audio/speaking modality and speakingCriteria", async () => {
    const { llm, calls } = spyLlm(current);
    await refineExamSpec({ llm }, current, "Вариант: секция Speaking...");
    const sent = `${calls[0].system ?? ""}\n${calls[0].prompt}`;
    expect(sent).toMatch(/audio/);
    expect(sent).toMatch(/speaking/);
    expect(sent).toMatch(/speakingCriteria/);
  });

  it("accepts a refined spec with a speaking section and speakingCriteria", async () => {
    const refined = {
      ...current,
      sections: [
        ...current.sections,
        {
          name: "Speaking",
          taskCount: null,
          timeLimitMinutes: null,
          taskTypes: [],
          topics: [],
          modality: "speaking",
          speakingCriteria: [{ key: "fluency", label: "Беглость", maxPoints: 5 }],
        },
      ],
    };
    const llm = fakeLlm([refined]);
    const result = await refineExamSpec({ llm }, current, "Вариант: секция Speaking...");
    const speaking = result.sections.find((s) => s.name === "Speaking");
    expect(speaking?.modality).toBe("speaking");
    expect(speaking?.speakingCriteria).toEqual([{ key: "fluency", label: "Беглость", maxPoints: 5 }]);
  });
});
