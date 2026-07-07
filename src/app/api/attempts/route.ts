import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseTestRepo } from "@/features/tests/repo";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { startAttempt } from "@/features/attempts/service";

const bodySchema = z.object({ testId: z.uuid() });

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const test = await supabaseTestRepo(supabase).getTest(parsed.data.testId);
  if (!test) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Тест принадлежит юзеру через hq_id -> study_hqs.user_id. RLS тоже
  // фильтрует, но явный 404 для чужого теста — не полагаемся молча на RLS.
  const { data: hq, error: hqError } = await supabase
    .from("study_hqs")
    .select("id")
    .eq("id", test.hqId)
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (hqError) throw hqError;
  if (!hq) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { attempt, deadlineAt } = await startAttempt(
    { repo: supabaseAttemptRepo(supabase) },
    { test, userId: data.user.id },
  );

  // spec-без-ответов: tests.spec никогда не содержит answer, но мы всё
  // равно отдаём наружу только явно перечисленные поля (не весь spec целиком)
  // — устойчиво к будущим полям, которые могут появиться в TestSpec.
  return NextResponse.json({
    attemptId: attempt.id,
    deadlineAt: deadlineAt ? deadlineAt.toISOString() : null,
    startedAt: attempt.startedAt.toISOString(),
    finishedAt: attempt.finishedAt ? attempt.finishedAt.toISOString() : null,
    spec: {
      kind: test.spec.kind,
      sections: test.spec.sections,
      taskIds: test.spec.taskIds,
      totalTimeMinutes: test.spec.totalTimeMinutes ?? null,
    },
  });
}
