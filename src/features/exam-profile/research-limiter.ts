import { createRateLimiter } from "@/lib/rate-limit";

// D3: единый лимитер для обоих спенд-путей POST /api/exam-profiles —
// обычный research И reroll (excludeSlug) делят один инстанс/бюджет на
// пользователя (иначе reroll обходил бы лимит обычного research отдельной
// корзиной). Проверяется ДО любого LLM/веб-спенда (см. jsdoc в
// src/lib/rate-limit.ts — best-effort, per-instance). capacity 3 / 10 минут,
// как задано в D3/Task5.
export const researchLimiter = createRateLimiter({ capacity: 3, refillPerMs: 3 / (10 * 60_000) });
