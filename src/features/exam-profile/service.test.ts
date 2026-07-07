import { describe, expect, it } from "vitest";
import { fakeLlm } from "@/lib/llm";
import { fakeSearch } from "@/lib/search";
import { findOrCreateExamProfile, type ExamProfileRepo, type StoredExamProfile } from "./service";

const specFixture = {
  examName: "ЕНТ",
  language: "kk",
  description: "Тест.",
  sections: [{ name: "Математика" }],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

function memoryRepo(seed: StoredExamProfile[] = []): ExamProfileRepo & { rows: StoredExamProfile[] } {
  const rows = [...seed];
  return {
    rows,
    async findBySlug(slug) {
      return rows.find((r) => r.slug === slug) ?? null;
    },
    async insert(p) {
      const stored = { ...p, id: `id-${rows.length + 1}` } as StoredExamProfile;
      rows.push(stored);
      return stored;
    },
  };
}

const liveDeps = () => ({
  llm: fakeLlm([specFixture]),
  search: fakeSearch(
    [{ url: "https://a.example", title: "A", snippet: "формат" }],
    { "https://a.example": "длинный текст страницы про формат экзамена ".repeat(10) },
  ),
});

describe("findOrCreateExamProfile", () => {
  it("researches and stores a new profile", async () => {
    const repo = memoryRepo();
    const { profile, created } = await findOrCreateExamProfile({ ...liveDeps(), repo }, "ЕНТ 2027");
    expect(created).toBe(true);
    expect(profile.slug).toBe("ent-2027");
    expect(profile.origin).toBe("ai_research");
    expect(profile.trust).toBe("ai_draft");
    expect(repo.rows).toHaveLength(1);
  });

  it("returns existing profile without calling llm", async () => {
    const existing = {
      id: "id-1", slug: "ent-2027", title: "ЕНТ", language: "kk",
      spec: specFixture, sources: [], origin: "ai_research", trust: "ai_draft",
    } as unknown as StoredExamProfile;
    const repo = memoryRepo([existing]);
    const llm = fakeLlm([]); // бросит, если сервис его вызовет
    const { profile, created } = await findOrCreateExamProfile(
      { llm, search: fakeSearch([]), repo },
      "ент 2027",
    );
    expect(created).toBe(false);
    expect(profile.id).toBe("id-1");
  });
});
