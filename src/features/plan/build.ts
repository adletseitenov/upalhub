// D3: чистое ядро понедельного плана — buildStudyPlan. НОЛЬ импортов
// llm/supabase/fetch. Принимает уже посчитанную карту знаний (states, из
// computeKnowledgeStates) + активные секции (resolveActiveSections) — не
// делает собственных запросов; supabase-граница (DELETE future/INSERT) живёт
// в repo.ts (PlanRepo), маппинг states -> план -> запись делает оркестратор
// (src/features/hq/recompute.ts, Task4 встройка).
import { z } from "zod";
import type { ExamSection } from "@/features/exam-profile/spec";
import type { TopicState } from "@/features/knowledge/compute";
import { isStale } from "@/features/knowledge/compute";
import { levelToBand } from "@/features/knowledge/constants";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

// K=3 темы/неделю (baseline из D3) — автоповышается ниже ради гарантии
// покрытия каждой non-strong темы хотя бы одной неделей горизонта.
const BASE_WEEKLY_TOPICS = 3;
const DEFAULT_WEEKS_NO_EXAM_DATE = 8;
const MIN_WEEKS = 1;
const MAX_WEEKS = 12;

export const planBandSchema = z.enum(["unknown", "weak", "shaky", "strong"]);
export const planReasonSchema = z.enum(["weak", "unexplored", "stale", "review"]);

export const planWeekTopicsSchema = z.object({
  focus: z.array(
    z.object({
      topic: z.string(),
      section: z.string(),
      band: planBandSchema,
      reason: planReasonSchema,
    }),
  ),
  suggestedTest: z.object({ kind: z.enum(["practice", "mock"]) }),
});
export type PlanWeekTopics = z.infer<typeof planWeekTopicsSchema>;
export type PlanFocusItem = PlanWeekTopics["focus"][number];
export type PlanBand = z.infer<typeof planBandSchema>;
export type PlanReason = z.infer<typeof planReasonSchema>;

export type PlanWeek = { weekStart: string; topics: PlanWeekTopics };
export type PlanStatus = "ok" | "noExamDate" | "examDatePassed";
export type StudyPlan = { status: PlanStatus; weeks: PlanWeek[] };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatUtcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// 🔴 TZ-стабильно: UTC-полночь понедельника недели, содержащей `date`.
// Используются ТОЛЬКО getUTC*-геттеры — date.getDay()/getDate() читают
// компоненты в ЛОКАЛЬНОЙ TZ хоста и у меток времени около полуночи UTC могут
// "перепрыгнуть" на соседний календарный день (напр. 23:00 UTC воскресенья
// в Алматы (+5) уже локально понедельник 04:00) — так неделя съезжает на 7
// дней в зависимости от того, где выполняется код/тест.
function mondayUtcMs(date: Date): number {
  const utcMidnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const dow = new Date(utcMidnight).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7; // Mon=0 .. Sun=6
  return utcMidnight - daysSinceMonday * MS_PER_DAY;
}

export function mondayUtc(date: Date): string {
  return formatUtcDate(mondayUtcMs(date));
}

// Мирроим topicsOfSection из src/features/hq/recompute.ts (и buildPlan в
// src/features/tests/assemble.ts): секция без явных topics трактует своё имя
// как единственную тему. Дублирование сознательное — план не импортирует
// оркестратор (pure-модуль, ноль зависимостей от src/features/hq/*).
function topicsOfSection(section: ExamSection): string[] {
  return section.topics.length > 0 ? section.topics : [section.name];
}

function collectTopics(activeSections: ExamSection[]): Map<string, string> {
  const topicToSection = new Map<string, string>();
  for (const section of activeSections) {
    for (const topic of topicsOfSection(section)) {
      // Первая секция, объявившая тему, побеждает — детерминизм на редком
      // случае пересечения topics между секциями одной спеки.
      if (!topicToSection.has(topic)) topicToSection.set(topic, section.name);
    }
  }
  return topicToSection;
}

type TopicInfo = {
  topic: string;
  section: string;
  band: PlanBand;
  need: number;
  state: TopicState | null;
};

// need: нет строки в карте -> 0.8 (максимальный приоритет "не изведано" —
// выше типичного need изведанной слабой темы); иначе (1-level) + 0.1 за
// staleness (D3). isStale/staleness читается относительно `today` — тот же
// аргумент, что уходит в D1 isStale (там называется `now`).
function computeNeed(state: TopicState | null, today: Date): number {
  if (!state) return 0.8;
  const staleBonus = isStale(state.lastSeenAt, today) ? 0.1 : 0;
  return 1 - state.level + staleBonus;
}

// Сортировка desc по need, tie-break по имени темы (строковое сравнение по
// code unit — НЕ localeCompare: тот зависит от ICU-данных окружения и может
// давать разный порядок на разных хостах/версиях Node для не-ASCII имён).
function compareTopicInfo(a: TopicInfo, b: TopicInfo): number {
  if (b.need !== a.need) return b.need - a.need;
  if (a.topic < b.topic) return -1;
  if (a.topic > b.topic) return 1;
  return 0;
}

