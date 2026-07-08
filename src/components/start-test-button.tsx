"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { TestKind } from "@/features/tests/spec";
import { GeneratingState } from "./GeneratingState";

// Точка запуска движка тестов из штаба (D3/Task 6): POST /api/tests
// собирает (или переиспользует тёплый банк) тест и возвращает testId —
// дальше юзер идёт на страницу прохождения, которая сама стартует попытку
// (POST /api/attempts). slug нужен для 422-ветки ниже (ссылка назад в
// визард переконфигурации).
//
// 🔴 Task 6 red-team: `kind` — явный проп (default 'diagnostic', обратная
// совместимость со старым единственным вызовом из hq/page.tsx). Без него
// mock-калибровка (D4) мертва: дашборд предлагает suggestedTest.kind
// последней недели плана ('mock' на пред-экзаменационной неделе), и без
// проброса kind сюда кнопка всегда собирала бы diagnostic вместо mock.
export function StartTestButton({
  hqId,
  slug,
  kind = "diagnostic",
}: {
  hqId: string;
  slug: string;
  kind?: TestKind;
}) {
  const router = useRouter();
  const t = useTranslations("testRunner");
  const [busy, setBusy] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [error, setError] = useState(false);
  const [reconfigureNeeded, setReconfigureNeeded] = useState(false);

  async function start() {
    setBusy(true);
    setRateLimited(false);
    setError(false);
    setReconfigureNeeded(false);
    try {
      const res = await fetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hqId, kind }),
      });
      // 401/ok оставляют busy=true (GeneratingState) до завершения навигации —
      // setBusy(false) только на путях, где остаёмся на этой же странице.
      if (res.status === 401) return router.push("/sign-in");
      if (res.status === 429) {
        setRateLimited(true);
        setBusy(false);
        return;
      }
      if (res.status === 422) {
        // 🔴 final-review Fix1a: /api/tests отвечает 422 reconfigure_needed,
        // когда config штаба больше не проходит validateHqConfig (spec
        // поменялась после онбординга, например через /refine) — раньше это
        // был глухой тупик (busy молча сбрасывался). Теперь даём выход:
        // ссылка обратно в визард переконфигурации.
        setReconfigureNeeded(true);
        setBusy(false);
        return;
      }
      if (res.ok) {
        const { testId } = (await res.json()) as { testId: string };
        return router.push(`/hq/${hqId}/tests/${testId}`);
      }
      // Прочие не-ok (500 и т.п.) — тот же generic error, что и сетевой сбой
      // ниже (ключ testRunner.error уже есть и подходит).
      setError(true);
      setBusy(false);
    } catch {
      // Сетевой сбой/исключение: не оставляем кнопку зависшей в
      // GeneratingState — сбрасываем busy и показываем ошибку.
      setError(true);
      setBusy(false);
    }
  }

  if (busy) return <GeneratingState />;

  return (
    <div className="flex flex-col gap-1">
      <button onClick={start} className="rounded border px-4 py-2 text-sm font-medium">
        {t("start")}
      </button>
      {rateLimited && <p className="text-sm text-red-600">{t("rateLimited")}</p>}
      {error && <p className="text-sm text-red-600">{t("error")}</p>}
      {reconfigureNeeded && (
        <p className="text-sm text-red-600">
          {t("reconfigureNeeded")}{" "}
          <Link href={`/onboarding/${slug}`} className="underline">
            {t("reconfigureLink")}
          </Link>
        </p>
      )}
    </div>
  );
}
