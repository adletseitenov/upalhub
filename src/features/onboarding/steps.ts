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
  | { kind: "variant" }
  | { kind: "selection" }
  | { kind: "date" };

// Минимальная форма спеки, которую реально используют эти функции —
// variants/selectionGroups. Структурно совместима с полным ExamProfileSpec
// (вызывающий код может передавать как полную спеку с сервера, так и
// урезанный набор пропсов, дошедший до клиента — см. OnboardingWizard).
export type StepsSpec = Pick<ExamProfileSpec, "variants" | "selectionGroups">;

export function buildOnboardingSteps(spec: StepsSpec): OnboardingStep[] {
  const steps: OnboardingStep[] = [{ kind: "confirm" }];
  if (spec.variants.length > 0) steps.push({ kind: "variant" });
  if (spec.selectionGroups.length > 0) steps.push({ kind: "selection" });
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