function buildTopicInfos(
  states: Map<string, TopicState>,
  activeSections: ExamSection[],
  today: Date,
): TopicInfo[] {
  const topicToSection = collectTopics(activeSections);
  const infos: TopicInfo[] = [];
  for (const [topic, section] of topicToSection) {
    const state = states.get(topic) ?? null;
    const band: PlanBand = state ? levelToBand(state.level) : "unknown";
    infos.push({ topic, section, band, need: computeNeed(state, today), state });
  }
  infos.sort(compareTopicInfo);
  return infos;
}

// reason (не последняя неделя): unexplored (нет строки) > stale > weak (band
// weak|shaky — единственные варианты band у non-strong темы со строкой).
function reasonFor(info: TopicInfo, today: Date): PlanReason {
  if (!info.state) return "unexplored";
  if (isStale(info.state.lastSeenAt, today)) return "stale";
  return "weak";
}

function toFocusItem(info: TopicInfo, reason: PlanReason): PlanFocusItem {
  return { topic: info.topic, section: info.section, band: info.band, reason };
}

/**
 * buildStudyPlan — D3. Полностью pure/детерминированная сборка понедельного
 * плана из уже посчитанной карты знаний (states) и активных секций.
 *
 * weeksLeft = clamp(ceil((examDate - mondayUtc(today)) / 7д), 1, 12).
 * examDate=null -> 8 недель, status 'noExamDate'.
 * 🔴 examDate < mondayUtc(today) -> status 'examDatePassed', weeks=[] (план
 * НЕ генерится вовсе).
 *
 * need темы: нет строки в states -> 0.8; иначе (1-level) + 0.1·isStale.
 * Сортировка тем: need desc, tie-break по имени. K=3 темы/неделю — база;
 * K автоповышается (effectiveK) так, чтобы ПОСЛЕДОВАТЕЛЬНОЕ разбиение
 * отсортированного списка non-strong тем на weeksLeft чанков по effectiveK
 * покрыло ВЕСЬ список — гарантия "каждая non-strong тема (band !== 'strong'
 * по единой конвенции levelToBand) минимум в одной неделе".
 *
 * Последняя неделя горизонта: получает объединение своего чанка (хвост
 * покрытия) И топ-effectiveK "слабейших" тем по need (повтор для закрепления
 * перед экзаменом) — все её focus-темы помечены reason='review';
 * suggestedTest.kind='mock' (у всех остальных недель — 'practice').
 */
export function buildStudyPlan(
  states: Map<string, TopicState>,
  activeSections: ExamSection[],
  examDate: Date | null,
  today: Date,
): StudyPlan {
  const todayMondayMs = mondayUtcMs(today);

  let status: PlanStatus;
  let weeksLeft: number;
  if (examDate === null) {
    status = "noExamDate";
    weeksLeft = DEFAULT_WEEKS_NO_EXAM_DATE;
  } else if (examDate.getTime() < todayMondayMs) {
    return { status: "examDatePassed", weeks: [] };
  } else {
    status = "ok";
    const diffWeeks = Math.ceil((examDate.getTime() - todayMondayMs) / MS_PER_WEEK);
    weeksLeft = clamp(diffWeeks, MIN_WEEKS, MAX_WEEKS);
  }

  const infos = buildTopicInfos(states, activeSections, today);
  const nonStrong = infos.filter((info) => info.band !== "strong");

  const effectiveK =
    nonStrong.length === 0
      ? BASE_WEEKLY_TOPICS
      : Math.max(BASE_WEEKLY_TOPICS, Math.ceil(nonStrong.length / weeksLeft));

  const weeks: PlanWeek[] = [];
  for (let i = 0; i < weeksLeft; i++) {
    const isLastWeek = i === weeksLeft - 1;
    const weekStart = formatUtcDate(todayMondayMs + i * MS_PER_WEEK);
    const chunk = nonStrong.slice(i * effectiveK, (i + 1) * effectiveK);

    let focusInfos: TopicInfo[];
    if (isLastWeek) {
      // Хвост секвенциального покрытия (может быть неполным/пустым, если всё
      // уже покрыто раньше) ОБЪЕДИНЯЕТСЯ с топ-effectiveK слабейших по need
      // из всего non-strong пула — гарантия покрытия не зависит от того,
      // насколько "впритык" effectiveK*weeksLeft к nonStrong.length.
      const weakest = nonStrong.slice(0, effectiveK);
      const seen = new Set<string>();
      focusInfos = [];
      for (const info of [...chunk, ...weakest]) {
        if (seen.has(info.topic)) continue;
        seen.add(info.topic);
        focusInfos.push(info);
      }
    } else {
      focusInfos = chunk;
    }

    const focus = focusInfos.map((info) =>
      toFocusItem(info, isLastWeek ? "review" : reasonFor(info, today)),
    );

    weeks.push({
      weekStart,
      topics: { focus, suggestedTest: { kind: isLastWeek ? "mock" : "practice" } },
    });
  }

  return { status, weeks };
}
