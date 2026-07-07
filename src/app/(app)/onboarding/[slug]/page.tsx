import { notFound, redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { examProfileSpecSchema } from "@/features/exam-profile/spec";
import { buildOnboardingSteps } from "@/features/onboarding/steps";
import { OnboardingWizard } from "./OnboardingWizard";

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
  const { data: userData } = await supabase.auth.getUser();
  if (userData.user) {
    const { data: existingHq } = await supabase
      .from("study_hqs")
      .select("id")
      .eq("user_id", userData.user.id)
      .eq("exam_profile_id", row.id)
      .maybeSingle();
    if (existingHq) redirect("/hq");
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
