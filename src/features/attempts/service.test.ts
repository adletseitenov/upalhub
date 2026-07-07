import { describe, expect, it } from "vitest";
import type { StoredTask } from "@/features/tasks/repo";
import type { TestSpec } from "@/features/tests/spec";
import type { StoredTest } from "@/features/tests/repo";
import {
  AttemptClosedError,
  InvalidTaskError,
  OwnershipError,
  computeDeadline,
  saveAnswers,
  startAttempt,
  submitAttempt,
} from "./service";
import type { AttemptItemRow, AttemptRepo, StoredAttempt } from "./repo";

// --- fake AttemptRepo -------------------------------------------------
// Реализует семантику D4 «одна открытая попытка на (testId, userId)» прямо
// в fake (эквивалент реального partial-unique-индекса + перечитывания на
// 23505 в supabaseAttemptRepo — паттерн study_hqs/exam-profile repo).

function fakeAttemptRepo(): AttemptRepo & {
  rows: StoredAttempt[];
  items: Map<string, AttemptItemRow[]>;
} {
  const rows: StoredAttempt[] = [];
  const items = new Map<string, AttemptItemRow[]>();
  let nextId = 1;

  const repo: AttemptRepo = {
    async insertAttempt(testId, userId) {
      const existingOpen = rows.find(
        (r) => r.testId === testId && r.userId === userId && r.finishedAt === null,
      );
      if (existingOpen) return existingOpen; // симулирует 23505 -> reread открытой

      const attempt: StoredAttempt = {
        id: `attempt-${nextId++}`,
        testId,
        userId,
        startedAt: new Date(),
        finishedAt: null,
        rawScore: null,
        scaledScore: null,
      };
      rows.push(attempt);
      items.set(attempt.id, []);
      return attempt;
    },

    async findOpenAttempt(testId, userId) {
      return (
        rows.find((r) => r.testId === testId && r.userId === userId && r.finishedAt === null) ??
        null
      );
    },

    async getAttempt(id) {
      return rows.find((r) => r.id === id) ?? null;
    },

    async upsertItems(attemptId, newItems) {
      const existing = items.get(attemptId) ?? [];
      const byTaskId = new Map(existing.map((i) => [i.taskId, i]));
      for (const item of newItems) byTaskId.set(item.taskId, item);
      items.set(attemptId, [...byTaskId.values()]);
    },

    async getItems(attemptId) {
      return items.get(attemptId) ?? [];
    },

    async finalize(attemptId, patch) {
      await repo.upsertItems(attemptId, patch.items);
      const idx = rows.findIndex((r) => r.id === attemptId);
      const updated: StoredAttempt = {
        ...rows[idx],
        rawScore: patch.rawScore,
        scaledScore: patch.scaledScore,
        finishedAt: patch.finishedAt,
      };
      rows[idx] = updated;
      return updated;
    },
  };

  return Object.assign(repo, { rows, items });
}

// --- фикстуры задач/спек -----------------------------------------------

function scTask(id: string, correctOptionId: "a" | "b" = "a"): StoredTask {
  return {
    id,
    type: "algebra",
    topic: "Уравнения",
    difficulty: 3,
    language: "kk",
    body: {
      format: "single_choice",
      prompt: `question ${id}`,
      options: [
        { id: "a", text: "4" },
        { id: "b", text: "5" },
      ],
    },
    answer: { format: "single_choice", correctOptionId },
    explanation: "e",
  };
}

function testFixture(taskIds: string[], overrides: Partial<TestSpec> = {}): StoredTest {
  const spec: TestSpec = {
    version: 1,
    kind: "diagnostic",
    language: "kk",
    sections: [{ name: "Математика", taskIds }],
    taskIds,
    totalTimeMinutes: null,
    scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
    ...overrides,
  };
  return { id: "test-1", hqId: "hq-1", kind: "diagnostic", spec };
}

// ===========================================================================
// computeDeadline
// ===========================================================================

