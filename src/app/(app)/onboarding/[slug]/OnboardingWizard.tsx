"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ExamVariant, SelectionGroup } from "@/features/exam-profile/spec";
import {
  defaultConfig,
  reconcileDraft,
  reconcileWeakSections,
  resolveActiveSectionNames,
  selectionPools,
  type OnboardingStep,
  type SelectionPoolEntry,
} from "@/features/onboarding/steps";
import {
  APPROACH_LEVELS,
  EXPLANATION_STYLES,
  HOURS_PER_WEEK,
  type InterviewButtons,
} from "@/features/interview/approach";

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

// D1 (Stage 5, Task 2): the interview step's open-answer fields — both
// optional/skippable, stored as raw strings ("" = not entered, matches the
// "Пропустить" affordance clearing them rather than tracking a separate
// skipped flag).
type InterviewOpenDraft = { concern: string; motivation: string };

const DEFAULT_INTERVIEW_BUTTONS: InterviewButtons = {
  level: "intermediate",
  hoursPerWeek: "3-6",
  weakSections: [],
  explanationStyle: "concise",
};
const DEFAULT_INTERVIEW_OPEN: InterviewOpenDraft = { concern: "", motivation: "" };

// Явные карты значение -> ключ локали (вместо конкатенации строк в t(...)) —
// проще для статического анализа/поиска использований ключа, чем
// динамический `t(\`interviewLevel${level}\`)`.
const LEVEL_LABEL_KEYS: Record<(typeof APPROACH_LEVELS)[number], string> = {
  beginner: "interviewLevelBeginner",
  intermediate: "interviewLevelIntermediate",
  confident: "interviewLevelConfident",
};
const HOURS_LABEL_KEYS: Record<(typeof HOURS_PER_WEEK)[number], string> = {
  "<3": "interviewHoursLow",
  "3-6": "interviewHoursMid",
  "7+": "interviewHoursHigh",
};
const STYLE_LABEL_KEYS: Record<(typeof EXPLANATION_STYLES)[number], string> = {
  concise: "interviewStyleConcise",
  detailed: "interviewStyleDetailed",
};

type Draft = {
  variantKey: string | null;
  selected: string[];
  examDate: string | null | "skipped";
  // D6 (Task 8): raw text typed on the goal step; null = not entered (skip).
  target: string | null;
  // D1 (Stage 5, Task 2): interview step state — always present after
  // loadDraft normalizes (defaults for older drafts that predate this step).
  interviewButtons: InterviewButtons;
  interviewOpen: InterviewOpenDraft;
};

function isApproachLevel(v: unknown): v is (typeof APPROACH_LEVELS)[number] {
  return typeof v === "string" && (APPROACH_LEVELS as readonly string[]).includes(v);
}
function isHoursPerWeek(v: unknown): v is (typeof HOURS_PER_WEEK)[number] {
  return typeof v === "string" && (HOURS_PER_WEEK as readonly string[]).includes(v);
}
function isExplanationStyle(v: unknown): v is (typeof EXPLANATION_STYLES)[number] {
  return typeof v === "string" && (EXPLANATION_STYLES as readonly string[]).includes(v);
}

// Defensive parsing (no zod here, matching this file's existing loadDraft
// style) — a draft saved before Stage 5 Task 2 shipped has no
// interviewButtons/interviewOpen keys at all; a corrupted/hand-edited
// localStorage value can have the wrong shape entirely. Both degrade to the
// sensible defaults above rather than throwing (loadDraft as a whole must
// never crash the wizard on a bad draft).
function parseInterviewButtons(raw: unknown): InterviewButtons {
  if (raw === null || typeof raw !== "object") return DEFAULT_INTERVIEW_BUTTONS;
  const r = raw as Partial<Record<keyof InterviewButtons, unknown>>;
  return {
    level: isApproachLevel(r.level) ? r.level : DEFAULT_INTERVIEW_BUTTONS.level,
    hoursPerWeek: isHoursPerWeek(r.hoursPerWeek) ? r.hoursPerWeek : DEFAULT_INTERVIEW_BUTTONS.hoursPerWeek,
    weakSections: Array.isArray(r.weakSections)
      ? r.weakSections.filter((s): s is string => typeof s === "string")
      : [],
    explanationStyle: isExplanationStyle(r.explanationStyle)
      ? r.explanationStyle
      : DEFAULT_INTERVIEW_BUTTONS.explanationStyle,
  };
}

function parseInterviewOpen(raw: unknown): InterviewOpenDraft {
  if (raw === null || typeof raw !== "object") return DEFAULT_INTERVIEW_OPEN;
  const r = raw as Partial<InterviewOpenDraft>;
  return {
    concern: typeof r.concern === "string" ? r.concern : "",
    motivation: typeof r.motivation === "string" ? r.motivation : "",
  };
}

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
    const interviewButtons = parseInterviewButtons(parsed.interviewButtons);
    const interviewOpen = parseInterviewOpen(parsed.interviewOpen);
    return { variantKey, selected, examDate, target, interviewButtons, interviewOpen };
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
  | { kind: "success"; hqId: string }
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
    const data = (await res.json()) as { id: string };
    return { kind: "success", hqId: data.id };
  } catch {
    return { kind: "error" };
  }
}

