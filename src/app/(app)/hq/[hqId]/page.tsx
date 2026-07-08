import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";
import { examProfileSpecSchema } from "@/features/exam-profile/spec";
import { parseHqConfig, resolveActiveSections } from "@/features/exam-profile/selection";
import type { TopicState } from "@/features/knowledge/compute";
import { supabasePlanRepo } from "@/features/plan/repo";
import type { Forecast, ForecastConfidence } from "@/features/forecast/compute";
import type { TestKind } from "@/features/tests/spec";
import {
  buildKnowledgeMapSections,
  isHqStale,
  parseTargetNumber,
  selectCurrentWeek,
} from "@/features/hq/dashboard-view";
import { StartTestButton } from "@/components/start-test-button";
import { KnowledgeMap } from "./KnowledgeMap";
import { WeekPlanCard } from "./WeekPlanCard";
import { ForecastCard } from "./ForecastCard";
import { RecomputeKicker } from "./RecomputeKicker";

// D2/Task6: дашборд штаба — server component, GET-рендер, 🔴 НОЛЬ записей
// (Global Constraints: пересчёт живёт только в write-путях — submit-хук,
// POST recompute, study-hqs UPDATE-ветка; НИКАКОГО вызова recomputeHqInsights
// отсюда, даже "просто чтобы поправить stale"). Staleness лишь решает,
// монтировать ли клиентский <RecomputeKicker/> (сам делает fire-and-forget
// POST и router.refresh() по успеху).
export default async function HqDashboardPage({
  params,
}: {
  params: Promise<{ hqId: string }>;
}) {
  const { hqId } = await params;
  const supabase = await supabaseServer();

  // Тот же паттерн, что и /hq/[hqId]/tests/[testId]: (app)-layout уже
  // гейтит анонимов, но страница всё равно сама проверяет владение — не
  // полагаемся молча на RLS.
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) notFound();

  // (1) study_hqs by id+user (ownership) + exam_profiles join.
  const { data: hqRow } = await supabase
    .from("study_hqs")
    .select("id, config, exam_date, target, last_recomputed_at, exam_profiles(slug, title, spec)")
    .eq("id", hqId)
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (!hqRow) notFound();

  const t = await getTranslations("hqDashboard");
  const profile = hqRow.exam_profiles;

  // Хвост T1 (Stage3): битая/устаревшая spec (ручная правка в БД, регресс
  // апстрима) деградирует к title + сообщению, НЕ 500 — весь остальной
  // дашборд (карта/план/прогноз) требует валидной spec, без неё рендерить
  // нечего.
  const parsedSpec = profile ? examProfileSpecSchema.safeParse(profile.spec) : null;
  if (!profile || !parsedSpec?.success) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <h1 className="text-xl font-semibold">{profile?.title ?? "—"}</h1>
        <p className="text-sm text-red-600">{t("specBroken")}</p>
      </main>
    );
  }
  const spec = parsedSpec.data;
  const config = parseHqConfig(hqRow.config);
  const activeSections = resolveActiveSections(spec, config);
  const examDate = hqRow.exam_date ? new Date(hqRow.exam_date) : null;
  const target = parseTargetNumber(hqRow.target);
  const lastRecomputedAt = hqRow.last_recomputed_at ? new Date(hqRow.last_recomputed_at) : null;
  const now = new Date();

  // (2) knowledge_states по hq — плоское чтение, НЕ через KnowledgeRepo
  // (та граница читает сырые attempt_items для write-пути пересчёта; здесь
  // нужны уже посчитанные строки карты as-is).
  const { data: stateRows } = await supabase
    .from("knowledge_states")
    .select("topic, level, answered_count, last_seen_at")
    .eq("hq_id", hqId);
  const states = new Map<string, TopicState>();
  for (const row of stateRows ?? []) {
    // Битая строка (last_seen_at отсутствует/невалиден, level не число) —
    // скип, а не throw: одна испорченная строка не должна ронять весь
    // дашборд. upsertStates (Task3) всегда пишет оба поля явно, так что в
    // норме это недостижимо — защита на всякий случай.
    if (row.last_seen_at == null || !Number.isFinite(row.level)) continue;
    const lastSeenAt = new Date(row.last_seen_at);
    if (!Number.isFinite(lastSeenAt.getTime())) continue;
    states.set(row.topic, { level: row.level, answeredCount: row.answered_count, lastSeenAt });
  }

  // (3) plan weeks — переиспользуем PlanRepo.loadWeeks (уже делает
  // safeParse на чтении, та же защита от битых строк).
  const weeks = await supabasePlanRepo(supabase).loadWeeks(hqId);
  const currentWeek = selectCurrentWeek(weeks, now);

  // (4) latest forecast — прямой select (НЕ ForecastRepo.latest: та
  // возвращает урезанный {point,low,high} только для внутреннего дедупа
  // append(), дашборду нужны ещё confidence/coverage).
  const { data: forecastRow } = await supabase
    .from("forecasts")
    .select("point, low, high, confidence, coverage")
    .eq("hq_id", hqId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const forecast: Forecast | null =
    forecastRow && forecastRow.point !== null
      ? {
          point: forecastRow.point,
          low: forecastRow.low,
          high: forecastRow.high,
          confidence: forecastRow.confidence as ForecastConfidence,
          coverage: forecastRow.coverage ?? 0,
        }
      : null;

  // (5) лёгкий max(finished_at) + count завершённых попыток hq (tests →
  // attempts), без единого item/task в выборке.
  const { data: hqTests } = await supabase.from("tests").select("id").eq("hq_id", hqId);
  const testIds = (hqTests ?? []).map((row) => row.id);
  let maxFinishedAt: Date | null = null;
  let finishedCount = 0;
  if (testIds.length > 0) {
    const { data: latestFinished } = await supabase
      .from("attempts")
      .select("finished_at")
      .in("test_id", testIds)
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestFinished?.finished_at) {
      const d = new Date(latestFinished.finished_at);
      if (Number.isFinite(d.getTime())) maxFinishedAt = d;
    }

    const { count } = await supabase
      .from("attempts")
      .select("id", { count: "exact", head: true })
      .in("test_id", testIds)
      .not("finished_at", "is", null);
    finishedCount = count ?? 0;
  }

  const stale = isHqStale(maxFinishedAt, lastRecomputedAt);
  const mapSections = buildKnowledgeMapSections(activeSections, states, now);
  const mapEmpty = states.size === 0;

  // Кнопка внизу берёт kind из suggestedTest текущей недели (всегда
  // 'practice'|'mock' — planWeekTopicsSchema), 'diagnostic' по умолчанию,
  // если недели нет вовсе.
  const suggestedKind: TestKind = currentWeek?.topics.suggestedTest.kind ?? "diagnostic";

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold">{profile.title}</h1>

      <ForecastCard forecast={forecast} target={target} unit={spec.scoring.unit} finishedCount={finishedCount} />

      {mapEmpty ? (
        // 🔴 Task6 acceptance: пустая карта -> CTA-блок вместо неё, с
        // явным kind='diagnostic' (первая попытка всегда диагностика,
        // независимо от suggestedTest несуществующей ещё истории) + подпись.
        // Замещает и штатную нижнюю кнопку — второй StartTestButton внизу
        // страницы был бы дублем того же призыва.
        <section className="flex flex-col items-start gap-2 rounded border border-dashed p-6">
          <p className="text-sm text-gray-600">{t("emptyMap")}</p>
          <StartTestButton hqId={hqId} slug={profile.slug} kind="diagnostic" />
          <p className="text-xs text-gray-400">{t("emptyMapCta")}</p>
        </section>
      ) : (
        <KnowledgeMap sections={mapSections} />
      )}

      <WeekPlanCard examDateIsSet={examDate !== null} currentWeek={currentWeek} />

      {!mapEmpty && <StartTestButton hqId={hqId} slug={profile.slug} kind={suggestedKind} />}

      {stale && <RecomputeKicker hqId={hqId} />}
    </main>
  );
}
