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

export type HqContext = { spec: ExamProfileSpec | null; config: HqConfig | null };

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
        .select("exam_profile_id, config")
        .eq("id", hqId)
        .maybeSingle();
      if (hqError) throw hqError;
      if (!hq) return { spec: null, config: null };

      const { data: profileRow, error: profileError } = await client
        .from("exam_profiles")
        .select("spec")
        .eq("id", hq.exam_profile_id)
        .maybeSingle();
      if (profileError) throw profileError;
      if (!profileRow) return { spec: null, config: null };

      const parsedSpec = examProfileSpecSchema.safeParse(profileRow.spec);
      return {
        spec: parsedSpec.success ? parsedSpec.data : null,
        config: parseHqConfig(hq.config),
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
  // TODO(Stage3 Task4): planRepo — реген понедельного плана (buildStudyPlan,
  // D3) встраивается здесь между upsertStates и touchWatermark; использует
  // states + activeSections + context.spec/config (examDate/target).
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
 * upsertStates/будущих T4/T5) пробрасывается КАК ЕСТЬ и watermark в этом
 * случае не трогается — вызывающая сторона решает (submit-хук глотает и
 * логирует, recompute-роут отвечает 500).
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

  // TODO(Task4): buildStudyPlan(...) + DELETE-future/INSERT недель.
  // TODO(Task5): computeForecast(...) + append с дедупом по (point,low,high).

  await deps.knowledgeRepo.touchWatermark(hqId, now);
}
