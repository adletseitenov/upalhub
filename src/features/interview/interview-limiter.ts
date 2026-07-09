import { createRateLimiter } from "@/lib/rate-limit";

// D1 (Global Constraints) 🔴: ёмкость лимитера задана планом явно — 3/10мин
// на пользователя. Интервью-путь дешёвый (максимум 1 LLM-вызов за POST, и
// только если открытые ответы непусты — см. analyzeOpenAnswers), но
// лимитер всё равно защищает от спама derive-only запросов на UPDATE
// study_hqs.approach + recomputeHqInsights (не бесплатная операция даже
// без LLM). Module-level singleton — тот же паттерн, что и
// researchLimiter/explainLimiter.
export const interviewLimiter = createRateLimiter({ capacity: 3, refillPerMs: 3 / (10 * 60_000) });
