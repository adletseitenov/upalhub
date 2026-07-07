import { describe, expect, it } from "vitest";
import { fakeLlm } from "@/lib/llm";
import { fakeSearch } from "@/lib/search";
import { researchExam, ResearchError } from "./research";

const specFixture = {
  examName: "ЕНТ",
  language: "kk",
  description: "Единое национальное тестирование Казахстана.",
  sections: [{ name: "Математическая грамотность", taskCount: 10 }],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

const results = [
  { url: "https://a.example", title: "A", snippet: "формат ЕНТ" },
  { url: "https://b.example", title: "B", snippet: "структура ЕНТ" },
];

describe("researchExam", () => {
  it("returns validated spec with page sources on happy path", async () => {
    const deps = {
      llm: fakeLlm([specFixture]),
      search: fakeSearch(results, {
        "https://a.example": "подробный текст страницы A про формат экзамена ".repeat(10),
        "https://b.example": "подробный текст страницы B про структуру экзамена ".repeat(10),
      }),
    };
    const { spec, sources } = await researchExam(deps, "ЕНТ");
    expect(spec.examName).toBe("ЕНТ");
    expect(sources).toEqual([
      { url: "https://a.example", title: "A" },
      { url: "https://b.example", title: "B" },
    ]);
  });

  it("falls back to snippets when pages are unreachable", async () => {
    const deps = {
      llm: fakeLlm([specFixture]),
      search: fakeSearch(results, {}), // fetchPage бросает для любого url
    };
    const { sources } = await researchExam(deps, "ЕНТ");
    expect(sources.map((s) => s.url)).toEqual(["https://a.example", "https://b.example"]);
  });

  it("throws ResearchError when search finds nothing", async () => {
    const deps = { llm: fakeLlm([specFixture]), search: fakeSearch([]) };
    await expect(researchExam(deps, "abcdefg")).rejects.toThrow(ResearchError);
  });
});
