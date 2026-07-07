import { describe, expect, it, beforeAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLlm } from "@/lib/llm";
import { createSearch } from "@/lib/search";
import { researchExam } from "@/features/exam-profile/research";
import { slugifyExamQuery } from "@/features/exam-profile/slug";

const EXAMS = ["ЕНТ Казахстан", "IELTS Academic", "DTM Узбекистан", "SAT"];
const OUT = join(process.cwd(), "evals", "exam-profiles", "out");

beforeAll(() => {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // нет .env.local — ключи должны быть в окружении
  }
  mkdirSync(OUT, { recursive: true });
});

describe("exam profile quality eval (live)", () => {
  for (const exam of EXAMS) {
    it(`researches: ${exam}`, async () => {
      const { spec, sources } = await researchExam(
        { llm: createLlm(), search: createSearch() },
        exam,
      );
      writeFileSync(
        join(OUT, `${slugifyExamQuery(exam)}.json`),
        JSON.stringify({ spec, sources }, null, 2),
        "utf8",
      );
      // структурный минимум; качество содержания оцениваем глазами по out/*.json
      expect(spec.sections.length).toBeGreaterThan(0);
      expect(spec.scoring.scaleMax).toBeGreaterThan(spec.scoring.scaleMin);
      expect(sources.length).toBeGreaterThanOrEqual(2);
      console.log(
        `${exam}: ${spec.sections.length} секций, шкала ${spec.scoring.scaleMin}-${spec.scoring.scaleMax} ${spec.scoring.unit}, ${sources.length} источников`,
      );
    });
  }
});
