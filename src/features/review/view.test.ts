import { describe, expect, it } from "vitest";
import type { TaskAnswer, TaskBody } from "@/features/tasks/schema";
import type { SimilarTaskRow } from "./similar";
import { buildReviewViewModel } from "./view";
import type { ReviewTask } from "./view";

function singleChoiceBody(prompt: string, passage: string | null = null): TaskBody {
  return {
    format: "single_choice",
    prompt,
    passage,
    options: [
      { id: "a", text: "Option A" },
      { id: "b", text: "Option B" },
    ],
  };
}

function singleChoiceAnswer(correctOptionId: string): TaskAnswer {
  return { format: "single_choice", correctOptionId };
}

function task(overrides: Partial<ReviewTask> & Pick<ReviewTask, "id">): ReviewTask {
  return {
    id: overrides.id,
    type: overrides.type ?? "grammar",
    topic: overrides.topic ?? "verbs",
    body: overrides.body ?? singleChoiceBody(`prompt-${overrides.id}`),
    answer: overrides.answer ?? singleChoiceAnswer("a"),
    explanation: overrides.explanation ?? "because grammar",
  };
}

describe("buildReviewViewModel", () => {
  it("orders items by the canonical taskIds order, not item/task insertion order", () => {
    const t1 = task({ id: "task-1" });
    const t2 = task({ id: "task-2" });
    const tasksById = new Map([
      ["task-2", t2],
      ["task-1", t1],
    ]);
    const result = buildReviewViewModel({
      taskIds: ["task-1", "task-2"],
      items: [
        { taskId: "task-2", response: { format: "single_choice", optionId: "a" }, isCorrect: true },
        { taskId: "task-1", response: { format: "single_choice", optionId: "a" }, isCorrect: true },
      ],
      tasksById,
      openTaskIds: new Set(),
      audioTaskIds: new Set(),
      language: "ru",
      similarRows: [],
    });
    expect(result.map((r) => r.taskId)).toEqual(["task-1", "task-2"]);
    expect(result.map((r) => r.orderIndex)).toEqual([0, 1]);
  });

  it("degrades to kind='unavailable', correct=false when the task is missing from the bank", () => {
    const result = buildReviewViewModel({
      taskIds: ["ghost-task"],
      items: [{ taskId: "ghost-task", response: null, isCorrect: false }],
      tasksById: new Map(),
      openTaskIds: new Set(),
      audioTaskIds: new Set(),
      language: "ru",
      similarRows: [],
    });
    expect(result).toEqual([{ taskId: "ghost-task", orderIndex: 0, kind: "unavailable", correct: false }]);
  });

  it("marks an unanswered item (response=null) with userResponse=null while answerView stays full for a correct-task lookup", () => {
    const t = task({ id: "task-1" });
    const result = buildReviewViewModel({
      taskIds: ["task-1"],
      items: [{ taskId: "task-1", response: null, isCorrect: false }],
      tasksById: new Map([["task-1", t]]),
      openTaskIds: new Set(),
      audioTaskIds: new Set(),
      language: "ru",
      similarRows: [],
    });
    const item = result[0];
    expect(item.kind).toBe("available");
    if (item.kind !== "available") throw new Error("unreachable");
    expect(item.userResponse).toBeNull();
    expect(item.correct).toBe(false);
    expect(item.answerView).toEqual({ kind: "full", correctLabel: "Option A", explanation: "because grammar" });
  });

  it("computes correctLabel for single_choice/multi_choice/text_input formats", () => {
    const single = task({
      id: "s1",
      body: singleChoiceBody("q1"),
      answer: singleChoiceAnswer("b"),
    });
    const multiBody: TaskBody = {
      format: "multi_choice",
      prompt: "q2",
      passage: null,
      options: [
        { id: "a", text: "Alpha" },
        { id: "b", text: "Beta" },
        { id: "c", text: "Gamma" },
      ],
    };
    const multi = task({
      id: "m1",
      body: multiBody,
      answer: { format: "multi_choice", correctOptionIds: ["a", "c"] },
    });
    const textBody: TaskBody = { format: "text_input", prompt: "q3", passage: null, inputKind: "string" };
    const text = task({
      id: "x1",
      body: textBody,
      answer: { format: "text_input", accepted: ["paris", "Paris"], caseSensitive: false },
    });

    const result = buildReviewViewModel({
      taskIds: ["s1", "m1", "x1"],
      items: [
        { taskId: "s1", response: { format: "single_choice", optionId: "a" }, isCorrect: false },
        { taskId: "m1", response: { format: "multi_choice", optionIds: ["a"] }, isCorrect: false },
        { taskId: "x1", response: { format: "text_input", value: "lyon" }, isCorrect: false },
      ],
      tasksById: new Map([
        ["s1", single],
        ["m1", multi],
        ["x1", text],
      ]),
      openTaskIds: new Set(),
      audioTaskIds: new Set(),
      language: "ru",
      similarRows: [],
    });

    const labels = result.map((r) => (r.kind === "available" ? r.answerView : null));
    expect(labels[0]).toEqual({ kind: "full", correctLabel: "Option B", explanation: "because grammar" });
    expect(labels[1]).toEqual({ kind: "full", correctLabel: "Alpha, Gamma", explanation: "because grammar" });
    expect(labels[2]).toEqual({ kind: "full", correctLabel: "paris / Paris", explanation: "because grammar" });
  });

  it("wires audio only for tasks in audioTaskIds with a non-null passage", () => {
    const audioTask = task({ id: "a1", body: singleChoiceBody("listen", "the transcript") });
    const textTask = task({ id: "t1", body: singleChoiceBody("no audio", "a plain passage") });
    const result = buildReviewViewModel({
      taskIds: ["a1", "t1"],
      items: [
        { taskId: "a1", response: { format: "single_choice", optionId: "a" }, isCorrect: true },
        { taskId: "t1", response: { format: "single_choice", optionId: "a" }, isCorrect: true },
      ],
      tasksById: new Map([
        ["a1", audioTask],
        ["t1", textTask],
      ]),
      openTaskIds: new Set(),
      audioTaskIds: new Set(["a1"]),
      language: "kk",
      similarRows: [],
    });
    const a1 = result.find((r) => r.taskId === "a1");
    const t1 = result.find((r) => r.taskId === "t1");
    expect(a1?.kind === "available" && a1.audio).toEqual({ passage: "the transcript", lang: "kk" });
    expect(t1?.kind === "available" && t1.audio).toBeNull();
  });

  it("attaches similar tasks (grouped by type/topic) only to incorrect items, never to correct ones", () => {
    const wrong = task({ id: "w1", type: "grammar", topic: "verbs" });
    const right = task({ id: "r1", type: "grammar", topic: "verbs" });
    const similarRows: SimilarTaskRow[] = [
      { id: "sim-1", type: "grammar", topic: "verbs", body: singleChoiceBody("sim1") },
      { id: "sim-2", type: "grammar", topic: "verbs", body: singleChoiceBody("sim2") },
    ];
    const result = buildReviewViewModel({
      taskIds: ["w1", "r1"],
      items: [
        { taskId: "w1", response: { format: "single_choice", optionId: "b" }, isCorrect: false },
        { taskId: "r1", response: { format: "single_choice", optionId: "a" }, isCorrect: true },
      ],
      tasksById: new Map([
        ["w1", wrong],
        ["r1", right],
      ]),
      openTaskIds: new Set(),
      audioTaskIds: new Set(),
      language: "ru",
      similarRows,
    });
    const w1 = result.find((r) => r.taskId === "w1");
    const r1 = result.find((r) => r.taskId === "r1");
    expect(w1?.kind === "available" && w1.similar).toEqual([
      { id: "sim-1", body: singleChoiceBody("sim1") },
      { id: "sim-2", body: singleChoiceBody("sim2") },
    ]);
    expect(r1?.kind === "available" && r1.similar).toEqual([]);
  });

  it("two wrong items sharing the same (type, topic) share the SAME capped similar list, not a duplicated/merged one (page.tsx dedupes buckets by distinct pair before calling loadSimilarTasks — see D5 'различимым (type,topic) ошибок'; this test locks in the view.ts side of that contract: it must not silently double a caller's already-capped group)", () => {
    const wrong1 = task({ id: "w1", type: "grammar", topic: "verbs" });
    const wrong2 = task({ id: "w2", type: "grammar", topic: "verbs" });
    // Emulates page.tsx's post-fix behavior: ONE deduped bucket for the
    // shared topic -> pickSimilar (called once, upstream) already capped
    // this to capPerBucket=2 candidates before view.ts ever sees them.
    const similarRows: SimilarTaskRow[] = [
      { id: "sim-1", type: "grammar", topic: "verbs", body: singleChoiceBody("sim1") },
      { id: "sim-2", type: "grammar", topic: "verbs", body: singleChoiceBody("sim2") },
    ];
    const result = buildReviewViewModel({
      taskIds: ["w1", "w2"],
      items: [
        { taskId: "w1", response: null, isCorrect: false },
        { taskId: "w2", response: null, isCorrect: false },
      ],
      tasksById: new Map([
        ["w1", wrong1],
        ["w2", wrong2],
      ]),
      openTaskIds: new Set(),
      audioTaskIds: new Set(),
      language: "ru",
      similarRows,
    });
    const w1 = result.find((r) => r.taskId === "w1");
    const w2 = result.find((r) => r.taskId === "w2");
    const w1Similar = w1?.kind === "available" ? w1.similar : null;
    const w2Similar = w2?.kind === "available" ? w2.similar : null;
    expect(w1Similar).toHaveLength(2);
    expect(w2Similar).toEqual(w1Similar);
  });

  // 🔴 Инвариант (б) брифа T7: task ∈ openTaskIds -> answerView.kind==='locked'
  // и в объекте физически НЕТ полей answer/explanation (structural test —
  // JSON.stringify не содержит 'correctLabel', даже если future-регресс
  // случайно добавит answer в объект где-то ещё в дереве).
  it("[INVARIANT b] task in openTaskIds -> answerView is 'locked' with no answer/explanation leakage anywhere in the object", () => {
    const locked = task({ id: "locked-1", explanation: "top secret explanation" });
    const result = buildReviewViewModel({
      taskIds: ["locked-1"],
      items: [{ taskId: "locked-1", response: { format: "single_choice", optionId: "a" }, isCorrect: false }],
      tasksById: new Map([["locked-1", locked]]),
      openTaskIds: new Set(["locked-1"]),
      audioTaskIds: new Set(),
      language: "ru",
      similarRows: [],
    });
    const item = result[0];
    expect(item.kind).toBe("available");
    if (item.kind !== "available") throw new Error("unreachable");
    expect(item.answerView).toEqual({ kind: "locked" });
    const serialized = JSON.stringify(item);
    expect(serialized).not.toContain("correctLabel");
    expect(serialized).not.toContain("top secret explanation");
  });

  // 🔴 Инвариант (в) брифа T7: похожие задания никогда не содержат ответ.
  it("[INVARIANT c] similar task view objects never carry an answer/explanation field", () => {
    const wrong = task({ id: "w1", type: "grammar", topic: "verbs" });
    const similarRows: SimilarTaskRow[] = [
      { id: "sim-1", type: "grammar", topic: "verbs", body: singleChoiceBody("sim1") },
    ];
    const result = buildReviewViewModel({
      taskIds: ["w1"],
      items: [{ taskId: "w1", response: null, isCorrect: false }],
      tasksById: new Map([["w1", wrong]]),
      openTaskIds: new Set(),
      audioTaskIds: new Set(),
      language: "ru",
      similarRows,
    });
    const item = result[0];
    expect(item.kind).toBe("available");
    if (item.kind !== "available") throw new Error("unreachable");
    expect(item.similar).toEqual([{ id: "sim-1", body: singleChoiceBody("sim1") }]);
    const serialized = JSON.stringify(item.similar);
    expect(serialized).not.toContain("answer");
    expect(serialized).not.toContain("explanation");
  });

  // 🔴 Инвариант (а) брифа T7 задокументирован, не юнит-тестируется здесь:
  // buildReviewViewModel — чистая функция без доступа к attempt.finished_at,
  // она физически не может проверить "открыта ли попытка". Гарантия живёт на
  // уровне вызывающего кода: src/app/(app)/hq/[hqId]/tests/[testId]/page.tsx
  // вызывает buildReviewViewModel ТОЛЬКО внутри
  // `if (attemptRow && attemptRow.finished_at !== null)` — при открытой
  // попытке весь блок (включая эту функцию) не выполняется вовсе, поэтому
  // ReviewList для неё не рендерится и view-model не строится. См. комментарий
  // над вызовом в page.tsx.
});
