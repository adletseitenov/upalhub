import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { testSpecSchema } from "@/features/tests/spec";
import { taskAnswerSchema, taskBodySchema, taskResponseSchema } from "@/features/tasks/schema";
import type { TaskAnswer, TaskBody, TaskResponse } from "@/features/tasks/schema";
import { explainMistake } from "@/features/review/explain";
import { explainLimiter } from "@/features/review/explain-limiter";
import { createLlm } from "@/lib/llm";
import { locales, defaultLocale, type Locale } from "@/i18n/locales";
import type { Database } from "@/lib/supabase/database.types";

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

// D5/Task9: единственный LLM-путь этапа — «почему я ошибся» под ReviewList.
// Многошаговый (auth+ownership+cross-attempt gate+LLM) — тот же
// maxDuration=60, что и у /submit и /hq/[hqId]/recompute.
export const maxDuration = 60;

// Локальный эквивалент rowToStoredTask из /submit — тот файл его не
// экспортирует (тот же паттерн: единственный владелец answer/explanation вне
// submit — теперь ещё и этот роут; supabaseAdmin читается ТОЛЬКО после
// ownership+finished+cross-attempt гейтов ниже).
function rowToStoredTask(
  row: TaskRow,
): { body: TaskBody; answer: TaskAnswer; explanation: string | null } | null {
  const bodyResult = taskBodySchema.safeParse(row.body);
  const answerResult = taskAnswerSchema.safeParse(row.answer);
  if (!bodyResult.success || !answerResult.success) {
    console.warn(`attempts/explain: skipping malformed task row id=${row.id} (invalid body/answer shape)`);
    return null;
  }
  return {
    body: bodyResult.data,
    answer: answerResult.data,
    explanation: row.explanation && row.explanation.trim() !== "" ? row.explanation : null,
  };
}

// Тот же fallback, что и src/i18n/request.ts — но route handlers не проходят
// через getRequestConfig, поэтому cookie читается напрямую.
async function resolveLocale(): Promise<Locale> {
  const store = await cookies();
  const fromCookie = store.get("NEXT_LOCALE")?.value;
  return locales.includes(fromCookie as Locale) ? (fromCookie as Locale) : defaultLocale;
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; taskId: string }> },
) {
  const { id, taskId } = await params;
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const attemptRepo = supabaseAttemptRepo(supabase);
  const attempt = await attemptRepo.getAttempt(id);
  if (!attempt) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Тот же явный ownership-check, что и /submit и /items: чужая попытка ->
  // 403, ДО finished-гейта и любого дальнейшего чтения.
  if (attempt.userId !== data.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (attempt.finishedAt === null) {
    return NextResponse.json({ error: "attempt_not_finished" }, { status: 403 });
  }

  const test = await supabaseTestRepo(supabase).getTest(attempt.testId);
  if (!test) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!test.spec.taskIds.includes(taskId)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // 🔴 Кросс-попыточный гейт (D5): taskId не должен принадлежать НИ ОДНОЙ
  // незавершённой попытке этого юзера — по ВСЕМ hq/тестам, не только
  // текущему (тот же гейт, что buildReviewViewModel применяет к
  // answer/explanation в ReviewList; здесь он серверно пересчитан заново для
  // самого explain-запроса, а не унаследован от рендера страницы).
  const { data: openAttemptRows } = await supabase
    .from("attempts")
    .select("test_id")
    .eq("user_id", data.user.id)
    .is("finished_at", null);
  const openTestIds = Array.from(new Set((openAttemptRows ?? []).map((row) => row.test_id)));
  if (openTestIds.length > 0) {
    const { data: openTestRows } = await supabase.from("tests").select("id, spec").in("id", openTestIds);
    for (const row of openTestRows ?? []) {
      const parsedOpenSpec = testSpecSchema.safeParse(row.spec);
      if (!parsedOpenSpec.success) continue; // битая spec — скип, не 500
      if (parsedOpenSpec.data.taskIds.includes(taskId)) {
        return NextResponse.json({ error: "task_in_active_attempt" }, { status: 403 });
      }
    }
  }

  // 🔴 Лимитер строго ПОСЛЕ всех auth/ownership/finished/cross-attempt
  // гейтов и СТРОГО ДО любого чтения answer/explanation или LLM-вызова — ни
  // одного токена на невалидный запрос, ни одного LLM-спенда без токена.
  if (!explainLimiter.take(data.user.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Ownership+finished+гейты подтверждены выше — только теперь читаем
  // answer/explanation через service-role клиент (та же граница, что
  // /submit и /tests/[testId]/page.tsx).
  const { data: taskRow } = await supabaseAdmin().from("tasks").select("*").eq("id", taskId).maybeSingle();
  const stored = taskRow ? rowToStoredTask(taskRow) : null;
  if (!stored) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const items = await attemptRepo.getItems(attempt.id);
  const itemRow = items.find((item) => item.taskId === taskId);
  const responseParsed = taskResponseSchema.safeParse(itemRow?.response ?? null);
  const userResponse: TaskResponse | null = responseParsed.success ? responseParsed.data : null;

  const locale = await resolveLocale();

  try {
    const result = await explainMistake(
      { llm: createLlm() },
      {
        locale,
        body: stored.body,
        userResponse,
        answer: stored.answer,
        explanation: stored.explanation,
      },
    );
    return NextResponse.json(result);
  } catch (e) {
    // LLM-провал (включая 402 «недостаточно кредитов») деградирует мягко —
    // 502, не 500-стек: level-0 разбор (уже отрендерен) остаётся рабочим без
    // этой кнопки.
    console.warn(`attempts/explain: llm failed for task=${taskId}`, e);
    return NextResponse.json({ error: "llm_unavailable" }, { status: 502 });
  }
}
