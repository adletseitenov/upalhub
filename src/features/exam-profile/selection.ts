// D2: единственная точка истины «config -> активные секции» (pure, НОЛЬ
// импортов llm/сети/supabase). study_hqs.config хранит выбор ученика
// (вариант + выбранные секции из selectionGroups); эти функции — то, чем
// buildPlan/assembleTest (сейчас) и карта знаний (этап 3, потом) читают этот
// выбор.
//
// resolveActiveSections ТОТАЛЬНАЯ: устаревший/испорченный config (снятый
// вариант, переименованная секция, случайный мусор) должен деградировать к
// безопасному дефолту, а не ронять сборку теста (500). validateHqConfig —
// отдельная функция для явной проверки на границе API (422), которая как
// раз ЛОВИТ то, что resolveActiveSections молча прощает.
import { z } from "zod";
import type { ExamProfileSpec, ExamSection } from "./spec";

export const hqConfigSchema = z.object({
  variantKey: z.string().nullish(),
  selectedSectionNames: z.array(z.string()).default([]),
});
export type HqConfig = z.infer<typeof hqConfigSchema>;

type LooseHqConfig = { variantKey?: string | null; selectedSectionNames?: string[] };

// Stage3 T1 (хвост 2.5): консолидация — этот хелпер был продублирован
// (буквально идентичный код) в /api/tests/route.ts и в
// (app)/onboarding/[slug]/page.tsx (и в /api/tests/[testId]/refill/route.ts,
// вне зоны этой задачи). Единственная точка истины: study_hqs.config —
// jsonb, до миграции T5 (Stage 2.5) колонки не было в database.types.ts,
// поэтому вызывающая сторона читает её через cast (raw: unknown).
// Тотальная (не throw): null/undefined/массив/непарсибельный объект -> null,
// которое resolveActiveSections/validateHqConfig трактуют как "нет config"
// (legacy-деградация), а не как ошибку.
export function parseHqConfig(raw: unknown): HqConfig | null {
  if (raw == null || Array.isArray(raw)) return null;
  const parsed = hqConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * resolveActiveSections (D2, тотальная):
 * - config null/undefined/{} -> все секции спеки (legacy штабы без config).
 * - variantKey задан, но не найден среди spec.variants -> база = все секции
 *   (устаревший config не должен ронять сборку).
 * - variantKey найден -> база сужается до секций, чьи имена входят в
 *   variant.sectionNames.
 * - Для каждой selectionGroup: пул = group.sectionNames ∩ имена текущей базы.
 *   Непустой пул -> члены пула исключаются из базы и возвращаются ТОЛЬКО те
 *   из них, что перечислены в selectedSectionNames (несуществующие/устаревшие
 *   имена в selectedSectionNames молча дропаются — не влияют ни на что).
 *   Пустой пул (группа ОРТОГОНАЛЬНА текущему варианту — ни один её член не
 *   входит в базу) -> ДОЛЖНА совпадать с фолбэком validateHqConfig
 *   (D-important3): пул = вся group.sectionNames, а выбранные из него имена
 *   (существующие в spec.sections) ДОБАВЛЯЮТСЯ в базу. Иначе config,
 *   прошедший validateHqConfig (который в этой ветке требует ровно выбор из
 *   полного пула), молча теряет выбранную ортогональную секцию при сборке
 *   теста. Ничего не выбрано -> группа отсутствует в результате (как и раньше).
 */
export function resolveActiveSections(
  spec: ExamProfileSpec,
  config: LooseHqConfig | null | undefined,
): ExamSection[] {
  const selected = new Set(config?.selectedSectionNames ?? []);

  const variant =
    config?.variantKey != null
      ? spec.variants.find((v) => v.key === config.variantKey)
      : undefined;

  let base: ExamSection[] = variant
    ? spec.sections.filter((s) => variant.sectionNames.includes(s.name))
    : spec.sections;

  const sectionByName = new Map(spec.sections.map((s) => [s.name, s] as const));

  for (const group of spec.selectionGroups) {
    const baseNames = new Set(base.map((s) => s.name));
    const pool = group.sectionNames.filter((name) => baseNames.has(name));

    if (pool.length === 0) {
      // Ортогональная группа: пул совпадает с полным group.sectionNames
      // (симметрично validateHqConfig), выбранные члены добавляются в базу.
      const chosenNames = group.sectionNames.filter((name) => selected.has(name));
      for (const name of chosenNames) {
        const section = sectionByName.get(name);
        if (section && !baseNames.has(name)) {
          base = [...base, section];
          baseNames.add(name);
        }
      }
      continue;
    }

    const poolSet = new Set(pool);
    const chosen = new Set(pool.filter((name) => selected.has(name)));
    base = base.filter((s) => !poolSet.has(s.name) || chosen.has(s.name));
  }

  return base;
}

/**
 * validateHqConfig (D2): проверка config на границе API (используется перед
 * созданием/обновлением study_hqs и перед сборкой теста, D5).
 * - variantKey ОБЯЗАТЕЛЕН и должен существовать iff spec.variants.length>0.
 * - все selectedSectionNames должны существовать среди sections[].name.
 * - для каждой selectionGroup: пул = group.sectionNames, суженный до
 *   пересечения с variant.sectionNames, ЕСЛИ вариант выбран И пересечение
 *   непусто (иначе пул = вся group.sectionNames — группа независима от оси
 *   вариантов, D2 note).
 *   - |пул| >= chooseCount -> требуем |selected ∩ пул| === chooseCount.
 *   - |пул| < chooseCount (деградация D1) -> требуем selected ⊇ пул (все
 *     доступные варианты включены).
 */
export function validateHqConfig(
  spec: ExamProfileSpec,
  config: LooseHqConfig | null | undefined,
): { ok: true } | { ok: false; error: string } {
  const selectedSectionNames = config?.selectedSectionNames ?? [];
  const sectionNameSet = new Set(spec.sections.map((s) => s.name));

  for (const name of selectedSectionNames) {
    if (!sectionNameSet.has(name)) {
      return { ok: false, error: `unknown section in selectedSectionNames: "${name}"` };
    }
  }

  let variant: ExamProfileSpec["variants"][number] | undefined;
  if (spec.variants.length > 0) {
    if (!config?.variantKey) {
      return { ok: false, error: "variantKey is required" };
    }
    variant = spec.variants.find((v) => v.key === config.variantKey);
    if (!variant) {
      return { ok: false, error: `unknown variantKey: "${config.variantKey}"` };
    }
  }

  const selectedSet = new Set(selectedSectionNames);

  for (const group of spec.selectionGroups) {
    const variantIntersection = variant
      ? group.sectionNames.filter((name) => variant.sectionNames.includes(name))
      : [];
    const pool = variant && variantIntersection.length > 0 ? variantIntersection : group.sectionNames;

    const poolSelected = pool.filter((name) => selectedSet.has(name));

    if (pool.length >= group.chooseCount) {
      if (poolSelected.length !== group.chooseCount) {
        return {
          ok: false,
          error: `selectionGroups "${group.key}" requires exactly ${group.chooseCount} selected section(s), got ${poolSelected.length}`,
        };
      }
    } else {
      // D1 деградация: пул меньше chooseCount -> все доступные обязаны быть выбраны.
      const missing = pool.filter((name) => !selectedSet.has(name));
      if (missing.length > 0) {
        return {
          ok: false,
          error: `selectionGroups "${group.key}" is degraded (available ${pool.length} < chooseCount ${group.chooseCount}); all available sections must be selected`,
        };
      }
    }
  }

  return { ok: true };
}
