import { describe, expect, it } from "vitest";
import { fakeLlm, type Llm } from "@/lib/llm";
import { explainMistake, explainSchema } from "./explain";
import type { TaskAnswer, TaskBody, TaskResponse } from "@/features/tasks/schema";

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

const body: TaskBody = {
  format: "single_choice",
  prompt: "Сколько будет 2+2?",
  options: [
    { id: "a", text: "4" },
    { id: "b", text: "5" },
    { id: "c", text: "22" },
  ],
};

const answer: TaskAnswer = { format: "single_choice", correctOptionId: "a" };

const wrongResponse: TaskResponse = { format: "single_choice", optionId: "b" };

const validExplain = { explanation: "Сложение чисел даёт 4, а не 5.", hint: "Проверяй арифметику дважды." };

describe("explainMistake", () => {
  it("includes the task prompt and option texts in the prompt", async () => {
    const { llm, calls } = spyLlm(validExplain);
    await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: null },
    );
    expect(calls[0].prompt).toContain("Сколько будет 2+2?");
    expect(calls[0].prompt).toContain("4");
    expect(calls[0].prompt).toContain("5");
  });

  it("maps the student's optionId response to its option text (not the raw id)", async () => {
    const { llm, calls } = spyLlm(validExplain);
    await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: null },
    );
    expect(calls[0].prompt).toMatch(/Ответ ученика:.*5/);
  });

  it("includes the correct answer's option text", async () => {
    const { llm, calls } = spyLlm(validExplain);
    await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: null },
    );
    expect(calls[0].prompt).toMatch(/Правильный ответ:.*4/);
  });

  it("includes the bank explanation when provided", async () => {
    const { llm, calls } = spyLlm(validExplain);
    await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: "потому что арифметика" },
    );
    expect(calls[0].prompt).toContain("потому что арифметика");
  });

  it("omits any bank-explanation line when explanation is null", async () => {
    const { llm, calls } = spyLlm(validExplain);
    await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: null },
    );
    expect(calls[0].prompt).not.toContain("Банковское объяснение");
  });

  it("notes an unanswered response instead of crashing", async () => {
    const { llm, calls } = spyLlm(validExplain);
    const unanswered: TaskResponse = { format: "single_choice", optionId: null };
    await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: unanswered, answer, explanation: null },
    );
    expect(calls[0].prompt).toMatch(/Ответ ученика:.*не дал ответа/);
  });

  it("includes a hard language instruction to answer only in the given locale", async () => {
    const { llm, calls } = spyLlm(validExplain);
    await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: null },
    );
    const sent = `${calls[0].system ?? ""}\n${calls[0].prompt}`;
    expect(sent).toMatch(/русском/);
  });

  it("produces a different prompt (and system) for kk vs ru locale", async () => {
    const { llm: llmRu, calls: callsRu } = spyLlm(validExplain);
    const { llm: llmKk, calls: callsKk } = spyLlm(validExplain);
    await explainMistake(
      { llm: llmRu },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: null },
    );
    await explainMistake(
      { llm: llmKk },
      { locale: "kk", body, userResponse: wrongResponse, answer, explanation: null },
    );
    expect(callsRu[0].prompt).not.toBe(callsKk[0].prompt);
    expect(callsRu[0].system).not.toBe(callsKk[0].system);
    expect(callsKk[0].system).toMatch(/қазақ/);
  });

  it("requests completion with maxTokens 2000 and the explainSchema", async () => {
    const { llm, calls } = spyLlm(validExplain);
    await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: null },
    );
    expect(calls[0].maxTokens).toBe(2_000);
  });

  it("parses a valid fakeLlm response into {explanation, hint}", async () => {
    const llm = fakeLlm([validExplain]);
    const result = await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: null },
    );
    expect(result).toEqual(validExplain);
  });

  it("accepts a response without hint (hint is optional)", async () => {
    const llm = fakeLlm([{ explanation: "просто объяснение" }]);
    const result = await explainMistake(
      { llm },
      { locale: "ru", body, userResponse: wrongResponse, answer, explanation: null },
    );
    expect(result).toEqual({ explanation: "просто объяснение" });
  });

  it("rejects a response missing explanation via explainSchema", () => {
    expect(() => explainSchema.parse({ hint: "только подсказка" })).toThrow();
  });
});
