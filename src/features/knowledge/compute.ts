// D1: чистое ядро карты знаний — Bayesian mastery с recency-взвешиванием.
// НОЛЬ импортов llm/supabase/fetch. Принимает только плоские входы; маппинг
// attempt_items(join tests.hq_id)/tasks -> KnowledgeItem[] делает repo.ts
// оркестратора (Task 3), не этот модуль.
import { HALF_LIFE_DAYS, K, NMIN, P0, RECENCY_FLOOR, STALE_DAYS } from "./constants";

export type KnowledgeItem = {
  topic: string;
  difficulty: number;
  isCorrect: boolean;
  // response=null у источника -> answered=false; skipped-items не сигнал
  // (Global Constraints плана) и полностью исключаются ниже.
  answered: boolean;
  finishedAt: Date;
};

export type TopicState = {
  level: number;
  answeredCount: number;
  lastSeenAt: Date;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Мусорная difficulty (NaN и подобное) толерантно нормализуется в середину
// диапазона [1,5] — Math.min/max с NaN даёт NaN, поэтому явная проверка.
function normalizeDifficulty(difficulty: number): number {
  if (!Number.isFinite(difficulty)) return 3;
  return clamp(difficulty, 1, 5);
}

// Будущая дата (мусор/часовые пояса) толерантно нормализуется в age=0, а не
// в отрицательный возраст, который раздул бы recency выше 1.
function ageDays(finishedAt: Date, now: Date): number {
  const diffMs = now.getTime() - finishedAt.getTime();
  return Math.max(0, diffMs / MS_PER_DAY);
}

function recencyWeight(finishedAt: Date, now: Date): number {
  const age = ageDays(finishedAt, now);
  return Math.max(0.5 ** (age / HALF_LIFE_DAYS), RECENCY_FLOOR);
}

function difficultyWeight(difficulty: number): number {
  const d = normalizeDifficulty(difficulty);
  return 1 + (d - 1) / 4;
}

type Accumulator = {
  sumG: number;
  sumGX: number;
  answeredCount: number;
  lastSeenAt: Date;
};

/**
 * computeKnowledgeStates — D1. Полный recompute (никогда инкрементальный):
 * только answered=true и topic ∈ activeTopics участвуют; битые строки
 * (не-finite finishedAt) скипаются. Тема с answeredCount < NMIN не попадает
 * в результат вовсе ("не изведано" = отсутствие ключа).
 *
 * level = (Σ g_i·x_i + K·P0) / (Σ g_i + K), где
 *   g_i = recency_i · diffW_i,
 *   recency_i = max(0.5^(age_days/HALF_LIFE_DAYS), RECENCY_FLOOR),
 *   diffW_i = 1 + (clamp(difficulty,1,5) - 1) / 4.
 */
export function computeKnowledgeStates(
  items: KnowledgeItem[],
  activeTopics: ReadonlySet<string>,
  now: Date,
): Map<string, TopicState> {
  const acc = new Map<string, Accumulator>();

  for (const item of items) {
    if (!item.answered) continue;
    if (!activeTopics.has(item.topic)) continue;
    if (!Number.isFinite(item.finishedAt.getTime())) continue;

    const g = recencyWeight(item.finishedAt, now) * difficultyWeight(item.difficulty);
    const x = item.isCorrect ? 1 : 0;

    const existing = acc.get(item.topic);
    if (existing) {
      existing.sumG += g;
      existing.sumGX += g * x;
      existing.answeredCount += 1;
      if (item.finishedAt.getTime() > existing.lastSeenAt.getTime()) {
        existing.lastSeenAt = item.finishedAt;
      }
    } else {
      acc.set(item.topic, {
        sumG: g,
        sumGX: g * x,
        answeredCount: 1,
        lastSeenAt: item.finishedAt,
      });
    }
  }

  const result = new Map<string, TopicState>();
  for (const [topic, a] of acc) {
    if (a.answeredCount < NMIN) continue;
    result.set(topic, {
      level: (a.sumGX + K * P0) / (a.sumG + K),
      answeredCount: a.answeredCount,
      lastSeenAt: a.lastSeenAt,
    });
  }
  return result;
}

// D2: staleness-бейдж на чтении, не участвует в арифметике level.
export function isStale(lastSeenAt: Date, now: Date): boolean {
  return ageDays(lastSeenAt, now) > STALE_DAYS;
}
