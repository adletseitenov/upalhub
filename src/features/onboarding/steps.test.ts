import { describe, expect, it } from "vitest";
import { examProfileSpecSchema, type ExamProfileSpec } from "@/features/exam-profile/spec";
import { buildOnboardingSteps, defaultConfig, selectionPools } from "./steps";

const baseFields = {
  language: "en",
  description: "Test spec.",
  scoring: { scaleMin: 0, scaleMax: 9, unit: "band" },
};

// IELTS-подобная плоская спека: нет variants, нет selectionGroups.
const ieltsLikeSpec: ExamProfileSpec = examProfileSpecSchema.parse({
  ...baseFields,
  examName: "IELTS Academic",
  sections: [
    { name: "Listening", taskTypes: [], topics: [] },
    { name: "Reading", taskTypes: [], topics: [] },
    { name: "Writing", taskTypes: [], topics: [] },
    { name: "Speaking", taskTypes: [], topics: [] },
  ],
});

// Вариантная спека без selectionGroups (НИШ-подобная).
const variantSpec: ExamProfileSpec = examProfileSpecSchema.parse({
  ...baseFields,
  examName: "Вариантный экзамен",
  sections: [
    { name: "Математика", taskTypes: [], topics: [] },
    { name: "Физика", taskTypes: [], topics: [] },
    { name: "Химия", taskTypes: [], topics: [] },
  ],
  variants: [
    { key: "phys-math", label: "Физмат", sectionNames: ["Математика", "Физика"] },
    { key: "chem", label: "Хим", sectionNames: ["Математика", "Химия"] },
  ],
});

// Выбираемая спека без variants (ЕНТ-подобная без профильных вариантов).
const selectableSpec: ExamProfileSpec = examProfileSpecSchema.parse({
  ...baseFields,
  examName: "Экзамен с выбором",
  sections: [
    { name: "Математика", taskTypes: [], topics: [] },
    { name: "Английский", taskTypes: [], topics: [] },
    { name: "Немецкий", taskTypes: [], topics: [] },
  ],
  selectionGroups: [
    {
      key: "lang",
      title: "Иностранный язык",
      chooseCount: 1,
      sectionNames: ["Английский", "Немецкий"],
    },
  ],
});

// Вариант + деградирующая группа: пул группы, пересечённый с вариантом v1,
// меньше chooseCount (см. selection.test.ts::degradedSpec).
const degradedSpec: ExamProfileSpec = examProfileSpecSchema.parse({
  ...baseFields,
  examName: "Экзамен с деградацией",
  sections: [
    { name: "A", taskTypes: [], topics: [] },
    { name: "B", taskTypes: [], topics: [] },
    { name: "C", taskTypes: [], topics: [] },
  ],
  variants: [{ key: "v1", label: "V1", sectionNames: ["A", "B"] }],
  selectionGroups: [{ key: "g", title: "G", chooseCount: 2, sectionNames: ["B", "C"] }],
});

describe("buildOnboardingSteps (D1)", () => {
  it("IELTS-подобная плоская спека -> confirm + date", () => {
    expect(buildOnboardingSteps(ieltsLikeSpec)).toEqual([{ kind: "confirm" }, { kind: "date" }]);
  });

  it("вариантная спека -> confirm + variant + date", () => {
    expect(buildOnboardingSteps(variantSpec)).toEqual([
      { kind: "confirm" },
      { kind: "variant" },
      { kind: "date" },
    ]);
  });

  it("выбираемая спека (без variants) -> confirm + selection + date", () => {
    expect(buildOnboardingSteps(selectableSpec)).toEqual([
      { kind: "confirm" },
      { kind: "selection" },
      { kind: "date" },
    ]);
  });

  it("спека с variants И selectionGroups -> все четыре шага по порядку", () => {
    expect(buildOnboardingSteps(degradedSpec)).toEqual([
      { kind: "confirm" },
      { kind: "variant" },
      { kind: "selection" },
      { kind: "date" },
    ]);
  });
});

describe("selectionPools (D1)", () => {
  it("без выбранного варианта -> пул = вся группа, не деградирован", () => {
    const pools = selectionPools(selectableSpec, null);
    expect(pools).toEqual([
      { group: selectableSpec.selectionGroups[0], pool: ["Английский", "Немецкий"], degraded: false },
    ]);
  });

  it("деградированный пул: пересечение группы с вариантом < chooseCount", () => {
    const pools = selectionPools(degradedSpec, "v1");
    expect(pools).toEqual([{ group: degradedSpec.selectionGroups[0], pool: ["B"], degraded: true }]);
  });

  it("неизвестный variantKey ведёт себя как отсутствующий вариант (без throw)", () => {
    expect(() => selectionPools(degradedSpec, "ghost")).not.toThrow();
    const pools = selectionPools(degradedSpec, "ghost");
    expect(pools[0]).toEqual({ group: degradedSpec.selectionGroups[0], pool: ["B", "C"], degraded: false });
  });
});

describe("defaultConfig (D1 деградация)", () => {
  it("автовключает весь пул для деградированной группы", () => {
    expect(defaultConfig(degradedSpec, "v1")).toEqual({
      variantKey: "v1",
      selectedSectionNames: ["B"],
    });
  });

  it("не выбирает ничего для недеградированной группы (юзер выбирает сам)", () => {
    expect(defaultConfig(selectableSpec, null)).toEqual({
      variantKey: null,
      selectedSectionNames: [],
    });
  });
});
