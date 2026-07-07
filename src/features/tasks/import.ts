import { z } from "zod";
import { taskAnswerSchema, taskBodySchema, validateTaskPair } from "./schema";
import type { NewTask } from "./schema";
import { contentHash } from "./repo";
import type { NewTaskRow, TaskBankRepo } from "./repo";

// D6: ровно shape NewTask ({type, topic, difficulty, language, body, answer,
// explanation}) + кросс-рефайнмент body/answer (validateTaskPair, Task 1) —
// реюз, не дублирование, парных правил single/multi/text_input.
const importItemSchema = z
  .object({
    type: z.string().min(1),
    topic: z.string().min(1),
    difficulty: z.number().int().min(1).max(5),
    language: z.string().min(1),
    body: taskBodySchema,
    answer: taskAnswerSchema,
    explanation: z.string().min(1),
  })
  .superRefine((item, ctx) => {
    try {
      validateTaskPair(item.body, item.answer);
    } catch (e) {
      if (!(e instanceof z.ZodError)) throw e;
      for (const issue of e.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
      }
    }
  });

function issueMessage(issue: z.ZodError["issues"][number]): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}

// Вход — JSON-массив заданий напрямую (не обёртка). Каждый элемент проходит
// safeParse независимо: один плохой элемент не роняет остальные. Если вход
// вовсе не массив — единственная запись с index:-1 (нет per-item индекса).
export function parseImport(json: unknown): {
  valid: NewTask[];
  errors: Array<{ index: number; message: string }>;
} {
  if (!Array.isArray(json)) {
    return { valid: [], errors: [{ index: -1, message: "expected a JSON array of tasks" }] };
  }

  const valid: NewTask[] = [];
  const errors: Array<{ index: number; message: string }> = [];

  json.forEach((item, index) => {
    const result = importItemSchema.safeParse(item);
    if (result.success) {
      valid.push(result.data);
    } else {
      errors.push({ index, message: issueMessage(result.error.issues[0]) });
    }
  });

  return { valid, errors };
}

// rejected здесь всегда 0: реджекты (невалидный shape) уже отфильтрованы
// parseImport'ом до вызова importTasks — поле в сигнатуре только для формы
// единого отчёта роута (D6).
export async function importTasks(
  deps: { repo: TaskBankRepo },
  examProfileId: string,
  tasks: NewTask[],
): Promise<{ inserted: number; skippedDuplicates: number; rejected: number }> {
  const rows: NewTaskRow[] = tasks.map((task) => ({
    ...task,
    examProfileId,
    origin: "import",
    contentHash: contentHash(task.body),
  }));

  const { inserted, skipped } = await deps.repo.insertMany(rows);

  return { inserted: inserted.length, skippedDuplicates: skipped, rejected: 0 };
}
