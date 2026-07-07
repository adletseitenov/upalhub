import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { taskAnswerSchema, taskBodySchema, validateTaskPair } from "./schema";
import type { NewTask, TaskBody } from "./schema";

type Row = Database["public"]["Tables"]["tasks"]["Row"];

export type StoredTask = NewTask & { id: string };

// Строка на вставку: NewTask (Task 1) + то, что репозиторий обязан знать сам
// (контент-хэш для дедупа, к какому профилю относится задание, происхождение).
export type NewTaskRow = NewTask & {
  contentHash: string;
  examProfileId: string;
  origin: "ai" | "author" | "import";
};

export interface TaskBankRepo {
  findBucket(
    profileId: string,
    type: string,
    topic: string,
    difficulty: number,
    limit: number,
  ): Promise<StoredTask[]>;
  insertMany(rows: NewTaskRow[]): Promise<{ inserted: StoredTask[]; skipped: number }>;
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

// D2: sha256(normalized(prompt) + sorted(options[].text)); text_input — только prompt.
export function contentHash(body: TaskBody): string {
  const parts: string[] = [normalizePrompt(body.prompt)];
  if (body.format !== "text_input") {
    const optionTexts = body.options.map((o) => o.text).sort();
    parts.push(...optionTexts);
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function rowToTask(row: Row): StoredTask {
  const body = taskBodySchema.parse(row.body);
  const answer = taskAnswerSchema.parse(row.answer);
  validateTaskPair(body, answer);
  return {
    id: row.id,
    type: row.type,
    topic: row.topic,
    difficulty: row.difficulty,
    language: row.language,
    body,
    answer,
    explanation: row.explanation ?? "",
  };
}

export function supabaseTaskRepo(client: SupabaseClient<Database>): TaskBankRepo {
  return {
    async findBucket(profileId, type, topic, difficulty, limit) {
      const { data, error } = await client
        .from("tasks")
        .select("*")
        .eq("exam_profile_id", profileId)
        .eq("type", type)
        .eq("topic", topic)
        .eq("difficulty", difficulty)
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map(rowToTask);
    },

    async insertMany(rows) {
      const inserted: StoredTask[] = [];
      let skipped = 0;

      // Вставка по одной: 23505 (дубликат по exam_profile_id+content_hash)
      // на КАЖДУЮ строку обрабатывается индивидуально как skip, не роняя батч.
      for (const row of rows) {
        const { data, error } = await client
          .from("tasks")
          .insert({
            exam_profile_id: row.examProfileId,
            type: row.type,
            topic: row.topic,
            difficulty: row.difficulty,
            language: row.language,
            body: row.body as unknown as Json,
            answer: row.answer as unknown as Json,
            explanation: row.explanation,
            origin: row.origin,
            content_hash: row.contentHash,
          })
          .select("*")
          .single();

        if (error) {
          if (error.code === "23505") {
            skipped += 1;
            continue;
          }
          throw error;
        }
        inserted.push(rowToTask(data));
      }

      return { inserted, skipped };
    },
  };
}
