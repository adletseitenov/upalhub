"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

// D5 «Дособрать» (T6): показывается сервер-компонентом страницы теста ТОЛЬКО
// когда partial && !attemptExists. refillCount/actual — часть контракта со
// страницей (снапшот на момент рендера; смена refillCount после успешного
// router.refresh() естественно перемонтирует эту кнопку через key={refillCount}
// у вызывающей стороны, сбрасывая busy/stuck state без явного useEffect).
export type RefillButtonProps = {
  testId: string;
  refillCount: number;
  actual: number;
};

type Status = "idle" | "rate_limited" | "attempt_exists" | "no_progress" | "error";

export function RefillButton({ testId }: RefillButtonProps) {
  const router = useRouter();
  const t = useTranslations("testRunner");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  // 🔴 «дособрать не удалось» — после stuck кнопка навсегда задизейблена до
  // следующего захода на страницу (новый серверный рендер = новый компонент).
  const stuck = status === "no_progress" || status === "attempt_exists";

  async function refill() {
    if (busy || stuck) return; // busy-lock
    setBusy(true);
    setStatus("idle");
    try {
      const res = await fetch(`/api/tests/${testId}/refill`, { method: "POST" });
      if (res.status === 429) {
        setStatus("rate_limited");
        setBusy(false);
        return;
      }
      if (res.status === 409) {
        setStatus("attempt_exists");
        setBusy(false);
        return;
      }
      if (!res.ok) {
        setStatus("error");
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { taskCount: number; previousTaskCount: number };
      if (data.taskCount === data.previousTaskCount) {
        // Пересборка отработала, но не добавила ни одного задания (банк
        // исчерпан/LLM не смог добрать) — честно сообщаем и не зовём
        // router.refresh() (страница всё равно покажет тот же actual, кнопка
        // просто должна замолчать до следующего визита).
        setStatus("no_progress");
        setBusy(false);
        return;
      }
      router.refresh();
      // busy остаётся true до перерендера страницы (новый testCount) — тот
      // же паттерн, что и StartTestButton при успешной навигации.
    } catch {
      setStatus("error");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={refill}
        disabled={busy || stuck}
        className="self-start rounded border px-4 py-2 text-sm font-medium"
      >
        {busy ? t("refillBusy") : t("refill")}
      </button>
      {status === "rate_limited" && <p className="text-sm text-red-600">{t("refillRateLimited")}</p>}
      {status === "attempt_exists" && <p className="text-sm text-red-600">{t("refillAttemptExists")}</p>}
      {status === "no_progress" && <p className="text-sm text-gray-500">{t("refillNoProgress")}</p>}
      {status === "error" && <p className="text-sm text-red-600">{t("error")}</p>}
    </div>
  );
}
