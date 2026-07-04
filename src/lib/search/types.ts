export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}

export interface WebSearch {
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
  fetchPage(url: string): Promise<string>;
}
