import type { Llm } from "@/lib/llm";
import { examProfileSpecSchema, type ExamProfileSpec } from "./spec";

export async function refineExamSpec(
  deps: { llm: Llm },
  current: ExamProfileSpec,
  sampleText: string,
): Promise<ExamProfileSpec> {
  return deps.llm.complete({
    system:
      "Ты уточняешь профиль экзамена по реальному примеру варианта. Отвечай ТОЛЬКО валидным JSON той же структуры, что и текущий профиль. Сохраняй всё верное, исправляй и дополняй по примеру.",
    prompt: `Текущий профиль экзамена (JSON):\n${JSON.stringify(current, null, 2)}\n\nРеальный пример варианта экзамена:\n${sampleText.slice(0, 20_000)}\n\nВерни уточнённый профиль той же JSON-структуры.`,
    schema: examProfileSpecSchema,
    // final-review Fix3: 8k резался на мега-спеках с длинными variants на
    // кириллице (тот же класс инцидента, что уже чинили для research/
    // generation) — модель обрезала JSON на полуслове и schema.parse падал.
    maxTokens: 24_000,
  });
}
