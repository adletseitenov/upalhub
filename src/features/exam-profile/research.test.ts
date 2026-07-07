import { describe, expect, it, vi } from "vitest";
import { fakeLlm, llmFromRaw, type Llm, type RawComplete } from "@/lib/llm";
import { fakeSearch } from "@/lib/search";
import { researchExam, ResearchError } from "./research";

const specFixture = {
  examName: "ЕНТ",
  language: "kk",
  description: "Единое национальное тестирование Казахстана.",
  sections: [{ name: "Математическая грамотность", taskCount: 10 }],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

// D4: НИШ-подобная спека — взаимоисключающие профили с общими секциями.
const nisSpec = {
  examName: "NIS — вступительный тест",
  language: "kk",
  description: "Экзамен в Назарбаев Интеллектуальные школы.",
  sections: [
    { name: "Критическое мышление" },
    { name: "Математическая грамотность" },
    { name: "Физика" },
    { name: "Химия" },
  ],
  variants: [
    {
      key: "phys-math",
      label: "Физико-математический",
      sectionNames: ["Критическое мышление", "Математическая грамотность", "Физика"],
    },
    {
      key: "chem-bio",
      label: "Химико-биологический",
      sectionNames: ["Критическое мышление", "Математическая грамотность", "Химия"],
    },
  ],
  scoring: { scaleMin: 0, scaleMax: 100, unit: "баллов" },
};

// D4: ЕНТ-подобная спека — «выбери 2 из 3» профильных предметов.
const entSpec = {
  examName: "ЕНТ",
  language: "kk",
  description: "Единое национальное тестирование Казахстана.",
  sections: [
    { name: "Математическая грамотность" },
    { name: "Физика" },
    { name: "Химия" },
    { name: "Биология" },
  ],
  selectionGroups: [
    {
      key: "profile-subjects",
      title: "Профильные предметы",
      chooseCount: 2,
      sectionNames: ["Физика", "Химия", "Биология"],
    },
  ],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

// D4: IELTS-подобная спека — одновариантный экзамен с аудированием.
const ieltsSpec = {
  examName: "IELTS",
  language: "en",
  description: "International English Language Testing System.",
  sections: [
    { name: "Listening", modality: "audio" },
    { name: "Reading" },
    { name: "Writing" },
    { name: "Speaking" },
  ],
  variants: [],
  scoring: { scaleMin: 0, scaleMax: 9, unit: "band" },
};

const results = [
  { url: "https://a.example", title: "A", snippet: "формат ЕНТ" },
  { url: "https://b.example", title: "B", snippet: "структура ЕНТ" },
];

type RecordedCall = { system?: string; prompt: string; maxTokens?: number };

function spyLlm(response: unknown): { llm: Llm; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const llm: Llm = {
    async complete(args) {
      calls.push({ system: args.system, prompt: args.prompt, maxTokens: args.maxTokens });
      return args.schema.parse(response);
    },
  };
  return { llm, calls };
}

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

  it("preserves variants for a NIS-like multi-variant exam", async () => {
    const deps = { llm: fakeLlm([nisSpec]), search: fakeSearch(results, {}) };
    const { spec } = await researchExam(deps, "NIS");
    expect(spec.variants.length).toBeGreaterThanOrEqual(2);
    const sectionNames = new Set(spec.sections.map((s) => s.name));
    for (const variant of spec.variants) {
      for (const name of variant.sectionNames) {
        expect(sectionNames.has(name)).toBe(true);
      }
    }
  });

  it("preserves selectionGroups for an ENT-like choose-N exam", async () => {
    const deps = { llm: fakeLlm([entSpec]), search: fakeSearch(results, {}) };
    const { spec } = await researchExam(deps, "ЕНТ");
    expect(spec.selectionGroups).toEqual([
      {
        key: "profile-subjects",
        title: "Профильные предметы",
        chooseCount: 2,
        sectionNames: ["Физика", "Химия", "Биология"],
      },
    ]);
  });

  it("preserves audio modality for an IELTS-like Listening section", async () => {
    const deps = { llm: fakeLlm([ieltsSpec]), search: fakeSearch(results, {}) };
    const { spec } = await researchExam(deps, "IELTS");
    expect(spec.variants).toEqual([]);
    const listening = spec.sections.find((s) => s.name === "Listening");
    expect(listening?.modality).toBe("audio");
  });

  it("prompts the model to extract variants, selectionGroups, and modality", async () => {
    const { llm, calls } = spyLlm(specFixture);
    const deps = { llm, search: fakeSearch(results, {}) };
    await researchExam(deps, "ЕНТ");
    const sent = `${calls[0].system ?? ""}\n${calls[0].prompt}`;
    expect(sent).toMatch(/variants/);
    expect(sent).toMatch(/selectionGroups/);
    expect(sent).toMatch(/modality/);
    expect(sent).toMatch(/chooseCount/);
    expect(sent).toMatch(/audio/);
  });

  it("includes an avoid line in the prompt when opts.avoid is provided", async () => {
    const { llm, calls } = spyLlm(specFixture);
    const deps = { llm, search: fakeSearch(results, {}) };
    await researchExam(deps, "ЕНТ", { avoid: { name: "SAT", country: "США" } });
    expect(calls[0].prompt).toContain('пользователь уточнил, что это НЕ "SAT" (США)');
  });

  it("omits the avoid line when opts is not provided", async () => {
    const { llm, calls } = spyLlm(specFixture);
    const deps = { llm, search: fakeSearch(results, {}) };
    await researchExam(deps, "ЕНТ");
    expect(calls[0].prompt).not.toContain("пользователь уточнил");
  });

  it("accepts a flat response without variants/selectionGroups/modality (graceful degrade)", async () => {
    const deps = { llm: fakeLlm([specFixture]), search: fakeSearch(results, {}) };
    const { spec } = await researchExam(deps, "ЕНТ");
    expect(spec.variants).toEqual([]);
    expect(spec.selectionGroups).toEqual([]);
    expect(spec.sections[0].modality).toBeUndefined();
  });

  it("retries once when the first response violates spec integrity, then accepts a clean one", async () => {
    const dangling = {
      ...specFixture,
      variants: [{ key: "x", label: "X", sectionNames: ["Несуществующая секция"] }],
    };
    const raw: RawComplete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify(dangling))
      .mockResolvedValueOnce(JSON.stringify(specFixture));
    const llm = llmFromRaw(raw);
    const deps = { llm, search: fakeSearch(results, {}) };
    await expect(researchExam(deps, "ЕНТ")).resolves.toMatchObject({
      spec: { examName: specFixture.examName },
    });
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("requests completion with maxTokens 24000", async () => {
    const { llm, calls } = spyLlm(specFixture);
    const deps = { llm, search: fakeSearch(results, {}) };
    await researchExam(deps, "ЕНТ");
    expect(calls[0].maxTokens).toBe(24_000);
  });
});
