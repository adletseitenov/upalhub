import { createRateLimiter } from "@/lib/rate-limit";

// D5: единый лимитер сборки, общий для обоих дорогих LLM-путей — POST
// /api/tests (первая сборка) и POST /api/tests/[testId]/refill (T6,
// «Дособрать»). Один инстанс, а не по одному на роут: иначе refill обходил
// бы лимит первой сборки (и наоборот) отдельным бюджетом на того же
// пользователя. Параметры не меняются относительно исходного лимитера
// api/tests/route.ts — best-effort, per-instance (см. jsdoc в
// src/lib/rate-limit.ts): 5 сборок / 10 минут на пользователя.
export const assemblyLimiter = createRateLimiter({ capacity: 5, refillPerMs: 5 / (10 * 60_000) });
