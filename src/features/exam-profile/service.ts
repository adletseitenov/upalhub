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

export async function findOrCreateExamProfile(
  deps: { llm: Llm; search: WebSearch; repo: ExamProfileRepo },
  rawQuery: string,
): Promise<{ profile: StoredExamProfile; created: boolean }> {
  const slug = slugifyExamQuery(rawQuery);
  const existing = await deps.repo.findBySlug(slug);
  if (existing) return { profile: existing, created: false };

  const { spec, sources } = await researchExam(deps, rawQuery);
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
