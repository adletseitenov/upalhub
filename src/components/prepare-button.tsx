"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

// D1 (Stage 2.5): вместо прямого POST /api/study-hqs кнопка теперь ведёт в
// интервью-визард — сам /api/study-hqs зовётся из финального шага
// OnboardingWizard, с выбором варианта/секций/даты. Публичная страница
// профиля (/exams/[slug]) остаётся библиотечным активом.
export function PrepareButton({ slug }: { slug: string }) {
  const router = useRouter();
  const t = useTranslations("profile");
  const [busy, setBusy] = useState(false);

  function prepare() {
    if (busy) return;
    setBusy(true);
    router.push(`/onboarding/${slug}`);
  }

  return (
    <button onClick={prepare} disabled={busy} className="rounded border px-6 py-3 font-medium">
      {busy ? t("preparing") : t("prepare")}
    </button>
  );
}
