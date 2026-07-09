// D1 (Stage 5, Task 2): зеркало src/features/review/explain.ts — единственный
// LLM-путь интервью-гибрида. ≤2 открытых вопроса анализируются РОВНО одним
// llm.complete, только если хотя бы один реально непуст; оба пустые/undefined
// -> ноль LLM-вызовов (кнопочные поля уже дают полноценный approach без
// этого шага). Чистый модуль: только llm.complete + текстовая сборка
// промпта, ноль supabase/сеть/лимитер-импортов (граница auth/лимитер живёт
// в src/app/api/interview/route.ts, тот же паттерн, что и explain/route.ts
// относительно explain.ts).
import { z } from "zod";
import type { Llm } from "@/lib/llm";
import { APPROACH_TONES, type InterviewButtons, type StudentApproach } from "./approach";

export type InterviewLocale = "ru" | "kk";

const analyzeResultSchema = z.object({
  concerns: z.array(z.string()).max(3),
  tone: z.enum(APPROACH_TONES),
  summary: z.string(),
});

export type AnalyzeResult = Pick<StudentApproach, "concerns" | "tone" | "summary">;

export type OpenAnswers = { concern?: string; motivation?: string };

export type AnalyzeOpenAnswersArgs = {
  locale: InterviewLocale;
  // Имена активных секций экзамена — контекст для модели (не только
  // выбранные учеником "слабые" секции, а весь набор, чтобы резюме было
  // осмысленным даже когда weakSections пуст).
  sections: string[];
  buttons: InterviewButtons;
  openAnswers: OpenAnswers;
};

// Тот же приём, что и в explain.ts: жёсткая языковая инструкция написана на
// ЦЕЛЕВОМ языке ответа, чтобы первые токены генерации уже были смещены в
// нужный язык.
const LANGUAGE_DIRECTIVE: Record<InterviewLocale, string> = {
  ru: "Отвечай СТРОГО на русском языке — никаких вставок на других языках.",
  kk: "Тек қазақ тілінде жауап бер — жауапта басқа тіл болмасын.",
};

const SYSTEM_PROMPT: Record<InterviewLocale, string> = {
  ru: `Ты — доброжелательный образовательный консультант. По ответам ученика на интервью перед подготовкой к экзамену определи его главные опасения (concerns, до 3 коротких пунктов) и эмоциональный тон (tone), дай короткое резюме (summary, 1-2 предложения) для персонализации подготовки. Отвечай ТОЛЬКО валидным JSON без markdown и пояснений вне JSON. ${LANGUAGE_DIRECTIVE.ru}`,
  kk: `Сен — қайырымды білім беру кеңесшісісің. Оқушының емтиханға дайындық алдындағы сұхбат жауаптары бойынша оның басты алаңдаушылықтарын (concerns, 3-ке дейін қысқа тармақ) және эмоционалды тонын (tone) анықта, дайындықты жекелендіру үшін қысқа қорытынды (summary, 1-2 сөйлем) жаз. Тек JSON форматында, markdown-сыз және JSON сыртында түсініктемесіз жауап бер. ${LANGUAGE_DIRECTIVE.kk}`,
};

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function buildPrompt(args: AnalyzeOpenAnswersArgs): string {
  const lines: string[] = [];
  lines.push(`Самооценка уровня: ${args.buttons.level}`);
  lines.push(`Часов в неделю на подготовку: ${args.buttons.hoursPerWeek}`);
  if (args.sections.length > 0) {
    lines.push(`Разделы экзамена: ${args.sections.join(", ")}`);
  }
  if (args.buttons.weakSections.length > 0) {
    lines.push(`Слабые разделы (выбраны учеником): ${args.buttons.weakSections.join(", ")}`);
  }
  if (!isBlank(args.openAnswers.concern)) {
    lines.push(`Что не получалось раньше / чего боится: ${args.openAnswers.concern}`);
  }
  if (!isBlank(args.openAnswers.motivation)) {
    lines.push(`Зачем ученику этот экзамен: ${args.openAnswers.motivation}`);
  }
  lines.push(
    "",
    "Верни JSON строго такой структуры:",
    '{ "concerns": ["до 3 коротких пунктов опасений"], "tone": "reassuring|neutral|challenging", "summary": "1-2 предложения резюме для персонализации подготовки" }',
    LANGUAGE_DIRECTIVE[args.locale],
  );
  return lines.join("\n");
}

/**
 * analyzeOpenAnswers — D1: оба openAnswers пусты/undefined -> null БЕЗ
 * вызова LLM (кнопочный derive уже покрыл всё, что можно детерминированно).
 * Иначе — ровно один llm.complete с zod-схемой {concerns, tone, summary}.
 */
export async function analyzeOpenAnswers(
  deps: { llm: Llm },
  args: AnalyzeOpenAnswersArgs,
): Promise<AnalyzeResult | null> {
  if (isBlank(args.openAnswers.concern) && isBlank(args.openAnswers.motivation)) {
    return null;
  }
  return deps.llm.complete({
    system: SYSTEM_PROMPT[args.locale],
    prompt: buildPrompt(args),
    schema: analyzeResultSchema,
    maxTokens: 1_000,
  });
}
