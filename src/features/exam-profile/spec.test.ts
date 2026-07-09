import { describe, expect, it } from "vitest";
import { examProfileSpecSchema, sourceRefSchema } from "./spec";

const valid = {
  examName: "IELTS Academic",
  language: "en",
  country: "международный",
  description: "Международный экзамен по английскому языку.",
  sections: [
    {
      name: "Listening",
      taskCount: 40,
      timeLimitMinutes: 30,
      taskTypes: ["multiple choice", "matching"],
      topics: ["everyday conversations", "academic lectures"],
    },
  ],
  scoring: { scaleMin: 0, scaleMax: 9, passingScore: null, unit: "band" },
  totalTimeMinutes: 165,
  typicalDates: "круглый год",
};

// D4 mega-спека: несколько секций, взаимоисключающие варианты + группа
// выбора, вложенная в оба варианта (используется в тестах
// variants/selectionGroups/superRefine ниже, а также в selection.test.ts).
const megaValid = {
  examName: "НИШ",
  language: "ru",
  description: "Многопрофильный вступительный экзамен.",
  sections: [
    { name: "Математика", taskTypes: [], topics: [] },
    { name: "Физика", taskTypes: [], topics: [] },
    { name: "Химия", taskTypes: [], topics: [] },
    { name: "Биология", taskTypes: [], topics: [] },
    { name: "Английский", taskTypes: [], topics: [] },
    { name: "Немецкий", taskTypes: [], topics: [] },
  ],
  variants: [
    {
      key: "phys-math",
      label: "Физико-математическое",
      sectionNames: ["Математика", "Физика", "Английский", "Немецкий"],
    },
    {
      key: "chem-bio",
      label: "Химико-биологическое",
      sectionNames: ["Математика", "Химия", "Биология", "Английский", "Немецкий"],
    },
  ],
  selectionGroups: [
    {
      key: "foreign-language",
      title: "Иностранный язык",
      chooseCount: 1,
      sectionNames: ["Английский", "Немецкий"],
    },
  ],
  scoring: { scaleMin: 0, scaleMax: 140, unit: "баллов" },
};

