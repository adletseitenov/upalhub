"use client";
import { useTranslations } from "next-intl";

// Busy-состояние сборки теста (D2/D3: до 3 LLM-вызовов, ≤60с). Используется
// StartTestButton, пока ждём ответ POST /api/tests.
export function GeneratingState() {
  const t = useTranslations("testRunner");

  return (
    <div className="flex items-center gap-2 text-sm text-gray-500">
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-600"
      />
      <span>{t("generating")}</span>
    </div>
  );
}
