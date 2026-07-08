// D1/Task3: supabase-граница карты знаний — единственное место, где
// attempt_items/attempts/tests/tasks превращаются в плоские KnowledgeItem[]
// для чистого computeKnowledgeStates (compute.ts), и где Map<topic,
// TopicState> обратно ложится в knowledge_states. Ноль доменной логики
// здесь — только чтение/запись + защита от битых строк.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { KnowledgeItem, TopicState } from "./compute";

export type KnowledgeInputs = {
  items: KnowledgeItem[];
  nFinished: number;
  maxFinishedAt: Date | null;
};

export interface KnowledgeRepo {
  /**
   * attempt_items ЗАВЕРШЁННЫХ попыток hq (join attempts → tests.hq_id) +
   * batch tasks (topic, difficulty). Битые строки (задание удалено из
   * банка, мусорная дата) скипаются молча — одна плохая строка не должна
   * ронять весь пересчёт. `answered` не фильтруется здесь (только
   * маппируется из response!=null) — фактическое исключение
   * answered=false из сигнала делает computeKnowledgeStates (D1).
   */
  loadKnowledgeInputs(hqId: string): Promise<KnowledgeInputs>;
  /**
   * Upsert on conflict (hq_id, topic) c ЯВНЫМ updated_at — колонка имеет
   * default now() в схеме, но default НЕ срабатывает на conflict-update
   * (только на insert), поэтому updated_at шлётся явно на каждый вызов.
   * Пустая карта (все темы < NMIN) — no-op, без сетевого вызова.
   */
  upsertStates(hqId: string, states: Map<string, TopicState>): Promise<void>;
  /** study_hqs.last_recomputed_at — единственный watermark пересчёта. */
  touchWatermark(hqId: string, now: Date): Promise<void>;
}

export function supabaseKnowledgeRepo(client: SupabaseClient<Database>): KnowledgeRepo {
  return {
    async loadKnowledgeInputs(hqId) {
      const { data: testRows, error: testsError } = await client
        .from("tests")
        .select("id")
        .eq("hq_id", hqId);
      if (testsError) throw testsError;
      const testIds = (testRows ?? []).map((row) => row.id);
      if (testIds.length === 0) return { items: [], nFinished: 0, maxFinishedAt: null };

      const { data: attemptRows, error: attemptsError } = await client
        .from("attempts")
        .select("id, finished_at")
        .in("test_id", testIds)
        .not("finished_at", "is", null);
      if (attemptsError) throw attemptsError;

      const finishedAtByAttemptId = new Map<string, Date>();
      let maxFinishedAt: Date | null = null;
      for (const row of attemptRows ?? []) {
        if (!row.finished_at) continue; // defensive: .not() should already exclude nulls
        const finishedAt = new Date(row.finished_at);
        if (!Number.isFinite(finishedAt.getTime())) continue; // битая дата — скип
        finishedAtByAttemptId.set(row.id, finishedAt);
        if (!maxFinishedAt || finishedAt.getTime() > maxFinishedAt.getTime()) {
          maxFinishedAt = finishedAt;
        }
      }
      const attemptIds = Array.from(finishedAtByAttemptId.keys());
      const nFinished = attemptIds.length;
      if (attemptIds.length === 0) return { items: [], nFinished: 0, maxFinishedAt: null };

      const { data: itemRows, error: itemsError } = await client
        .from("attempt_items")
        .select("attempt_id, task_id, answer, is_correct")
        .in("attempt_id", attemptIds);
      if (itemsError) throw itemsError;
      const items = itemRows ?? [];
      if (items.length === 0) return { items: [], nFinished, maxFinishedAt };

      const taskIds = Array.from(new Set(items.map((row) => row.task_id)));
      const { data: taskRows, error: tasksError } = await client
        .from("tasks")
        .select("id, topic, difficulty")
        .in("id", taskIds);
      if (tasksError) throw tasksError;
      const taskById = new Map((taskRows ?? []).map((task) => [task.id, task]));

      const knowledgeItems: KnowledgeItem[] = [];
      for (const row of items) {
        const task = taskById.get(row.task_id);
        const finishedAt = finishedAtByAttemptId.get(row.attempt_id);
        // Битая строка: задание удалено из банка после сдачи, либо попытка
        // вне набора, отфильтрованного выше — скип, не throw.
        if (!task || !finishedAt) continue;
        if (typeof task.topic !== "string" || task.topic.length === 0) continue;
        if (!Number.isFinite(task.difficulty)) continue;

        knowledgeItems.push({
          topic: task.topic,
          difficulty: task.difficulty,
          isCorrect: row.is_correct === true,
          answered: row.answer !== null,
          finishedAt,
        });
      }

      return { items: knowledgeItems, nFinished, maxFinishedAt };
    },

    async upsertStates(hqId, states) {
      if (states.size === 0) return;
      const rows = Array.from(states.entries()).map(([topic, state]) => ({
        hq_id: hqId,
        topic,
        level: state.level,
        answered_count: state.answeredCount,
        last_seen_at: state.lastSeenAt.toISOString(),
        // 🔴 явный updated_at — default не срабатывает на conflict-update.
        updated_at: new Date().toISOString(),
      }));
      const { error } = await client
        .from("knowledge_states")
        .upsert(rows as unknown as Database["public"]["Tables"]["knowledge_states"]["Insert"][], {
          onConflict: "hq_id,topic",
        });
      if (error) throw error;
    },

    async touchWatermark(hqId, now) {
      const patch: Database["public"]["Tables"]["study_hqs"]["Update"] = {
        last_recomputed_at: now.toISOString(),
      };
      const { error } = await client.from("study_hqs").update(patch).eq("id", hqId);
      if (error) throw error;
    },
  };
}
