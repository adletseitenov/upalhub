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
import { reassembleTest } from "@/features/tests/assemble";
import { assemblyLimiter } from "@/features/tests/assembly-limiter";

// D5 «Дособрать»: reassembleTest может делать до 3 LLM-вызовов (тот же
// бюджет, что и первая сборка) — тот же maxDuration, что у POST /api/tests.
export const maxDuration = 60;

// Stage3 T1 (хвост 2.5): parseHqConfig — единая точка истины в
// src/features/exam-profile/selection.ts (консолидировано из локального
// дубля, который раньше жил здесь).

// D5: config считается "непустым" (требующим validateHqConfig -> 422) только
// если ученик реально что-то выбрал — легаси-штабы без онбординга (config
// null или {}) не должны блокировать "Дособрать" за то, что никогда не
// проходили визард.
function isEmptyHqConfig(config: HqConfig | null): boolean {
  return config === null || (config.variantKey == null && config.selectedSectionNames.length === 0);
}

export async function POST(_request: Request, { params }: { params: Promise<{ testId: string }> }) {
  const { testId } = await params;

  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // D5: общий с /api/tests лимитер (src/features/tests/assembly-limiter.ts) —
  // один инстанс на пользователя для обоих дорогих LLM-путей сборки.
  if (!assemblyLimiter.take(data.user.id)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const testRepo = supabaseTestRepo(supabase);
  const test = await testRepo.getTest(testId);
  if (!test) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Владение: hq теста должен принадлежать вызывающему. RLS тоже фильтрует,
  // но явная проверка отдаёт понятный 404 вместо молчаливой пустой выборки
  // (паттерн /api/tests, /api/attempts/[id]/submit).
  const { data: hq, error: hqError } = await supabase
    .from("study_hqs")
    .select("*")
    .eq("id", test.hqId)
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (hqError) throw hqError;
  if (!hq) return NextResponse.json({ error: "not_found" }, { status: 404 });

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

  // Тот же паттерн, что и /api/tests: hq/test/exam_profiles уже провладены
  // выше на user-клиенте; таск-репо для дособорки — через taskReadClient
  // (service-role, если SUPABASE_SECRET_KEY задан; иначе временный фолбэк на
  // user-клиент — см. src/lib/supabase/admin.ts).
  const newSpec = await reassembleTest(
    { taskRepo: supabaseTaskRepo(taskReadClient(supabase)), llm: createLlm() },
    { test, examProfile, hqConfig },
  );

  // D5/🔴 атомарная замена (RPC, TOCTOU-фикс красной команды): 0 строк
  // означает, что у теста уже есть попытка — не перезаписываем spec под
  // прохождением.
  const replaced = await testRepo.replaceTestSpecIfNoAttempts(testId, newSpec);
  if (!replaced) {
    return NextResponse.json({ error: "attempt_exists" }, { status: 409 });
  }

  // Ответ намеренно минимален (как и /api/tests): ни заданий, ни ответов —
  // только счётчики, по которым клиент решает, показывать ли прогресс.
  return NextResponse.json({
    taskCount: newSpec.taskIds.length,
    previousTaskCount: test.spec.taskIds.length,
  });
}
