import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { submitAttempt } from "@/features/attempts/service";
import { taskAnswerSchema, taskBodySchema, validateTaskPair } from "@/features/tasks/schema";
import type { StoredTask } from "@/features/tasks/repo";
import type { Database } from "@/lib/supabase/database.types";

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

// Локальный эквивалент приватного rowToTask из tasks/repo.ts — тот не
// экспортируется, а контракт repo.ts менять нельзя (бриф T6). Это ЕДИНСТВЕННЫЙ
// роут, который видит answer — только на сервере, наружу answer не отдаётся
// (submitAttempt возвращает только raw/scaled/total).
function rowToStoredTask(row: TaskRow): StoredTask {
  const body = taskBodySchema.parse(row.body);
  const answer = taskAnswerSchema.parse(row.answer);
  validateTaskPair(body, answer);
  return {
    id: row.id,
    type: row.type,
    topic: row.topic,
    difficulty: row.difficulty,
    language: row.language,
    body,
    answer,
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
  const tasks = (taskRows ?? []).map(rowToStoredTask);

  const result = await submitAttempt(
    { repo: attemptRepo },
    { attemptId: attempt.id, test, tasks, userId: data.user.id, now: new Date() },
  );

  return NextResponse.json(result);
}
