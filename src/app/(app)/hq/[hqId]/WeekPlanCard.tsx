import { getTranslations } from "next-intl/server";
import type { StoredPlanWeek } from "@/features/plan/repo";

export type WeekPlanCardProps = {
  /** study_hqs.exam_date !== null — план-статус НЕ хранится в БД (D3), этот
   * баннер деривируется прямо из наличия даты экзамена на каждом рендере. */
  examDateIsSet: boolean;
  /** Уже выбранная текущая неделя (src/features/hq/dashboard-view.ts,
   * selectCurrentWeek) — null, если ни одна неделя не покрывает "сегодня"
   * (план ещё не построен ни разу, либо дата экзамена в прошлом и горизонт
   * заморожен). */
  currentWeek: StoredPlanWeek | null;
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// D3/Task6: server-компонент (план не требует клиентского состояния — чисто
// презентационный рендер уже готовой недели). Band тем здесь намеренно НЕ
// дублируется (это ответственность KnowledgeMap) — фокус-темы несут
// reason-подпись (weak/unexplored/stale/review), этого достаточно для
// "почему именно эта тема на этой неделе".
export async function WeekPlanCard({ examDateIsSet, currentWeek }: WeekPlanCardProps) {
  const t = await getTranslations("hqDashboard");

  // Нет ни одной подходящей недели вообще: если дата экзамена не указана —
  // всё равно стоит подтолкнуть её указать (план по умолчанию строится на 8
  // недель, но точнее с реальной датой); если дата указана — сказать
  // нечего (нет спец-копирайта под "план ещё не считался"/"дата в прошлом" —
  // молчаливое отсутствие карточки честнее выдуманной фразы).
  if (!currentWeek) {
    if (!examDateIsSet) {
      return (
        <section className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold">{t("planTitle")}</h2>
          <p className="text-sm text-amber-800">{t("noExamDate")}</p>
        </section>
      );
    }
    return null;
  }

  return (
    <section className="flex flex-col gap-3 rounded border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">{t("planTitle")}</h2>
        <span className="text-sm text-gray-500">{t("planWeek", { date: currentWeek.weekStart })}</span>
      </div>
      {!examDateIsSet && <p className="text-sm text-amber-700">{t("noExamDate")}</p>}
      {currentWeek.topics.focus.length > 0 && (
        <ul className="flex flex-col gap-2">
          {currentWeek.topics.focus.map((item) => (
            <li key={item.topic} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {item.topic} <span className="text-gray-400">— {item.section}</span>
              </span>
              <span className="text-gray-500">{t(`reason${capitalize(item.reason)}`)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-gray-500">
        {t("suggestedTest")}: {capitalize(currentWeek.topics.suggestedTest.kind)}
      </p>
    </section>
  );
}
