// D6 (Stage5 Task1): бэкафилл section.modality на живых exam_profiles.
// sectionModalitySchema аддитивно расширена ['text','audio','speaking']
// (src/features/exam-profile/spec.ts) — старые профили, созданные ДО этого
// расширения, чаще всего имеют absent/"text" modality на секциях
// аудирования/говорения просто потому, что research/refine ещё не умели их
// проставлять. Это НЕ миграция (спеки — живые данные в jsonb-колонке, не
// схема), поэтому обычный SQL alter тут не поможет — нужен скрипт с
// эвристикой по имени секции.
//
// Usage:
//   npx tsx scripts/backfill-modality.ts             # dry-run (по умолчанию): печатает diff, ничего не пишет
//   npx tsx scripts/backfill-modality.ts --apply      # реально применяет UPDATE
//
// Идемпотентно: секции, УЖЕ размеченные "audio" или "speaking", никогда не
// трогаются повторным запуском (см. computeProfileModalityDiff) — только
// absent/"text" секции проверяются по имени.
import { pathToFileURL } from "node:url";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { examProfileSpecSchema, type ExamProfileSpec, type SectionModality } from "@/features/exam-profile/spec";

// Эвристика по имени секции — ru/kk/en, регистронезависимо, подстрокой
// (напр. "Listening Comprehension" тоже матчит "listening").
const AUDIO_NAME_PATTERNS = [/аудирован/i, /тыңдалым/i, /listening/i];
const SPEAKING_NAME_PATTERNS = [/говорен/i, /сөйлеу/i, /speaking/i];

/**
 * proposeModalityForSectionName — pure: возвращает предложенную модальность
 * по имени секции, либо null, если ни один паттерн не совпал (имя секции
 * ничего не говорит об аудировании/говорении — оставляем как есть).
 */
export function proposeModalityForSectionName(name: string): SectionModality | null {
  if (SPEAKING_NAME_PATTERNS.some((re) => re.test(name))) return "speaking";
  if (AUDIO_NAME_PATTERNS.some((re) => re.test(name))) return "audio";
  return null;
}

export type ModalityProposal = {
  profileId: string;
  profileSlug: string;
  sectionName: string;
  from: SectionModality | null; // null = absent (не "text" явно, а отсутствие поля)
  to: SectionModality;
};

/**
 * computeProfileModalityDiff — pure: секции с modality "audio"/"speaking" уже
 * размечены -> пропускаются БЕЗУСЛОВНО (идемпотентность повторного запуска,
 * см. D6). Секция без heuristics-совпадения по имени -> тоже пропускается
 * (ничего не предлагаем, не гадаем).
 */
export function computeProfileModalityDiff(profile: {
  id: string;
  slug: string;
  spec: ExamProfileSpec;
}): ModalityProposal[] {
  const proposals: ModalityProposal[] = [];
  for (const section of profile.spec.sections) {
    const current = section.modality ?? null;
    if (current === "audio" || current === "speaking") continue;
    const proposed = proposeModalityForSectionName(section.name);
    if (proposed === null) continue;
    proposals.push({
      profileId: profile.id,
      profileSlug: profile.slug,
      sectionName: section.name,
      from: current,
      to: proposed,
    });
  }
  return proposals;
}

/**
 * applyModalityProposals — pure: возвращает НОВУЮ spec с modality
 * проставленной по предложениям для этого профиля (остальные поля секций и
 * секции без предложения — байт-в-байт как были).
 */
export function applyModalityProposals(
  spec: ExamProfileSpec,
  proposals: ModalityProposal[],
): ExamProfileSpec {
  const bySectionName = new Map(proposals.map((p) => [p.sectionName, p.to]));
  return {
    ...spec,
    sections: spec.sections.map((section) => {
      const to = bySectionName.get(section.name);
      return to === undefined ? section : { ...section, modality: to };
    }),
  };
}

export function formatModalityDiffLine(p: ModalityProposal): string {
  return `${p.profileSlug} :: "${p.sectionName}" :: ${p.from ?? "(absent)"} -> ${p.to}`;
}

type ProfileRow = { id: string; slug: string; spec: unknown };

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = supabaseAdmin();

  const { data, error } = await admin
    .from("exam_profiles")
    .select("id, slug, spec")
    .order("slug");
  if (error) throw error;
  const rows: ProfileRow[] = data ?? [];

  const allProposals: ModalityProposal[] = [];
  for (const row of rows) {
    const parsed = examProfileSpecSchema.safeParse(row.spec);
    if (!parsed.success) {
      console.warn(`backfill-modality: skipping ${row.slug} (${row.id}) — invalid spec`);
      continue;
    }
    const proposals = computeProfileModalityDiff({ id: row.id, slug: row.slug, spec: parsed.data });
    if (proposals.length === 0) continue;
    allProposals.push(...proposals);

    if (apply) {
      const nextSpec = applyModalityProposals(parsed.data, proposals);
      const { error: updateError } = await admin
        .from("exam_profiles")
        .update({ spec: nextSpec as unknown as Json })
        .eq("id", row.id);
      if (updateError) throw updateError;
    }
  }

  if (allProposals.length === 0) {
    console.log("backfill-modality: no sections need a modality update.");
    return;
  }

  for (const p of allProposals) console.log(formatModalityDiffLine(p));
  console.log(
    apply
      ? `backfill-modality: applied ${allProposals.length} section modality update(s).`
      : `backfill-modality: dry-run — ${allProposals.length} proposed update(s). Re-run with --apply to write them.`,
  );
}

// ESM main-module guard (mirrors the common tsx/node --experimental-strip-types
// pattern): running functions/side effects ONLY when this file is executed
// directly, never on import (vitest imports the pure exports above for unit
// tests without touching env/network).
const isMainModule = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
