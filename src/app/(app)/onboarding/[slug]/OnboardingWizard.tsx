"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ExamVariant, SelectionGroup } from "@/features/exam-profile/spec";
import {
  defaultConfig,
  reconcileDraft,
  selectionPools,
  type OnboardingStep,
  type SelectionPoolEntry,
} from "@/features/onboarding/steps";

export type OnboardingSectionSummary = { name: string; taskCount: number | null };

// D6 (Task 8): urезанный scoring, дошедший из spec.scoring — только то, что
// нужно шагу goal (min/max/step для number input + unit для подсказки).
// step может отсутствовать в старых профилях (spec.scoring.step nullish).
export type OnboardingScoring = {
  scaleMin: number;
  scaleMax: number;
  step: number | null;
  unit: string;
};

export type OnboardingWizardProps = {
  slug: string;
  profileId: string;
  examName: string;
  description: string;
  country: string | null;
  sections: OnboardingSectionSummary[];
  variants: ExamVariant[];
  selectionGroups: SelectionGroup[];
  steps: OnboardingStep[];
  scoring: OnboardingScoring;
};

type Draft = {
  variantKey: string | null;
  selected: string[];
  examDate: string | null | "skipped";
  // D6 (Task 8): raw text typed on the goal step; null = not entered (skip).
  target: string | null;
};

// D1 🔴 localStorage-черновик: ключ onboarding:<slug>, восстановление
// исключительно через lazy useState initializer (SSR-безопасно —
// typeof window guard), запись — из обработчиков событий, НЕ из эффекта
// (react-hooks/set-state-in-effect не про это, но правило про побочные
// эффекты в рендере/эффектах — эти хелперы module-level и вызываются
// строго из событий или из initializer, никогда во время самого рендера).
function draftKey(slug: string): string {
  return `onboarding:${slug}`;
}

function loadDraft(slug: string): Draft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(draftKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft> | null;
    if (!parsed || !Array.isArray(parsed.selected)) return null;
    const selected = parsed.selected.filter((s): s is string => typeof s === "string");
    const variantKey = typeof parsed.variantKey === "string" ? parsed.variantKey : null;
    const examDate =
      parsed.examDate === "skipped" || parsed.examDate === null || typeof parsed.examDate === "string"
        ? parsed.examDate
        : null;
    const target = typeof parsed.target === "string" ? parsed.target : null;
    return { variantKey, selected, examDate, target };
  } catch {
    return null;
  }
}

function saveDraft(slug: string, draft: Draft): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(draftKey(slug), JSON.stringify(draft));
  } catch {
    // best-effort — черновик не критичен для функциональности
  }
}

function clearDraft(slug: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(draftKey(slug));
  } catch {
    // ignore
  }
}

// Сетевые вызовы вынесены в module-level функции с типизированным исходом
// (тот же паттерн, что и submitOnce/startOnce в TestRunner.tsx) — try/catch
// живёт вне обработчиков-событий компонента, обработчики только ветвятся по
// kind и зовут setState.
type RerollOutcome =
  | { kind: "success"; slug: string }
  | { kind: "rate_limited" }
  | { kind: "not_found" }
  | { kind: "unauthorized" }
  | { kind: "error" };

async function rerollOnce(
  examName: string,
  excludeSlug: string,
  clarification: string,
): Promise<RerollOutcome> {
  try {
    const res = await fetch("/api/exam-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: examName, excludeSlug, clarification }),
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 429) return { kind: "rate_limited" };
    if (res.status === 404) return { kind: "not_found" };
    if (!res.ok) return { kind: "error" };
    const data = (await res.json()) as { slug: string };
    return { kind: "success", slug: data.slug };
  } catch {
    return { kind: "error" };
  }
}

type FinishOutcome =
  | { kind: "success" }
  | { kind: "invalid_config" }
  | { kind: "unauthorized" }
  | { kind: "error" };

