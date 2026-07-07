// Жизненный цикл попытки (D4/D5): НОЛЬ импортов llm/сети/supabase — только
// доменные функции (gradeAnswer/scaleScore) и репозиторий за DI-интерфейсом.
import { gradeAnswer } from "@/features/tasks/grade";
import { taskResponseSchema } from "@/features/tasks/schema";
import type { StoredTask } from "@/features/tasks/repo";
import { scaleScore } from "@/features/tests/scoring";
import type { TestSpec } from "@/features/tests/spec";
import type { StoredTest } from "@/features/tests/repo";
import type { AttemptItemRow, AttemptRepo, StoredAttempt } from "./repo";

// Роуты (Task 6) маппят на HTTP-статусы: OwnershipError -> 403,
// InvalidTaskError -> 400.
export class OwnershipError extends Error {
  constructor(message = "attempt does not belong to this user") {
    super(message);
    this.name = "OwnershipError";
  }
}

export class InvalidTaskError extends Error {
  constructor(public readonly taskId: string) {
    super(`taskId "${taskId}" is not part of this test's spec`);
    this.name = "InvalidTaskError";
  }
}

// Не в обязательном списке ошибок брифа, но нужна: без неё автосейв,
// вызванный после submit (гонка вкладок), переписал бы уже
// зафиксированные is_correct обратно на NULL при повторном upsert.
export class AttemptClosedError extends Error {
  constructor(public readonly attemptId: string) {
    super(`attempt "${attemptId}" is already finished`);
    this.name = "AttemptClosedError";
  }
}

/**
 * computeDeadline — чистая (D4). totalTimeMinutes отсутствует/null -> без
 * таймера (null). Иначе started_at + totalTimeMinutes.
 */
export function computeDeadline(spec: TestSpec, startedAt: Date): Date | null {
  if (spec.totalTimeMinutes == null) return null;
  return new Date(startedAt.getTime() + spec.totalTimeMinutes * 60_000);
}

/**
 * startAttempt — идемпотентно (insertAttempt перечитывает открытую попытку
 * на 23505 — паттерн уже реализован в AttemptRepo). deadlineAt считается от
 * фактического started_at попытки (важно при resume: не "сейчас", а когда
 * попытка реально была создана).
 */
export async function startAttempt(
  deps: { repo: AttemptRepo },
  args: { test: StoredTest; userId: string },
): Promise<{ attempt: StoredAttempt; deadlineAt: Date | null }> {
  const attempt = await deps.repo.insertAttempt(args.test.id, args.userId);
  const deadlineAt = computeDeadline(args.test.spec, attempt.startedAt);
  return { attempt, deadlineAt };
}

/**
 * saveAnswers — автосейв (D4). Работает до сабмита включительно после
 * дедлайна (сервер не блокирует по времени — только клиент-автосабмит и
 * роут решают, когда звать submit). Guard: попытка ещё открыта; таскIds
 * вне spec.taskIds отвергаются целиком (InvalidTaskError) до записи чего
 * бы то ни было — батч валидируется полностью, потом пишется одним вызовом.
 * is_correct никогда не трогается автосейвом (остаётся NULL).
 *
 * Guard читает состояние попытки заново через repo.getAttempt, а не
 * доверяет args.attempt.finishedAt напрямую: args.attempt может быть
 * снапшотом, снятым до конкурентного submit (другая вкладка/двойной
 * сабмит) — без живого перечитывания автосейв, начатый до финализации, но
 * выполнившийся после, переписал бы уже зафиксированные is_correct.
 */
export async function saveAnswers(
  deps: { repo: AttemptRepo },
  args: {
    attempt: StoredAttempt;
    test: StoredTest;
    items: { taskId: string; response: unknown; timeMs?: number }[];
  },
): Promise<void> {
  const current = await deps.repo.getAttempt(args.attempt.id);
  if (!current || current.finishedAt !== null) {
    throw new AttemptClosedError(args.attempt.id);
  }

  const validTaskIds = new Set(args.test.spec.taskIds);
  const rows: AttemptItemRow[] = args.items.map((item) => {
    if (!validTaskIds.has(item.taskId)) {
      throw new InvalidTaskError(item.taskId);
    }
    const response = taskResponseSchema.parse(item.response);
    return {
      taskId: item.taskId,
      response,
      timeMs: item.timeMs ?? null,
      isCorrect: null,
    };
  });

  if (rows.length === 0) return;
  await deps.repo.upsertItems(args.attempt.id, rows);
}

/**
 * submitAttempt — идемпотентен (D4): повторный вызов на уже завершённой
 * попытке возвращает готовый (persisted) результат вместо перегрейдинга.
 * Грейдит КАЖДЫЙ taskId из spec.taskIds (контракт карты знаний этапа 3) —
 * неотвеченные и отсутствующие в банке задания получают response=null,
 * is_correct=false, но всё равно попадают строкой в attempt_items.
 * Дедлайн НЕ проверяется здесь: сабмит после истечения времени просто
 * финализирует по тому, что успело сохраниться (без бонус-логики) — время
 * контролирует только клиент/роут, вызывающий эту функцию когда угодно.
 */
export async function submitAttempt(
  deps: { repo: AttemptRepo },
  args: { attemptId: string; test: StoredTest; tasks: StoredTask[]; userId: string; now: Date },
): Promise<{ raw: number; scaled: number; total: number; alreadyFinished: boolean }> {
  const attempt = await deps.repo.getAttempt(args.attemptId);
  // Несуществующая попытка не отличается от чужой — не даём различить их
  // по ответу (избегаем enumeration чужих attemptId).
  if (!attempt || attempt.userId !== args.userId) {
    throw new OwnershipError();
  }

  const total = args.test.spec.taskIds.length;

  if (attempt.finishedAt !== null) {
    return {
      raw: attempt.rawScore ?? 0,
      scaled: attempt.scaledScore ?? 0,
      total,
      alreadyFinished: true,
    };
  }

  const savedItems = await deps.repo.getItems(args.attemptId);
  const savedByTaskId = new Map(savedItems.map((item) => [item.taskId, item]));
  const tasksById = new Map(args.tasks.map((task) => [task.id, task]));

  const items: AttemptItemRow[] = args.test.spec.taskIds.map((taskId) => {
    const saved = savedByTaskId.get(taskId);
    const responseRaw = saved?.response ?? null;
    const task = tasksById.get(taskId);

    let isCorrect = false;
    if (task && responseRaw !== null) {
      const parsed = taskResponseSchema.safeParse(responseRaw);
      if (parsed.success) {
        isCorrect = gradeAnswer(task.body, task.answer, parsed.data);
      }
    }

    return {
      taskId,
      response: responseRaw,
      timeMs: saved?.timeMs ?? null,
      isCorrect,
    };
  });

  const raw = items.filter((item) => item.isCorrect === true).length;
  const scaled = scaleScore(raw, total, args.test.spec.scoringSnapshot);

  await deps.repo.finalize(args.attemptId, {
    rawScore: raw,
    scaledScore: scaled,
    finishedAt: args.now,
    items,
  });

  return { raw, scaled, total, alreadyFinished: false };
}