describe("computeDeadline", () => {
  it("returns null when totalTimeMinutes is null", () => {
    const spec = testFixture(["t1"]).spec;
    expect(computeDeadline(spec, new Date("2026-01-01T00:00:00Z"))).toBeNull();
  });

  it("returns null when totalTimeMinutes is undefined (absent)", () => {
    const spec = testFixture(["t1"]).spec;
    const withoutField: TestSpec = { ...spec };
    delete (withoutField as { totalTimeMinutes?: number | null }).totalTimeMinutes;
    expect(computeDeadline(withoutField, new Date("2026-01-01T00:00:00Z"))).toBeNull();
  });

  it("returns startedAt + totalTimeMinutes when set (60 -> +60min)", () => {
    const spec = testFixture(["t1"], { totalTimeMinutes: 60 }).spec;
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const deadline = computeDeadline(spec, startedAt);
    expect(deadline).toEqual(new Date("2026-01-01T01:00:00.000Z"));
  });
});

// ===========================================================================
// startAttempt
// ===========================================================================

describe("startAttempt", () => {
  it("creates a new attempt and computes the deadline from its startedAt", async () => {
    const repo = fakeAttemptRepo();
    const test = testFixture(["t1", "t2"], { totalTimeMinutes: 30 });

    const { attempt, deadlineAt } = await startAttempt({ repo }, { test, userId: "user-1" });

    expect(attempt.testId).toBe("test-1");
    expect(attempt.userId).toBe("user-1");
    expect(attempt.finishedAt).toBeNull();
    expect(deadlineAt).toEqual(new Date(attempt.startedAt.getTime() + 30 * 60_000));
  });

  it("a double start (F5/race) returns the same open attempt, not a second one", async () => {
    const repo = fakeAttemptRepo();
    const test = testFixture(["t1"]);

    const first = await startAttempt({ repo }, { test, userId: "user-1" });
    const second = await startAttempt({ repo }, { test, userId: "user-1" });

    expect(second.attempt.id).toBe(first.attempt.id);
    expect(repo.rows).toHaveLength(1);
  });

  it("null totalTimeMinutes yields a null deadline", async () => {
    const repo = fakeAttemptRepo();
    const test = testFixture(["t1"]);
    const { deadlineAt } = await startAttempt({ repo }, { test, userId: "user-1" });
    expect(deadlineAt).toBeNull();
  });
});

// ===========================================================================
// saveAnswers
// ===========================================================================

describe("saveAnswers", () => {
  it("resume: answers saved via saveAnswers are visible via repo.getItems", async () => {
    const repo = fakeAttemptRepo();
    const test = testFixture(["t1", "t2"]);
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });

    await saveAnswers(
      { repo },
      {
        attempt,
        test,
        items: [
          { taskId: "t1", response: { format: "single_choice", optionId: "a" }, timeMs: 1200 },
        ],
      },
    );

    const items = await repo.getItems(attempt.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      taskId: "t1",
      response: { format: "single_choice", optionId: "a" },
      timeMs: 1200,
      isCorrect: null, // автосейв никогда не грейдит
    });
  });

  it("upserts by taskId — saving the same taskId twice overwrites, not duplicates", async () => {
    const repo = fakeAttemptRepo();
    const test = testFixture(["t1"]);
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });

    await saveAnswers(
      { repo },
      { attempt, test, items: [{ taskId: "t1", response: { format: "single_choice", optionId: "a" } }] },
    );
    await saveAnswers(
      { repo },
      { attempt, test, items: [{ taskId: "t1", response: { format: "single_choice", optionId: "b" } }] },
    );

    const items = await repo.getItems(attempt.id);
    expect(items).toHaveLength(1);
    expect(items[0].response).toEqual({ format: "single_choice", optionId: "b" });
  });

  it("rejects a taskId outside spec.taskIds with InvalidTaskError, writing nothing", async () => {
    const repo = fakeAttemptRepo();
    const test = testFixture(["t1"]);
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });

    await expect(
      saveAnswers(
        { repo },
        {
          attempt,
          test,
          items: [{ taskId: "not-in-spec", response: { format: "single_choice", optionId: "a" } }],
        },
      ),
    ).rejects.toThrow(InvalidTaskError);

    expect(await repo.getItems(attempt.id)).toHaveLength(0);
  });

  it("rejects a malformed response shape (fails taskResponseSchema)", async () => {
    const repo = fakeAttemptRepo();
    const test = testFixture(["t1"]);
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });

    await expect(
      saveAnswers({ repo }, { attempt, test, items: [{ taskId: "t1", response: { garbage: true } }] }),
    ).rejects.toThrow();
  });

  it("refuses to write to an already-finished attempt (protects finalized grading)", async () => {
    const repo = fakeAttemptRepo();
    const tasks = [scTask("t1")];
    const test = testFixture(["t1"]);
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });
    await submitAttempt({ repo }, { attemptId: attempt.id, test, tasks, userId: "user-1", now: new Date() });

    await expect(
      saveAnswers(
        { repo },
        { attempt, test, items: [{ taskId: "t1", response: { format: "single_choice", optionId: "a" } }] },
      ),
    ).rejects.toThrow(AttemptClosedError);
  });
});

