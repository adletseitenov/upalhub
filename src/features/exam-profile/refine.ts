import type { Llm } from "@/lib/llm";
import { examProfileSpecSchema, type ExamProfileSpec } from "./spec";

export async function refineExamSpec(
  deps: { llm: Llm },
  current: ExamProfileSpec,
  sampleText: string,
): Promise<ExamProfileSpec> {
  return deps.llm.complete({
    system:
      "Ты уточняешь профиль экзамена по реальному примеру варианта. Отвечай ТОЛЬКО валидным JSON той же структуры, что и текущий профиль. Сохраняй всё верное, исправляй и дополняй по примеру. " +
      'Если пример явно показывает секцию аудирования (Listening и т.п.) — ставь у неё modality: "audio"; если секцию устной речи/говорения (Speaking и т.п.) — modality: "speaking" и, если из примера понятны критерии оценки, дополни speakingCriteria: [{key, label, maxPoints}]. Модальность остальных секций не трогай без явных оснований в примере.',
    prompt: `Текущий профиль экзамена (JSON):\n${JSON.stringify(current, null, 2)}\n\nРеальный пример варианта экзамена:\n${sampleText.slice(0, 20_000)}\n\nВерни уточнённый профиль той же JSON-структуры.`,
    schema: examProfileSpecSchema,
    // final-review Fix3: 8k резался на мега-спеках с длинными variants на
    // кириллице (тот же класс инцидента, что уже чинили для research/
    // generation) — модель обрезала JSON на полуслове и schema.parse падал.
    maxTokens: 24_000,
  });
}
