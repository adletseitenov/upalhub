// D5/Task9: единственный LLM-путь этапа 3 — кнопка «почему я ошибся» под
// ReviewList (level 1 разбора). Чистый модуль: только llm.complete + текстовая
// сборка промпта, ноль supabase-импортов (граница supabase/auth/лимитер живёт
// в роуте explain/route.ts). Схема ответа НАМЕРЕННО не требует hint (модель
// не всегда даёт короткую подсказку отдельно от полного объяснения) —
// адаптер llmFromRaw (src/lib/llm/provider.ts) ретраит один раз при провале
// schema.parse, так что explanation обязателен для полезного результата.
import { z } from "zod";
import type { Llm } from "@/lib/llm";
import type { TaskAnswer, TaskBody, TaskResponse } from "@/features/tasks/schema";

export const explainSchema = z.object({
  explanation: z.string().min(1),
  hint: z.string().optional(),
});
export type Explain = z.infer<typeof explainSchema>;

export type ExplainLocale = "ru" | "kk";

export type ExplainMistakeArgs = {
  locale: ExplainLocale;
  body: TaskBody;
  userResponse: TaskResponse | null;
  answer: TaskAnswer;
  explanation: string | null;
};

const NOT_ANSWERED: Record<ExplainLocale, string> = {
  ru: "(ученик не дал ответа)",
  kk: "(оқушы жауап бермеген)",
};

// Жёсткая языковая инструкция — намеренно написана на ЦЕЛЕВОМ языке ответа
// (не на русском для kk), чтобы первые токены генерации модели уже были
// смещены в нужный язык — известный приём для structured-output моделей,
// склонных «сваливаться» в доминирующий язык промпта иначе.
const LANGUAGE_DIRECTIVE: Record<ExplainLocale, string> = {
  ru: "Отвечай СТРОГО на русском языке — никаких вставок на других языках.",
  kk: "Тек қазақ тілінде жауап бер — жауапта басқа тіл болмасын.",
};

const SYSTEM_PROMPT: Record<ExplainLocale, string> = {
  ru: `Ты — доброжелательный репетитор. Ученик ошибся в задании теста, объясни ПОЧЕМУ его ответ неверный и почему верен правильный вариант — просто, по делу, без воды. Отвечай ТОЛЬКО валидным JSON без markdown и пояснений вне JSON. ${LANGUAGE_DIRECTIVE.ru}`,
  kk: `Сен — қайырымды репетитормын. Оқушы тест тапсырмасында қателесті, оның жауабы НЕГЕ дұрыс емес және дұрыс нұсқа НЕГЕ дұрыс екенін қарапайым әрі нақты түсіндір. Тек JSON форматында, markdown-сыз және JSON сыртында түсініктемесіз жауап бер. ${LANGUAGE_DIRECTIVE.kk}`,
};

function formatOptions(body: TaskBody): string {
  if (body.format === "single_choice" || body.format === "multi_choice") {
    return body.options.map((o) => `  - ${o.id}: ${o.text}`).join("\n");
  }
  return "";
}

function formatTaskBody(body: TaskBody): string {
  const lines: string[] = [];
  if (body.passage) lines.push(`Текст/транскрипт: ${body.passage}`);
  lines.push(`Вопрос: ${body.prompt}`);
  const options = formatOptions(body);
  if (options) lines.push(`Варианты ответа:\n${options}`);
  return lines.join("\n");
}

function formatUserResponse(
  body: TaskBody,
  response: TaskResponse | null,
  locale: ExplainLocale,
): string {
  if (!response) return NOT_ANSWERED[locale];
  if (body.format === "single_choice" && response.format === "single_choice") {
    if (response.optionId === null) return NOT_ANSWERED[locale];
    return body.options.find((o) => o.id === response.optionId)?.text ?? response.optionId;
  }
  if (body.format === "multi_choice" && response.format === "multi_choice") {
    if (response.optionIds.length === 0) return NOT_ANSWERED[locale];
    const ids = new Set(response.optionIds);
    return body.options
      .filter((o) => ids.has(o.id))
      .map((o) => o.text)
      .join(", ");
  }
  if (body.format === "text_input" && response.format === "text_input") {
    return response.value !== null && response.value.trim() !== "" ? response.value : NOT_ANSWERED[locale];
  }
  return NOT_ANSWERED[locale];
}

function formatCorrectAnswer(body: TaskBody, answer: TaskAnswer): string {
  if (body.format === "single_choice" && answer.format === "single_choice") {
    return body.options.find((o) => o.id === answer.correctOptionId)?.text ?? answer.correctOptionId;
  }
  if (body.format === "multi_choice" && answer.format === "multi_choice") {
    const ids = new Set(answer.correctOptionIds);
    return body.options
      .filter((o) => ids.has(o.id))
      .map((o) => o.text)
      .join(", ");
  }
  if (body.format === "text_input" && answer.format === "text_input") {
    return answer.accepted.join(" / ");
  }
  return ""; // defensive: body/answer format mismatch should never happen (validateTaskPair at write time)
}

function buildPrompt(args: ExplainMistakeArgs): string {
  const { body, userResponse, answer, explanation, locale } = args;
  const lines: string[] = [
    "Задание:",
    formatTaskBody(body),
    "",
    `Ответ ученика: ${formatUserResponse(body, userResponse, locale)}`,
    `Правильный ответ: ${formatCorrectAnswer(body, answer)}`,
  ];
  if (explanation) {
    lines.push(`Банковское объяснение (может быть неполным, используй как подсказку): ${explanation}`);
  }
  lines.push(
    "",
    "Верни JSON строго такой структуры:",
    '{ "explanation": "объяснение ошибки и правильного решения", "hint": "короткая подсказка-принцип на будущее (необязательно)" }',
    LANGUAGE_DIRECTIVE[locale],
  );
  return lines.join("\n");
}

export async function explainMistake(deps: { llm: Llm }, args: ExplainMistakeArgs): Promise<Explain> {
  return deps.llm.complete({
    system: SYSTEM_PROMPT[args.locale],
    prompt: buildPrompt(args),
    schema: explainSchema,
    maxTokens: 2_000,
  });
}
