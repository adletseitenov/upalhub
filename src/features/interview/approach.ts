// D1 (Stage 5, Task 2): гибрид-интервью — 4 детерминированных кнопочных
// вопроса (pure, ноль LLM) строят большую часть study_hqs.approach;
// analyze.ts добавляет ≤1 LLM-вызов поверх, только если открытые ответы
// реально непусты. Этот модуль — pure ядро: схема хранения (approach jsonb
// NULL-able колонка), деривация из кнопок, тотальный парсинг, частичный
// merge с уже сохранённым approach. Ноль supabase/llm/DOM импортов —
// граница auth/сеть/лимитер живёт в src/app/api/interview/route.ts.
import { z } from "zod";

export const APPROACH_LEVELS = ["beginner", "intermediate", "confident"] as const;
export const APPROACH_INTENSITY = ["light", "steady", "intense"] as const;
export const EXPLANATION_STYLES = ["concise", "detailed"] as const;
export const APPROACH_TONES = ["reassuring", "neutral", "challenging"] as const;
// Кнопочный вопрос "сколько часов в неделю сможете готовиться" — отдельная
// ось от intensity (см. deriveApproachFromButtons ниже): hoursPerWeek — то,
// что реально жмёт ученик в визарде; intensity — производная от него ось
// approach. Экспортируется отдельной константой, чтобы route.ts (zod enum)
// и OnboardingWizard.tsx (рендер кнопок) не дублировали один и тот же
// литерал-юнион в трёх местах.
export const HOURS_PER_WEEK = ["<3", "3-6", "7+"] as const;

// 🔴 D1 (красная команда, Important-фикс): схема устойчива к дрейфу —
// КАЖДОЕ поле — `.catch(default)` на уровне поля (тот же приём, что и
// hqConfigSchema/parseHqConfig в exam-profile/selection.ts), а НЕ единый
// `.parse()` на весь объект целиком. Одно битое поле (дрейф схемы, ручная
// правка approach в БД, будущая несовместимая версия) не должно стирать
// соседние валидные поля — особенно concerns/summary (рефлексия ученика,
// дорогая для регенерации: требует LLM-вызов, см. analyze.ts).
export const studentApproachSchema = z.object({
  level: z.enum(APPROACH_LEVELS).catch("intermediate"),
  intensity: z.enum(APPROACH_INTENSITY).catch("steady"),
  focusSections: z.array(z.string()).catch([]),
  explanationStyle: z.enum(EXPLANATION_STYLES).catch("concise"),
  concerns: z.array(z.string()).max(3).catch([]),
  tone: z.enum(APPROACH_TONES).catch("neutral"),
  summary: z.string().catch(""),
});
export type StudentApproach = z.infer<typeof studentApproachSchema>;

export const DEFAULT_APPROACH: StudentApproach = {
  level: "intermediate",
  intensity: "steady",
  focusSections: [],
  explanationStyle: "concise",
  concerns: [],
  tone: "neutral",
  summary: "",
};

/**
 * parseApproach — тотальная (никогда не бросает). study_hqs.approach —
 * NULL-able jsonb: raw может быть null (интервью ни разу не пройдено),
 * массивом/примитивом (испорченные данные) или объектом. null/не-объект ->
 * DEFAULT_APPROACH целиком (в т.ч. массив: typeof [] === "object", но
 * studentApproachSchema — z.object и отвергает массивы на уровне формы, так
 * что safeParse.success===false для них тоже деградирует в
 * DEFAULT_APPROACH — тот же исход, просто через другую ветку). Объект ->
 * safeParse: поле-за-полем .catch выше уже чинит частично битые поля
 * ВНУТРИ объекта; success здесь практически всегда true для объекта на
 * входе (per-field .catch ловит контент), проверка добавлена как страховка
 * на случай будущих несовместимых версий схемы (напр. новое обязательное
 * поле без .catch).
 */
export function parseApproach(raw: unknown): StudentApproach {
  if (raw === null || typeof raw !== "object") return DEFAULT_APPROACH;
  const parsed = studentApproachSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_APPROACH;
}

export type InterviewButtons = {
  level: (typeof APPROACH_LEVELS)[number];
  hoursPerWeek: (typeof HOURS_PER_WEEK)[number];
  weakSections: string[];
  explanationStyle: (typeof EXPLANATION_STYLES)[number];
};

/**
 * deriveApproachFromButtons — pure, ноль LLM: 4 кнопочных ответа
 * детерминированно определяют level/intensity/focusSections/
 * explanationStyle. hoursPerWeek -> intensity: "<3" = light, "3-6" =
 * steady, "7+" = intense (D1 дословно).
 */
export function deriveApproachFromButtons(
  buttons: InterviewButtons,
): Pick<StudentApproach, "level" | "intensity" | "focusSections" | "explanationStyle"> {
  const intensity =
    buttons.hoursPerWeek === "<3" ? "light" : buttons.hoursPerWeek === "3-6" ? "steady" : "intense";
  return {
    level: buttons.level,
    intensity,
    focusSections: buttons.weakSections,
    explanationStyle: buttons.explanationStyle,
  };
}

/**
 * mergeApproach — 🔴 D1 Important-фикс (re-интервью стирает analyze-слой):
 * derive-поля (level/intensity/focusSections/explanationStyle) патчатся
 * ВСЕГДА поверх existing — это дешёвая, чисто кнопочная часть, безопасно
 * перезаписывать каждый раз. analyze-поля (concerns/tone/summary)
 * перезаписываются ТОЛЬКО когда `analyzed` не null (открытые ответы были
 * реально непустые в ЭТОМ вызове интервью) — иначе сохраняются из
 * `existing` (или дефолт из DEFAULT_APPROACH, если это самое первое
 * интервью). Это НЕ overwrite всей колонки: юзер, повторно проходящий
 * интервью и скипающий открытые вопросы (правит только часы/уровень), не
 * стирает прежнюю рефлексию молча.
 */
export function mergeApproach(
  existing: StudentApproach | null,
  derived: ReturnType<typeof deriveApproachFromButtons>,
  analyzed: Pick<StudentApproach, "concerns" | "tone" | "summary"> | null,
): StudentApproach {
  const base = existing ?? DEFAULT_APPROACH;
  return {
    ...base,
    ...derived,
    ...(analyzed ?? { concerns: base.concerns, tone: base.tone, summary: base.summary }),
  };
}
