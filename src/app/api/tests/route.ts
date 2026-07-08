import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { taskReadClient } from "@/lib/supabase/admin";
import { createLlm } from "@/lib/llm";
import { examProfileSpecSchema, sourceRefSchema } from "@/features/exam-profile/spec";
import type { StoredExamProfile } from "@/features/exam-profile/service";
import { parseHqConfig, validateHqConfig, type HqConfig } from "@/features/exam-profile/selection";
import { supabaseTaskRepo } from "@/features/tasks/repo";
import { supabaseTestRepo } from "@/features/tests/repo";
import { testKindSchema } from "@/features/tests/spec";
import { assembleTest } from "@/features/tests/assemble";
import { assemblyLimiter } from "@/features/tests/assembly-limiter";

// Сборка теста может занять несколько LLM-вызовов (D2/D3, cap 3).
export const maxDuration = 60;

const bodySchema = z.object({ hqId: z.uuid(), kind: testKindSchema });

// D5: study_hqs.config появляется миграцией T5 — до неё колонки в
// database.types.ts нет, поэтому читаем defensively через cast.
// Stage3 T1: parseHqConfig (Array.isArray-гард включён) теперь живёт в
// selection.ts — единая точка истины, консолидировано из этого дубля.

// D5: config считается "непустым" (требующим validateHqConfig -> 422) только
// если ученик реально что-то выбрал — легаси-штабы без онбординга (config
// null или {}) не должны получать 422 за то, что никогда не проходили визард.
function isEmptyHqConfig(config: HqConfig | null): boolean {
  return config === null || (config.variantKey == null && config.selectedSectionNames.length === 0);
}

export async function POST(request: Request) {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!assemblyLimiter.take(data.user.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  // hq принадлежит юзеру — явная проверка (RLS тоже фильтрует, но роут
  // отдаёт понятный 404, а не полагается только на пустой select от RLS).
  // select("*") (не точечный список колонок) — до миграции T5 колонки config
  // ещё нет в database.types.ts, но "*" переживёт её появление без правки
  // этого select; парсим config ниже через cast (см. parseHqConfig).
  const { data: hq, error: hqError } = await supabase
    .from("study_hqs")
    .select("*")
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

  const hqConfig = parseHqConfig((hq as { config?: unknown }).config);
  if (!isEmptyHqConfig(hqConfig)) {
    const validation = validateHqConfig(spec, hqConfig);
    if (!validation.ok) {
      return NextResponse.json({ error: "reconfigure_needed" }, { status: 422 });
    }
  }

  // hq/exam_profiles уже прочитаны и провладены выше на user-клиенте; сборка
  // теста читает банк tasks (id/body/answer и т.п.) через taskReadClient
  // (service-role, если SUPABASE_SECRET_KEY задан; иначе временный фолбэк на
  // user-клиент — см. src/lib/supabase/admin.ts), таск-репо их парсит
  // (rowToTaskSafe). testRepo — обычный user-клиент (tests/attempts не
  // тронуты миграцией).
  const test = await assembleTest(
    {
      taskRepo: supabaseTaskRepo(taskReadClient(supabase)),
      testRepo: supabaseTestRepo(supabase),
      llm: createLlm(),
    },
    { hqId: hq.id, examProfile, kind: parsed.data.kind, hqConfig },
  );

  // Ответ намеренно минимален: tests.spec содержит только taskIds, ответы в
  // него не входят, но всё равно отдаём наружу только id — клиент дальше
  // стартует попытку через POST /api/attempts.
  return NextResponse.json({ testId: test.id });
}
