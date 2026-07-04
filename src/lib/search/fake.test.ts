import { describe, expect, it } from "vitest";
import { fakeSearch } from "./fake";

const results = [
  { url: "https://a", title: "A", snippet: "sa" },
  { url: "https://b", title: "B", snippet: "sb" },
];

describe("fakeSearch", () => {
  it("returns limited results and pages", async () => {
    const s = fakeSearch(results, { "https://a": "text A" });
    expect(await s.search("q", { limit: 1 })).toEqual([results[0]]);
    expect(await s.fetchPage("https://a")).toBe("text A");
    await expect(s.fetchPage("https://x")).rejects.toThrow("no page");
  });
});