// D1 (Stage 5, Task 2): интервью-обогащение — ВСЕГДА вызывается после
// успешного finishOnce, но best-effort: провал (сеть/429/5xx) НЕ блокирует
// переход в /hq — approach просто остаётся DEFAULT_APPROACH (записан
// INSERT-веткой /api/study-hqs, Stage5 Task1), юзер ничего не теряет кроме
// персонализации. Исход намеренно не различается вызывающей стороной.
async function interviewOnce(
  hqId: string,
  buttons: InterviewButtons,
  openAnswers: { concern?: string; motivation?: string },
): Promise<void> {
  try {
    await fetch("/api/interview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hqId, buttons, openAnswers }),
    });
  } catch {
    // best-effort — провал этого шага не должен ничего блокировать
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
  const allSectionNames = props.sections.map((s) => s.name);

  // D1 (Stage 5, Task 2): "активные секции" для пула weakSections на
  // интервью-шаге — ДОЛЖНЫ совпадать с тем, что /api/interview резолвит
  // server-side (resolveActiveSections против variantKey+
  // effectiveSelectedNames, которые сам визард отправит в /api/study-hqs
  // прямо перед /api/interview), иначе клиент предложит выбор, который
  // роут отклонит 400 invalid_weak_sections. Пересчитывается заново из
  // аргументов (а не из текущего render-состояния) — безопасно вызывать с
  // ЕЩЁ НЕ применённым (следующим) variantKey/selected, см.
  // selectVariant/toggleSection ниже.
  function activeSectionNamesFor(variantKeyArg: string | null, selectedArg: Set<string>): string[] {
    const poolsArg = selectionPools(specForPools, variantKeyArg);
    const effective = effectiveSelectedNames(poolsArg, selectedArg);
    return resolveActiveSectionNames(specForPools, allSectionNames, variantKeyArg, new Set(effective));
  }

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
    const reconciled = reconcileDraft(raw, validSectionNames, validVariantKeys, {
      min: props.scoring.scaleMin,
      max: props.scoring.scaleMax,
    });
    // 🔴 D1: weakSections реконсилятся вперёд против АКТИВНЫХ секций под уже
    // реконсиленным variantKey/selected — черновик, сохранённый до смены
    // варианта/выбора (или до spec refine), может ссылаться на секцию, что
    // больше не активна; тот же риск лока, что и в reconcileDraft (jsdoc
    // выше), применённый к weakSections интервью-шага.
    const names = activeSectionNamesFor(reconciled.variantKey, new Set(reconciled.selected));
    return {
      ...reconciled,
      interviewButtons: {
        ...reconciled.interviewButtons,
        weakSections: reconcileWeakSections(reconciled.interviewButtons.weakSections, names),
      },
    };
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
  const [interviewButtons, setInterviewButtons] = useState<InterviewButtons>(
    () => loadReconciledDraft()?.interviewButtons ?? DEFAULT_INTERVIEW_BUTTONS,
  );
  const [interviewOpen, setInterviewOpen] = useState<InterviewOpenDraft>(
    () => loadReconciledDraft()?.interviewOpen ?? DEFAULT_INTERVIEW_OPEN,
  );
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
  // D1 (Stage 5, Task 2): пул выбора для weakSections на интервью-шаге —
  // текущие variantKey/selected этого рендера.
  const activeSectionNamesForInterview = activeSectionNamesFor(variantKey, selected);

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
    // 🔴 D1: смена варианта в рамках сессии реконсилит weakSections ВПЕРЁД
    // против активных секций ПОД НОВЫМ вариантом — иначе ранее отмеченная
    // слабая секция могла бы больше не входить в активный набор и позже
    // словить 400 invalid_weak_sections от /api/interview.
    const names = activeSectionNamesFor(key, selected);
    const nextButtons = { ...interviewButtons, weakSections: reconcileWeakSections(interviewButtons.weakSections, names) };
    setInterviewButtons(nextButtons);
    saveDraft(props.slug, {
      variantKey: key,
      selected: Array.from(selected),
      examDate,
      target,
      interviewButtons: nextButtons,
      interviewOpen,
    });
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
    // 🔴 D1: то же форвард-реконсилирование weakSections, что и в
    // selectVariant — смена selectionGroup-выбора тоже может сузить активный
    // набор секций.
    const names = activeSectionNamesFor(variantKey, next);
    const nextButtons = { ...interviewButtons, weakSections: reconcileWeakSections(interviewButtons.weakSections, names) };
    setInterviewButtons(nextButtons);
    saveDraft(props.slug, {
      variantKey,
      selected: Array.from(next),
      examDate,
      target,
      interviewButtons: nextButtons,
      interviewOpen,
    });
  }

  function onExamDateChange(value: string) {
    const next = value === "" ? null : value;
    setExamDate(next);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate: next, target, interviewButtons, interviewOpen });
  }

  function onTargetChange(value: string) {
    const next = value === "" ? null : value;
    setTarget(next);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate, target: next, interviewButtons, interviewOpen });
  }

  function skipGoal() {
    setTarget(null);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate, target: null, interviewButtons, interviewOpen });
    goNext();
  }

  function setInterviewButtonField<K extends keyof InterviewButtons>(key: K, value: InterviewButtons[K]) {
    const next = { ...interviewButtons, [key]: value };
    setInterviewButtons(next);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate, target, interviewButtons: next, interviewOpen });
  }

  function toggleWeakSection(name: string) {
    const has = interviewButtons.weakSections.includes(name);
    const nextWeak = has
      ? interviewButtons.weakSections.filter((n) => n !== name)
      : [...interviewButtons.weakSections, name];
    const next = { ...interviewButtons, weakSections: nextWeak };
    setInterviewButtons(next);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate, target, interviewButtons: next, interviewOpen });
  }

  function onInterviewOpenChange(field: keyof InterviewOpenDraft, value: string) {
    const next = { ...interviewOpen, [field]: value };
    setInterviewOpen(next);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate, target, interviewButtons, interviewOpen: next });
  }

  function skipInterviewOpen() {
    const next = DEFAULT_INTERVIEW_OPEN;
    setInterviewOpen(next);
    saveDraft(props.slug, { variantKey, selected: Array.from(selected), examDate, target, interviewButtons, interviewOpen: next });
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
      // D1 (Stage 5, Task 2): интервью-обогащение ПОСЛЕ успешного создания/
      // обновления штаба — best-effort, провал НЕ блокирует переход в /hq
      // (approach останется DEFAULT_APPROACH, см. interviewOnce jsdoc).
      const openAnswers: { concern?: string; motivation?: string } = {};
      if (interviewOpen.concern.trim() !== "") openAnswers.concern = interviewOpen.concern.trim();
      if (interviewOpen.motivation.trim() !== "") openAnswers.motivation = interviewOpen.motivation.trim();
      await interviewOnce(outcome.hqId, interviewButtons, openAnswers);
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

      {step.kind === "interview" && (
        <div className="flex flex-col gap-4">
          <h2 className="font-semibold">{t("interviewTitle")}</h2>

          <div className="flex flex-col gap-2">
            <p className="font-medium">{t("interviewLevelLabel")}</p>
            {APPROACH_LEVELS.map((level) => (
              <label key={level} className="flex items-center gap-2 rounded border p-3">
                <input
                  type="radio"
                  name="interview-level"
                  checked={interviewButtons.level === level}
                  onChange={() => setInterviewButtonField("level", level)}
                />
                <span>{t(LEVEL_LABEL_KEYS[level])}</span>
              </label>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <p className="font-medium">{t("interviewHoursLabel")}</p>
            {HOURS_PER_WEEK.map((hours) => (
              <label key={hours} className="flex items-center gap-2 rounded border p-3">
                <input
                  type="radio"
                  name="interview-hours"
                  checked={interviewButtons.hoursPerWeek === hours}
                  onChange={() => setInterviewButtonField("hoursPerWeek", hours)}
                />
                <span>{t(HOURS_LABEL_KEYS[hours])}</span>
              </label>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <p className="font-medium">{t("interviewWeakLabel")}</p>
            {activeSectionNamesForInterview.length > 0 ? (
              <div className="flex flex-col gap-2">
                {activeSectionNamesForInterview.map((name) => (
                  <label key={name} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={interviewButtons.weakSections.includes(name)}
                      onChange={() => toggleWeakSection(name)}
                    />
                    <span>{name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">{t("interviewWeakHint")}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="font-medium">{t("interviewStyleLabel")}</p>
            {EXPLANATION_STYLES.map((style) => (
              <label key={style} className="flex items-center gap-2 rounded border p-3">
                <input
                  type="radio"
                  name="interview-style"
                  checked={interviewButtons.explanationStyle === style}
                  onChange={() => setInterviewButtonField("explanationStyle", style)}
                />
                <span>{t(STYLE_LABEL_KEYS[style])}</span>
              </label>
            ))}
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-gray-600" htmlFor="interview-concern">
              {t("interviewConcernLabel")}
            </label>
            <textarea
              id="interview-concern"
              className="min-h-20 rounded border p-3"
              placeholder={t("interviewConcernPlaceholder")}
              value={interviewOpen.concern}
              onChange={(e) => onInterviewOpenChange("concern", e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm text-gray-600" htmlFor="interview-motivation">
              {t("interviewMotivationLabel")}
            </label>
            <textarea
              id="interview-motivation"
              className="min-h-20 rounded border p-3"
              placeholder={t("interviewMotivationPlaceholder")}
              value={interviewOpen.motivation}
              onChange={(e) => onInterviewOpenChange("motivation", e.target.value)}
            />
          </div>

          <div className="flex gap-3">
            <button type="button" onClick={goBack} className="rounded border px-4 py-2 text-sm">
              ←
            </button>
            <button type="button" onClick={goNext} className="rounded border px-6 py-3 font-medium">
              →
            </button>
            <button type="button" onClick={skipInterviewOpen} className="rounded border px-4 py-2 text-sm">
              {t("interviewOpenSkip")}
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
                  interviewButtons,
                  interviewOpen,
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
