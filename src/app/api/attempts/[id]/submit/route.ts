import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { submitAttempt } from "@/features/attempts/service";
import { taskAnswerSchema, taskBodySchema, validateTaskPair } from "@/features/tasks/schema";
import type { StoredTask } from "@/features/tasks/repo";
import type { Database } from "@/lib/supabase/database.types";

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

// Локальный эквивалент приватного rowToTaskSafe из tasks/repo.ts — тот не
// экспортируется, а контракт repo.ts менять нельзя (бриф T6). Это ЕДИНСТВЕННЫЙ
// роут, который видит answer — только на сервере, наружу answer не отдаётся
// (submitAttempt возвращает только raw/scaled/total).
//
// safeParse, не .parse (D-fix3): одна мусорная строка банка не должна ронять
// сабмит для остальных заданий попытки. Пропущенный (null) таск ниже
// фильтруется — submitAttempt уже грейдит отсутствующий в `tasks` id как
// isCorrect=false, так что пропуск здесь не меняет остальную сдачу попытки.
function rowToStoredTask(row: TaskRow): StoredTask | null {
  const bodyResult = taskBodySchema.safeParse(row.body);
  const answerResult = taskAnswerSchema.safeParse(row.answer);
  if (!bodyResult.success || !answerResult.success) {
    console.warn(`attempts/submit: skipping malformed task row id=${row.id} (invalid body/answer shape)`);
    return null;
  }
  try {
    validateTaskPair(bodyResult.data, answerResult.data);
  } catch {
    console.warn(`attempts/submit: skipping malformed task row id=${row.id} (body/answer pair invalid)`);
    return null;
  }
  return {
    id: row.id,
    type: row.type,
    topic: row.topic,
    difficulty: row.difficulty,
    language: row.language,
    body: bodyResult.data,
    answer: answerResult.data,
    explanation: row.explanation ?? "",
  };
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const attemptRepo = supabaseAttemptRepo(supabase);
  const attempt = await attemptRepo.getAttempt(id);
  if (!attempt) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Тот же явный ownership-check, что и в /items (требование ревью T5):
  // чужая попытка -> 403, ДО загрузки заданий и вызова submitAttempt.
  if (attempt.userId !== data.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const test = await supabaseTestRepo(supabase).getTest(attempt.testId);
  if (!test) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { data: taskRows, error: tasksError } = await supabase
    .from("tasks")
    .select("*")
    .in("id", test.spec.taskIds);
  if (tasksError) throw tasksError;
  const tasks = (taskRows ?? [])
    .map(rowToStoredTask)
    .filter((task): task is StoredTask => task !== null);

  const result = await submitAttempt(
    { repo: attemptRepo },
    { attemptId: attempt.id, test, tasks, userId: data.user.id, now: new Date() },
  );

  return NextResponse.json(result);
}
