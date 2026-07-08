"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

// D2/D7 🔴: дашборд — GET-рендер, НОЛЬ записей (Global Constraints плана).
// page.tsx решает staleness на сервере (src/features/hq/dashboard-view.ts,
// isHqStale) и монтирует этот компонент ТОЛЬКО в этом случае — он сам не
// проверяет ничего, просто делает ОДИН fire-and-forget POST на монтаж.
//
// busy-гард — useRef, НЕ useState: эффект не должен ре-рендериться из-за
// собственного гарда (тот же паттерн, что и submit/attemptId-рефы в
// TestRunner.tsx). Пустой deps-массив + ref-гард — это НЕ "setState in
// effect" (нет ни одного вызова set-функции здесь вообще, только
// router.refresh() по успеху) — react-hooks/exhaustive-deps глушится тем же
// способом, что и в TestRunner.tsx (резюм завершённой попытки, ровно один
// раз на монтаж).
export function RecomputeKicker({ hqId }: { hqId: string }) {
  const router = useRouter();
  const t = useTranslations("hqDashboard");
  const firedRef = useRef(false);

  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    (async () => {
      try {
        const res = await fetch(`/api/hq/${hqId}/recompute`, { method: "POST" });
        if (res.ok) router.refresh();
        // 401/403/404/429/500: молча — кикер best-effort, не блокирует
        // рендер уже показанного дашборда стейл-данными.
      } catch {
        // сетевой сбой — молча, тот же best-effort контракт.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <p className="text-sm text-gray-400">{t("refreshing")}</p>;
}
