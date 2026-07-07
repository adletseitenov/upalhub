import { notFound } from "next/navigation";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";
import { examProfileSpecSchema, sourceRefSchema } from "@/features/exam-profile/spec";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { PrepareButton } from "@/components/prepare-button";
import { RefineForm } from "@/components/refine-form";

export default async function ExamProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await getTranslations("profile");
  const supabase = await supabaseServer();
  const { data: row } = await supabase
    .from("exam_profiles")
    .select("*")
    .eq("slug", slug)
    .maybeSingle();
  if (!row) notFound();
  const parsedSpec = examProfileSpecSchema.safeParse(row.spec);
  if (!parsedSpec.success) notFound();
  const spec = parsedSpec.data;
  const parsedSources = z.array(sourceRefSchema).safeParse(row.sources ?? []);
  const sources = parsedSources.success ? parsedSources.data : [];
  const { data: userData } = await supabase.auth.getUser();
  const isCreator = userData.user != null && row.created_by === userData.user.id;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{spec.examName}</h1>
        <LocaleSwitcher />
      </header>
      <p className="rounded border px-3 py-1 text-sm">{t(`trust_${row.trust}`)}</p>
      <p>{spec.description}</p>

      <section>
        <h2 className="mb-2 font-semibold">{t("sections")}</h2>
        <ul className="flex flex-col gap-2">
          {spec.sections.map((s) => (
            <li key={s.name} className="rounded border p-3">
              <p className="font-medium">{s.name}</p>
              <p className="text-sm text-gray-500">
                {[
                  s.taskCount ? `${s.taskCount} ${t("tasks")}` : null,
                  s.timeLimitMinutes ? `${s.timeLimitMinutes} ${t("minutes")}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {s.topics.length > 0 && (
                <p className="text-sm text-gray-500">{s.topics.join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="text-sm">
        <p>
          <span className="font-semibold">{t("scoring")}:</span> {spec.scoring.scaleMin}–
          {spec.scoring.scaleMax} {spec.scoring.unit}
          {spec.scoring.passingScore != null &&
            ` (${t("passing")}: ${spec.scoring.passingScore})`}
        </p>
        {spec.totalTimeMinutes != null && (
          <p>
            <span className="font-semibold">{t("totalTime")}:</span> {spec.totalTimeMinutes}{" "}
            {t("minutes")}
          </p>
        )}
        {spec.typicalDates && (
          <p>
            <span className="font-semibold">{t("dates")}:</span> {spec.typicalDates}
          </p>
        )}
      </section>

      <PrepareButton slug={slug} />

      <section>
        <h2 className="mb-2 font-semibold">{t("sources")}</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {sources.map((s) => (
            <li key={s.url}>
              <a className="underline" href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title || s.url}
              </a>
            </li>
          ))}
        </ul>
      </section>

      {isCreator && <RefineForm slug={slug} />}
    </main>
  );
}
