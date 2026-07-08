import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { StartTestButton } from "@/components/start-test-button";

export default async function HqPage() {
  const t = await getTranslations("hq");
  const supabase = await supabaseServer();
  const { data: hqs } = await supabase
    .from("study_hqs")
    .select("id, exam_profiles(slug, title)")
    .order("created_at", { ascending: false });

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <LocaleSwitcher />
      </header>
      <h2 className="font-medium">{t("myExams")}</h2>
      {!hqs || hqs.length === 0 ? (
        <p className="text-sm text-gray-500">
          {t("empty")} — <Link className="underline" href="/">{t("addExam")}</Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {hqs.map((hq) => (
            <li key={hq.id} className="flex flex-col gap-2 rounded border p-3">
              <Link className="underline" href={`/exams/${hq.exam_profiles?.slug}`}>
                {hq.exam_profiles?.title}
              </Link>
              <StartTestButton hqId={hq.id} slug={hq.exam_profiles?.slug ?? ""} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
