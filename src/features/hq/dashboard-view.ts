// D2/Task6: pure view-model helpers for /hq/[hqId] (server dashboard). НОЛЬ
// импортов supabase/llm/fetch — page.tsx загружает плоские данные (states,
// weeks, forecast, watermark), эти функции превращают их в готовые для
// рендера структуры. KnowledgeMap/WeekPlanCard/ForecastCard остаются тупыми
// презентационными компонентами — band/stale/gap-ветки посчитаны здесь, не
// в JSX (см. Task 6 бриф: "клиент тупой").
import type { ExamSection } from "@/features/exam-profile/spec";
import type { TopicState } from "@/features/knowledge/compute";
import { isStale } from "@/features/knowledge/compute";
import type { KnowledgeBand } from "@/features/knowledge/constants";
import { levelToBand } from "@/features/knowledge/constants";
import type { Forecast } from "@/features/forecast/compute";
import type { StoredPlanWeek } from "@/features/plan/repo";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

// --- Карта знаний (D1/D2) -----------------------------------------------

export type KnowledgeMapTopic = {
  topic: string;
  state: { level: number; band: KnowledgeBand; stale: boolean } | null;
};
export type KnowledgeMapSection = { name: string; topics: KnowledgeMapTopic[] };

// Мирроим topicsOfSection из src/features/hq/recompute.ts,
// src/features/plan/build.ts и src/features/forecast/compute.ts (тот же
// комментарий там: дублирование сознательное — каждый pure-модуль
// самодостаточен, ноль общих зависимостей друг на друга). Секция без явных
// topics трактует своё имя как единственную тему.
function topicsOfSection(section: ExamSection): string[] {
  return section.topics.length > 0 ? section.topics : [section.name];
}

/**
 * buildKnowledgeMapSections — активные секции (resolveActiveSections) +
 * посчитанная карта (states, из computeKnowledgeStates) -> вью-модель
 * KnowledgeMap.tsx. Тема без строки в states -> state: null ("не изведано",
 * рендерится без процента — компонент это отличает от 0%). Тема со строкой
 * получает band (levelToBand) и stale-бейдж (isStale), посчитанные ровно
 * той же логикой, что и оркестратор пересчёта — единая конвенция D1.
 */
export function buildKnowledgeMapSections(
  activeSections: ExamSection[],
  states: Map<string, TopicState>,
  now: Date,
): KnowledgeMapSection[] {
  return activeSections.map((section) => ({
    name: section.name,
    topics: topicsOfSection(section).map((topic) => {
      const state = states.get(topic);
      return {
        topic,
        state: state
          ? { level: state.level, band: levelToBand(state.level), stale: isStale(state.lastSeenAt, now) }
          : null,
      };
    }),
  }));
}

// --- Watermark / stale-детект (D2/D7) ------------------------------------

/**
 * isHqStale — 🔴 красная команда: пересчёт НЕ запускается в GET-рендере.
 * Дашборд лишь решает, показывать ли <RecomputeKicker/> (клиентский
 * fire-and-forget POST). maxFinishedAt=null (ни одной завершённой попытки
 * этого hq вообще) -> никогда не stale — нечего пересчитывать, кикер не
 * должен долбить recompute на девственном штабе. Иначе: watermark
 * (last_recomputed_at) должен быть НЕ старше самой свежей завершённой
 * попытки; null-watermark (ни разу не пересчитывалось) считается stale.
 */
export function isHqStale(maxFinishedAt: Date | null, lastRecomputedAt: Date | null): boolean {
  if (maxFinishedAt === null) return false;
  if (lastRecomputedAt === null) return true;
  return maxFinishedAt.getTime() > lastRecomputedAt.getTime();
}

// --- Текущая неделя плана (D3) --------------------------------------------

/**
 * selectCurrentWeek — неделя, чьё окно [weekStart, weekStart+7д) содержит
 * `today`. weekStart — UTC-date-строка 'yyyy-mm-dd' (та же конвенция, что и
 * buildStudyPlan/D3): `new Date(weekStart)` парсит её как UTC-полночь, что и
 * требуется для сравнения с `today` без TZ-дрейфа. Ни одна неделя не
 * покрывает today (план ещё не построен, план строился под "плоский"
 * 8-недельный горизонт без даты и она успела истечь, либо дата экзамена уже
 * в прошлом и горизонт заморожен в прошлом) -> null, вызывающая сторона
 * (WeekPlanCard) решает, что показать. Битый weekStart скипается молча —
 * одна испорченная строка не должна ронять выбор. Если несколько недель
 * (в норме не должно — недели непересекающиеся 7-дневные блоки) покрывают
 * today одновременно (defensive: гонка/артефакт регена), выбирается
 * последняя по weekStart.
 */
export function selectCurrentWeek(weeks: StoredPlanWeek[], today: Date): StoredPlanWeek | null {
  const todayMs = today.getTime();
  let best: StoredPlanWeek | null = null;
  let bestStartMs = -Infinity;
  for (const week of weeks) {
    const startMs = new Date(week.weekStart).getTime();
    if (!Number.isFinite(startMs)) continue;
    if (startMs <= todayMs && todayMs < startMs + MS_PER_WEEK && startMs > bestStartMs) {
      best = week;
      bestStartMs = startMs;
    }
  }
  return best;
}

// --- Цель vs. прогноз (D6) -------------------------------------------------

export type GoalGap =
  | { kind: "none" } // нет цели, и/или нет прогноза -> gap-копирайт скрыт
  | { kind: "onTrack" } // target ∈ [low, high]
  | { kind: "above" } // target < low — цель уже в кармане
  | { kind: "gap"; delta: number }; // target > high — Δ = target − point (> 0)

/**
 * parseTargetNumber — study_hqs.target хранится как свободный текст (D6:
 * ввод балла с подсказкой шкалы, но поле НЕ ограничено на запись). Мусорный
 * /нечисловой /пустой /null target -> null ("нет цели", а не 0 — 0 может
 * быть валидной целью на некоторых шкалах). target НЕ участвует в
 * математике прогноза (Global Constraints) — только в этом read-time
 * сравнении.
 */
export function parseTargetNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * computeGoalGap — D6 (🔴 три ветки копирайта + четвёртая "нет данных").
 * Границы [low, high] закрытые (target === low/high -> onTrack). delta
 * всегда положительна в ветке 'gap' по построению (target > high >= point).
 */
export function computeGoalGap(target: number | null, forecast: Forecast | null): GoalGap {
  if (target === null || forecast === null) return { kind: "none" };
  if (target < forecast.low) return { kind: "above" };
  if (target > forecast.high) return { kind: "gap", delta: target - forecast.point };
  return { kind: "onTrack" };
}

/**
 * isNarrowForecast — узкая шкала (напр. IELTS band 0–9 с шагом 0.5) может
 * дать low === high === point после округления к шагу; ForecastCard в этом
 * случае показывает только точку, не диапазон "X–X".
 */
export function isNarrowForecast(forecast: Forecast): boolean {
  return forecast.low === forecast.high;
}
