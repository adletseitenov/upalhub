// Чистый грейдер: НОЛЬ импортов llm/сети/supabase. Детерминированный, синхронный.
import type { TaskAnswer, TaskBody, TaskResponse } from "./schema";

function normalizeText(value: string, caseSensitive: boolean): string {
  const collapsed = value.trim().replace(/\s+/g, " ");
  return caseSensitive ? collapsed : collapsed.toLowerCase();
}

// Поддержка десятичной запятой ("3,14" === "3.14"). Только первую запятую меняем
// на точку — этого достаточно для одиночного десятичного разделителя.
//
// Backlog wave fix2: Number.parseFloat парсит ПРЕФИКС строки ("5abc" -> 5,
// "5." -> 5) — мусорный хвост молча отбрасывался, и заведомо неверный ответ
// вроде "5abc" грейдился как верный для number-задания. Строгий regex-гейт
// перед Number(...) требует, чтобы ВСЯ строка (после запятая->точка) была
// валидным числом — Number(normalized) сам по себе недостаточен (Number("")
// === 0, но это уже отсечено выше; Number(" 5 ") === 5 — trim уже снял
// пробелы), поэтому regex остаётся источником истины по форме.
const STRICT_NUMBER_RE = /^-?\d+(\.\d+)?$/;

function parseNumericInput(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (normalized === "") return null;
  if (!STRICT_NUMBER_RE.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isNaN(n) ? null : n;
}

function gradeTextInput(
  body: Extract<TaskBody, { format: "text_input" }>,
  answer: Extract<TaskAnswer, { format: "text_input" }>,
  value: string,
): boolean {
  if (body.inputKind === "number") {
    const given = parseNumericInput(value);
    if (given === null) return false;
    const tolerance = answer.tolerance ?? 0;
    // Небольшой эпсилон гасит бинарную неточность вроде |3.16-3.14| ->
    // 0.020000000000000018 при tolerance=0.02, не меняя семантику сравнения.
    const FLOAT_EPSILON = 1e-9;
    return answer.accepted.some((accepted) => {
      const target = parseNumericInput(accepted);
      if (target === null) return false;
      return Math.abs(given - target) <= tolerance + FLOAT_EPSILON;
    });
  }

  const normalizedGiven = normalizeText(value, answer.caseSensitive);
  return answer.accepted.some(
    (accepted) => normalizeText(accepted, answer.caseSensitive) === normalizedGiven,
  );
}

/**
 * gradeAnswer — чистая функция (D1). single_choice: точный id; multi_choice:
 * set-equality; text_input: нормализация + membership. null/mismatch -> false.
 */
export function gradeAnswer(body: TaskBody, answer: TaskAnswer, response: TaskResponse): boolean {
  if (body.format !== answer.format || body.format !== response.format) return false;

  switch (body.format) {
    case "single_choice": {
      if (answer.format !== "single_choice" || response.format !== "single_choice") return false;
      if (response.optionId === null) return false;
      return response.optionId === answer.correctOptionId;
    }
    case "multi_choice": {
      if (answer.format !== "multi_choice" || response.format !== "multi_choice") return false;
      const correct = new Set(answer.correctOptionIds);
      const given = new Set(response.optionIds);
      if (correct.size !== given.size) return false;
      for (const id of correct) {
        if (!given.has(id)) return false;
      }
      return true;
    }
    case "text_input": {
      if (answer.format !== "text_input" || response.format !== "text_input") return false;
      if (response.value === null) return false;
      return gradeTextInput(body, answer, response.value);
    }
  }
}
