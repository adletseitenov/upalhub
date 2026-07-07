import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAttemptRepo } from "@/features/attempts/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { AttemptClosedError, InvalidTaskError, saveAnswers } from "@/features/attempts/service";

const itemSchema = z.object({
  taskId: z.string().min(1),
  response: z.unknown(),
  timeMs: z.number().int().nonnegative().optional(),
});
const bodySchema = z.object({ items: z.array(itemSchema).min(1) });

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const attemptRepo = supabaseAttemptRepo(supabase);
  const attempt = await attemptRepo.getAttempt(id);
  if (!attempt) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // ОБЯЗАТЕЛЬНОЕ ТРЕБОВАНИЕ ИЗ РЕВЬЮ T5: явный ownership-check ДО вызова
  // saveAnswers (сервис его не делает — гейт живёт в роуте). Чужая попытка
  // -> 403, не 404/409 (не путаем с "не найдено"/"уже закрыта").
  if (attempt.userId !== data.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const test = await supabaseTestRepo(supabase).getTest(attempt.testId);
  if (!test) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    await saveAnswers({ repo: attemptRepo }, { attempt, test, items: parsed.data.items });
  } catch (e) {
    if (e instanceof InvalidTaskError) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (e instanceof AttemptClosedError) {
      return NextResponse.json({ error: "attempt_closed" }, { status: 409 });
    }
    // Малоформенный response (не проходит taskResponseSchema) тоже 400, а
    // не 500 — это ошибка клиента, а не сервера.
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    throw e;
  }

  return NextResponse.json({ saved: parsed.data.items.length });
}
