import { notFound, redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { examProfileSpecSchema } from "@/features/exam-profile/spec";
import { parseHqConfig, validateHqConfig } from "@/features/exam-profile/selection";
import { buildOnboardingSteps } from "@/features/onboarding/steps";
import { OnboardingWizard } from "./OnboardingWizard";

// Stage3 T1: parseHqConfig (Array.isArray-гард включён) консолидирован в
// selection.ts — раньше был продублирован здесь и в /api/tests/route.ts
// (см. jsdoc в selection.ts). validateHqConfig трактует null как "нет
// variantKey" -> невалидно, если spec.variants непуст.

// D1 (Stage 2.5, Task 7): интервью-визард. Auth уже гарантирован
// (app)/layout.tsx (redirect на /sign-in при отсутствии сессии) — здесь
// повторный supabase.auth.getUser() нужен только для server-guard ниже, не
// для самого гейтинга доступа к странице.
export default async function OnboardingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = await supabaseServer();

  const { data: row } = await supabase
    .from("exam_profiles")
    .select("id, spec")
    .eq("slug", slug)
    .maybeSingle();
  if (!row) notFound();

  const parsedSpec = examProfileSpecSchema.safeParse(row.spec);
  if (!parsedSpec.success) notFound();
  const spec = parsedSpec.data;

  // 🔴 D1 server-guard: у юзера уже есть штаб на этот exam_profile_id ->
  // повторный визарда не имеет смысла и рискует затереть существующий
  // config без предупреждения (MVP, см. Open Questions #5 плана) ->
  // редиректим в штаб, а не даём молча пере-онбордиться.
  //
  // final-review Fix1b: но ТОЛЬКО если существующий config всё ещё валиден.
  // Раньше редиректили на /hq при ЛЮБОМ существующем hq — если spec потом
  // менялась (например, /api/exam-profiles/refine), config переставал
  // проходить validateHqConfig и юзер попадал в глухой тупик (422
  // reconfigure_needed на /api/tests, а сюда его отсюда же выпинывало назад
  // в /hq). Теперь: валидный config -> редирект как раньше; невалидный/
  // непарсибельный -> пропускаем в визард, юзер переконфигурируется — финал
  // визарда UPDATE'ит существующий hq (см. /api/study-hqs/route.ts).
  const { data: userData } = await supabase.auth.getUser();
  if (userData.user) {
    const { data: existingHq } = await supabase
      .from("study_hqs")
      .select("id, config")
      .eq("user_id", userData.user.id)
      .eq("exam_profile_id", row.id)
      .maybeSingle();
    if (existingHq) {
      const existingConfig = parseHqConfig(existingHq.config);
      const validation = validateHqConfig(spec, existingConfig);
      if (validation.ok) redirect("/hq");
    }
  }

  const steps = buildOnboardingSteps(spec);

  return (
    <OnboardingWizard
      slug={slug}
      profileId={row.id}
      examName={spec.examName}
      description={spec.description}
      country={spec.country ?? null}
      sections={spec.sections.map((s) => ({ name: s.name, taskCount: s.taskCount ?? null }))}
      variants={spec.variants}
      selectionGroups={spec.selectionGroups}
      steps={steps}
    />
  );
}
