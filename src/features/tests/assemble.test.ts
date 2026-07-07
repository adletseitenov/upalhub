import { describe, expect, it, vi } from "vitest";
import { fakeLlm } from "@/lib/llm";
import type { ExamProfileSpec } from "@/features/exam-profile/spec";
import type { StoredExamProfile } from "@/features/exam-profile/service";
import type { HqConfig } from "@/features/exam-profile/selection";
import type { NewTaskRow, StoredTask, TaskBankRepo } from "@/features/tasks/repo";
import type { Bucket } from "@/features/tasks/generate";
import { parseImport, importTasks } from "@/features/tasks/import";
import { buildPlan, assembleTest, reassembleTest } from "./assemble";
import type { TestRepo, StoredTest } from "./repo";
import type { TestKind, TestSpec } from "./spec";

// --- фикстуры спек -------------------------------------------------------

const minimalSpec: ExamProfileSpec = {
  examName: "Mini Exam",
  language: "en",
  description: "d",
  sections: [],
  variants: [],
  selectionGroups: [],
  scoring: { scaleMin: 0, scaleMax: 100, unit: "points" },
};

// ЕНТ: points-шкала, 5 секций, часть без topics/taskTypes/taskCount (D3 tolerance).
const entSpec: ExamProfileSpec = {
  examName: "ЕНТ",
  language: "kk",
  description: "Единое национальное тестирование.",
  sections: [
    {
      name: "Математика",
      taskCount: 20,
      timeLimitMinutes: 40,
      taskTypes: ["algebra"],
      topics: ["Уравнения", "Геометрия"],
    },
    { name: "Физика", taskCount: 20, timeLimitMinutes: 40, taskTypes: ["mechanics"], topics: [] },
    { name: "Химия", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] },
    {
      name: "Биология",
      taskCount: 15,
      timeLimitMinutes: 30,
      taskTypes: ["genetics"],
      topics: ["Генетика"],
    },
    { name: "История Казахстана", taskCount: 20, timeLimitMinutes: 40, taskTypes: [], topics: [] },
  ],
  variants: [],
  selectionGroups: [],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

// IELTS: band-шкала — тот же код-путь, другая единица шкалы.
const ieltsSpec: ExamProfileSpec = {
  examName: "IELTS",
  language: "en",
  description: "International English Language Testing System.",
  sections: [
    {
      name: "Listening",
      taskCount: 8,
      timeLimitMinutes: 30,
      taskTypes: ["multiple_choice"],
      topics: [],
    },
    {
      name: "Reading",
      taskCount: 8,
      timeLimitMinutes: 60,
      taskTypes: ["reading_comprehension"],
      topics: ["Skimming", "Scanning"],
    },
  ],
  variants: [],
  selectionGroups: [],
  scoring: { scaleMin: 0, scaleMax: 9, unit: "band" },
};

function examProfileFixture(spec: ExamProfileSpec, id: string): StoredExamProfile {
  return {
    id,
    slug: `fixture-${id}`,
    title: spec.examName,
    language: spec.language,
    spec,
    sources: [],
    origin: "ai_research",
    trust: "ai_draft",
  };
}

// --- fakeLlm task fixtures -------------------------------------------------

function singleChoiceTask(promptText: string) {
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
    difficulty: 3,
  };
}

function batchOf(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => singleChoiceTask(`${prefix}-${i}`));
}

function scBody(promptText: string) {
  return {
    format: "single_choice" as const,
    prompt: promptText,
    options: [
      { id: "a", text: "4" },
      { id: "b", text: "5" },
    ],
  };
}
function scAnswer() {
  return { format: "single_choice" as const, correctOptionId: "a" };
}

// --- fake репозитории -------------------------------------------------

type InternalTaskRow = NewTaskRow & { id: string };

function toStored(row: InternalTaskRow): StoredTask {
  return {
    id: row.id,
    type: row.type,
    topic: row.topic,
    difficulty: row.difficulty,
    language: row.language,
    body: row.body,
    answer: row.answer,
    explanation: row.explanation,
  };
}

