// D5/Task7: похожие задания для разбора ошибок. Единственная supabase-граница
// здесь — ОДИН батч-запрос по УЖЕ РАЗЛИЧИМЫМ (type, topic) парам ошибок
// (плашка "Потренировать похожие"). Проекция ЖЁСТКО ограничена
// 'id, type, topic, body' — answer/explanation сюда никогда не попадают (в
// отличие от tasks/repo.ts.findBucket, который тянет полную строку и
// специально НЕ годится для этой поверхности). type/topic остаются на самом
// SimilarTaskRow только чтобы вызывающий код (view.ts) мог сгруппировать
// результат обратно по ошибочному заданию — на границе ReviewList они уже
// не нужны и отбрасываются (см. view.ts: similar: [{id, body}]).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { taskBodySchema } from "@/features/tasks/schema";
import type { TaskBody } from "@/features/tasks/schema";

export type SimilarBucket = { type: string; topic: string };

export type SimilarTaskRow = { id: string; type: string; topic: string; body: TaskBody };

export type SimilarCaps = { capPerBucket: number; capTotal: number };

const DEFAULT_CAP_PER_BUCKET = 2;
const DEFAULT_CAP_TOTAL = 10;

/**
 * pickSimilar — чистая функция (TDD-ядро D5). Бакеты обходятся В ПОРЯДКЕ
 * массива; каждый ЭЛЕМЕНТ buckets (в т.ч. повторный — та же (type,topic)
 * пара дважды) получает свой СОБСТВЕННЫЙ бюджет capPerBucket и может забрать
 * НОВЫХ кандидатов, если они есть — глобальный дедуп по id лишь не даёт
 * повторно выдать уже picked-строку. 🔴 Именно поэтому производственный
 * вызывающий код (page.tsx) обязан сам дедуплицировать buckets до РАЗЛИЧИМЫХ
 * (type,topic) пар ПЕРЕД вызовом (как буквально сказано в D5: "buckets из
 * различимых (type,topic) ошибок") — иначе два промаха на одну тему получат
 * каждый свой бюджет здесь, но view.ts потом сольёт оба набора в один общий
 * список по ключу (type,topic) и покажет ОБЪЕДИНЁННЫЙ (не капнутый) список
 * обеим ошибкам сразу. Инварианты этой функции: дедуп по id (глобально, не
 * только внутри бакета), исключение excludeIds, cap N на бакет-ОККУРЕНС,
 * cap M суммарно.
 */
export function pickSimilar(
  rows: SimilarTaskRow[],
  buckets: SimilarBucket[],
  excludeIds: Set<string>,
  caps: SimilarCaps = { capPerBucket: DEFAULT_CAP_PER_BUCKET, capTotal: DEFAULT_CAP_TOTAL },
): SimilarTaskRow[] {
  const picked: SimilarTaskRow[] = [];
  const pickedIds = new Set<string>();

  for (const bucket of buckets) {
    if (picked.length >= caps.capTotal) break;
    let countForBucket = 0;
    for (const row of rows) {
      if (picked.length >= caps.capTotal) break;
      if (countForBucket >= caps.capPerBucket) break;
      if (row.type !== bucket.type || row.topic !== bucket.topic) continue;
      if (excludeIds.has(row.id) || pickedIds.has(row.id)) continue;
      picked.push(row);
      pickedIds.add(row.id);
      countForBucket += 1;
    }
  }

  return picked;
}

/**
 * loadSimilarTasks — тонкая supabase-обёртка вокруг pickSimilar (D5). ОДИН
 * батч-запрос: .in("type", ...).in("topic", ...) — это надмножество точных
 * пар (кросс-произведение типов×тем), пары фильтруются постфактум в
 * pickSimilar/pickSimilar-фильтре ниже. Пустые buckets -> [] без единого
 * сетевого вызова (нет ошибок -> нечего искать похожего).
 */
export async function loadSimilarTasks(
  client: SupabaseClient<Database>,
  params: {
    profileId: string;
    buckets: SimilarBucket[];
    excludeIds: Set<string>;
    capPerBucket?: number;
    capTotal?: number;
  },
): Promise<SimilarTaskRow[]> {
  const {
    profileId,
    buckets,
    excludeIds,
    capPerBucket = DEFAULT_CAP_PER_BUCKET,
    capTotal = DEFAULT_CAP_TOTAL,
  } = params;
  if (buckets.length === 0) return [];

  const types = Array.from(new Set(buckets.map((b) => b.type)));
  const topics = Array.from(new Set(buckets.map((b) => b.topic)));

  const { data, error } = await client
    .from("tasks")
    .select("id, type, topic, body")
    .eq("exam_profile_id", profileId)
    .in("type", types)
    .in("topic", topics);
  if (error) throw error;

  const rows: SimilarTaskRow[] = [];
  for (const row of data ?? []) {
    const parsed = taskBodySchema.safeParse(row.body);
    if (!parsed.success) {
      console.warn(`review/loadSimilarTasks: skipping malformed task row id=${row.id}`);
      continue;
    }
    // .in("type",...).in("topic",...) — это кросс-произведение (не точные
    // пары); pickSimilar сама отфильтрует по точной паре (type,topic) на
    // бакет, здесь просто нормализуем сырые строки.
    rows.push({ id: row.id, type: row.type, topic: row.topic, body: parsed.data });
  }

  return pickSimilar(rows, buckets, excludeIds, { capPerBucket, capTotal });
}
