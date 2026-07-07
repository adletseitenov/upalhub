import { describe, expect, it, vi } from "vitest";
import { fakeLlm } from "@/lib/llm";
import type { ExamProfileSpec } from "@/features/exam-profile/spec";
import { generateForBucket, type Bucket } from "./generate";
import { contentHash } from "./repo";
import type { NewTaskRow, StoredTask, TaskBankRepo } from "./repo";

const examSpec: ExamProfileSpec = {
  examName: "ЕНТ",
  language: "kk",
  description: "Единое национальное тестирование.",
  sections: [
    { name: "Математика", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] },
  ],
  variants: [],
  selectionGroups: [],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

const bucket: Bucket = {
  sectionName: "Математика",
  type: "algebra",
  topic: "Уравнения",
  difficulty: 3,
  count: 10,
  modality: "text",
  sectionTopics: [],
  sectionTaskTypes: [],
};

function singleChoiceTask(promptText: string, difficulty = 3) {
  return {
    body: {
      format: "single_choice",
      prompt: promptText,
      options: [
        { id: "a", text: "4" },
        { id: "b", text: "5" },
      ],
    },
    answer: { format: "single_choice", correctOptionId: "a" },
    explanation: "2+2=4.",
    difficulty,
  };
}

// D6: тот же shape, что singleChoiceTask, но с body.passage — для
// audio-модальности и enforcement-тестов дропа.
function singleChoiceTaskWithPassage(promptText: string, passage: string | null | undefined, difficulty = 3) {
  const task = singleChoiceTask(promptText, difficulty);
  return { ...task, body: { ...task.body, passage } };
}

function fakeRepo(): TaskBankRepo & { rows: NewTaskRow[] } {
  const rows: NewTaskRow[] = [];
  let nextId = 1;
  return {
    rows,
    async findBucket() {
      return [];
    },
    async insertMany(newRows) {
      const inserted: StoredTask[] = [];
      for (const row of newRows) {
        rows.push(row);
        inserted.push({
          id: String(nextId++),
          type: row.type,
          topic: row.topic,
          difficulty: row.difficulty,
          language: row.language,
          body: row.body,
          answer: row.answer,
          explanation: row.explanation,
        });
      }
      return { inserted, skipped: 0 };
    },
  };
}

