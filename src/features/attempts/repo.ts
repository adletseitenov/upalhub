import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

type AttemptRow = Database["public"]["Tables"]["attempts"]["Row"];
type AttemptItemDbRow = Database["public"]["Tables"]["attempt_items"]["Row"];

// D4: статус деривируется — finishedAt === null значит «открыта». Никаких
// отдельных колонок статуса.
export type StoredAttempt = {
  id: string;
  testId: string;
  userId: string;
  startedAt: Date;
  finishedAt: Date | null;
  rawScore: number | null;
  scaledScore: number | null;
};

export type AttemptItemRow = {
  taskId: string;
  response: unknown | null;
  timeMs: number | null;
  isCorrect: boolean | null;
};

export interface AttemptRepo {
  // Идемпотентно: гонка по partial-unique attempts_one_open_per_test (D7)
  // -> 23505 -> перечитать уже открытую попытку и вернуть её (паттерн
  // exam-profile/repo.ts).
  insertAttempt(testId: string, userId: string): Promise<StoredAttempt>;
  findOpenAttempt(testId: string, userId: string): Promise<StoredAttempt | null>;
  getAttempt(id: string): Promise<StoredAttempt | null>;
  // Batch upsert по PK (attempt_id, task_id) — автосейв никогда не трогает
  // is_correct (грейдинг только на submit).
  upsertItems(attemptId: string, items: AttemptItemRow[]): Promise<void>;
  getItems(attemptId: string): Promise<AttemptItemRow[]>;
  // Пишет финальные items (с is_correct) и закрывает попытку одной операцией.
  finalize(
    attemptId: string,
    patch: { rawScore: number; scaledScore: number; finishedAt: Date; items: AttemptItemRow[] },
  ): Promise<StoredAttempt>;
}

function rowToAttempt(row: AttemptRow): StoredAttempt {
  return {
    id: row.id,
    testId: row.test_id,
    userId: row.user_id,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    rawScore: row.raw_score,
    scaledScore: row.scaled_score,
  };
}

function rowToItem(row: AttemptItemDbRow): AttemptItemRow {
  return {
    taskId: row.task_id,
    response: row.answer,
    timeMs: row.time_ms,
    isCorrect: row.is_correct,
  };
}

export function supabaseAttemptRepo(client: SupabaseClient<Database>): AttemptRepo {
  const repo: AttemptRepo = {
    async insertAttempt(testId, userId) {
      const { data, error } = await client
        .from("attempts")
        .insert({ test_id: testId, user_id: userId })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") {
          // гонка по одну-открытую-на-(test_id,user_id) — попытка уже
          // создана параллельно (двойной старт/F5), забираем её.
          const existing = await repo.findOpenAttempt(testId, userId);
          if (existing) return existing;
        }
        throw error;
      }
      return rowToAttempt(data);
    },

    async findOpenAttempt(testId, userId) {
      const { data, error } = await client
        .from("attempts")
        .select("*")
        .eq("test_id", testId)
        .eq("user_id", userId)
        .is("finished_at", null)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToAttempt(data) : null;
    },

    async getAttempt(id) {
      const { data, error } = await client.from("attempts").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return data ? rowToAttempt(data) : null;
    },

    async upsertItems(attemptId, items) {
      if (items.length === 0) return;
      const { error } = await client.from("attempt_items").upsert(
        items.map((item) => ({
          attempt_id: attemptId,
          task_id: item.taskId,
          answer: item.response as Json | null,
          time_ms: item.timeMs,
          is_correct: item.isCorrect,
        })),
        { onConflict: "attempt_id,task_id" },
      );
      if (error) throw error;
    },

    async getItems(attemptId) {
      const { data, error } = await client
        .from("attempt_items")
        .select("*")
        .eq("attempt_id", attemptId);
      if (error) throw error;
      return (data ?? []).map(rowToItem);
    },

    async finalize(attemptId, patch) {
      await repo.upsertItems(attemptId, patch.items);
      const { data, error } = await client
        .from("attempts")
        .update({
          raw_score: patch.rawScore,
          scaled_score: patch.scaledScore,
          finished_at: patch.finishedAt.toISOString(),
        })
        .eq("id", attemptId)
        .select("*")
        .single();
      if (error) throw error;
      return rowToAttempt(data);
    },
  };
  return repo;
}
