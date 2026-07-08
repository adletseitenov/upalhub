import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { recomputeHqInsights, supabaseHqReader } from "@/features/hq/recompute";
import { recomputeLimiter } from "@/features/hq/recompute-limiter";
import { supabaseKnowledgeRepo } from "@/features/knowledge/repo";
import { supabasePlanRepo } from "@/features/plan/repo";

// D7: пересчёт может задеть несколько таблиц (карта; в T4/T5 — план и
// прогноз) без единого LLM-вызова, но всё равно многошаговый — тот же
// maxDuration=60, что и у сборки теста/submit-хука.
export const maxDuration = 60;

/**
 * POST /api/hq/[hqId]/recompute — D7: ручной/kicker-triggered полный
 * пересчёт карты знаний (+ план/прогноз, T4/T5) для одного hq. Идемпотентен
 * (recomputeHqInsights — полный recompute, не инкремент). Порядок проверок:
 * auth (401) → ownership (404, тот же паттерн "чужой/несуществующий hq
 * неразличимы", что и /api/tests, /api/attempts/[id]/submit) → лёгкий
 * лимитер (429, capacity 6/10мин — защита от случайного цикла на клиенте,
 * не бюджетный гейт: пересчёт не зовёт LLM) → recomputeHqInsights.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ hqId: string }> }) {
  const { hqId } = await params;

  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: hq, error: hqError } = await supabase
    .from("study_hqs")
    .select("id")
    .eq("id", hqId)
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (hqError) throw hqError;
  if (!hq) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!recomputeLimiter.take(data.user.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  await recomputeHqInsights(
    {
      hqReader: supabaseHqReader(supabase),
      knowledgeRepo: supabaseKnowledgeRepo(supabase),
      planRepo: supabasePlanRepo(supabase),
    },
    { hqId, now: new Date() },
  );

  return NextResponse.json({ recomputed: true });
}
