import { createHash } from "node:crypto";

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ә: "a", ғ: "g", қ: "k", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h", і: "i",
};

export function slugifyExamQuery(query: string): string {
  let out = "";
  for (const ch of query.trim().toLowerCase()) out += TRANSLIT[ch] ?? ch;
  const cleaned = out
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-+|-+$/g, "");
  return cleaned || "exam";
}

// D3/Task5: slug-guard для reroll — если пересчитанный слаг совпадает с
// отвергнутым (уточнение почти не изменило запрос), findOrCreateExamProfile
// нашёл бы тот же профиль по slug и reroll не выдал бы новый результат.
// Суффикс делает слаг заведомо отличным от excludeSlug: newSlug никогда не
// равен excludeSlug на выходе этой функции. seed (уточнение или исходный
// запрос) даёт стабильный, но не предсказуемый заранее суффикс.
export function ensureRerollSlug(newSlug: string, excludeSlug: string, seed: string): string {
  if (newSlug !== excludeSlug) return newSlug;
  const suffix = createHash("sha256").update(seed).digest("hex").slice(0, 6);
  return `${newSlug}-x${suffix}`;
}
