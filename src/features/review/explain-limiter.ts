import { createRateLimiter } from "@/lib/rate-limit";

// D5/Task9: единственный LLM-путь этапа 3 — «почему я ошибся». Module-level
// (переживает запросы, но не деплой/рестарт — см. jsdoc в
// src/lib/rate-limit.ts) инстанс, проверяется ДО любого LLM-спенда, ПОСЛЕ
// всех auth/ownership/finished/cross-attempt гейтов (см. route.ts) — ни
// одного токена на заведомо невалидный запрос, ни одного LLM-вызова без
// свободного токена. capacity 10 / 10 минут, как задано в D5/Task9.
export const explainLimiter = createRateLimiter({ capacity: 10, refillPerMs: 10 / (10 * 60_000) });
