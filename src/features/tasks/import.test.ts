import { describe, expect, it } from "vitest";
import { parseImport, importTasks } from "./import";
import { contentHash } from "./repo";
import type { NewTaskRow, StoredTask, TaskBankRepo } from "./repo";
import type { NewTask } from "./schema";

// Тестовая фикстура ЕНТ (история Казахстана) — только для этого файла, в
// прод-код не тащится (D6/Task 8 notes).
function entFixture(): unknown[] {
  return [
    {
      type: "history_kz",
      topic: "Древний Казахстан",
      difficulty: 2,
      language: "kk",
      body: {
        format: "single_choice",
        prompt: "В каком веке образовалось Казахское ханство?",
        options: [
          { id: "a", text: "XIII век" },
          { id: "b", text: "XV век" },
          { id: "c", text: "XVIII век" },
        ],
      },
      answer: { format: "single_choice", correctOptionId: "b" },
      explanation: "Казахское ханство образовано в 1465 году, XV век.",
    },
    {
      type: "history_kz",
      topic: "Ханы Казахского ханства",
      difficulty: 3,
      language: "kk",
      body: {
        format: "multi_choice",
        prompt: "Кто из перечисленных был ханом Казахского ханства?",
        options: [
          { id: "a", text: "Керей" },
          { id: "b", text: "Жанибек" },
          { id: "c", text: "Чингисхан" },
          { id: "d", text: "Тимур" },
        ],
      },
      answer: { format: "multi_choice", correctOptionIds: ["a", "b"] },
      explanation: "Керей и Жанибек — основатели Казахского ханства.",
    },
    {
      type: "history_kz",
      topic: "Даты",
      difficulty: 2,
      language: "kk",
      body: {
        format: "text_input",
        prompt: "В каком году было образовано Казахское ханство?",
        inputKind: "number",
      },
      answer: { format: "text_input", accepted: ["1465"], caseSensitive: false },
      explanation: "1465 год — общепринятая дата образования ханства.",
    },
    {
      type: "history_kz",
      topic: "Столицы",
      difficulty: 1,
      language: "kk",
      body: {
        format: "text_input",
        prompt: "Назовите первую столицу Казахского ханства.",
        inputKind: "string",
      },
      answer: { format: "text_input", accepted: ["Козыбасы", "Козы-Басы"], caseSensitive: false },
      explanation: "Первой ставкой ханства принято считать Козыбасы.",
    },
    {
      type: "history_kz",
      topic: "Жузы",
      difficulty: 3,
      language: "kk",
      body: {
        format: "single_choice",
        prompt: "Сколько жузов традиционно выделяют в казахской истории?",
        passage: "Жуз — историческое территориально-родовое объединение казахов.",
        options: [
          { id: "a", text: "Два" },
          { id: "b", text: "Три" },
          { id: "c", text: "Пять" },
        ],
      },
      answer: { format: "single_choice", correctOptionId: "b" },
      explanation: "Выделяют Старший, Средний и Младший жузы — три жуза.",
    },
  ];
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

describe("parseImport", () => {
  it("parses 5+ valid ENT-format tasks into `valid`, no errors", () => {
    const { valid, errors } = parseImport(entFixture());

    expect(errors).toEqual([]);
    expect(valid).toHaveLength(5);
    expect(valid[0].type).toBe("history_kz");
    expect(valid[0].body.format).toBe("single_choice");
  });

  it("returns a single index:-1 error when the input is not an array", () => {
    const { valid, errors } = parseImport({ not: "an array" });

    expect(valid).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(-1);
    expect(errors[0].message).toBeTruthy();
  });

  it("also rejects non-array primitives (null, string, number) with index:-1", () => {
    expect(parseImport(null).errors).toEqual([{ index: -1, message: expect.any(String) }]);
    expect(parseImport("nope").errors).toEqual([{ index: -1, message: expect.any(String) }]);
    expect(parseImport(42).errors).toEqual([{ index: -1, message: expect.any(String) }]);
  });

  it("splits a mixed array: valid items collected, invalid items reported with their index + message", () => {
    const fixture = entFixture();
    const input = [
      fixture[0],
      { type: "history_kz" }, // missing required fields entirely
      fixture[1],
      { ...(fixture[2] as Record<string, unknown>), difficulty: 99 }, // out of 1..5 range
    ];

    const { valid, errors } = parseImport(input);

    expect(valid).toHaveLength(2);
    expect(errors).toHaveLength(2);
    expect(errors[0].index).toBe(1);
    expect(errors[0].message).toBeTruthy();
    expect(errors[1].index).toBe(3);
    expect(errors[1].message).toBeTruthy();
  });

  it("rejects a task whose answer references an option id outside body.options (validateTaskPair)", () => {
    const bad = {
      type: "history_kz",
      topic: "Жузы",
      difficulty: 2,
      language: "kk",
      body: {
        format: "single_choice",
        prompt: "Сколько жузов?",
        options: [
          { id: "a", text: "Два" },
          { id: "b", text: "Три" },
        ],
      },
      // "z" is not among body.options ids — duplicate/mismatched key outside options.
      answer: { format: "single_choice", correctOptionId: "z" },
      explanation: "Три жуза.",
    };

    const { valid, errors } = parseImport([bad]);

    expect(valid).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].index).toBe(0);
    expect(errors[0].message).toBeTruthy();
  });

  it("rejects difficulty outside the 1..5 integer range", () => {
    const bad = { ...entFixture()[0] as NewTask, difficulty: 0 };
    const { valid, errors } = parseImport([bad]);

    expect(valid).toEqual([]);
    expect(errors[0].index).toBe(0);
  });

  it("rejects a task with an empty explanation", () => {
    const bad = { ...(entFixture()[0] as Record<string, unknown>), explanation: "" };
    const { valid, errors } = parseImport([bad]);

    expect(valid).toEqual([]);
    expect(errors[0].index).toBe(0);
  });
});

