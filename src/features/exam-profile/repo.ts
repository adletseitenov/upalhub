import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { examProfileSpecSchema, sourceRefSchema } from "./spec";
import type { ExamProfileRepo, NewExamProfile, StoredExamProfile } from "./service";
import { z } from "zod";

type Row = Database["public"]["Tables"]["exam_profiles"]["Row"];

function rowToProfile(row: Row): StoredExamProfile {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    language: row.language,
    spec: examProfileSpecSchema.parse(row.spec),
    sources: z.array(sourceRefSchema).parse(row.sources ?? []),
    origin: row.origin as StoredExamProfile["origin"],
    trust: row.trust as StoredExamProfile["trust"],
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
      return rowToProfile(data);
    },
  };
  return repo;
}
