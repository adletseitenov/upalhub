// D7: оркестратор полного пересчёта карты/плана/прогноза для одного hq.
// Вызывается ТОЛЬКО из write-путей (submit-хук, POST recompute, будущая
// UPDATE-ветка study-hqs) — никогда из GET-рендера дашборда.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { examProfileSpecSchema } from "@/features/exam-profile/spec";
import type { ExamProfileSpec, ExamSection } from "@/features/exam-profile/spec";
import { parseHqConfig, resolveActiveSections } from "@/features/exam-profile/selection";
import type { HqConfig } from "@/features/exam-profile/selection";
import { computeKnowledgeStates } from "@/features/knowledge/compute";
import type { KnowledgeRepo } from "@/features/knowledge/repo";
import { buildStudyPlan } from "@/features/plan/build";
import type { PlanRepo } from "@/features/plan/repo";

export type HqContext = { spec: ExamProfileSpec | null; config: HqConfig | null; examDate: Date | null };

export interface HqReader {
  loadHqContext(hqId: string): Promise<HqContext>;
}

// study_hqs -> exam_profiles join, оба шага толерантны: отсутствующий hq,
// отсутствующий/битый профиль -> spec: null (оркестратор трактует это как
// "нечего пересчитывать", не как ошибку — см. recomputeHqInsights).
export function supabaseHqReader(client: SupabaseClient<Database>): HqReader {
  return {
    async loadHqContext(hqId) {
      const { data: hq, error: hqError } = await client
        .from("study_hqs")
        .select("exam_profile_id, config, exam_date")
        .eq("id", hqId)
        .maybeSingle();
      if (hqError) throw hqError;
      if (!hq) return { spec: null, config: null, examDate: null };

      // date-колонка (без времени) -> Date; ISO 'YYYY-MM-DD' парсится как
      // UTC-полночь (спецификация Date, не local-tz), что и требует D3
      // (mondayUtc-арифметика buildStudyPlan).
      const examDate = hq.exam_date ? new Date(hq.exam_date) : null;

      const { data: profileRow, error: profileError } = await client
        .from("exam_profiles")
        .select("spec")
        .eq("id", hq.exam_profile_id)
        .maybeSingle();
      if (profileError) throw profileError;
      if (!profileRow) return { spec: null, config: null, examDate };

      const parsedSpec = examProfileSpecSchema.safeParse(profileRow.spec);
      return {
        spec: parsedSpec.success ? parsedSpec.data : null,
        config: parseHqConfig(hq.config),
        examDate,
      };
    },
  };
}

// Мирроим buildPlan (src/features/tests/assemble.ts): секция без явных
// topics трактует своё ИМЯ как единственную тему (плоские экзамен-профили
// без разбивки на темы) — так же назначается task.topic при сборке теста.
// Без этого зеркалирования темы таких профилей никогда не набрали бы NMIN
// (activeTopics был бы пуст для секции, а tasks.topic == section.name).
function topicsOfSection(section: ExamSection): string[] {
  return section.topics.length > 0 ? section.topics : [section.name];
}

function activeTopicsOf(sections: ExamSection[]): Set<string> {
  return new Set(sections.flatMap(topicsOfSection));
}

export type RecomputeDeps = {
  hqReader: HqReader;
  knowledgeRepo: KnowledgeRepo;
  planRepo: PlanRepo;
  // TODO(Stage3 Task5): forecastRepo — append прогноза с дедупом
  // (computeForecast, D4) — тоже между upsertStates и touchWatermark;
  // использует states + inputs.nFinished + context.spec.scoring.
};

/**
 * recomputeHqInsights — D7. Полный (не инкрементальный) пересчёт,
 * идемпотентен: context → activeTopics → loadKnowledgeInputs →
 * computeKnowledgeStates → upsertStates → [T4 план] → [T5 прогноз] →
 * touchWatermark.
 *
 * Watermark (`study_hqs.last_recomputed_at`) обновляется ВСЕГДА при
 * успешном прохождении шагов выше — даже если карта осталась пустой (все
 * темы < NMIN: это не ошибка, а честный "пересчитано, данных пока
 * недостаточно", иначе such hq остаётся stale навечно). spec===null (hq не
 * существует, или профиль отсутствует/битый) — короткий путь: только
 * touchWatermark, знаниевые шаги вообще не запускаются.
 *
 * НЕТ try/catch: исключение из любого шага (loadKnowledgeInputs/
 * upsertStates/buildStudyPlan-записи/будущего T5) пробрасывается КАК ЕСТЬ и
 * watermark в этом случае не трогается — вызывающая сторона решает
 * (submit-хук глотает и логирует, recompute-роут отвечает 500).
 */
export async function recomputeHqInsights(
  deps: RecomputeDeps,
  args: { hqId: string; now: Date },
): Promise<void> {
  const { hqId, now } = args;
  const context = await deps.hqReader.loadHqContext(hqId);

  if (!context.spec) {
    await deps.knowledgeRepo.touchWatermark(hqId, now);
    return;
  }

  const activeSections = resolveActiveSections(context.spec, context.config);
  const activeTopics = activeTopicsOf(activeSections);

  const inputs = await deps.knowledgeRepo.loadKnowledgeInputs(hqId);
  const states = computeKnowledgeStates(inputs.items, activeTopics, now);
  await deps.knowledgeRepo.upsertStates(hqId, states);

  // D3/Task4: план строится из ТЕХ ЖЕ states/activeSections, что и карта
  // выше — единый снимок пересчёта. examDatePassed -> НЕ пишем (и не
  // удаляем прошлое): buildStudyPlan уже вернул weeks=[] для этого статуса,
  // а replaceFutureWeeks на пустом массиве и так no-op, но короткое условие
  // здесь делает намерение явным и не полагается на этот no-op молча.
  const plan = buildStudyPlan(states, activeSections, context.examDate, now);
  if (plan.status !== "examDatePassed") {
    await deps.planRepo.replaceFutureWeeks(hqId, plan.weeks);
  }

  // TODO(Task5): computeForecast(...) + append с дедупом по (point,low,high).

  await deps.knowledgeRepo.touchWatermark(hqId, now);
}
