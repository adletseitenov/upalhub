import { tavilySearch } from "./tavily";
import type { WebSearch } from "./types";

export type { WebSearch, SearchResult } from "./types";
export { fakeSearch } from "./fake";

export function createSearch(env: Record<string, string | undefined> = process.env): WebSearch {
  const key = env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY is not set");
  return tavilySearch({ apiKey: key });
}
