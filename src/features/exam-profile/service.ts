import type { Llm } from "@/lib/llm";
import type { WebSearch } from "@/lib/search";
import { researchExam } from "./research";
import { slugifyExamQuery } from "./slug";
import type { ExamProfileSpec, SourceRef } from "./spec";

export type NewExamProfile = {
  slug: string;
  title: string;
  language: string;
  spec: ExamProfileSpec;
  sources: SourceRef[];
  origin: "ai_research" | "uploaded" | "manual";
  trust: "ai_draft" | "data_refined" | "verified";
};
export type StoredExamProfile = NewExamProfile & { id: string };

export interface ExamProfileRepo {
  findBySlug(slug: string): Promise<StoredExamProfile | null>;
  insert(p: NewExamProfile): Promise<StoredExamProfile>;
}

// D3/Task5: opts аддитивны — старые вызовы (без opts) ведут себя как раньше.
// slugOverride — reroll-путь (Task5) передаёт уже посчитанный
// slug-guard'ом слаг (см. ensureRerollSlug в slug.ts), чтобы не пересчитывать
// slugifyExamQuery(rawQuery) здесь заново (rawQuery для reroll — это
// refinedQuery, а не исходный отвергнутый запрос). avoid прокидывается в
// researchExam (T3) — LLM избегает переисследовать отвергнутый экзамен.
export async function findOrCreateExamProfile(
  deps: { llm: Llm; search: WebSearch; repo: ExamProfileRepo },
  rawQuery: string,
  opts?: { slugOverride?: string; avoid?: { name: string; country?: string | null } },
): Promise<{ profile: StoredExamProfile; created: boolean }> {
  const slug = opts?.slugOverride ?? slugifyExamQuery(rawQuery);
  const existing = await deps.repo.findBySlug(slug);
  if (existing) return { profile: existing, created: false };

  const { spec, sources } = await researchExam(deps, rawQuery, { avoid: opts?.avoid });
  const profile = await deps.repo.insert({
    slug,
    title: spec.examName,
    language: spec.language,
    spec,
    sources,
    origin: "ai_research",
    trust: "ai_draft",
  });
  return { profile, created: true };
}
