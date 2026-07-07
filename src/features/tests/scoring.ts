// Чистое скорирование (D5): НОЛЬ импортов llm/сети/supabase. Замороженный
// snapshot гарантирует детерминизм даже после refine профиля.
import { z } from "zod";

export const scoringSnapshotSchema = z.object({
  scaleMin: z.number(),
  scaleMax: z.number(),
  unit: z.string().min(1),
  passingScore: z.number().nullish(),
  step: z.number().positive().nullish(),
});
export type ScoringSnapshot = z.infer<typeof scoringSnapshotSchema>;

const DEFAULT_STEP_BAND = 0.5;
const DEFAULT_STEP_LINEAR = 1;

// Плавающая точка: exact .5-тай (напр. 13.5) должна округляться ВНИЗ, а не
// к Math.round-у (который тянет .5 к +Infinity) — иначе IELTS-фикстура
// 15/20 -> 6.5 стала бы 7.0. Небольшой эпсилон гасит эту тай-ситуацию
// детерминированно, не трогая обычные (не-тай) значения.
const TIE_EPSILON = 1e-9;

function roundToStep(value: number, step: number): number {
  const ratio = value / step;
  const rounded = Math.round(ratio - TIE_EPSILON);
  return rounded * step;
}

function clamp(value: number, min: number, max: number): number {
  // Math.max/Math.min normalize -0 -> +0 when min/max is a plain +0 literal.
  return Math.min(max, Math.max(min, value)) + 0;
}

/**
 * scaleScore — чистая функция (D5). raw/total -> линейная интерполяция в
 * [scaleMin, scaleMax] -> округление к шагу (default: band=0.5, иначе 1) ->
 * clamp. total===0 -> scaleMin (без деления на ноль).
 *
 * Rounding is anchored at scaleMin: we round the offset from scaleMin,
 * not the absolute linear value. This ensures all valid scores are at
 * scaleMin + k*step for non-negative integer k.
 */
export function scaleScore(raw: number, total: number, snap: ScoringSnapshot): number {
  const { scaleMin, scaleMax, unit, step } = snap;
  if (total === 0) return scaleMin;

  const resolvedStep = step ?? (unit === "band" ? DEFAULT_STEP_BAND : DEFAULT_STEP_LINEAR);
  const linear = scaleMin + (raw / total) * (scaleMax - scaleMin);
  const offset = roundToStep(linear - scaleMin, resolvedStep);
  return clamp(scaleMin + offset, scaleMin, scaleMax);
}