async function finishOnce(
  examProfileId: string,
  config: { variantKey: string | null; selectedSectionNames: string[] },
  examDate: string | undefined,
  target: string | undefined,
): Promise<FinishOutcome> {
  try {
    // 🔴 examDate/target ТОЛЬКО если юзер реально ввёл значение — отсутствие
    // ключа в теле (а не null) сигналит роуту "не трогай эту колонку"
    // (частичный patch, см. api/study-hqs/route.ts).
    const body: Record<string, unknown> = { examProfileId, config };
    if (examDate !== undefined) body.examDate = examDate;
    if (target !== undefined) body.target = target;
    const res = await fetch("/api/study-hqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) return { kind: "unauthorized" };
    if (res.status === 422) return { kind: "invalid_config" };
    if (!res.ok) return { kind: "error" };
    return { kind: "success" };
  } catch {
    return { kind: "error" };
  }
}

function effectiveSelectedNames(pools: SelectionPoolEntry[], selected: Set<string>): string[] {
  const degraded = pools.filter((p) => p.degraded).flatMap((p) => p.pool);
  return Array.from(new Set([...selected, ...degraded]));
}

export function OnboardingWizard(props: OnboardingWizardProps) {
  const router = useRouter();
  const t = useTranslations("onboarding");

  const specForPools = { variants: props.variants, selectionGroups: props.selectionGroups };

  // D-important5: a draft persisted from a PRIOR onboarding session for this
  // slug can reference section names / a variantKey the CURRENT spec no
  // longer has (spec refined via /api/exam-profiles/refine after the draft
  // was saved) — reconcile against props (the current spec) before seeding
  // state, or a stale name with no UI control to remove it locks finish
  // behind a permanent 422 (see reconcileDraft jsdoc).
  function loadReconciledDraft(): Draft | null {
    const raw = loadDraft(props.slug);
    if (!raw) return null;
    const validSectionNames = new Set(props.sections.map((s) => s.name));
    const validVariantKeys = new Set(props.variants.map((v) => v.key));
    // D6 (Task 8) 🔴: a draft's target can predate a profile reroll/refine
    // whose scoring scale differs — reconcile against the CURRENT scale, or
    // an out-of-range prefill would silently disable "Далее" on the goal
    // step with no obvious reason.
    return reconcileDraft(raw, validSectionNames, validVariantKeys, {
      min: props.scoring.scaleMin,
      max: props.scoring.scaleMax,
    });
  }

  const [stepIndex, setStepIndex] = useState(0);
  const [variantKey, setVariantKey] = useState<string | null>(() => loadReconciledDraft()?.variantKey ?? null);
  const [selected, setSelected] = useState<Set<string>>(() => {
    const draft = loadReconciledDraft();
    if (draft) return new Set(draft.selected);
    return new Set(defaultConfig(specForPools, null).selectedSectionNames);
  });
  const [examDate, setExamDate] = useState<string | null | "skipped">(
    () => loadReconciledDraft()?.examDate ?? null,
  );
  const [target, setTarget] = useState<string | null>(() => loadReconciledDraft()?.target ?? null);
  const [busy, setBusy] = useState(false);
  const [researching, setResearching] = useState(false);
  const [rerollOpen, setRerollOpen] = useState(false);
  const [rerollText, setRerollText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const pools = selectionPools(specForPools, variantKey);
  const selectionSatisfied = pools.every((p) => {
    if (p.degraded) return true;
    const count = p.pool.filter((n) => selected.has(n)).length;
    return count === p.group.chooseCount;
  });

  // D6 (Task 8): пустое поле — можно идти дальше/пропустить без target;
  // непустое, но вне [scaleMin, scaleMax] (или нечисловое) — блокирует
  // "Далее" клиент-валидацией (сервер продублирует regex-гейтом на 400).
  const targetOutOfRange = (() => {
    if (target === null || target.trim() === "") return false;
    const n = Number(target);
    return !Number.isFinite(n) || n < props.scoring.scaleMin || n > props.scoring.scaleMax;
  })();

  function goNext() {
    setError(null);
    setStepIndex((i) => Math.min(i + 1, props.steps.length - 1));
  }
  function goBack() {
    setError(null);
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  function selectVariant(key: string) {
    setVariantKey(key);
    saveDraft(props.slug, { variantKey: key, selected: Array.from(selected), examDate, target });
  }

  function toggleSection(name: string, poolEntry: SelectionPoolEntry) {
    if (poolEntry.degraded) return; // задизейблено в UI, страхуемся и в хендлере
    const next = new Set(selected);
    if (next.has(name)) {
      next.delete(name);
    } else {
      const inGroupSelected = poolEntry.pool.filter((n) => next.has(n)).length;
      if (inGroupSelected >= poolEntry.group.chooseCount) return; // ровно chooseCount, не больше
      next.add(name);
    }
    setSelected(next);
    saveDraft(props.slug, { variantKey, selected: Array.from(next), examDate, target });
  }

  function onExamDateChange(value: string) {
    const next = value === "" ? null : value;
    setExamDate(next);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate: next, target });
  }

  function onTargetChange(value: string) {
    const next = value === "" ? null : value;
    setTarget(next);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate, target: next });
  }

  function skipGoal() {
    setTarget(null);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate, target: null });
    goNext();
  }

  async function submitReroll() {
    if (busy) return; // 🔴 busy-lock
    const clarification = rerollText.trim();
    if (clarification.length < 3) return;
    setBusy(true);
    setResearching(true);
    setError(null);
    const outcome = await rerollOnce(props.examName, props.slug, clarification);
    if (outcome.kind === "success") {
      clearDraft(props.slug);
      router.replace(`/onboarding/${outcome.slug}`); // 🔴 replace, не push
      return; // остаёмся busy/researching — страница уходит в навигацию
    }
    setResearching(false);
    if (outcome.kind === "unauthorized") {
      setBusy(false);
      router.push("/sign-in");
      return;
    }
    if (outcome.kind === "rate_limited") setError(t("rateLimited"));
    else if (outcome.kind === "not_found") setError(t("rerollNotFound"));
    else setError(t("error"));
    setBusy(false);
  }

  async function handleFinish(examDateOverride: string | null | "skipped") {
    if (busy) return; // 🔴 busy-lock
    setBusy(true);
    setError(null);
    const config = { variantKey, selectedSectionNames: effectiveSelectedNames(pools, selected) };
    const examDateValue =
      examDateOverride !== null && examDateOverride !== "skipped" ? examDateOverride : undefined;
    // 🔴 D6: body.target ТОЛЬКО если юзер реально ввёл значение на шаге goal
    // — target=null (пропущен) не должен попасть в body ключом вовсе
    // (partial-patch, см. finishOnce/route.ts).
    const targetValue = target !== null && target.trim() !== "" ? target : undefined;
    const outcome = await finishOnce(props.profileId, config, examDateValue, targetValue);
    if (outcome.kind === "success") {
      clearDraft(props.slug);
      router.replace("/hq"); // 🔴 replace, не push
      return;
    }
    if (outcome.kind === "unauthorized") {
      setBusy(false);
      router.push("/sign-in");
      return;
    }
    setError(outcome.kind === "invalid_config" ? t("invalidConfig") : t("error"));
    setBusy(false);
  }

  // Полноэкранный текст на время reroll-исследования (D1) — заменяет весь
  // визард, а не только карточку confirm-шага.
  if (researching) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-4 p-6">
        <p className="text-lg text-gray-600">{t("researchPending")}</p>
      </main>
    );
  }

  const step = props.steps[stepIndex];

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <p className="text-sm text-gray-500">
        {t("stepOf", { x: stepIndex + 1, n: props.steps.length })}
      </p>

      {step.kind === "confirm" && (
        <div className="flex flex-col gap-4">
          <h1 className="text-lg font-medium text-gray-600">{t("confirmTitle")}</h1>
          <div className="rounded border p-4">
            <h2 className="text-xl font-semibold">{props.examName}</h2>
            {props.country && <p className="text-sm text-gray-500">{props.country}</p>}
            <p className="mt-2 text-sm text-gray-600">{props.description}</p>
            {props.sections.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1 text-sm text-gray-500">
                {props.sections.map((s) => (
                  <li key={s.name}>
                    {s.name}
                    {s.taskCount != null ? ` — ${s.taskCount}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={goNext}
              className="rounded border px-6 py-3 font-medium"
            >
              {t("confirmYes")}
            </button>
            <button
              type="button"
              onClick={() => setRerollOpen(true)}
              className="rounded border px-6 py-3 font-medium"
            >
              {t("wrongExam")}
            </button>
          </div>
          {rerollOpen && (
            <div className="flex flex-col gap-2">
              <textarea
                className="min-h-24 rounded border p-3"
                placeholder={t("clarifyPlaceholder")}
                value={rerollText}
                maxLength={200}
                onChange={(e) => setRerollText(e.target.value)}
              />
              <button
                type="button"
                onClick={() => void submitReroll()}
                disabled={busy || rerollText.trim().length < 3}
                className="self-start rounded border px-4 py-2 text-sm font-medium"
              >
                {t("clarifySubmit")}
              </button>
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}

      {step.kind === "goal" && (
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold">{t("goalTitle")}</h2>
          <input
            type="number"
            inputMode="decimal"
            className="rounded border p-3"
            min={props.scoring.scaleMin}
            max={props.scoring.scaleMax}
            step={props.scoring.step ?? 1}
            value={target ?? ""}
            onChange={(e) => onTargetChange(e.target.value)}
          />
          <p className="text-sm text-gray-500">
            {t("goalHint", {
              min: props.scoring.scaleMin,
              max: props.scoring.scaleMax,
              unit: props.scoring.unit,
            })}
          </p>
          <div className="flex gap-3">
            <button type="button" onClick={goBack} className="rounded border px-4 py-2 text-sm">
              ←
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={targetOutOfRange}
              className="rounded border px-6 py-3 font-medium"
            >
              →
            </button>
            <button type="button" onClick={skipGoal} className="rounded border px-4 py-2 text-sm">
              {t("goalSkip")}
            </button>
          </div>
        </div>
      )}

      {step.kind === "variant" && (
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold">{t("variantTitle")}</h2>
          <div className="flex flex-col gap-2">
            {props.variants.map((v) => (
              <label key={v.key} className="flex items-center gap-2 rounded border p-3">
                <input
                  type="radio"
                  name="variant"
                  checked={variantKey === v.key}
                  onChange={() => selectVariant(v.key)}
                />
                <span>{v.label}</span>
              </label>
            ))}
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={goBack} className="rounded border px-4 py-2 text-sm">
              ←
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={variantKey === null}
              className="rounded border px-6 py-3 font-medium"
            >
              →
            </button>
          </div>
        </div>
      )}

      {step.kind === "selection" && (
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold">{t("selectionTitle")}</h2>
          {pools.map((p) => {
            const count = p.pool.filter((n) => selected.has(n)).length;
            return (
              <div key={p.group.key} className="rounded border p-3">
                <p className="mb-2 font-medium">
                  {p.group.title}
                  {!p.degraded && (
                    <span className="ml-2 text-sm font-normal text-gray-500">
                      {t("selectionCount", { x: count, n: p.group.chooseCount })}
                    </span>
                  )}
                </p>
                {p.degraded && <p className="mb-2 text-sm text-gray-500">{t("degradedGroup")}</p>}
                <div className="flex flex-col gap-2">
                  {p.pool.map((name) => (
                    <label key={name} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={p.degraded || selected.has(name)}
                        disabled={p.degraded}
                        onChange={() => toggleSection(name, p)}
                      />
                      <span>{name}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="flex gap-3">
            <button type="button" onClick={goBack} className="rounded border px-4 py-2 text-sm">
              ←
            </button>
            <button
              type="button"
              onClick={goNext}
              disabled={!selectionSatisfied}
              className="rounded border px-6 py-3 font-medium"
            >
              →
            </button>
          </div>
        </div>
      )}

      {step.kind === "date" && (
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold">{t("dateTitle")}</h2>
          <input
            type="date"
            className="rounded border p-3"
            value={examDate !== null && examDate !== "skipped" ? examDate : ""}
            onChange={(e) => onExamDateChange(e.target.value)}
          />
          <div className="flex gap-3">
            <button type="button" onClick={goBack} className="rounded border px-4 py-2 text-sm">
              ←
            </button>
            <button
              type="button"
              onClick={() => void handleFinish(examDate)}
              disabled={busy || examDate === null || examDate === "skipped"}
              className="rounded border px-6 py-3 font-medium"
            >
              {busy ? "…" : t("finish")}
            </button>
            <button
              type="button"
              onClick={() => {
                setExamDate("skipped");
                saveDraft(props.slug, {
                  variantKey,
                  selected: Array.from(selected),
                  examDate: "skipped",
                  target,
                });
                void handleFinish("skipped");
              }}
              disabled={busy}
              className="rounded border px-4 py-2 text-sm"
            >
              {t("dateSkip")}
            </button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </main>
  );
}
