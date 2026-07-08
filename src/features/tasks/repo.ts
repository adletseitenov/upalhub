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
  /**
   * Выборка бакета банка заданий по (profileId, type, topic[, difficulty]),
   * до `limit` штук. `difficulty === null` снимает фильтр по сложности
   * (релакс-фолбэк T4: импортированные/сгенерированные вне
   * FIXED_DIFFICULTY задания иначе никогда бы не матчились точным select).
   */
  findBucket(
    profileId: string,
    type: string,
    topic: string,
    difficulty: number | null,
    limit: number,
  ): Promise<StoredTask[]>;
  insertMany(rows: NewTaskRow[]): Promise<{ inserted: StoredTask[]; skipped: number }>;
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ").toLowerCase();
}

// D2: sha256(format + normalized(prompt) + normalized(passage) + sorted(options[].text));
// text_input — без options.
// D-important2: passage ОБЯЗАН участвовать в хэше — иначе два разных
// аудио/reading-задания с общим generic-стемом и набором опций (разный
// passage, тот же prompt+options) схлопываются в один content_hash и второе
// молча теряется на unique(exam_profile_id, content_hash). format — тоже
// часть хэша: без него single_choice и multi_choice с одинаковым
// prompt+options коллизировали бы между собой (inputKind text_input НЕ
// добавлен намеренно — text_input-таски с одним prompt считаются одним и тем
// же контентом независимо от inputKind, это уже закреплено тестом).
export function contentHash(body: TaskBody): string {
  const parts: string[] = [body.format, normalizePrompt(body.prompt), normalizePrompt(body.passage ?? "")];
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

// Толерантная версия rowToTask для findBucket (D-fix3): банк — общий стол,
// одна мусорная строка (битый body/answer от прежней версии генератора,
// ручной SQL-фикс и т.п.) не должна ронять всю сборку теста. safeParse на
// строку — пропускаем с console.warn(id), остальные строки бакета отдаём как
// обычно.
function rowToTaskSafe(row: Row): StoredTask | null {
  const bodyResult = taskBodySchema.safeParse(row.body);
  const answerResult = taskAnswerSchema.safeParse(row.answer);
  if (!bodyResult.success || !answerResult.success) {
    console.warn(`tasks.findBucket: skipping malformed task row id=${row.id} (invalid body/answer shape)`);
    return null;
  }
  try {
    validateTaskPair(bodyResult.data, answerResult.data);
  } catch {
    console.warn(`tasks.findBucket: skipping malformed task row id=${row.id} (body/answer pair invalid)`);
    return null;
  }
  return {
    id: row.id,
    type: row.type,
    topic: row.topic,
    difficulty: row.difficulty,
    language: row.language,
    body: bodyResult.data,
    answer: answerResult.data,
    explanation: row.explanation ?? "",
  };
}

export function supabaseTaskRepo(client: SupabaseClient<Database>): TaskBankRepo {
  return {
    async findBucket(profileId, type, topic, difficulty, limit) {
      let query = client
        .from("tasks")
        .select("*")
        .eq("exam_profile_id", profileId)
        .eq("type", type)
        .eq("topic", topic);
      if (difficulty !== null) {
        query = query.eq("difficulty", difficulty);
      }
      const { data, error } = await query.limit(limit);
      if (error) throw error;
      return (data ?? []).map(rowToTaskSafe).filter((task): task is StoredTask => task !== null);
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
