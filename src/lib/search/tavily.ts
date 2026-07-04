import type { SearchResult, WebSearch } from "./types";
import { stripHtml } from "./strip-html";

export function tavilySearch(opts: { apiKey: string }): WebSearch {
  return {
    async search(query, { limit = 5 } = {}): Promise<SearchResult[]> {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, max_results: limit }),
      });
      if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as {
        results: { url: string; title: string; content: string }[];
      };
      return data.results.map((r) => ({ url: r.url, title: r.title, snippet: r.content }));
    },
    async fetchPage(url) {
      const res = await fetch(url, { headers: { "User-Agent": "U-Pal research bot" } });
      if (!res.ok) throw new Error(`fetchPage ${res.status} for ${url}`);
      return stripHtml(await res.text()).slice(0, 50_000);
    },
  };
}
