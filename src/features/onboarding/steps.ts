// D1 (Stage 2.5, Task 7): интервью-визард строит шаги ДЕТЕРМИНИРОВАННО из
// спеки профиля — НОЛЬ LLM-вызовов на этом пути. confirm/date — всегда;
// variant/selection — условно, по наличию соответствующих массивов в спеке.
// Эти функции — pure (никаких supabase/llm/DOM импортов), общие для
// server-страницы (buildOnboardingSteps) и клиентского визарда
// (selectionPools/defaultConfig — те же формулы деградации, что и
// resolveActiveSections/validateHqConfig в exam-profile/selection.ts, но
// раскрытые построчно для рендера, а не свёрнутые в true/false).
import type { ExamProfileSpec, SelectionGroup } from "@/features/exam-profile/spec";

export type OnboardingStep =
  | { kind: "confirm" }
  | { kind: "goal" }
  | { kind: "variant" }
  | { kind: "selection" }
  | { kind: "interview" }
  | { kind: "date" };

// Минимальная форма спеки, которую реально используют эти функции —
// variants/selectionGroups. Структурно совместима с полным ExamProfileSpec
// (вызывающий код может передавать как полную спеку с сервера, так и
// урезанный набор пропсов, дошедший до клиента — см. OnboardingWizard).
export type StepsSpec = Pick<ExamProfileSpec, "variants" | "selectionGroups">;

// D6 (Task 8) 🔴 / D1 (Stage 5, Task 2): goal — мотивирующий якорь сразу
// ПОСЛЕ confirm, а не терминальный шаг перед датой; interview — ПОСЛЕ
// variant/selection (weakSections нужны уже РЕЗОЛВНУТЫЕ активные секции,
// см. resolveActiveSectionNames ниже), но ДО date. Порядок: confirm → goal
// → variant? → selection? → interview → date. interview, в отличие от
// variant/selection, добавляется БЕЗУСЛОВНО (не зависит от формы спеки) —
// approach строится для любого экзамена.
export function buildOnboardingSteps(spec: StepsSpec): OnboardingStep[] {
  const steps: OnboardingStep[] = [{ kind: "confirm" }, { kind: "goal" }];
  if (spec.variants.length > 0) steps.push({ kind: "variant" });
  if (spec.selectionGroups.length > 0) steps.push({ kind: "selection" });
  steps.push({ kind: "interview" });
  steps.push({ kind: "date" });
  return steps;
}

export type SelectionPoolEntry = {
  group: SelectionGroup;
  pool: string[];
  degraded: boolean;
};

/**
 * selectionPools (D1): для каждой selectionGroup спеки считает пул опций,
 * доступных под текущий выбранный вариант, и помечает деградацию.
 * - variantKey === null (ещё не выбран/нет variant-шага) -> пул = вся группа.
 * - variantKey задан, но пересечение group.sectionNames ∩ variant.sectionNames
 *   пусто -> группа ортогональна оси вариантов -> пул = вся группа (совпадает
 *   с формулой validateHqConfig в exam-profile/selection.ts).
 * - Пересечение непусто -> пул = пересечение.
 * 🔴 degraded = pool.length < group.chooseCount — UI (OnboardingWizard)
 * обязан автовключить весь пул и НЕ блокировать переход дальше.
 */
export function selectionPools(spec: StepsSpec, variantKey: string | null): SelectionPoolEntry[] {
  const variant = variantKey != null ? spec.variants.find((v) => v.key === variantKey) : undefined;
  return spec.selectionGroups.map((group) => {
    const intersection = variant
      ? group.sectionNames.filter((name) => variant.sectionNames.includes(name))
      : [];
    const pool = variant && intersection.length > 0 ? intersection : group.sectionNames;
    return { group, pool, degraded: pool.length < group.chooseCount };
  });
}

export type DraftHqConfig = { variantKey: string | null; selectedSectionNames: string[] };

/**
 * defaultConfig (D1): начальный config для варианта variantKey — деградированные
 * группы (пул < chooseCount) автоматически включают ВСЕ доступные опции;
 * недеградированные группы стартуют пустыми (юзер выбирает сам).
 */
export function defaultConfig(spec: StepsSpec, variantKey: string | null): DraftHqConfig {
  const pools = selectionPools(spec, variantKey);
  const selectedSectionNames = pools.filter((p) => p.degraded).flatMap((p) => p.pool);
  return { variantKey, selectedSectionNames };
}

// D-important5: shape of a persisted OnboardingWizard localStorage draft —
// deliberately loose (subset of the wizard's own Draft type) so this module
// stays free of any client/DOM import.
// D6 (Task 8): target — optional, aligned with the wizard's own Draft.target
// (raw text the user typed on the goal step; absent/undefined when older
// drafts predate this field — additive, not a breaking change).
export type DraftLike = {
  variantKey: string | null;
  selected: string[];
  target?: string | null;
};

export type TargetRange = { min: number; max: number };

