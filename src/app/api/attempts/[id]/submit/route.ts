import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { taskReadClient } from "@/lib/supabase/admin";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { submitAttempt } from "@/features/attempts/service";
import { taskAnswerSchema, taskBodySchema, validateTaskPair } from "@/features/tasks/schema";
import type { StoredTask } from "@/features/tasks/repo";
import type { Database } from "@/lib/supabase/database.types";
import { recomputeHqInsights, supabaseHqReader } from "@/features/hq/recompute";
import { supabaseKnowledgeRepo } from "@/features/knowledge/repo";
import { supabasePlanRepo } from "@/features/plan/repo";
import { supabaseForecastRepo } from "@/features/forecast/repo";

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

// D7: submit-хук может теперь дозвониться до recomputeHqInsights (карта +
// в T4/T5 план/прогноз) после грейдинга — тот же maxDuration=60, что и у
// сборки/дособорки теста (см. /api/tests, /api/tests/[testId]/refill).
export const maxDuration = 60;

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

  // Ownership уже подтверждён выше (userId сверен на user-клиенте) — только
  // ПОСЛЕ этого читаем tasks.answer/explanation через taskReadClient
  // (service-role, если SUPABASE_SECRET_KEY задан в env; иначе временный
  // фолбэк на user-клиент — см. src/lib/supabase/admin.ts).
  const { data: taskRows, error: tasksError } = await taskReadClient(supabase)
    .from("tasks")
    .select("*")
    .in("id", test.spec.taskIds);
  if (tasksError) throw tasksError;
  const tasks = (taskRows ?? [])
    .map(rowToStoredTask)
    .filter((task): task is StoredTask => task !== null);

  const now = new Date();
  const result = await submitAttempt(
    { repo: attemptRepo },
    { attemptId: attempt.id, test, tasks, userId: data.user.id, now },
  );

  // D7: пересчёт карты знаний (+ в T4/T5 план/прогноз) — best-effort после
  // успешного submit. Сбой/таймаут пересчёта НЕ должен валить уже
  // посчитанный результат попытки: глотаем и логируем, ответ уходит как
  // обычно. Пересчёт читает только topic/difficulty банка (не
  // answer/explanation), поэтому user-клиент (тот же `supabase`, что
  // подтвердил ownership выше) достаточен — admin-клиент здесь не нужен.
  try {
    await recomputeHqInsights(
      {
        hqReader: supabaseHqReader(supabase),
        knowledgeRepo: supabaseKnowledgeRepo(supabase),
        planRepo: supabasePlanRepo(supabase),
        forecastRepo: supabaseForecastRepo(supabase),
      },
      { hqId: test.hqId, now },
    );
  } catch (err) {
    console.warn(`attempts/submit: recompute failed for hq=${test.hqId}`, err);
  }

  return NextResponse.json(result);
}
