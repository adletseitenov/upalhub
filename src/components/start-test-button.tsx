"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { GeneratingState } from "./GeneratingState";

// Точка запуска движка тестов из штаба (D3/Task 6): POST /api/tests
// собирает (или переиспользует тёплый банк) диагностику и возвращает
// testId — дальше юзер идёт на страницу прохождения, которая сама стартует
// попытку (POST /api/attempts).
export function StartTestButton({ hqId }: { hqId: string }) {
  const router = useRouter();
  const t = useTranslations("testRunner");
  const [busy, setBusy] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);

  async function start() {
    setBusy(true);
    setRateLimited(false);
    const res = await fetch("/api/tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hqId, kind: "diagnostic" }),
    });
    if (res.status === 401) return router.push("/sign-in");
    if (res.status === 429) {
      setRateLimited(true);
      setBusy(false);
      return;
    }
    if (res.ok) {
      const { testId } = (await res.json()) as { testId: string };
      return router.push(`/hq/${hqId}/tests/${testId}`);
    }
    setBusy(false);
  }

  if (busy) return <GeneratingState />;

  return (
    <div className="flex flex-col gap-1">
      <button onClick={start} className="rounded border px-4 py-2 text-sm font-medium">
        {t("start")}
      </button>
      {rateLimited && <p className="text-sm text-red-600">{t("rateLimited")}</p>}
    </div>
  );
}
