// D1: константы Bayesian-модели карты знаний. Экзамен-агностичны — темы/веса/
// шкала экзамена живут в exam_profiles.spec, здесь ТОЛЬКО модельные параметры.
// Ревизия ожидается после клик-теста основателя на живых данных (см. Open
// Questions плана Stage 3, #1).

// 🔴 красная команда: было 30 — один свежий промах вымывал всю историю темы.
export const HALF_LIFE_DAYS = 45;

// 🔴 красная команда: recency больше не падает в ноль — старые ответы всегда
// вносят хотя бы минимальный вклад в знаменатель/числитель.
export const RECENCY_FLOOR = 0.15;

// Байесовский приор (P0) и его "вес" в псевдонаблюдениях (K).
export const P0 = 0.3;
// 🔴 красная команда: было 2 — при K=3 единичный свежий промах не проваливает
// тему ниже приора P0.
export const K = 3;

// Тема с answeredCount < NMIN не попадает в карту вовсе ("не изведано" —
// отсутствие строки, не ноль/прочерк).
export const NMIN = 3;

// Порог "залежалости" темы для бейджа на чтении: now - lastSeenAt > STALE_DAYS.
export const STALE_DAYS = 21;

// 🔴 красная команда: полуоткрытая конвенция бэндов — strong ⇔ level >=
// BAND_STRONG; weak ⇔ level < BAND_WEAK; иначе shaky. Единственная реализация
// (levelToBand ниже) переиспользуется картой (D2) и планом (D3) — пороги НЕ
// дублировать инлайн в других местах.
export const BAND_STRONG = 0.75;
export const BAND_WEAK = 0.4;

export type KnowledgeBand = "weak" | "shaky" | "strong";

export function levelToBand(level: number): KnowledgeBand {
  if (level >= BAND_STRONG) return "strong";
  if (level < BAND_WEAK) return "weak";
  return "shaky";
}
