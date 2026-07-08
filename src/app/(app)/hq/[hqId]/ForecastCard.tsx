import { getTranslations } from "next-intl/server";
import type { Forecast } from "@/features/forecast/compute";
import { computeGoalGap, isNarrowForecast } from "@/features/hq/dashboard-view";

export type ForecastCardProps = {
  forecast: Forecast | null;
  /** study_hqs.target, уже распарсенный в число (parseTargetNumber) —
   * null означает "нет цели" (пустой/нечисловой target), gap-копирайт
   * скрыт. target НЕ участвует в математике прогноза (Global Constraints). */
  target: number | null;
  unit: string;
  /** Лёгкий count-запрос со страницы (D2 п.5) — прозрачность: на скольких
   * завершённых попытках построен прогноз. Гарантированно > 0, если
   * forecast не null (computeForecast гейтит nFinished===0 -> null). */
  finishedCount: number;
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// D4/D6/Task6: server-компонент — точка/диапазон/уверенность уже посчитаны
// оркестратором пересчёта (write-путь), здесь только чтение последней
// записи forecasts + чистое сравнение с целью (computeGoalGap,
// isNarrowForecast — src/features/hq/dashboard-view.ts, TDD-покрыты).
export async function ForecastCard({ forecast, target, unit, finishedCount }: ForecastCardProps) {
  const t = await getTranslations("hqDashboard");

  if (!forecast) {
    return (
      <section className="flex flex-col gap-1 rounded border p-4">
        <h2 className="font-semibold">{t("forecastTitle")}</h2>
        <p className="text-sm text-gray-500">{t("forecastEmpty")}</p>
      </section>
    );
  }

  const narrow = isNarrowForecast(forecast);
  const gap = computeGoalGap(target, forecast);

  return (
    <section className="flex flex-col gap-1 rounded border p-4">
      <h2 className="font-semibold">{t("forecastTitle")}</h2>
      <p className="text-sm text-gray-500">{t("approx")}</p>
      <p className="text-3xl font-bold">
        ≈{forecast.point} <span className="text-base font-medium text-gray-500">{unit}</span>
      </p>
      {/* D4 🔴: узкая шкала (low===high===point после округления к шагу) —
          показываем только точку, диапазон "X–X" был бы шумом. */}
      {!narrow && (
        <p className="text-sm text-gray-500">
          {forecast.low}–{forecast.high} {unit}
        </p>
      )}
      <p className="text-sm text-gray-500">
        {t(`confidence${capitalize(forecast.confidence)}`)} · {t("basedOn", { count: finishedCount })}
      </p>
      {/* D6 🔴: три ветки gap-копирайта; 'none' (нет цели/прогноза) уже
          отфильтрован выше (forecast точно не null здесь) — но target мог
          остаться null (нет цели), тогда computeGoalGap вернёт 'none' и
          ничего не рендерится. */}
      {gap.kind === "onTrack" && <p className="text-sm">{t("goalOnTrack")}</p>}
      {gap.kind === "above" && <p className="text-sm">{t("goalAbove")}</p>}
      {gap.kind === "gap" && (
        <p className="text-sm">{t("goalGap", { delta: Math.round(gap.delta * 10) / 10 })} {unit}</p>
      )}
    </section>
  );
}