function fakeTaskRepo(seed: InternalTaskRow[] = []): TaskBankRepo & { rows: InternalTaskRow[] } {
  const rows: InternalTaskRow[] = [...seed];
  let nextId = rows.length + 1;
  return {
    rows,
    async findBucket(profileId, type, topic, difficulty, limit) {
      return rows
        .filter(
          (r) =>
            r.examProfileId === profileId &&
            r.type === type &&
            r.topic === topic &&
            (difficulty === null || r.difficulty === difficulty),
        )
        .slice(0, limit)
        .map(toStored);
    },
    async insertMany(newRows) {
      const inserted: StoredTask[] = [];
      for (const row of newRows) {
        const stored: InternalTaskRow = { ...row, id: `id-${nextId++}` };
        rows.push(stored);
        inserted.push(toStored(stored));
      }
      return { inserted, skipped: 0 };
    },
  };
}

// Заранее заполняет банк ровно под каждый бакет плана (тёплый банк).
function seedForBuckets(buckets: Bucket[], profileId: string, language: string): InternalTaskRow[] {
  const rows: InternalTaskRow[] = [];
  let n = 1;
  for (const bucket of buckets) {
    for (let i = 0; i < bucket.count; i++) {
      rows.push({
        id: `seed-${n}`,
        type: bucket.type,
        topic: bucket.topic,
        difficulty: bucket.difficulty,
        language,
        body: scBody(`${bucket.type}-${bucket.topic}-${i}`),
        answer: scAnswer(),
        explanation: "e",
        contentHash: `hash-${n}`,
        examProfileId: profileId,
        origin: "author",
      });
      n++;
    }
  }
  return rows;
}