describe("examProfileSpecSchema", () => {
  it("accepts a complete valid spec", () => {
    expect(examProfileSpecSchema.parse(valid)).toMatchObject({ examName: "IELTS Academic" });
  });
  it("defaults missing taskTypes/topics to empty arrays", () => {
    const spec = examProfileSpecSchema.parse({
      ...valid,
      sections: [{ name: "Writing" }],
    });
    expect(spec.sections[0].taskTypes).toEqual([]);
    expect(spec.sections[0].topics).toEqual([]);
  });
  it("rejects spec without sections", () => {
    expect(() => examProfileSpecSchema.parse({ ...valid, sections: [] })).toThrow();
  });
  it("rejects spec without scoring unit", () => {
    expect(() =>
      examProfileSpecSchema.parse({ ...valid, scoring: { scaleMin: 0, scaleMax: 9 } }),
    ).toThrow();
  });
  it("rejects non-http(s) source urls", () => {
    expect(() => sourceRefSchema.parse({ url: "javascript:alert(1)", title: "x" })).toThrow();
    expect(sourceRefSchema.parse({ url: "https://a.example", title: "x" }).url).toBe(
      "https://a.example",
    );
  });
  it("defaults scoring.step to undefined for existing profiles without it (additive, backward compatible)", () => {
    const spec = examProfileSpecSchema.parse(valid);
    expect(spec.scoring.step).toBeUndefined();
  });
  it("accepts an explicit scoring.step", () => {
    const spec = examProfileSpecSchema.parse({
      ...valid,
      scoring: { ...valid.scoring, step: 0.5 },
    });
    expect(spec.scoring.step).toBe(0.5);
  });
  it("rejects a non-positive scoring.step", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...valid,
        scoring: { ...valid.scoring, step: 0 },
      }),
    ).toThrow();
  });

  // D2: modality.
  it("defaults section modality to undefined (absent = text)", () => {
    const spec = examProfileSpecSchema.parse(valid);
    expect(spec.sections[0].modality).toBeUndefined();
  });
  it("accepts modality: audio on a section", () => {
    const spec = examProfileSpecSchema.parse({
      ...valid,
      sections: [{ ...valid.sections[0], modality: "audio" }],
    });
    expect(spec.sections[0].modality).toBe("audio");
  });
  it("rejects an unknown modality", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...valid,
        sections: [{ ...valid.sections[0], modality: "video" }],
      }),
    ).toThrow();
  });

  // D6 (Stage5 Task1): "speaking" modality + optional speakingCriteria.
  it("accepts modality: speaking on a section", () => {
    const spec = examProfileSpecSchema.parse({
      ...valid,
      sections: [{ ...valid.sections[0], modality: "speaking" }],
    });
    expect(spec.sections[0].modality).toBe("speaking");
  });
  it("defaults speakingCriteria to undefined (old specs parse unchanged)", () => {
    const spec = examProfileSpecSchema.parse({
      ...valid,
      sections: [{ ...valid.sections[0], modality: "speaking" }],
    });
    expect(spec.sections[0].speakingCriteria).toBeUndefined();
  });
  it("accepts speakingCriteria on a speaking section", () => {
    const spec = examProfileSpecSchema.parse({
      ...valid,
      sections: [
        {
          ...valid.sections[0],
          modality: "speaking",
          speakingCriteria: [
            { key: "fluency", label: "Беглость", maxPoints: 5 },
            { key: "pronunciation", label: "Произношение", maxPoints: 5 },
          ],
        },
      ],
    });
    expect(spec.sections[0].speakingCriteria).toEqual([
      { key: "fluency", label: "Беглость", maxPoints: 5 },
      { key: "pronunciation", label: "Произношение", maxPoints: 5 },
    ]);
  });
  it("rejects a speakingCriteria entry with non-positive maxPoints", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...valid,
        sections: [
          {
            ...valid.sections[0],
            modality: "speaking",
            speakingCriteria: [{ key: "fluency", label: "Беглость", maxPoints: 0 }],
          },
        ],
      }),
    ).toThrow();
  });

  // D2/D4: variants + selectionGroups (mega-спека).
  it("accepts a mega spec with variants and selectionGroups, defaulting them to [] when absent", () => {
    const mega = examProfileSpecSchema.parse(megaValid);
    expect(mega.variants).toHaveLength(2);
    expect(mega.selectionGroups).toHaveLength(1);
    const flat = examProfileSpecSchema.parse(valid);
    expect(flat.variants).toEqual([]);
    expect(flat.selectionGroups).toEqual([]);
  });

  // D2 superRefine (a): уникальность имён секций.
  it("rejects a spec with duplicate section names", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...valid,
        sections: [valid.sections[0], { ...valid.sections[0] }],
      }),
    ).toThrow();
  });

  // D2 superRefine (b): variants[].sectionNames ⊆ sections[].name.
  it("rejects a variant referencing an unknown section name", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...megaValid,
        variants: [
          { key: "ghost", label: "Призрачный", sectionNames: ["Математика", "Астрономия"] },
        ],
      }),
    ).toThrow();
  });

  // D2 superRefine (b): selectionGroups[].sectionNames ⊆ sections[].name.
  it("rejects a selectionGroup referencing an unknown section name", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...megaValid,
        selectionGroups: [
          { key: "ghost", title: "Призрак", chooseCount: 1, sectionNames: ["Английский", "Испанский"] },
        ],
      }),
    ).toThrow();
  });

  // D2 superRefine (c): chooseCount <= |group.sectionNames| (базовая проверка).
  it("rejects a selectionGroup whose chooseCount exceeds its own section count", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...megaValid,
        selectionGroups: [
          {
            key: "foreign-language",
            title: "Иностранный язык",
            chooseCount: 3,
            sectionNames: ["Английский", "Немецкий"],
          },
        ],
      }),
    ).toThrow();
  });

  // Backlog wave fix5: variants[].key must be unique — used as a lookup key
  // (spec.variants.find(v => v.key === config.variantKey) in selection.ts).
  it("rejects a spec with duplicate variant keys", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...megaValid,
        variants: [
          megaValid.variants[0],
          { ...megaValid.variants[1], key: megaValid.variants[0].key },
        ],
      }),
    ).toThrow();
  });

  // Backlog wave fix5: selectionGroups[].key must be unique — same lookup
  // role as variants[].key (group.key identifies a group in error messages
  // and in resolveActiveSections' per-group loop).
  it("rejects a spec with duplicate selectionGroups keys", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...megaValid,
        sections: [...megaValid.sections, { name: "Французский", taskTypes: [], topics: [] }],
        selectionGroups: [
          megaValid.selectionGroups[0],
          {
            key: megaValid.selectionGroups[0].key,
            title: "Другая группа",
            chooseCount: 1,
            sectionNames: ["Английский", "Французский"],
          },
        ],
      }),
    ).toThrow();
  });

  // Backlog wave fix5: sectionNames WITHIN one selectionGroup must be
  // unique — resolveActiveSections/validateHqConfig build Set-shaped pools
  // from this array, so a duplicate would silently collapse.
  it("rejects a selectionGroup with duplicate sectionNames", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...megaValid,
        selectionGroups: [
          {
            key: "foreign-language",
            title: "Иностранный язык",
            chooseCount: 1,
            sectionNames: ["Английский", "Английский"],
          },
        ],
      }),
    ).toThrow();
  });

  // D2 note: деградация группы относительно КОНКРЕТНОГО варианта (D1) — это
  // НЕ ошибка спеки. Группа может пересекаться с вариантом на меньше, чем
  // chooseCount элементов, и спека всё равно валидна (визард деградирует
  // группу в рантайме).
  it("accepts a spec where a selectionGroup's intersection with a variant is smaller than chooseCount (D1 degradation is not a spec error)", () => {
    const spec = examProfileSpecSchema.parse({
      ...megaValid,
      sections: [...megaValid.sections, { name: "Французский", taskTypes: [], topics: [] }],
      variants: [
        {
          key: "phys-math",
          label: "Физико-математическое",
          sectionNames: ["Математика", "Физика", "Английский"], // только 1 язык из группы
        },
      ],
      selectionGroups: [
        {
          key: "foreign-language",
          title: "Иностранный язык",
          chooseCount: 2,
          sectionNames: ["Английский", "Немецкий", "Французский"],
        },
      ],
    });
    expect(spec.selectionGroups[0].chooseCount).toBe(2);
  });

  it("rejects a selectionGroup with fewer than 2 sectionNames", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...megaValid,
        selectionGroups: [
          { key: "solo", title: "Один", chooseCount: 1, sectionNames: ["Английский"] },
        ],
      }),
    ).toThrow();
  });

  it("rejects a variant with an empty sectionNames array", () => {
    expect(() =>
      examProfileSpecSchema.parse({
        ...megaValid,
        variants: [{ key: "empty", label: "Пусто", sectionNames: [] }],
      }),
    ).toThrow();
  });
});
