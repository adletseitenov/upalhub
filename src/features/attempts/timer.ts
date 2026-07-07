// Клиентский таймер (D4): косметический — сервер остаётся единственным
// источником истины по времени (deadlineAt приходит из started_at +
// spec.totalTimeMinutes, посчитанного на сервере). Эти функции только
// форматируют/сравнивают уже известный дедлайн; setInterval/Date.now()
// живут в TestRunner.tsx, здесь — НОЛЬ побочных эффектов.

/**
 * remainingMs — сколько миллисекунд осталось до дедлайна. null, если у
 * теста нет ограничения по времени (deadlineAt === null). Никогда не
 * уходит в отрицательные значения — истёкший дедлайн даёт 0, а не минус.
 */
export function remainingMs(deadlineAt: Date | null, now: Date): number | null {
  if (deadlineAt === null) return null;
  return Math.max(0, deadlineAt.getTime() - now.getTime());
}

/**
 * isExpired — true, если дедлайн уже наступил (now >= deadlineAt).
 * Без таймера (null) — никогда не считается истёкшим.
 */
export function isExpired(deadlineAt: Date | null, now: Date): boolean {
  if (deadlineAt === null) return false;
  return now.getTime() >= deadlineAt.getTime();
}

/**
 * formatRemaining — MM:SS по умолчанию; переключается на H:MM:SS, как
 * только остаток превышает 60 минут (ровно 60:00 остаётся в MM:SS-виде).
 * Секунды округляются ВВЕРХ (Math.ceil), чтобы дисплей не показывал
 * 00:00, пока время формально ещё не истекло (например, 500мс -> 00:01).
 */
export function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");

  if (totalSeconds > 60 * 60) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad(minutes)}:${pad(seconds)}`;
}
