import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { createLlm } from "@/lib/llm";
import { createRateLimiter } from "@/lib/rate-limit";
import { examProfileSpecSchema, sourceRefSchema } from "@/features/exam-profile/spec";
import type { StoredExamProfile } from "@/features/exam-profile/service";
import { supabaseTaskRepo } from "@/features/tasks/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { testKindSchema } from "@/features/tests/spec";
import { assembleTest } from "@/features/tests/assemble";

// Сборка теста может занять несколько LLM-вызовов (D2/D3, cap 3).
export const maxDuration = 60;

const bodySchema = z.object({ hqId: z.uuid(), kind: testKindSchema });

// Best-effort, per-instance лимит на сборку (дорогой LLM-путь) — см. jsdoc
// в src/lib/rate-limit.ts: сбрасывается на деплой, не шарится между
// инстансами. 5 сборок / 10 минут на пользователя.
const limiter = createRateLimiter({ capacity: 5, refillPerMs: 5 / (10 * 60_000) });

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!limiter.take(data.user.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // hq принадлежит юзеру — явная проверка (RLS тоже фильтрует, но роут
  // отдаёт понятный 404, а не полагается только на пустой select от RLS).
  const { data: hq, error: hqError } = await supabase
    .from("study_hqs")
    .select("id, exam_profile_id")
    .eq("id", parsed.data.hqId)
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (hqError) throw hqError;
  if (!hq) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // exam_profiles.findById нет в контракте repo (только findBySlug) — грузим
  // строку напрямую и парсим спеку сами (паттерн /exams/[slug]/page.tsx).
  const { data: profileRow, error: profileError } = await supabase
    .from("exam_profiles")
    .select("*")
    .eq("id", hq.exam_profile_id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profileRow) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const spec = examProfileSpecSchema.parse(profileRow.spec);
  const parsedSources = z.array(sourceRefSchema).safeParse(profileRow.sources ?? []);
  const examProfile: StoredExamProfile = {
    id: profileRow.id,
    slug: profileRow.slug,
    title: profileRow.title,
    language: profileRow.language,
    spec,
    sources: parsedSources.success ? parsedSources.data : [],
    origin: profileRow.origin as StoredExamProfile["origin"],
    trust: profileRow.trust as StoredExamProfile["trust"],
  };

  const test = await assembleTest(
    {
      taskRepo: supabaseTaskRepo(supabase),
      testRepo: supabaseTestRepo(supabase),
      llm: createLlm(),
    },
    { hqId: hq.id, examProfile, kind: parsed.data.kind },
  );

  // Ответ намеренно минимален: tests.spec содержит только taskIds, ответы в
  // него не входят, но всё равно отдаём наружу только id — клиент дальше
  // стартует попытку через POST /api/attempts.
  return NextResponse.json({ testId: test.id });
}
