import { notFound } from "next/navigation";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";
import {
  examProfileSpecSchema,
  sourceRefSchema,
  type ExamSection,
  type SelectionGroup,
} from "@/features/exam-profile/spec";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { PrepareButton } from "@/components/prepare-button";
import { RefineForm } from "@/components/refine-form";

type Translator = Awaited<ReturnType<typeof getTranslations>>;

// D4/Task 10: секция может входить в несколько selectionGroups (редко, но
// целостность спеки этого не запрещает) — рендерим бейдж на каждую
// совпавшую группу, компактно (badge на карточке, а не подзаголовок группы —
// подзаголовок не подходит, т.к. одна и та же секция может уйти в неск.
// group/variant блоков, а группа физически не «владеет» отдельным блоком в
// текущей верстке).
function SectionCard({
  section,
  selectionGroups,
  t,
  tAudio,
}: {
  section: ExamSection;
  selectionGroups: SelectionGroup[];
  t: Translator;
  tAudio: Translator;
}) {
  const matchingGroups = selectionGroups.filter((g) => g.sectionNames.includes(section.name));
  const isAudio = section.modality === "audio";
  return (
    <li className="rounded border p-3">
      <p className="font-medium">
        {section.name}
        {matchingGroups.map((g) => (
          <span
            key={g.key}
            className="ml-2 rounded bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-600"
          >
            {t("selectionBadge", { n: g.chooseCount, m: g.sectionNames.length })}
          </span>
        ))}
        {isAudio && (
          <span className="ml-2 rounded bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-600">
            {tAudio("sectionBadge")}
          </span>
        )}
      </p>
      <p className="text-sm text-gray-500">
        {[
          section.taskCount ? `${section.taskCount} ${t("tasks")}` : null,
          section.timeLimitMinutes ? `${section.timeLimitMinutes} ${t("minutes")}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {section.topics.length > 0 && (
        <p className="text-sm text-gray-500">{section.topics.join(", ")}</p>
      )}
    </li>
  );
}

export default async function ExamProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = await getTranslations("profile");
  const tAudio = await getTranslations("audio");
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

  // Task 10 (D4): вариантный профиль (напр. НИШ физ-мат/хим-био) — секции
  // группируются по вариантам; секция может входить в несколько вариантов
  // сразу (это спектр, не выбор — рендерим её в каждом). Секции, не
  // упомянутые ни в одном варианте, идут общим блоком сверху. Плоский
  // профиль (variants=[]) — старая нерегруппированная верстка (регресс
  // запрещён), просто с добавленными бейджами (аддитивно, старые профили без
  // selectionGroups/modality ничего нового не показывают).
  const namesInVariants = new Set(spec.variants.flatMap((v) => v.sectionNames));
  const commonSections = spec.sections.filter((s) => !namesInVariants.has(s.name));

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
        {spec.variants.length === 0 ? (
          <ul className="flex flex-col gap-2">
            {spec.sections.map((s) => (
              <SectionCard
                key={s.name}
                section={s}
                selectionGroups={spec.selectionGroups}
                t={t}
                tAudio={tAudio}
              />
            ))}
          </ul>
        ) : (
          <div className="flex flex-col gap-4">
            {commonSections.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-gray-600">
                  {t("commonSections")}
                </h3>
                <ul className="flex flex-col gap-2">
                  {commonSections.map((s) => (
                    <SectionCard
                      key={s.name}
                      section={s}
                      selectionGroups={spec.selectionGroups}
                      t={t}
                      tAudio={tAudio}
                    />
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h3 className="mb-2 text-sm font-semibold text-gray-600">{t("variantsTitle")}</h3>
              <div className="flex flex-col gap-4">
                {spec.variants.map((variant) => {
                  const variantSections = variant.sectionNames
                    .map((name) => spec.sections.find((s) => s.name === name))
                    .filter((s): s is (typeof spec.sections)[number] => s != null);
                  return (
                    <div key={variant.key}>
                      <h4 className="mb-2 font-medium">{variant.label}</h4>
                      <ul className="flex flex-col gap-2">
                        {variantSections.map((s) => (
                          <SectionCard
                            key={s.name}
                            section={s}
                            selectionGroups={spec.selectionGroups}
                            t={t}
                            tAudio={tAudio}
                          />
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
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