describe("generateForBucket", () => {
  it("makes exactly one llm.complete call when the first (overshot) batch already covers bucket.count", async () => {
    const firstBatch = Array.from({ length: 10 }, (_, i) => singleChoiceTask(`Задание ${i}`));
    const llm = fakeLlm([firstBatch]);
    const completeSpy = vi.spyOn(llm, "complete");
    const repo = fakeRepo();

    const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", bucket);

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(10);
  });

  it("requests the full overshoot batch (10) regardless of a smaller bucket.count", async () => {
    const firstBatch = Array.from({ length: 10 }, (_, i) => singleChoiceTask(`Q${i}`));
    const llm = fakeLlm([firstBatch]);
    const completeSpy = vi.spyOn(llm, "complete");
    const repo = fakeRepo();
    const smallBucket: Bucket = { ...bucket, count: 1 };

    const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", smallBucket);

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy.mock.calls[0][0].prompt).toContain("10");
    expect(result).toHaveLength(10); // overshoot: bank warms up with all valid, not just the deficit
  });

  it("drops invalid elements and retries exactly once for the deficit", async () => {
    const firstBatch = [
      singleChoiceTask("Задание 1"),
      singleChoiceTask("Задание 2"),
      singleChoiceTask("Задание 3"),
      singleChoiceTask("Задание 4"),
      { garbage: true }, // completely invalid shape
      { body: { format: "single_choice", prompt: "", options: [] }, answer: {}, explanation: "", difficulty: 9 }, // invalid body/answer
      singleChoiceTask("Задание 5"),
      singleChoiceTask("Задание 6"),
      { format: "unknown" }, // completely invalid shape
      singleChoiceTask("Задание 7"),
    ]; // 7 valid, 3 invalid → deficit = 10 - 7 = 3
    const retryBatch = [
      singleChoiceTask("Добор 1"),
      singleChoiceTask("Добор 2"),
      singleChoiceTask("Добор 3"),
    ];
    const llm = fakeLlm([firstBatch, retryBatch]);
    const completeSpy = vi.spyOn(llm, "complete");
    const repo = fakeRepo();

    const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", bucket);

    expect(completeSpy).toHaveBeenCalledTimes(2);
    const retryArgs = completeSpy.mock.calls[1][0];
    expect(retryArgs.prompt).toMatch(/ещё/i);
    expect(retryArgs.prompt).toMatch(/не повторяя формулировки/i);
    expect(retryArgs.prompt).toContain("3"); // deficit size
    expect(result).toHaveLength(10);
  });

  it("returns a partial result without throwing when still short after the single retry", async () => {
    const firstBatch = [singleChoiceTask("Задание 1"), singleChoiceTask("Задание 2")]; // 2 valid, deficit 8
    const retryBatch = [singleChoiceTask("Добор 1")]; // only 1 valid, still short
    const llm = fakeLlm([firstBatch, retryBatch]);
    const completeSpy = vi.spyOn(llm, "complete");
    const repo = fakeRepo();

    const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", bucket);

    expect(completeSpy).toHaveBeenCalledTimes(2); // no third call
    expect(result).toHaveLength(3); // 2 + 1, graceful degrade, no throw
  });

  it("always calls deps.llm at least once, even for a zero-count bucket (caller decides whether to invoke at all)", async () => {
    const firstBatch = Array.from({ length: 10 }, (_, i) => singleChoiceTask(`Warm ${i}`));
    const llm = fakeLlm([firstBatch]);
    const completeSpy = vi.spyOn(llm, "complete");
    const repo = fakeRepo();
    const zeroBucket: Bucket = { ...bucket, count: 0 };

    const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", zeroBucket);

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(10);
  });

  it("builds the prompt only from spec + bucket fields, with spec.language as the content language", async () => {
    const firstBatch = Array.from({ length: 10 }, (_, i) => singleChoiceTask(`R${i}`));
    const llm = fakeLlm([firstBatch]);
    const completeSpy = vi.spyOn(llm, "complete");
    const repo = fakeRepo();
    const ieltsSpec: ExamProfileSpec = { ...examSpec, examName: "IELTS", language: "en" };
    const readingBucket: Bucket = {
      sectionName: "Reading",
      type: "reading_comprehension",
      topic: "Skimming",
      difficulty: 4,
      count: 10,
      modality: "text",
      sectionTopics: [],
      sectionTaskTypes: [],
    };

    await generateForBucket({ llm, repo }, ieltsSpec, "profile-2", readingBucket);

    const prompt = completeSpy.mock.calls[0][0].prompt;
    expect(prompt).toContain("IELTS");
    expect(prompt).toContain("en");
    expect(prompt).toContain("Reading");
    expect(prompt).toContain("reading_comprehension");
    expect(prompt).toContain("Skimming");
    expect(prompt).toContain("4");
  });

  it("inserts rows with origin='ai', the given examProfileId, bucket-authoritative type/topic/difficulty, and a matching contentHash", async () => {
    const firstBatch = [singleChoiceTask("Единственное задание", 5)]; // LLM-reported difficulty (5) differs from bucket.difficulty (3)
    const llm = fakeLlm([firstBatch]);
    const repo = fakeRepo();

    await generateForBucket({ llm, repo }, examSpec, "profile-42", { ...bucket, count: 1 });

    expect(repo.rows).toHaveLength(1);
    const row = repo.rows[0];
    expect(row.origin).toBe("ai");
    expect(row.examProfileId).toBe("profile-42");
    expect(row.type).toBe(bucket.type);
    expect(row.topic).toBe(bucket.topic);
    expect(row.language).toBe(examSpec.language);
    expect(row.difficulty).toBe(bucket.difficulty); // bucket wins over the LLM's self-reported difficulty
    expect(row.contentHash).toBe(contentHash(row.body));
  });

  it("degrades a failed first batch (unparseable LLM output) to the retry instead of throwing", async () => {
    const retryBatch = [singleChoiceTask("Спасено ретраем")];
    let call = 0;
    const llm = {
      complete: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("no JSON found in LLM output");
        return retryBatch as never;
      }),
    };
    const repo = fakeRepo();

    const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", {
      ...bucket,
      count: 1,
    });

    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
  });

  it("returns an empty result without throwing when both batch requests fail", async () => {
    const llm = {
      complete: vi.fn(async () => {
        throw new Error("no JSON found in LLM output");
      }),
    };
    const repo = fakeRepo();

    const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", bucket);

    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result).toEqual([]);
  });

  it("rethrows BudgetExceededError instead of degrading (assembly control signal)", async () => {
    const budgetError = new Error("llm generation budget exceeded for this test assembly");
    budgetError.name = "BudgetExceededError";
    const llm = {
      complete: vi.fn(async () => {
        throw budgetError;
      }),
    };
    const repo = fakeRepo();

    await expect(generateForBucket({ llm, repo }, examSpec, "profile-1", bucket)).rejects.toThrow(
      budgetError,
    );
  });

  // D6: привязка к секции + audio-транскрипт enforcement.
  describe("D6 section anchoring + audio transcript", () => {
    it("anchors the prompt to the section name, section topics list, and a cross-section prohibition", async () => {
      const firstBatch = Array.from({ length: 10 }, (_, i) => singleChoiceTask(`A${i}`));
      const llm = fakeLlm([firstBatch]);
      const completeSpy = vi.spyOn(llm, "complete");
      const repo = fakeRepo();
      const anchoredBucket: Bucket = {
        ...bucket,
        sectionTopics: ["Уравнения", "Неравенства"],
        sectionTaskTypes: ["algebra", "geometry"],
      };

      await generateForBucket({ llm, repo }, examSpec, "profile-1", anchoredBucket);

      const prompt = completeSpy.mock.calls[0][0].prompt;
      expect(prompt).toContain("Математика"); // section name
      expect(prompt).toContain("Уравнения");
      expect(prompt).toContain("Неравенства");
      expect(prompt).toMatch(/ЗАПРЕЩЕНО генерировать задания из других разделов экзамена/);
    });

    it("adds an audio-transcript requirement block (with content language) for modality:'audio' buckets", async () => {
      const firstBatch = Array.from({ length: 10 }, (_, i) => singleChoiceTask(`L${i}`));
      const llm = fakeLlm([firstBatch]);
      const completeSpy = vi.spyOn(llm, "complete");
      const repo = fakeRepo();
      const audioBucket: Bucket = { ...bucket, modality: "audio" };

      await generateForBucket({ llm, repo }, examSpec, "profile-1", audioBucket);

      const prompt = completeSpy.mock.calls[0][0].prompt;
      expect(prompt).toMatch(/ТРАНСКРИПТ/);
      expect(prompt).toMatch(/body\.passage ОБЯЗАТЕЛЬНО/);
      expect(prompt).toContain(examSpec.language);
    });

    it("does not require body.passage in the prompt for modality:'text' buckets", async () => {
      const firstBatch = Array.from({ length: 10 }, (_, i) => singleChoiceTask(`T${i}`));
      const llm = fakeLlm([firstBatch]);
      const completeSpy = vi.spyOn(llm, "complete");
      const repo = fakeRepo();
      const textBucket: Bucket = { ...bucket, modality: "text" };

      await generateForBucket({ llm, repo }, examSpec, "profile-1", textBucket);

      const prompt = completeSpy.mock.calls[0][0].prompt;
      expect(prompt).not.toMatch(/ТРАНСКРИПТ/);
      expect(prompt).not.toMatch(/body\.passage ОБЯЗАТЕЛЬНО/);
    });

    it("drops audio-bucket elements without a real transcript passage, retrying for the deficit", async () => {
      const longPassage = "A".repeat(60); // ≥50 chars after trim
      const firstBatch = [
        singleChoiceTaskWithPassage("Q1", longPassage),
        singleChoiceTaskWithPassage("Q2", longPassage),
        singleChoiceTask("Q3"), // no passage field at all
        singleChoiceTaskWithPassage("Q4", "too short"), // <50 chars
        singleChoiceTaskWithPassage("Q5", null), // explicit null
      ]; // 2 valid, 3 dropped -> deficit = bucket.count(5) - 2 = 3
      const retryBatch = [
        singleChoiceTaskWithPassage("R1", longPassage),
        singleChoiceTaskWithPassage("R2", longPassage),
        singleChoiceTaskWithPassage("R3", longPassage),
      ];
      const llm = fakeLlm([firstBatch, retryBatch]);
      const completeSpy = vi.spyOn(llm, "complete");
      const repo = fakeRepo();
      const audioBucket: Bucket = { ...bucket, modality: "audio", count: 5 };

      const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", audioBucket);

      expect(completeSpy).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(5); // 2 (first batch) + 3 (retry)
    });

    it("treats a 50-char (trimmed) passage as valid and a 49-char passage as invalid for audio buckets", async () => {
      const exactly50 = "B".repeat(50);
      const only49 = "B".repeat(49);
      const firstBatch = [
        singleChoiceTaskWithPassage("Q1", exactly50),
        singleChoiceTaskWithPassage("Q2", only49),
      ]; // only Q1 is valid -> deficit = 1 - 1 = 0, no retry
      const llm = fakeLlm([firstBatch]);
      const completeSpy = vi.spyOn(llm, "complete");
      const repo = fakeRepo();
      const audioBucket: Bucket = { ...bucket, modality: "audio", count: 1 };

      const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", audioBucket);

      expect(completeSpy).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });

    it("does not drop text-bucket elements lacking a passage (passage is optional for modality:'text')", async () => {
      const firstBatch = [singleChoiceTask("Q1"), singleChoiceTask("Q2")]; // neither has a passage
      const llm = fakeLlm([firstBatch]);
      const completeSpy = vi.spyOn(llm, "complete");
      const repo = fakeRepo();
      const textBucket: Bucket = { ...bucket, modality: "text", count: 2 };

      const result = await generateForBucket({ llm, repo }, examSpec, "profile-1", textBucket);

      expect(completeSpy).toHaveBeenCalledTimes(1); // no retry — nothing was dropped
      expect(result).toHaveLength(2);
    });
  });
});
