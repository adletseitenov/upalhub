import { getTranslations } from "next-intl/server";
import { LocaleSwitcher } from "@/components/locale-switcher";

export default async function Home() {
  const t = await getTranslations();
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b p-4">
        <span className="font-semibold">{t("shell.appName")}</span>
        <LocaleSwitcher />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
        <h1 className="max-w-xl text-3xl font-semibold">{t("home.tagline")}</h1>
        <a href="/sign-in" className="rounded border px-6 py-2">
          {t("home.cta")}
        </a>
      </main>
    </div>
  );
}
