import type { Llm } from "@/lib/llm";
import type { WebSearch, SearchResult } from "@/lib/search";
import { examProfileSpecSchema, type ExamProfileSpec, type SourceRef } from "./spec";

const MAX_PAGES = 3;
const PAGE_CHARS = 8_000;

export class ResearchError extends Error {}

const SYSTEM_PROMPT = `Ты — исследователь экзаменов. По материалам из интернета ты составляешь
структурированный профиль экзамена. Отвечай ТОЛЬКО валидным JSON без markdown и пояснений.
Если чего-то нет в материалах — используй null, не выдумывай точные числа.`;

function buildPrompt(query: string, context: string): string {
  return `Составь профиль экзамена по запросу: "${query}".

Материалы из интернета:
${context}

Верни JSON строго такой структуры:
{
  "examName": "официальное название экзамена",
  "language": "основной язык экзамена (код: ru/kk/en/uz/...)",
  "country": "страна или 'международный' (или null)",
  "description": "1-2 предложения: что это за экзамен и для чего",
  "sections": [{
    "name": "название секции/предмета",
    "taskCount": число заданий или null,
    "timeLimitMinutes": лимит времени секции в минутах или null,
    "taskTypes": ["типы заданий"],
    "topics": ["основные темы"]
  }],
  "scoring": { "scaleMin": число, "scaleMax": число, "passingScore": число или null, "unit": "единица шкалы" },
  "totalTimeMinutes": общее время в минутах или null,
  "typicalDates": "когда обычно проводится (или null)"
}`;
}

async function collectPages(search: WebSearch, results: SearchResult[]) {
  const pages: { url: string; title: string; text: string }[] = [];
  for (const r of results) {
    if (pages.length >= MAX_PAGES) break;
    try {
      const text = (await search.fetchPage(r.url)).slice(0, PAGE_CHARS);
      if (text.length > 200) pages.push({ url: r.url, title: r.title, text });
    } catch {
      // страница не открылась — пробуем следующую
    }
  }
  return pages;
}

export async function researchExam(
  deps: { llm: Llm; search: WebSearch },
  query: string,
): Promise<{ spec: ExamProfileSpec; sources: SourceRef[] }> {
  const queries = [
    `${query} формат структура экзамена`,
    `${query} exam format structure scoring`,
  ];
  const found = (
    await Promise.all(queries.map((q) => deps.search.search(q, { limit: 5 })))
  ).flat();
  const unique = [...new Map(found.map((r) => [r.url, r])).values()];
  if (unique.length === 0) throw new ResearchError(`ничего не найдено по запросу: ${query}`);

  const pages = await collectPages(deps.search, unique);
  const usedSnippets = pages.length === 0;
  const context = usedSnippets
    ? unique
        .slice(0, 8)
        .map((r, i) => `### Сниппет ${i + 1}: ${r.title}\n${r.url}\n${r.snippet}`)
        .join("\n\n")
    : pages
        .map((p, i) => `### Источник ${i + 1}: ${p.title}\n${p.url}\n${p.text}`)
        .join("\n\n");

  const spec = await deps.llm.complete({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(query, context),
    schema: examProfileSpecSchema,
    maxTokens: 8_000,
  });

  const sources: SourceRef[] = (usedSnippets ? unique.slice(0, 8) : pages).map((p) => ({
    url: p.url,
    title: p.title,
  }));
  return { spec, sources };
}