function fakeTestRepo(): TestRepo & { rows: StoredTest[] } {
  const rows: StoredTest[] = [];
  let nextId = 1;
  return {
    rows,
    async insertTest(hqId, kind, spec) {
      const stored: StoredTest = { id: `test-${nextId++}`, hqId, kind, spec };
      rows.push(stored);
      return stored;
    },
    async getTest(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async replaceTestSpecIfNoAttempts(testId, spec) {
      // Не используется по контракту T4 (reassembleTest не пишет в БД — deps
      // без testRepo), но нужен для формы TestRepo. Best-effort стаб для
      // будущих T6-тестов, если они переиспользуют этот фейк: заменяет spec
      // безусловно (T6 сам добавит fixture с попытками, когда понадобится).
      const test = rows.find((r) => r.id === testId);
      if (!test) return false;
      test.spec = spec;
      return true;
    },
  };
}

// ===========================================================================
// buildPlan (чистая функция)
// ===========================================================================

describe("buildPlan", () => {
  it("uses taskTypes[0] with a 'default' fallback, topics with a [section.name] fallback, and difficulty 3 always", () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: [
        { name: "WithTypes", taskCount: 4, timeLimitMinutes: null, taskTypes: ["essay", "other"], topics: ["T1"] },
        { name: "Empty", taskCount: 4, timeLimitMinutes: null, taskTypes: [], topics: [] },
      ],
    };
    const buckets = buildPlan(spec, "practice");

    const withTypesBucket = buckets.find((b) => b.sectionName === "WithTypes")!;
    expect(withTypesBucket.type).toBe("essay");
    expect(withTypesBucket.topic).toBe("T1");
    expect(withTypesBucket.difficulty).toBe(3);

    const emptyBucket = buckets.find((b) => b.sectionName === "Empty")!;
    expect(emptyBucket.type).toBe("default");
    expect(emptyBucket.topic).toBe("Empty");
    expect(emptyBucket.difficulty).toBe(3);
  });

  it("practice and mock use section.taskCount, falling back to 8 when unset", () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: [
        { name: "Has", taskCount: 20, timeLimitMinutes: null, taskTypes: [], topics: [] },
        { name: "HasNot", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] },
      ],
    };
    for (const kind of ["practice", "mock"] satisfies TestKind[]) {
      const buckets = buildPlan(spec, kind);
      expect(buckets.find((b) => b.sectionName === "Has")!.count).toBe(20);
      expect(buckets.find((b) => b.sectionName === "HasNot")!.count).toBe(8);
    }
  });

  it("splits a section's count evenly across multiple topics, remainder first", () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: [{ name: "S", taskCount: 7, timeLimitMinutes: null, taskTypes: [], topics: ["t1", "t2", "t3"] }],
    };
    const buckets = buildPlan(spec, "practice").filter((b) => b.sectionName === "S");
    const counts = buckets.map((b) => b.count);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(7);
    expect(counts[0]).toBeGreaterThanOrEqual(counts[1]);
    expect(counts[1]).toBeGreaterThanOrEqual(counts[2]);
  });

  it("diagnostic distributes a cap of 12 evenly across sections, remainder first, min 1 per section", () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: Array.from({ length: 5 }, (_, i) => ({
        name: `S${i}`,
        taskCount: 20,
        timeLimitMinutes: null,
        taskTypes: [],
        topics: [],
      })),
    };
    const buckets = buildPlan(spec, "diagnostic");
    const bySection = spec.sections.map((s) =>
      buckets.filter((b) => b.sectionName === s.name).reduce((sum, b) => sum + b.count, 0),
    );
    expect(bySection.reduce((a, b) => a + b, 0)).toBe(12);
    expect(bySection.every((c) => c >= 1)).toBe(true);
    expect(bySection).toEqual([3, 3, 2, 2, 2]);
  });

  it("diagnostic with more than 12 sections gives the first 12 exactly one task and the rest none", () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: Array.from({ length: 15 }, (_, i) => ({
        name: `S${i}`,
        taskCount: 5,
        timeLimitMinutes: null,
        taskTypes: [],
        topics: [],
      })),
    };
    const buckets = buildPlan(spec, "diagnostic");
    const bySection = spec.sections.map((s) =>
      buckets.filter((b) => b.sectionName === s.name).reduce((sum, b) => sum + b.count, 0),
    );
    expect(bySection.slice(0, 12)).toEqual(Array(12).fill(1));
    expect(bySection.slice(12)).toEqual([0, 0, 0]);
    expect(bySection.reduce((a, b) => a + b, 0)).toBe(12);
  });

  it("does not crash on empty topics/taskTypes/taskCount across all kinds", () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: [{ name: "Bare", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] }],
    };
    for (const kind of ["diagnostic", "practice", "mock"] satisfies TestKind[]) {
      expect(() => buildPlan(spec, kind)).not.toThrow();
      const buckets = buildPlan(spec, kind);
      expect(buckets.length).toBeGreaterThan(0);
      expect(buckets[0].count).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// assembleTest
// ===========================================================================

describe("assembleTest", () => {
  it("assembles ENT (points) diagnostic fully from a warm bank without touching the llm; ≤12 total, ≥1 per section, distinct ids", async () => {
    const profile = examProfileFixture(entSpec, "profile-ent");
    const buckets = buildPlan(entSpec, "diagnostic");
    const totalPlanned = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(totalPlanned).toBeLessThanOrEqual(12);
    for (const section of entSpec.sections) {
      const sectionTotal = buckets
        .filter((b) => b.sectionName === section.name)
        .reduce((sum, b) => sum + b.count, 0);
      expect(sectionTotal).toBeGreaterThanOrEqual(1);
    }

    const taskRepo = fakeTaskRepo(seedForBuckets(buckets, "profile-ent", "kk"));
    const testRepo = fakeTestRepo();
    const llm = fakeLlm([]); // тёплый банк — не должен трогаться
    const completeSpy = vi.spyOn(llm, "complete");

    const result = await assembleTest(
      { taskRepo, testRepo, llm },
      { hqId: "hq-1", examProfile: profile, kind: "diagnostic" },
    );

    expect(completeSpy).not.toHaveBeenCalled();
    expect(result.kind).toBe("diagnostic");
    expect(result.spec.taskIds).toHaveLength(totalPlanned);
    expect(new Set(result.spec.taskIds).size).toBe(result.spec.taskIds.length);
    expect(result.spec.scoringSnapshot).toEqual(entSpec.scoring);
    expect(result.spec.language).toBe("kk");
  });

  it("assembles IELTS (band) practice fully from a warm bank via the same code path", async () => {
    const profile = examProfileFixture(ieltsSpec, "profile-ielts");
    const buckets = buildPlan(ieltsSpec, "practice");
    const plannedTotal = buckets.reduce((sum, b) => sum + b.count, 0);

    const taskRepo = fakeTaskRepo(seedForBuckets(buckets, "profile-ielts", "en"));
    const testRepo = fakeTestRepo();
    const llm = fakeLlm([]);
    const completeSpy = vi.spyOn(llm, "complete");

    const result = await assembleTest(
      { taskRepo, testRepo, llm },
      { hqId: "hq-2", examProfile: profile, kind: "practice" },
    );

    expect(completeSpy).not.toHaveBeenCalled();
    expect(result.spec.scoringSnapshot.unit).toBe("band");
    expect(result.spec.language).toBe("en");
    expect(result.spec.taskIds).toHaveLength(plannedTotal);
  });

  it("caps generation at 3 total llm.complete calls across the whole assembly and does not throw", async () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: Array.from({ length: 5 }, (_, i) => ({
        name: `Section ${i}`,
        taskCount: 5,
        timeLimitMinutes: 10,
        taskTypes: [`type${i}`],
        topics: [],
      })),
    };
    const profile = examProfileFixture(spec, "profile-cap");
    const taskRepo = fakeTaskRepo(); // пустой банк — все 5 бакетов требуют генерации
    const testRepo = fakeTestRepo();
    const llm = fakeLlm([batchOf(10, "b0"), batchOf(10, "b1"), batchOf(10, "b2")]);
    const completeSpy = vi.spyOn(llm, "complete");

    const result = await assembleTest(
      { taskRepo, testRepo, llm },
      { hqId: "hq-3", examProfile: profile, kind: "practice" },
    );

    expect(completeSpy).toHaveBeenCalledTimes(3);
    // 3 из 5 бакетов успели сгенерироваться (по 10 заданий, но взято ≤5 на бакет) — сборка не падает.
    expect(result.spec.taskIds.length).toBeGreaterThan(0);
    expect(result.spec.taskIds.length).toBeLessThan(25);
  });

  it("dedupes taskIds when the same task surfaces across multiple bucket lookups (defensive)", async () => {
    // Патологический сценарий: findBucket возвращает одни и те же id для
    // РАЗНЫХ бакетов (в норме invariant type/topic/difficulty это исключает,
    // но D3 требует distinct как гарантию, а не как следствие удачи).
    const dupTasks: StoredTask[] = [
      { id: "dup-1", type: "x", topic: "x", difficulty: 3, language: "en", body: scBody("Q1"), answer: scAnswer(), explanation: "e" },
      { id: "dup-2", type: "x", topic: "x", difficulty: 3, language: "en", body: scBody("Q2"), answer: scAnswer(), explanation: "e" },
    ];
    const dupRepo: TaskBankRepo = {
      async findBucket() {
        return dupTasks;
      },
      async insertMany() {
        throw new Error("should not need to generate — findBucket always returns enough");
      },
    };
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: [
        { name: "A", taskCount: 2, timeLimitMinutes: null, taskTypes: [], topics: [] },
        { name: "B", taskCount: 2, timeLimitMinutes: null, taskTypes: [], topics: [] },
      ],
    };
    const profile = examProfileFixture(spec, "profile-dup");
    const testRepo = fakeTestRepo();
    const llm = fakeLlm([]);

    const result = await assembleTest(
      { taskRepo: dupRepo, testRepo, llm },
      { hqId: "hq-4", examProfile: profile, kind: "practice" },
    );

    expect(result.spec.taskIds).toEqual(["dup-1", "dup-2"]);
    expect(new Set(result.spec.taskIds).size).toBe(result.spec.taskIds.length);
    const sectionA = result.spec.sections.find((s) => s.name === "A")!;
    const sectionB = result.spec.sections.find((s) => s.name === "B")!;
    expect(sectionA.taskIds).toEqual(["dup-1", "dup-2"]);
    expect(sectionB.taskIds).toEqual([]); // оба id уже использованы секцией A
  });

  it("freezes scoringSnapshot as a copy — later mutation of the profile object does not affect the stored spec", async () => {
    const profile = examProfileFixture(entSpec, "profile-mut");
    const buckets = buildPlan(entSpec, "diagnostic");
    const taskRepo = fakeTaskRepo(seedForBuckets(buckets, "profile-mut", "kk"));
    const testRepo = fakeTestRepo();
    const llm = fakeLlm([]);

    const result = await assembleTest(
      { taskRepo, testRepo, llm },
      { hqId: "hq-5", examProfile: profile, kind: "diagnostic" },
    );
    const before = { ...result.spec.scoringSnapshot };

    // Мутация профиля ПОСЛЕ сборки — снапшот не должен измениться.
    profile.spec.scoring.scaleMax = 999;
    profile.spec.scoring.unit = "mutated";

    expect(result.spec.scoringSnapshot).toEqual(before);
    expect(result.spec.scoringSnapshot.scaleMax).toBe(140);
    expect(result.spec.scoringSnapshot.unit).toBe("баллов");
  });

  describe("totalTimeMinutes", () => {
    it("sums section.timeLimitMinutes when every section has one set", async () => {
      const spec: ExamProfileSpec = {
        ...minimalSpec,
        totalTimeMinutes: 999, // должен игнорироваться — все секции задают timeLimitMinutes
        sections: [
          { name: "A", taskCount: 2, timeLimitMinutes: 10, taskTypes: [], topics: [] },
          { name: "B", taskCount: 2, timeLimitMinutes: 15, taskTypes: [], topics: [] },
        ],
      };
      const profile = examProfileFixture(spec, "profile-time-a");
      const buckets = buildPlan(spec, "practice");
      const taskRepo = fakeTaskRepo(seedForBuckets(buckets, "profile-time-a", spec.language));
      const testRepo = fakeTestRepo();

      const result = await assembleTest(
        { taskRepo, testRepo, llm: fakeLlm([]) },
        { hqId: "hq", examProfile: profile, kind: "practice" },
      );

      expect(result.spec.totalTimeMinutes).toBe(25);
    });

    it("falls back to spec.totalTimeMinutes when any section is missing timeLimitMinutes", async () => {
      const spec: ExamProfileSpec = {
        ...minimalSpec,
        totalTimeMinutes: 60,
        sections: [
          { name: "A", taskCount: 2, timeLimitMinutes: 10, taskTypes: [], topics: [] },
          { name: "B", taskCount: 2, timeLimitMinutes: null, taskTypes: [], topics: [] },
        ],
      };
      const profile = examProfileFixture(spec, "profile-time-b");
      const buckets = buildPlan(spec, "practice");
      const taskRepo = fakeTaskRepo(seedForBuckets(buckets, "profile-time-b", spec.language));
      const testRepo = fakeTestRepo();

      const result = await assembleTest(
        { taskRepo, testRepo, llm: fakeLlm([]) },
        { hqId: "hq", examProfile: profile, kind: "practice" },
      );

      expect(result.spec.totalTimeMinutes).toBe(60);
    });

    it("returns null when sections and spec.totalTimeMinutes are both unset", async () => {
      const spec: ExamProfileSpec = {
        ...minimalSpec,
        totalTimeMinutes: null,
        sections: [{ name: "A", taskCount: 2, timeLimitMinutes: null, taskTypes: [], topics: [] }],
      };
      const profile = examProfileFixture(spec, "profile-time-c");
      const buckets = buildPlan(spec, "practice");
      const taskRepo = fakeTaskRepo(seedForBuckets(buckets, "profile-time-c", spec.language));
      const testRepo = fakeTestRepo();

      const result = await assembleTest(
        { taskRepo, testRepo, llm: fakeLlm([]) },
        { hqId: "hq", examProfile: profile, kind: "practice" },
      );

      expect(result.spec.totalTimeMinutes).toBeNull();
    });
  });

  // acceptance 2.5: импортированные задания (произвольная difficulty 1..5,
  // не только FIXED_DIFFICULTY=3) должны быть достижимы для сборки без
  // единого обращения к LLM — релакс-фолбэк findBucket(..., null, ...) в
  // assembleTest подхватывает то, что точный exact-match select пропускает.
  describe("imported tasks with non-fixed difficulty (acceptance 2.5)", () => {
    it("assembles entirely from imported tasks spanning difficulty 1..5, with zero llm.complete calls", async () => {
      const importFixture = [1, 2, 3, 4, 5].map((difficulty) => ({
        type: "algebra",
        topic: "Уравнения",
        difficulty,
        language: "kk",
        body: scBody(`Импорт сложности ${difficulty}`),
        answer: scAnswer(),
        explanation: "explanation",
      }));
      const { valid, errors } = parseImport(importFixture);
      expect(errors).toEqual([]);
      expect(valid).toHaveLength(5);

      const spec: ExamProfileSpec = {
        ...minimalSpec,
        sections: [
          {
            name: "Algebra",
            taskCount: 5,
            timeLimitMinutes: null,
            taskTypes: ["algebra"],
            topics: ["Уравнения"],
          },
        ],
      };
      const profile = examProfileFixture(spec, "profile-import");
      const taskRepo = fakeTaskRepo();
      await importTasks({ repo: taskRepo }, "profile-import", valid);
      const importedIds = taskRepo.rows.map((r) => r.id);
      expect(importedIds).toHaveLength(5);

      const testRepo = fakeTestRepo();
      const llm = fakeLlm([]);
      const completeSpy = vi.spyOn(llm, "complete");

      const result = await assembleTest(
        { taskRepo, testRepo, llm },
        { hqId: "hq-import", examProfile: profile, kind: "practice" },
      );

      expect(completeSpy).not.toHaveBeenCalled();
      expect(result.spec.taskIds).toHaveLength(5);
      expect(new Set(result.spec.taskIds)).toEqual(new Set(importedIds));
    });
  });
});

