import { describe, expect, it } from "vitest";
import { fakeLlm, type Llm } from "@/lib/llm";
import { analyzeOpenAnswers } from "./analyze";
import type { InterviewButtons } from "./approach";

type RecordedCall = { system?: string; prompt: string; maxTokens?: number };

function spyLlm(response: unknown): { llm: Llm; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const llm: Llm = {
    async complete(args) {
      calls.push({ system: args.system, prompt: args.prompt, maxTokens: args.maxTokens });
      return args.schema.parse(response);
    },
  };
  return { llm, calls };
}

const buttons: InterviewButtons = {
  level: "beginner",
  hoursPerWeek: "3-6",
  weakSections: ["Математика"],
  explanationStyle: "concise",
};

const validAnalyzed = {
  concerns: ["боюсь устной части"],
  tone: "reassuring",
  summary: "нервничает перед устной частью",
};

describe("analyzeOpenAnswers (D1, зеркало explain.ts)", () => {
  it("оба openAnswers отсутствуют -> null БЕЗ вызова llm", async () => {
    const { llm, calls } = spyLlm(validAnalyzed);
    const result = await analyzeOpenAnswers(
      { llm },
      { locale: "ru", sections: ["Математика"], buttons, openAnswers: {} },
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("оба openAnswers — пустые/пробельные строки -> null БЕЗ вызова llm", async () => {
    const { llm, calls } = spyLlm(validAnalyzed);
    const result = await analyzeOpenAnswers(
      { llm },
      { locale: "ru", sections: [], buttons, openAnswers: { concern: "   ", motivation: "" } },
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("concern непуст (motivation отсутствует) -> вызывает llm ровно один раз", async () => {
    const { llm, calls } = spyLlm(validAnalyzed);
    const result = await analyzeOpenAnswers(
      { llm },
      { locale: "ru", sections: [], buttons, openAnswers: { concern: "боюсь устной части" } },
    );
    expect(calls).toHaveLength(1);
    expect(result).toEqual(validAnalyzed);
  });

  it("motivation непуст (concern отсутствует) -> вызывает llm ровно один раз", async () => {
    const { llm, calls } = spyLlm(validAnalyzed);
    await analyzeOpenAnswers(
      { llm },
      { locale: "ru", sections: [], buttons, openAnswers: { motivation: "поступление" } },
    );
    expect(calls).toHaveLength(1);
  });

  it("включает открытые ответы в промпт", async () => {
    const { llm, calls } = spyLlm(validAnalyzed);
    await analyzeOpenAnswers(
      { llm },
      {
        locale: "ru",
        sections: [],
        buttons,
        openAnswers: { concern: "боюсь устной части", motivation: "поступление в вуз" },
      },
    );
    expect(calls[0].prompt).toContain("боюсь устной части");
    expect(calls[0].prompt).toContain("поступление в вуз");
  });

  it("включает слабые секции и весь список секций в промпт", async () => {
    const { llm, calls } = spyLlm(validAnalyzed);
    await analyzeOpenAnswers(
      { llm },
      { locale: "ru", sections: ["Математика", "Физика"], buttons, openAnswers: { concern: "x" } },
    );
    expect(calls[0].prompt).toContain("Математика, Физика");
  });

  it("разный system prompt для ru и kk", async () => {
    const { llm: llmRu, calls: callsRu } = spyLlm(validAnalyzed);
    const { llm: llmKk, calls: callsKk } = spyLlm(validAnalyzed);
    await analyzeOpenAnswers({ llm: llmRu }, { locale: "ru", sections: [], buttons, openAnswers: { concern: "x" } });
    await analyzeOpenAnswers({ llm: llmKk }, { locale: "kk", sections: [], buttons, openAnswers: { concern: "x" } });
    expect(callsRu[0].system).not.toBe(callsKk[0].system);
    expect(callsRu[0].prompt).not.toBe(callsKk[0].prompt);
    expect(callsKk[0].system).toMatch(/қазақ/);
  });

  it("запрашивает completion с maxTokens 1000", async () => {
    const { llm, calls } = spyLlm(validAnalyzed);
    await analyzeOpenAnswers({ llm }, { locale: "ru", sections: [], buttons, openAnswers: { concern: "x" } });
    expect(calls[0].maxTokens).toBe(1_000);
  });

  it("парсит валидный fakeLlm-ответ в {concerns, tone, summary}", async () => {
    const llm = fakeLlm([validAnalyzed]);
    const result = await analyzeOpenAnswers(
      { llm },
      { locale: "ru", sections: [], buttons, openAnswers: { concern: "x" } },
    );
    expect(result).toEqual(validAnalyzed);
  });

  it("бросает при невалидном ответе (concerns длиннее max(3))", async () => {
    const llm = fakeLlm([{ concerns: ["a", "b", "c", "d"], tone: "neutral", summary: "s" }]);
    await expect(
      analyzeOpenAnswers({ llm }, { locale: "ru", sections: [], buttons, openAnswers: { concern: "x" } }),
    ).rejects.toThrow();
  });

  it("бросает при невалидном tone", async () => {
    const llm = fakeLlm([{ concerns: [], tone: "furious", summary: "s" }]);
    await expect(
      analyzeOpenAnswers({ llm }, { locale: "ru", sections: [], buttons, openAnswers: { concern: "x" } }),
    ).rejects.toThrow();
  });
});
