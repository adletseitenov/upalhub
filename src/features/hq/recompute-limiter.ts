import { createRateLimiter } from "@/lib/rate-limit";

// D7: лёгкий лимитер manual-triggered POST /api/hq/[hqId]/recompute — тот
// же путь используется и дашбордом (RecomputeKicker, Task6, fire-and-forget
// на stale-детект), и ручным backfill legacy-штабов. Пересчёт не зовёт LLM
// (ноль спенда), поэтому лимит мягкий — только защита от случайного цикла
// на клиенте, не бюджетный гейт. capacity 6 / 10 минут на пользователя
// (per-instance, best-effort — см. jsdoc в src/lib/rate-limit.ts).
export const recomputeLimiter = createRateLimiter({ capacity: 6, refillPerMs: 6 / (10 * 60_000) });