describe("importTasks", () => {
  it("maps origin='import' and a matching contentHash for each task, then reports repo counts", async () => {
    const repo = fakeRepo();
    const { valid } = parseImport(entFixture());

    const result = await importTasks({ repo }, "profile-1", valid);

    expect(result).toEqual({ inserted: 5, skippedDuplicates: 0, rejected: 0 });
    expect(repo.rows).toHaveLength(5);
    for (const row of repo.rows) {
      expect(row.origin).toBe("import");
      expect(row.examProfileId).toBe("profile-1");
      expect(row.contentHash).toBe(contentHash(row.body));
    }
  });

  it("produces a deterministic, matching contentHash for two tasks with identical bodies", async () => {
    const repo = fakeRepo();
    const task = (entFixture()[0] as NewTask);

    await importTasks({ repo }, "profile-1", [task, { ...task }]);

    expect(repo.rows).toHaveLength(2);
    expect(repo.rows[0].contentHash).toBe(repo.rows[1].contentHash);
    expect(repo.rows[0].contentHash).toBe(contentHash(task.body));
  });

  it("passes skippedDuplicates through from repo.insertMany, rejected stays 0 (parseImport's job)", async () => {
    const repo: TaskBankRepo = {
      async findBucket() {
        return [];
      },
      async insertMany(rows) {
        return {
          inserted: rows.slice(0, 1).map((r) => ({
            id: "1",
            type: r.type,
            topic: r.topic,
            difficulty: r.difficulty,
            language: r.language,
            body: r.body,
            answer: r.answer,
            explanation: r.explanation,
          })),
          skipped: rows.length - 1,
        };
      },
    };
    const { valid } = parseImport(entFixture());

    const result = await importTasks({ repo }, "profile-1", valid);

    expect(result).toEqual({ inserted: 1, skippedDuplicates: 4, rejected: 0 });
  });
});
