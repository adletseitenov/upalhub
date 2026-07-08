import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { examProfileSpecSchema, sourceRefSchema } from "./spec";
import type { ExamProfileRepo, NewExamProfile, StoredExamProfile } from "./service";
import { z } from "zod";

type Row = Database["public"]["Tables"]["exam_profiles"]["Row"];

const originSchema = z.enum(["ai_research", "uploaded", "manual"]);
const trustSchema = z.enum(["ai_draft", "data_refined", "verified"]);

// Stage3 T1 (хвост 2.5): битая/устаревшая spec (например, ручная правка в БД
// или регресс в апстриме research) не должна ронять выборку 500-кой —
// safeParse деградирует к null (как "профиль не найден"), а не throw.
// Консьюмеры rowToProfile уже трактуют null как "нет строки" (findBySlug
// исторически мог вернуть null при отсутствии записи), так что сигнатуры
// вызовов не меняются.
function rowToProfile(row: Row): StoredExamProfile | null {
  const parsedSpec = examProfileSpecSchema.safeParse(row.spec);
  if (!parsedSpec.success) {
    console.warn(`exam_profiles row ${row.id} has an invalid spec, skipping:`, parsedSpec.error);
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    language: row.language,
    spec: parsedSpec.data,
    sources: z.array(sourceRefSchema).parse(row.sources ?? []),
    origin: originSchema.parse(row.origin),
    trust: trustSchema.parse(row.trust),
  };
}

export function supabaseExamProfileRepo(
  client: SupabaseClient<Database>,
  userId?: string,
): ExamProfileRepo {
  const repo: ExamProfileRepo = {
    async findBySlug(slug) {
      const { data, error } = await client
        .from("exam_profiles")
        .select("*")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      return data ? rowToProfile(data) : null;
    },

    // D-important4: raw existence check — bypasses examProfileSpecSchema
    // parsing entirely, so a corrupt/stale spec still reports "exists".
    async existsBySlug(slug) {
      const { data, error } = await client
        .from("exam_profiles")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      return data !== null;
    },

    async insert(p: NewExamProfile) {
      const { data, error } = await client
        .from("exam_profiles")
        .insert({
          slug: p.slug,
          title: p.title,
          language: p.language,
          spec: p.spec as unknown as Json,
          sources: p.sources as unknown as Json,
          origin: p.origin,
          trust: p.trust,
          created_by: userId ?? null,
        })
        .select("*")
        .single();
      if (error) {
        if (error.code === "23505") {
          // гонка по unique slug — профиль создан параллельно, забираем его
          const existing = await repo.findBySlug(p.slug);
          if (existing) return existing;
        }
        throw error;
      }
      const inserted = rowToProfile(data);
      if (!inserted) {
        // Практически недостижимо: p.spec уже прошла валидацию до insert,
        // так что свежевставленная строка не должна проваливать safeParse.
        // Явный throw вместо тихого null — insert() обязан вернуть профиль
        // по контракту ExamProfileRepo.
        throw new Error(`inserted exam_profiles row ${data.id} failed spec safeParse`);
      }
      return inserted;
    },
  };
  return repo;
}
