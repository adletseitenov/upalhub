"use client";
import { useTranslations } from "next-intl";

export type ResultViewProps = {
  raw: number;
  scaled: number;
  total: number;
  unit: string;
  passingScore?: number | null;
};

// Балл в шкале экзамена помечен «приблизительно» (D5: линейная интерполяция
// + округление к шагу — не официальная методика конвертации). Переживает
// passingScore === null/undefined (не у каждого экзамена он задан).
export function ResultView({ raw, scaled, total, unit, passingScore }: ResultViewProps) {
  const t = useTranslations("testResult");

  return (
    <section className="flex flex-col items-center gap-2 rounded border p-6 text-center">
      <p className="text-sm text-gray-500">{t("approx")}</p>
      <p className="text-5xl font-bold">
        {scaled} <span className="text-2xl font-medium text-gray-500">{unit}</span>
      </p>
      <p className="text-sm text-gray-500">
        {t("raw")}: {raw} {t("of")} {total}
      </p>
      {passingScore != null && (
        <p className="text-sm text-gray-500">
          {t("passing")}: {passingScore} {unit}
        </p>
      )}
    </section>
  );
}