// ===========================================================================
// D5: hqConfig-driven active sections, round-robin + rotation, plannedCount
// freeze, reassembleTest.
// ===========================================================================

describe("D5: assembleTest honors hqConfig, round-robin budget, frozen planned counts", () => {
  const groupSpec: ExamProfileSpec = {
    ...minimalSpec,
    examName: "Экзамен с выбором языка",
    sections: [
      { name: "Обязательная", taskCount: 4, timeLimitMinutes: null, taskTypes: [], topics: [] },
      { name: "Английский", taskCount: 4, timeLimitMinutes: null, taskTypes: [], topics: [] },
      { name: "Немецкий", taskCount: 4, timeLimitMinutes: null, taskTypes: [], topics: [] },
    ],
    selectionGroups: [
      { key: "lang", title: "Язык", chooseCount: 1, sectionNames: ["Английский", "Немецкий"] },
    ],
  };

  it("hqConfig.selectedSectionNames narrows the frozen spec to required + selected sections only", async () => {
    const profile = examProfileFixture(groupSpec, "profile-group");
    const allBuckets = buildPlan(groupSpec, "practice");
    const taskRepo = fakeTaskRepo(seedForBuckets(allBuckets, "profile-group", "en"));
    const testRepo = fakeTestRepo();
    const llm = fakeLlm([]);
    const completeSpy = vi.spyOn(llm, "complete");

    const result = await assembleTest(
      { taskRepo, testRepo, llm },
      {
        hqId: "hq-group",
        examProfile: profile,
        kind: "practice",
        hqConfig: { selectedSectionNames: ["Английский"] },
      },
    );

    expect(completeSpy).not.toHaveBeenCalled();
    expect(result.spec.sections.map((s) => s.name).sort()).toEqual(["Английский", "Обязательная"]);
    expect(result.spec.sections.some((s) => s.name === "Немецкий")).toBe(false);
  });

  const variantSpec: ExamProfileSpec = {
    ...minimalSpec,
    examName: "Вариантный экзамен",
    sections: [
      { name: "Математика", taskCount: 4, timeLimitMinutes: null, taskTypes: [], topics: [] },
      { name: "Физика", taskCount: 4, timeLimitMinutes: null, taskTypes: [], topics: [] },
      { name: "Химия", taskCount: 4, timeLimitMinutes: null, taskTypes: [], topics: [] },
    ],
    variants: [
      { key: "phys-math", label: "ФМ", sectionNames: ["Математика", "Физика"] },
      { key: "chem", label: "Химия-профиль", sectionNames: ["Математика", "Химия"] },
    ],
  };

  it("hqConfig.variantKey narrows the frozen spec to only that variant's sections", async () => {
    const profile = examProfileFixture(variantSpec, "profile-variant");
    const allBuckets = buildPlan(variantSpec, "practice");
    const taskRepo = fakeTaskRepo(seedForBuckets(allBuckets, "profile-variant", "en"));
    const testRepo = fakeTestRepo();

    const result = await assembleTest(
      { taskRepo, testRepo, llm: fakeLlm([]) },
      {
        hqId: "hq-variant",
        examProfile: profile,
        kind: "practice",
        hqConfig: { variantKey: "phys-math", selectedSectionNames: [] },
      },
    );

    expect(result.spec.sections.map((s) => s.name).sort()).toEqual(["Математика", "Физика"]);
  });

  it("treats a null or empty hqConfig as legacy — all sections active, same as an omitted hqConfig", async () => {
    const profile = examProfileFixture(entSpec, "profile-ent-legacy");
    const buckets = buildPlan(entSpec, "diagnostic");
    const expectedNames = entSpec.sections.map((s) => s.name);
    const configs: (HqConfig | null)[] = [null, { selectedSectionNames: [] }];

    for (const hqConfig of configs) {
      const taskRepo = fakeTaskRepo(seedForBuckets(buckets, "profile-ent-legacy", "kk"));
      const testRepo = fakeTestRepo();
      const result = await assembleTest(
        { taskRepo, testRepo, llm: fakeLlm([]) },
        { hqId: "hq-legacy", examProfile: profile, kind: "diagnostic", hqConfig },
      );
      expect(result.spec.sections.map((s) => s.name)).toEqual(expectedNames);
    }
  });

  it("round-robin gives every active section at least one generational call under a tight budget (no orphan section)", async () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: [
        { name: "A", taskCount: 3, timeLimitMinutes: null, taskTypes: [], topics: ["t1", "t2", "t3"] },
        { name: "B", taskCount: 1, timeLimitMinutes: null, taskTypes: [], topics: [] },
        { name: "C", taskCount: 1, timeLimitMinutes: null, taskTypes: [], topics: [] },
      ],
    };
    // Sanity: buildPlan's flat order puts all 3 of A's buckets before B and
    // C — without round-robin the 3-call budget is entirely consumed by A,
    // orphaning B and C (the bug D5 fixes).
    const flatOrder = buildPlan(spec, "practice").map((b) => b.sectionName);
    expect(flatOrder).toEqual(["A", "A", "A", "B", "C"]);

    const profile = examProfileFixture(spec, "profile-roundrobin");
    const taskRepo = fakeTaskRepo(); // пустой банк — все бакеты требуют генерации
    const testRepo = fakeTestRepo();
    const llm = fakeLlm([batchOf(10, "rr0"), batchOf(10, "rr1"), batchOf(10, "rr2")]);
    const completeSpy = vi.spyOn(llm, "complete");

    const result = await assembleTest(
      { taskRepo, testRepo, llm },
      { hqId: "hq-roundrobin", examProfile: profile, kind: "practice" },
    );

    expect(completeSpy).toHaveBeenCalledTimes(3);
    for (const name of ["A", "B", "C"]) {
      const section = result.spec.sections.find((s) => s.name === name)!;
      expect(section.taskIds.length).toBeGreaterThan(0);
    }
  });

  it("rotates the round-robin start section by refillCount so the first generational call hits a different section", async () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: ["X", "Y", "Z"].map((name) => ({
        name,
        taskCount: 1,
        timeLimitMinutes: null,
        taskTypes: [],
        topics: [],
      })),
    };
    const profile = examProfileFixture(spec, "profile-rotate");

    async function firstGeneratedSection(refillCount: number): Promise<string> {
      const taskRepo = fakeTaskRepo();
      const testRepo = fakeTestRepo();
      const llm = fakeLlm([batchOf(10, "a"), batchOf(10, "b"), batchOf(10, "c")]);
      const completeSpy = vi.spyOn(llm, "complete");
      await assembleTest(
        { taskRepo, testRepo, llm },
        { hqId: "hq-rotate", examProfile: profile, kind: "practice", refillCount },
      );
      const firstArgs = completeSpy.mock.calls[0][0] as { prompt: string };
      const hit = ["X", "Y", "Z"].find((name) => firstArgs.prompt.includes(`Секция: "${name}"`));
      if (!hit) throw new Error("no section name found in first generation prompt");
      return hit;
    }

    const first0 = await firstGeneratedSection(0);
    const first1 = await firstGeneratedSection(1);

    expect(first0).toBe("X");
    expect(first1).not.toBe(first0);
  });

  it("freezes plannedCount per section (>= actual taskIds under budget-limited deficit)", async () => {
    const spec: ExamProfileSpec = {
      ...minimalSpec,
      sections: Array.from({ length: 5 }, (_, i) => ({
        name: `Section ${i}`,
        taskCount: 5,
        timeLimitMinutes: 10,
        taskTypes: [`type${i}`],
        topics: [],
      })),
    };
    const expectedPlanned = buildPlan(spec, "practice").reduce<Record<string, number>>((acc, b) => {
      acc[b.sectionName] = (acc[b.sectionName] ?? 0) + b.count;
      return acc;
    }, {});
    const profile = examProfileFixture(spec, "profile-planned");
    const taskRepo = fakeTaskRepo(); // пустой банк — бюджет ≤3 гарантирует дефицит хотя бы в одной секции
    const testRepo = fakeTestRepo();
    const llm = fakeLlm([batchOf(10, "p0"), batchOf(10, "p1"), batchOf(10, "p2")]);

    const result = await assembleTest(
      { taskRepo, testRepo, llm },
      { hqId: "hq-planned", examProfile: profile, kind: "practice" },
    );

    for (const section of result.spec.sections) {
      expect(section.plannedCount).toBe(expectedPlanned[section.name]);
      expect(section.taskIds.length).toBeLessThanOrEqual(section.plannedCount!);
    }
    expect(result.spec.sections.some((s) => s.taskIds.length < s.plannedCount!)).toBe(true);
    expect(result.spec.refillCount).toBe(0);
  });

  describe("reassembleTest", () => {
    it("does not write to the repo, increments refillCount, and freezes modality per section", async () => {
      const spec: ExamProfileSpec = {
        ...minimalSpec,
        sections: [
          {
            name: "Listening",
            taskCount: 2,
            timeLimitMinutes: null,
            taskTypes: [],
            topics: [],
            modality: "audio",
          },
          { name: "Reading", taskCount: 2, timeLimitMinutes: null, taskTypes: [], topics: [] },
        ],
      };
      const profile = examProfileFixture(spec, "profile-reassemble");
      const buckets = buildPlan(spec, "practice");
      const taskRepo = fakeTaskRepo(seedForBuckets(buckets, "profile-reassemble", spec.language));
      const testRepo = fakeTestRepo();

      const first = await assembleTest(
        { taskRepo, testRepo, llm: fakeLlm([]) },
        { hqId: "hq-reassemble", examProfile: profile, kind: "practice" },
      );
      expect(first.spec.refillCount).toBe(0);

      const llm2 = fakeLlm([]);
      const completeSpy = vi.spyOn(llm2, "complete");
      const newSpec: TestSpec = await reassembleTest(
        { taskRepo, llm: llm2 },
        { test: first, examProfile: profile, hqConfig: null },
      );

      expect(completeSpy).not.toHaveBeenCalled(); // тёплый банк с первой сборки
      expect(newSpec.refillCount).toBe(1);
      expect(newSpec.kind).toBe("practice");
      expect(newSpec.sections.find((s) => s.name === "Listening")!.modality).toBe("audio");
      expect(newSpec.sections.find((s) => s.name === "Reading")!.modality).toBeNull();
      expect(testRepo.rows).toHaveLength(1); // reassembleTest не пишет в БД
    });

    it("uses a fresh ≤3 llm.complete budget on reassembly, independent from the original assembly", async () => {
      const spec: ExamProfileSpec = {
        ...minimalSpec,
        sections: Array.from({ length: 5 }, (_, i) => ({
          name: `Section ${i}`,
          taskCount: 5,
          timeLimitMinutes: 10,
          taskTypes: [`type${i}`],
          topics: [],
        })),
      };
      const profile = examProfileFixture(spec, "profile-reassemble-cap");

      const original = await assembleTest(
        {
          taskRepo: fakeTaskRepo(),
          testRepo: fakeTestRepo(),
          llm: fakeLlm([batchOf(10, "o0"), batchOf(10, "o1"), batchOf(10, "o2")]),
        },
        { hqId: "hq-cap2", examProfile: profile, kind: "practice" },
      );
      expect(original.spec.refillCount).toBe(0);

      // Свежий (пустой) банк для реассембли — изолирует проверку кап'а
      // LLM-бюджета от «перегрева» банка исходной сборкой (D2 overshoot:
      // генерация кладёт в банк с запасом на MAX_BATCH=10), чтобы все 5
      // бакетов реально требовали генерации и честно проверяли кап ≤3 заново.
      const taskRepo2 = fakeTaskRepo();
      const llm2 = fakeLlm([batchOf(10, "r0"), batchOf(10, "r1"), batchOf(10, "r2")]);
      const completeSpy = vi.spyOn(llm2, "complete");
      const refilled = await reassembleTest(
        { taskRepo: taskRepo2, llm: llm2 },
        { test: original, examProfile: profile, hqConfig: null },
      );

      expect(completeSpy).toHaveBeenCalledTimes(3);
      expect(refilled.refillCount).toBe(1);
    });
  });
});
