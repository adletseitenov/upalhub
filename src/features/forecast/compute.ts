// D4: чистое ядро прогноза v0 — computeForecast. НОЛЬ импортов
// llm/supabase/fetch. Принимает уже посчитанную карту знаний (states, из
// computeKnowledgeStates), активные секции (resolveActiveSections) и
// mock-попытки (repo.ts оркестратора собирает их из tests.spec.scoringSnapshot
// + attempts.scaled_score) — не делает собственных запросов.
import type { ExamSection } from "@/features/exam-profile/spec";
import type { TopicState } from "@/features/knowledge/compute";
import { NMIN, P0 } from "@/features/knowledge/constants";
import { scaleScore } from "@/features/tests/scoring";
import type { ScoringSnapshot } from "@/features/tests/scoring";

export type ForecastConfidence = "low" | "medium" | "high";

export type Forecast = {
  point: number;
  low: number;
  high: number;
  confidence: ForecastConfidence;
  coverage: number;
};

export type MockResult = { scaled: number; snapshot: ScoringSnapshot };

export type ComputeForecastArgs = {
  states: Map<string, TopicState>;
  activeSections: ExamSection[];
  scoring: ScoringSnapshot;
  nFinished: number;
  mocks: MockResult[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Мирроим topicsOfSection из src/features/hq/recompute.ts и
// src/features/plan/build.ts (тот же комментарий там: дублирование
// сознательное — pure-модуль не импортирует оркестратор/другие pure-модули,
// ноль зависимостей от src/features/hq/*). Секция без явных topics трактует
// своё имя как единственную тему.
function topicsOfSection(section: ExamSection): string[] {
  return section.topics.length > 0 ? section.topics : [section.name];
}

function meanTopicLevel(topics: string[], states: Map<string, TopicState>): number {
  const sum = topics.reduce((acc, topic) => acc + (states.get(topic)?.level ?? P0), 0);
  return sum / topics.length;
}

/**
 * computeForecast — D4. Полностью pure/детерминированный прогноз балла из
 * уже посчитанной карты знаний + опциональной mock-калибровки.
 *
 * Гейты (null, не 0/приор):
 *  - states.size === 0 — прогноз из чистого приора запрещён;
 *  - nFinished === 0 — ни одной завершённой попытки;
 *  - все активные секции выпали (после fallback темы секции пусты — защитный
 *    гард, в норме недостижимо: topicsOfSection всегда non-empty, т.к.
 *    section.name непустая строка по схеме) — Σw_s === 0.
 *
 * fraction = Σ w_s·meanTopic_s / Σ w_s, где meanTopic_s — среднее
 * (state?.level ?? P0) по темам секции (fallback = [section.name] для
 * секций без явных topics), w_s = section.taskCount ?? 1. Секции с пустым
 * списком тем (после fallback) полностью исключаются из числителя И
 * знаменателя — не участвуют как w_s·0.
 *
 * Mock-калибровка (в fraction-пространстве, НЕ в баллах — избегает
 * артефактов при разных шкалах mock vs. текущего профиля):
 *  mockFrac_i = (scaled_i − snap.scaleMin) / (snap.scaleMax − snap.scaleMin);
 *  span === 0 → mock пропускается (не входит ни в nMock, ни в среднее);
 *  α = min(0.5, 0.25 · nMock); fractionFinal = α·avg(mockFrac) + (1−α)·fraction
 *  (nMock === 0 → fractionFinal = fraction, α = 0 без деления на ноль).
 *
 * point = scaleScore(round(fractionFinal · 1000), 1000, scoring).
 *
 * coverage = |темы с answeredCount ≥ NMIN среди активных тем| /
 *   max(1, |активные темы|) — активные темы = объединение topicsOfSection по
 *   всем активным секциям (не взвешено по w_s, в отличие от fraction).
 *
 * halfWidthFrac = clamp(0.35·(1−coverage) + 0.25/√max(1,nFinished), 0.05, 0.35)
 * — доля ШКАЛЫ (span·halfWidthFrac дало бы halfWidth в баллах из D4
 * текстуально, но т.к. span сокращается при переводе обратно во
 * fraction-пространство перед scaleScore, halfWidth/span ≡ halfWidthFrac —
 * математически чистая форма без промежуточного deref через span:
 * low/high считаются как scaleScore на fraction-краях
 * (fractionFinal ∓ halfWidthFrac), одним вызовом scaleScore, который уже
 * делает round-to-step + clamp[scaleMin,scaleMax] — без риска
 * рассинхронизации между "point − halfWidth-в-баллах" и повторным
 * округлением к шагу шкалы.
 *
 * confidence: coverage≥0.6 && nFinished≥3 → 'high';
 *             coverage≥0.3 || nFinished≥2 → 'medium'; иначе 'low'.
 */
export function computeForecast(args: ComputeForecastArgs): Forecast | null {
  const { states, activeSections, scoring, nFinished, mocks } = args;

  if (states.size === 0) return null;
  if (nFinished === 0) return null;

  let sumWeightedLevel = 0;
  let sumWeight = 0;
  const activeTopics = new Set<string>();

  for (const section of activeSections) {
    const topics = topicsOfSection(section);
    if (topics.length === 0) continue; // 🔴 защитный гард (D4): пустая секция вне числителя/знаменателя
    for (const topic of topics) activeTopics.add(topic);

    const weight = section.taskCount ?? 1;
    sumWeightedLevel += weight * meanTopicLevel(topics, states);
    sumWeight += weight;
  }

  if (sumWeight === 0) return null; // 🔴 все секции выпали

  const fraction = sumWeightedLevel / sumWeight;

  const mockFracs: number[] = [];
  for (const mock of mocks) {
    const span = mock.snapshot.scaleMax - mock.snapshot.scaleMin;
    if (span === 0) continue; // 🔴 guard: вырожденная шкала снапшота — mock пропускается
    mockFracs.push((mock.scaled - mock.snapshot.scaleMin) / span);
  }
  const nMock = mockFracs.length;
  const alpha = Math.min(0.5, 0.25 * nMock);
  const fractionFinal =
    nMock > 0
      ? alpha * (mockFracs.reduce((sum, f) => sum + f, 0) / nMock) + (1 - alpha) * fraction
      : fraction;

  const point = scaleScore(Math.round(fractionFinal * 1000), 1000, scoring);

  const coveredCount = Array.from(activeTopics).filter(
    (topic) => (states.get(topic)?.answeredCount ?? 0) >= NMIN,
  ).length;
  const coverage = coveredCount / Math.max(1, activeTopics.size);

  const halfWidthFrac = clamp(
    0.35 * (1 - coverage) + 0.25 / Math.sqrt(Math.max(1, nFinished)),
    0.05,
    0.35,
  );

  const low = scaleScore(Math.round((fractionFinal - halfWidthFrac) * 1000), 1000, scoring);
  const high = scaleScore(Math.round((fractionFinal + halfWidthFrac) * 1000), 1000, scoring);

  const confidence: ForecastConfidence =
    coverage >= 0.6 && nFinished >= 3 ? "high" : coverage >= 0.3 || nFinished >= 2 ? "medium" : "low";

  return { point, low, high, confidence, coverage };
}
