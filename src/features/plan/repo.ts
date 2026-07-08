// D3: supabase-граница понедельного плана — единственное место, где
// PlanWeek[] (из pure buildStudyPlan, build.ts) ложится в study_plan_weeks и
// откуда её же читают обратно. Ноль доменной логики здесь — только
// чтение/запись + защита от битых строк (safeParse на чтении).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { PlanWeek, PlanWeekTopics } from "./build";
import { planWeekTopicsSchema } from "./build";

export type StoredPlanWeek = { weekStart: string; topics: PlanWeekTopics; status: string };

export interface PlanRepo {
  /**
   * 🔴 Реген недель горизонта: DELETE все строки study_plan_weeks(hq_id)
   * с week_start >= mondayUtc(текущего пересчёта), ПОТОМ INSERT свежего
   * набора `weeks` со status='planned'. Порог удаления берётся как
   * минимальный weekStart среди `weeks` — buildStudyPlan (D3) ВСЕГДА строит
   * первую неделю горизонта ровно на mondayUtc(now пересчёта), так что этот
   * минимум и есть "текущий понедельник" на момент вызова; отдельного
   * параметра `today`/`now` поэтому не требуется. Прошлые недели (week_start
   * до этого порога) НЕ трогаются — заморожены. Перенос даты экзамена раньше
   * не оставляет "недель-призраков" за пределами нового горизонта, т.к.
   * DELETE использует >= (не диапазон), а не просто "добавляет" новые.
   * No-op (без сетевого вызова), если `weeks` пуст — вызывающая сторона
   * (recompute.ts) и так не должна звать это при status='examDatePassed',
   * но пустой массив на всякий случай не должен молча удалить все future
   * недели без замены.
   */
  replaceFutureWeeks(hqId: string, weeks: PlanWeek[]): Promise<void>;
  /** Все недели hq по возрастанию week_start; битые topics (не проходят
   * planWeekTopicsSchema.safeParse) молча скипаются — одна испорченная
   * строка не должна ронять чтение всего плана. */
  loadWeeks(hqId: string): Promise<StoredPlanWeek[]>;
}

export function supabasePlanRepo(client: SupabaseClient<Database>): PlanRepo {
  return {
    async replaceFutureWeeks(hqId, weeks) {
      if (weeks.length === 0) return;

      const threshold = weeks.reduce(
        (min, w) => (w.weekStart < min ? w.weekStart : min),
        weeks[0].weekStart,
      );

      const { error: deleteError } = await client
        .from("study_plan_weeks")
        .delete()
        .eq("hq_id", hqId)
        .gte("week_start", threshold);
      if (deleteError) throw deleteError;

      const rows = weeks.map((w) => ({
        hq_id: hqId,
        week_start: w.weekStart,
        topics: w.topics as unknown as Json,
        status: "planned",
      }));
      const { error: insertError } = await client
        .from("study_plan_weeks")
        .insert(rows as unknown as Database["public"]["Tables"]["study_plan_weeks"]["Insert"][]);
      if (insertError) throw insertError;
    },

    async loadWeeks(hqId) {
      const { data, error } = await client
        .from("study_plan_weeks")
        .select("week_start, topics, status")
        .eq("hq_id", hqId)
        .order("week_start", { ascending: true });
      if (error) throw error;

      const result: StoredPlanWeek[] = [];
      for (const row of data ?? []) {
        const parsed = planWeekTopicsSchema.safeParse(row.topics);
        if (!parsed.success) {
          console.warn(`study_plan_weeks row (hq=${hqId}, week=${row.week_start}) has invalid topics, skipping:`, parsed.error);
          continue;
        }
        result.push({ weekStart: row.week_start, topics: parsed.data, status: row.status });
      }
      return result;
    },
  };
}
