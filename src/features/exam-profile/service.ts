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
  // D-important4: findBySlug returns null for BOTH "no row at this slug" and
  // "a row exists at this slug but its spec fails current-schema safeParse"
  // (corrupt/stale — see rowToProfile). Those two outcomes must be
  // distinguishable BEFORE spending on research, or a permanently-corrupt
  // row makes findOrCreateExamProfile waste a full research spend and then
  // 500 (raw 23505) on every identical query. existsBySlug does a raw
  // existence check that bypasses spec parsing entirely.
  existsBySlug(slug: string): Promise<boolean>;
  insert(p: NewExamProfile): Promise<StoredExamProfile>;
}

// Surfaced by findOrCreateExamProfile when a physical row already occupies
// the target slug but cannot be parsed into a StoredExamProfile — the route
// layer should map this to a handled 409, not rethrow into a raw 500.
export class ExamProfileSlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`exam_profiles row at slug "${slug}" exists but is unparseable (corrupt/stale spec)`);
    this.name = "ExamProfileSlugConflictError";
  }
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

  // D-important4: existing === null could mean "no row" (proceed to research)
  // OR "row exists but is corrupt" (must NOT spend on research — it would
  // just hit 23505 on insert and repeat forever). Check BEFORE spending.
  if (await deps.repo.existsBySlug(slug)) {
    throw new ExamProfileSlugConflictError(slug);
  }

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
