// D5/Task7: чистый view-model builder для ReviewList — ноль supabase/llm
// импортов. Единственный вызывающий — src/app/(app)/hq/[hqId]/tests/[testId]/
// page.tsx, и ТОЛЬКО когда attempt.finished_at != null (инвариант (а) из
// брифа: "при открытой попытке builder вообще не вызывается" — это
// СТРАНИЧНАЯ логика, page.tsx оборачивает весь блок чтения+сборки в
// `if (attemptRow && attemptRow.finished_at !== null)`, buildReviewViewModel
// физически не получает данных для открытой попытки и не вызывается вовсе;
// здесь это не тестируется юнит-тестом этого модуля — задокументировано тут
// и в комментарии над вызовом в page.tsx).
import type { TaskAnswer, TaskBody, TaskResponse } from "@/features/tasks/schema";
import { taskResponseSchema } from "@/features/tasks/schema";
import type { SimilarTaskRow } from "./similar";

export type ReviewTask = {
  id: string;
  type: string;
  topic: string;
  body: TaskBody;
  answer: TaskAnswer;
  explanation: string;
};

export type ReviewAttemptItem = {
  taskId: string;
  response: unknown;
  isCorrect: boolean | null;
};

export type AnswerView =
  | { kind: "full"; correctLabel: string; explanation: string }
  | { kind: "locked" };

export type SimilarView = { id: string; body: TaskBody };

export type ReviewViewItem =
  | { taskId: string; orderIndex: number; kind: "unavailable"; correct: false }
  | {
      taskId: string;
      orderIndex: number;
      kind: "available";
      correct: boolean;
      body: TaskBody;
      userResponse: TaskResponse | null;
      answerView: AnswerView;
      audio: { passage: string; lang: string } | null;
      similar: SimilarView[];
    };

export function bucketKey(type: string, topic: string): string {
  return `${type}::${topic}`;
}

function isAnsweredResponse(response: TaskResponse): boolean {
  switch (response.format) {
    case "single_choice":
      return response.optionId !== null;
    case "multi_choice":
      return response.optionIds.length > 0;
    case "text_input":
      return response.value !== null && response.value.trim() !== "";
  }
}

// Правильный ответ -> человекочитаемая строка. Единственное место, где
// TaskAnswer вообще разворачивается в текст — ReviewList эту функцию не
// вызывает и объекта TaskAnswer никогда не видит, только готовую строку.
function formatCorrectLabel(body: TaskBody, answer: TaskAnswer): string {
  if (body.format === "single_choice" && answer.format === "single_choice") {
    return body.options.find((o) => o.id === answer.correctOptionId)?.text ?? "";
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

export type BuildReviewViewModelArgs = {
  /** Канонический порядок — spec.taskIds замороженной сборки теста. */
  taskIds: string[];
  items: ReviewAttemptItem[];
  /**
   * ПОЛНЫЕ строки заданий (id/type/topic/body/answer/explanation),
   * загруженные через supabaseAdmin ПОСЛЕ проверки ownership выше по
   * странице. Присутствие в этой карте не означает, что answer/explanation
   * дойдут до ReviewList — это решает openTaskIds ниже.
   */
  tasksById: Map<string, ReviewTask>;
  /**
   * 🔴 Кросс-попыточный гейт (D5): id заданий, входящих в ЛЮБУЮ ДРУГУЮ
   * незавершённую попытку этого юзера. Для них answerView всегда 'locked' —
   * answer/explanation НЕ попадают в возвращаемый объект ни в каком виде.
   */
  openTaskIds: Set<string>;
  /** id заданий из audio-секций (spec.sections[].modality === 'audio'). */
  audioTaskIds: Set<string>;
  /** Язык транскрипта аудио (testSpec.language). */
  language: string;
  /** Плоский капнутый результат loadSimilarTasks — группируется здесь по (type,topic). */
  similarRows: SimilarTaskRow[];
};

/**
 * buildReviewViewModel — чистая сборка view-model для ReviewList (D5).
 * Порядок вывода = порядок taskIds (канонический, из spec). Похожие задания
 * группируются по (type,topic) самого задания и показываются ТОЛЬКО для
 * ошибок (D2: "по умолчанию только ошибки" — верным заданиям практиковать
 * нечего, similar всегда [] для correct===true).
 */
export function buildReviewViewModel(args: BuildReviewViewModelArgs): ReviewViewItem[] {
  const itemByTaskId = new Map(args.items.map((item) => [item.taskId, item]));

  const similarByBucket = new Map<string, SimilarTaskRow[]>();
  for (const row of args.similarRows) {
    const key = bucketKey(row.type, row.topic);
    const group = similarByBucket.get(key);
    if (group) group.push(row);
    else similarByBucket.set(key, [row]);
  }

  return args.taskIds.map((taskId, index) => {
    const task = args.tasksById.get(taskId);
    if (!task) {
      // Деградация: задание удалено из банка после сдачи (или сборка
      // легаси-попытки ссылалась на уже несуществующий id) — is_correct для
      // такого taskId submitAttempt всегда пишет false, так что это всегда
      // технически "ошибка" (учитывается при фильтре "только ошибки").
      return { taskId, orderIndex: index, kind: "unavailable", correct: false };
    }

    const item = itemByTaskId.get(taskId);
    const correct = item?.isCorrect === true;

    const responseParsed = taskResponseSchema.safeParse(item?.response ?? null);
    const userResponse =
      responseParsed.success && isAnsweredResponse(responseParsed.data) ? responseParsed.data : null;

    const locked = args.openTaskIds.has(taskId);
    const answerView: AnswerView = locked
      ? { kind: "locked" }
      : {
          kind: "full",
          correctLabel: formatCorrectLabel(task.body, task.answer),
          explanation: task.explanation,
        };

    const audio =
      task.body.passage != null && args.audioTaskIds.has(taskId)
        ? { passage: task.body.passage, lang: args.language }
        : null;

    const similar = correct
      ? []
      : (similarByBucket.get(bucketKey(task.type, task.topic)) ?? []).map(
          (row): SimilarView => ({ id: row.id, body: row.body }),
        );

    return {
      taskId,
      orderIndex: index,
      kind: "available",
      correct,
      body: task.body,
      userResponse,
      answerView,
      audio,
      similar,
    };
  });
}