// ===========================================================================
// submitAttempt
// ===========================================================================

describe("submitAttempt", () => {
  it("a double submit is idempotent: second call returns alreadyFinished with the same scaled score", async () => {
    const repo = fakeAttemptRepo();
    const tasks = [scTask("t1"), scTask("t2")];
    const test = testFixture(["t1", "t2"]);
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });
    await saveAnswers(
      { repo },
      { attempt, test, items: [{ taskId: "t1", response: { format: "single_choice", optionId: "a" } }] },
    );

    const first = await submitAttempt(
      { repo },
      { attemptId: attempt.id, test, tasks, userId: "user-1", now: new Date("2026-01-01T00:10:00Z") },
    );
    const second = await submitAttempt(
      { repo },
      { attemptId: attempt.id, test, tasks, userId: "user-1", now: new Date("2026-01-02T00:00:00Z") },
    );

    expect(first.alreadyFinished).toBe(false);
    expect(second.alreadyFinished).toBe(true);
    expect(second.scaled).toBe(first.scaled);
    expect(second.raw).toBe(first.raw);
    expect(second.total).toBe(first.total);
  });

  it("writes one attempt_items row per spec.taskId, marking unanswered questions is_correct=false", async () => {
    const repo = fakeAttemptRepo();
    const tasks = [scTask("t1"), scTask("t2"), scTask("t3")];
    const test = testFixture(["t1", "t2", "t3"]);
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });
    // Только t1 отвечен (верно); t2/t3 остаются без ответа.
    await saveAnswers(
      { repo },
      { attempt, test, items: [{ taskId: "t1", response: { format: "single_choice", optionId: "a" } }] },
    );

    await submitAttempt(
      { repo },
      { attemptId: attempt.id, test, tasks, userId: "user-1", now: new Date() },
    );

    const items = await repo.getItems(attempt.id);
    expect(items).toHaveLength(3);
    const byId = new Map(items.map((i) => [i.taskId, i]));
    expect(byId.get("t1")!.isCorrect).toBe(true);
    expect(byId.get("t2")!.isCorrect).toBe(false);
    expect(byId.get("t2")!.response).toBeNull();
    expect(byId.get("t3")!.isCorrect).toBe(false);
    expect(byId.get("t3")!.response).toBeNull();
  });

  it("a taskId present in spec but missing from the loaded task bank is graded false, not thrown", async () => {
    const repo = fakeAttemptRepo();
    const tasks = [scTask("t1")]; // t2 отсутствует в загруженных задачах
    const test = testFixture(["t1", "t2"]);
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });
    await saveAnswers(
      { repo },
      { attempt, test, items: [{ taskId: "t1", response: { format: "single_choice", optionId: "a" } }] },
    );

    const result = await submitAttempt(
      { repo },
      { attemptId: attempt.id, test, tasks, userId: "user-1", now: new Date() },
    );

    expect(result.raw).toBe(1);
    const items = await repo.getItems(attempt.id);
    expect(items.find((i) => i.taskId === "t2")!.isCorrect).toBe(false);
  });

  it("throws OwnershipError when the caller does not own the attempt", async () => {
    const repo = fakeAttemptRepo();
    const tasks = [scTask("t1")];
    const test = testFixture(["t1"]);
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });

    await expect(
      submitAttempt(
        { repo },
        { attemptId: attempt.id, test, tasks, userId: "someone-else", now: new Date() },
      ),
    ).rejects.toThrow(OwnershipError);
  });

  it("throws OwnershipError for a non-existent attemptId", async () => {
    const repo = fakeAttemptRepo();
    const tasks: StoredTask[] = [];
    const test = testFixture(["t1"]);

    await expect(
      submitAttempt(
        { repo },
        { attemptId: "does-not-exist", test, tasks, userId: "user-1", now: new Date() },
      ),
    ).rejects.toThrow(OwnershipError);
  });

  it("finalizes strictly from persisted answers even when 'now' is well past any reasonable deadline (no bonus logic)", async () => {
    const repo = fakeAttemptRepo();
    const tasks = [scTask("t1")];
    const test = testFixture(["t1"], { totalTimeMinutes: 10 });
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });
    await saveAnswers(
      { repo },
      { attempt, test, items: [{ taskId: "t1", response: { format: "single_choice", optionId: "a" } }] },
    );

    // Сабмит спустя дни после дедлайна — не должен ни падать, ни менять
    // результат: submitAttempt никогда не сверяется с дедлайном.
    const farFuture = new Date(attempt.startedAt.getTime() + 5 * 24 * 60 * 60 * 1000);
    const result = await submitAttempt(
      { repo },
      { attemptId: attempt.id, test, tasks, userId: "user-1", now: farFuture },
    );

    expect(result.raw).toBe(1);
    expect(result.alreadyFinished).toBe(false);
    const stored = await repo.getAttempt(attempt.id);
    expect(stored!.finishedAt).toEqual(farFuture);
  });

  it("scores the ENT fixture: 14/20 correct on a {0..140} points scale -> 98 (matches Task 1 scaleScore fixture)", async () => {
    const repo = fakeAttemptRepo();
    const taskIds = Array.from({ length: 20 }, (_, i) => `t${i + 1}`);
    const tasks = taskIds.map((id) => scTask(id));
    const test = testFixture(taskIds, {
      scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
    });
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });

    // 14 верных ("a"), 6 неверных ("b").
    const items = taskIds.map((taskId, i) => ({
      taskId,
      response: { format: "single_choice" as const, optionId: i < 14 ? "a" : "b" },
    }));
    await saveAnswers({ repo }, { attempt, test, items });

    const result = await submitAttempt(
      { repo },
      { attemptId: attempt.id, test, tasks, userId: "user-1", now: new Date() },
    );

    expect(result.raw).toBe(14);
    expect(result.total).toBe(20);
    expect(result.scaled).toBe(98);
  });

  it("scores the IELTS fixture: 15/20 correct on a {0..9} band scale -> 6.5 (matches Task 1 scaleScore fixture)", async () => {
    const repo = fakeAttemptRepo();
    const taskIds = Array.from({ length: 20 }, (_, i) => `t${i + 1}`);
    const tasks = taskIds.map((id) => scTask(id));
    const test = testFixture(taskIds, {
      scoringSnapshot: { scaleMin: 0, scaleMax: 9, unit: "band" },
    });
    const { attempt } = await startAttempt({ repo }, { test, userId: "user-1" });

    const items = taskIds.map((taskId, i) => ({
      taskId,
      response: { format: "single_choice" as const, optionId: i < 15 ? "a" : "b" },
    }));
    await saveAnswers({ repo }, { attempt, test, items });

    const result = await submitAttempt(
      { repo },
      { attemptId: attempt.id, test, tasks, userId: "user-1", now: new Date() },
    );

    expect(result.raw).toBe(15);
    expect(result.scaled).toBe(6.5);
  });

  it("all-correct scores scaleMax, all-unanswered scores scaleMin", async () => {
    const repo = fakeAttemptRepo();
    const taskIds = ["t1", "t2"];
    const tasks = taskIds.map((id) => scTask(id));
    const test = testFixture(taskIds, { scoringSnapshot: { scaleMin: 0, scaleMax: 140, unit: "points" } });

    // all-correct
    {
      const { attempt } = await startAttempt({ repo }, { test, userId: "user-correct" });
      await saveAnswers(
        { repo },
        {
          attempt,
          test,
          items: taskIds.map((taskId) => ({
            taskId,
            response: { format: "single_choice" as const, optionId: "a" },
          })),
        },
      );
      const result = await submitAttempt(
        { repo },
        { attemptId: attempt.id, test, tasks, userId: "user-correct", now: new Date() },
      );
      expect(result.scaled).toBe(140);
    }

    // all-unanswered
    {
      const { attempt } = await startAttempt({ repo }, { test, userId: "user-blank" });
      const result = await submitAttempt(
        { repo },
        { attemptId: attempt.id, test, tasks, userId: "user-blank", now: new Date() },
      );
      expect(result.scaled).toBe(0);
    }
  });
});
