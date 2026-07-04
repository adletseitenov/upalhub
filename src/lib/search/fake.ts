import type { SearchResult, WebSearch } from "./types";

export function fakeSearch(
  results: SearchResult[],
  pages: Record<string, string> = {},
): WebSearch {
  return {
    async search(_query, opts) {
      return results.slice(0, opts?.limit ?? results.length);
    },
    async fetchPage(url) {
      const page = pages[url];
      if (page === undefined) throw new Error(`fakeSearch: no page for ${url}`);
      return page;
    },
  };
}