/**
 * reconcileDraft (D-important5): a localStorage draft saved from a PRIOR
 * onboarding session for this slug can reference a variantKey/section names
 * that no longer exist in the CURRENT spec (the profile spec can be refined
 * via /api/exam-profiles/refine after the draft was saved, while the slug
 * stays the same). Restoring stale names verbatim into wizard state merges
 * them into the submitted config (effectiveSelectedNames) with no UI control
 * to remove them (they render in no current pool) -> validateHqConfig 422s
 * forever on finish. Drop what the current spec no longer knows about BEFORE
 * seeding wizard state from the draft.
 *
 * D6 (Task 8) 🔴 additive extension: an optional 4th `targetRange` param
 * reconciles `draft.target` the same way — a target saved under a PRIOR
 * profile's scoring scale (or corrupted/garbage text) can fall outside the
 * CURRENT spec's [scaleMin, scaleMax], or fail to parse as a finite number.
 * Such a target is dropped (-> null) rather than silently kept and later
 * rejected by the /api/study-hqs bodySchema regex, or displayed as a
 * confusing out-of-range prefill. Omitting the 4th arg (existing call
 * sites/tests) leaves `target` untouched — purely additive.
 */
export function reconcileDraft<D extends DraftLike>(
  draft: D,
  validSectionNames: ReadonlySet<string>,
  validVariantKeys: ReadonlySet<string>,
  targetRange?: TargetRange,
): D {
  const reconciled: D = {
    ...draft,
    variantKey: draft.variantKey != null && validVariantKeys.has(draft.variantKey) ? draft.variantKey : null,
    selected: draft.selected.filter((name) => validSectionNames.has(name)),
  };
  if (targetRange && draft.target != null) {
    const n = Number(draft.target);
    const inRange = Number.isFinite(n) && n >= targetRange.min && n <= targetRange.max;
    reconciled.target = inRange ? draft.target : null;
  }
  return reconciled;
}

/**
 * resolveActiveSectionNames (D1, Stage 5 Task 2): name-only client mirror of
 * resolveActiveSections (exam-profile/selection.ts) — same file convention
 * as selectionPools/defaultConfig above ("те же формулы деградации... но
 * раскрытые построчно для рендера"). The wizard only has section NAMES
 * (OnboardingWizardProps.sections carries {name, taskCount}, not full
 * ExamSection[]/ExamProfileSpec) — resolveActiveSections itself only ever
 * touches `.name` from each section internally, so a names-only mirror is
 * semantically identical to the server-side formula, just typed narrower.
 *
 * Used to compute the interview step's weakSections pool: MUST match
 * exactly what /api/interview later validates via
 * resolveActiveSections(spec, savedConfig) server-side (same variantKey +
 * effectiveSelectedNames the wizard is about to POST to /api/study-hqs) —
 * otherwise the client would offer a weakSection choice the server rejects
 * with 400 (D1 Important-фикс: weakSections ⊆ resolveActiveSections).
 */
export function resolveActiveSectionNames(
  spec: StepsSpec,
  allSectionNames: string[],
  variantKey: string | null,
  selectedSectionNames: ReadonlySet<string>,
): string[] {
  // Mirrors resolveActiveSections' backlog wave fix1 early-exit: a truly
  // empty/legacy config (no variantKey AND nothing selected) -> ALL section
  // names, without group-subtraction.
  if (variantKey == null && selectedSectionNames.size === 0) {
    return allSectionNames;
  }

  const variant = variantKey != null ? spec.variants.find((v) => v.key === variantKey) : undefined;

  let base: string[] = variant
    ? allSectionNames.filter((name) => variant.sectionNames.includes(name))
    : allSectionNames;

  for (const group of spec.selectionGroups) {
    const baseNames = new Set(base);
    const pool = group.sectionNames.filter((name) => baseNames.has(name));

    if (pool.length === 0) {
      // Orthogonal group (no member of it is in the current base): pool =
      // the whole group.sectionNames, chosen members get ADDED to base —
      // symmetric with resolveActiveSections' orthogonal-group branch.
      const chosenNames = group.sectionNames.filter((name) => selectedSectionNames.has(name));
      for (const name of chosenNames) {
        if (allSectionNames.includes(name) && !baseNames.has(name)) {
          base = [...base, name];
          baseNames.add(name);
        }
      }
      continue;
    }

    const poolSet = new Set(pool);
    const chosen = new Set(pool.filter((name) => selectedSectionNames.has(name)));
    base = base.filter((name) => !poolSet.has(name) || chosen.has(name));
  }

  return base;
}

/**
 * reconcileWeakSections (D1 🔴, Stage 5 Task 2): drops weakSections that no
 * longer name an active section — same "drop what's no longer valid"
 * discipline as reconcileDraft, applied to the interview step's multi-select.
 * Called BOTH when a localStorage draft is loaded (a draft can predate a
 * spec refine, same lockout risk as reconcileDraft's own jsdoc) AND,
 * forward, whenever the wizard's variant/selection changes within the same
 * session (choosing a different variant/section set can shrink the active
 * pool below a previously-checked weak section — the wizard component calls
 * this in selectVariant/toggleSection, not just at draft-load time).
 */
export function reconcileWeakSections(weakSections: string[], activeSectionNames: string[]): string[] {
  const valid = new Set(activeSectionNames);
  return weakSections.filter((name) => valid.has(name));
}
