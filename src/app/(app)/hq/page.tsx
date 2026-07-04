import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";
import { LocaleSwitcher } from "@/components/locale-switcher";

export default async function HqPage() {
  const t = await getTranslations("hq");
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  return (
    <main className="flex flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <LocaleSwitcher />
      </header>
      <p className="text-sm text-gray-500">{data.user?.email}</p>
    </main>
  );
}
