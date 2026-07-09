import { describe, expect, it } from "vitest";
import { examProfileSpecSchema, type ExamProfileSpec } from "@/features/exam-profile/spec";
import {
  buildOnboardingSteps,
  defaultConfig,
  reconcileDraft,
  reconcileWeakSections,
  resolveActiveSectionNames,
  selectionPools,
} from "./steps";

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

describe("buildOnboardingSteps (D1/D6, D1 Stage5-Task2: +interview)", () => {
  it("IELTS-подобная плоская спека -> confirm + goal + interview + date", () => {
    expect(buildOnboardingSteps(ieltsLikeSpec)).toEqual([
      { kind: "confirm" },
      { kind: "goal" },
      { kind: "interview" },
      { kind: "date" },
    ]);
  });

  it("вариантная спека -> confirm + goal + variant + interview + date", () => {
    expect(buildOnboardingSteps(variantSpec)).toEqual([
      { kind: "confirm" },
      { kind: "goal" },
      { kind: "variant" },
      { kind: "interview" },
      { kind: "date" },
    ]);
  });

  it("выбираемая спека (без variants) -> confirm + goal + selection + interview + date", () => {
    expect(buildOnboardingSteps(selectableSpec)).toEqual([
      { kind: "confirm" },
      { kind: "goal" },
      { kind: "selection" },
      { kind: "interview" },
      { kind: "date" },
    ]);
  });

  it("спека с variants И selectionGroups -> confirm + goal + variant + selection + interview + date", () => {
    expect(buildOnboardingSteps(degradedSpec)).toEqual([
      { kind: "confirm" },
      { kind: "goal" },
      { kind: "variant" },
      { kind: "selection" },
      { kind: "interview" },
      { kind: "date" },
    ]);
  });

  it("D6 🔴: goal идёт СРАЗУ после confirm, независимо от того, что дальше", () => {
    for (const spec of [ieltsLikeSpec, variantSpec, selectableSpec, degradedSpec]) {
      const steps = buildOnboardingSteps(spec);
      expect(steps[0]).toEqual({ kind: "confirm" });
      expect(steps[1]).toEqual({ kind: "goal" });
    }
  });

  // 🔴 D1 (Stage 5, Task 2): interview всегда идёт ПОСЛЕ variant/selection
  // (когда они есть) и ВСЕГДА непосредственно ПЕРЕД date — для ЛЮБОЙ формы
  // спеки (interview не условен на spec.variants/selectionGroups, в отличие
  // от них).
  it("🔴 interview идёт сразу перед date и после variant/selection для всех форм спек", () => {
    for (const spec of [ieltsLikeSpec, variantSpec, selectableSpec, degradedSpec]) {
      const steps = buildOnboardingSteps(spec);
      const interviewIndex = steps.findIndex((s) => s.kind === "interview");
      const dateIndex = steps.findIndex((s) => s.kind === "date");
      expect(interviewIndex).toBeGreaterThan(-1);
      expect(dateIndex).toBe(steps.length - 1);
      expect(interviewIndex).toBe(dateIndex - 1);
      const variantIndex = steps.findIndex((s) => s.kind === "variant");
      const selectionIndex = steps.findIndex((s) => s.kind === "selection");
      if (variantIndex > -1) expect(interviewIndex).toBeGreaterThan(variantIndex);
      if (selectionIndex > -1) expect(interviewIndex).toBeGreaterThan(selectionIndex);
    }
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

// D-important5: a localStorage onboarding draft can outlive a spec refine —
// reconcileDraft must drop what the current spec no longer knows about
// (stale section names / variantKey), matching the lockout scenario where a
// refined spec renamed/removed "Английский" and the draft still references it.
describe("reconcileDraft (D-important5)", () => {
  const validSectionNames = new Set(["Математика", "Английский", "Немецкий"]);
  const validVariantKeys = new Set(["phys-math", "chem"]);

  it("keeps a draft whose selected names and variantKey are all still valid", () => {
    const draft = { variantKey: "phys-math", selected: ["Английский"] };
    expect(reconcileDraft(draft, validSectionNames, validVariantKeys)).toEqual({
      variantKey: "phys-math",
      selected: ["Английский"],
    });
  });

  it("drops a stale selected section name absent from the current spec", () => {
    const draft = { variantKey: null, selected: ["Английский", "Испанский"] };
    expect(reconcileDraft(draft, validSectionNames, validVariantKeys)).toEqual({
      variantKey: null,
      selected: ["Английский"],
    });
  });

  it("drops the whole selection when NONE of the draft's names are still valid (the lockout scenario)", () => {
    const draft = { variantKey: null, selected: ["Английский"] };
    const onlyMathValid = new Set(["Математика"]); // "Английский" was removed by a spec refine
    expect(reconcileDraft(draft, onlyMathValid, validVariantKeys)).toEqual({
      variantKey: null,
      selected: [],
    });
  });

  it("resets a stale variantKey to null", () => {
    const draft = { variantKey: "ghost-variant", selected: [] };
    expect(reconcileDraft(draft, validSectionNames, validVariantKeys)).toEqual({
      variantKey: null,
      selected: [],
    });
  });

  it("leaves a null variantKey as null (not a throw / not coerced)", () => {
    const draft = { variantKey: null, selected: [] };
    expect(reconcileDraft(draft, validSectionNames, validVariantKeys).variantKey).toBeNull();
  });

  // D6 (Task 8) 🔴: target reconciliation is additive — only kicks in when a
  // 4th targetRange arg is passed. Existing 3-arg call sites above are
  // untouched by this.
  describe("target reconciliation (4th arg, additive)", () => {
    const targetRange = { min: 0, max: 9 };

    it("omitting targetRange leaves draft.target untouched (backwards-compatible 3-arg call)", () => {
      const draft = { variantKey: null, selected: [], target: "999" };
      expect(reconcileDraft(draft, validSectionNames, validVariantKeys)).toEqual({
        variantKey: null,
        selected: [],
        target: "999",
      });
    });

    it("keeps a target within [min, max]", () => {
      const draft = { variantKey: null, selected: [], target: "7.5" };
      expect(reconcileDraft(draft, validSectionNames, validVariantKeys, targetRange).target).toBe("7.5");
    });

    it("keeps a target exactly at the boundary (closed interval)", () => {
      const atMin = { variantKey: null, selected: [], target: "0" };
      const atMax = { variantKey: null, selected: [], target: "9" };
      expect(reconcileDraft(atMin, validSectionNames, validVariantKeys, targetRange).target).toBe("0");
      expect(reconcileDraft(atMax, validSectionNames, validVariantKeys, targetRange).target).toBe("9");
    });

    it("drops a target above max", () => {
      const draft = { variantKey: null, selected: [], target: "15" };
      expect(reconcileDraft(draft, validSectionNames, validVariantKeys, targetRange).target).toBeNull();
    });

    it("drops a target below min", () => {
      const draft = { variantKey: null, selected: [], target: "-3" };
      expect(reconcileDraft(draft, validSectionNames, validVariantKeys, targetRange).target).toBeNull();
    });

    it("drops a non-numeric (NaN) target", () => {
      const draft = { variantKey: null, selected: [], target: "abc" };
      expect(reconcileDraft(draft, validSectionNames, validVariantKeys, targetRange).target).toBeNull();
    });

    it("leaves a null target as null (nothing to reconcile)", () => {
      const draft = { variantKey: null, selected: [], target: null };
      expect(reconcileDraft(draft, validSectionNames, validVariantKeys, targetRange).target).toBeNull();
    });
  });
});

// D1 (Stage 5, Task 2): name-only client mirror of resolveActiveSections
// (exam-profile/selection.ts) — same fixtures/scenarios as
// selection.test.ts, adapted to operate on plain name arrays/sets.
describe("resolveActiveSectionNames (D1, Stage 5 Task 2)", () => {
  const allIeltsNames = ["Listening", "Reading", "Writing", "Speaking"];
  const allVariantNames = ["Математика", "Физика", "Химия"];
  const allSelectableNames = ["Математика", "Английский", "Немецкий"];
  const allDegradedNames = ["A", "B", "C"];

  it("плоская спека, config null/{} (нет variantKey И ничего не выбрано) -> ВСЕ секции", () => {
    expect(resolveActiveSectionNames(ieltsLikeSpec, allIeltsNames, null, new Set())).toEqual(allIeltsNames);
  });

  it("вариантная спека, variantKey выбран -> база сужена до sectionNames варианта", () => {
    expect(resolveActiveSectionNames(variantSpec, allVariantNames, "phys-math", new Set())).toEqual([
      "Математика",
      "Физика",
    ]);
  });

  it("неизвестный variantKey -> база = все секции (устаревший config не роняет)", () => {
    expect(resolveActiveSectionNames(variantSpec, allVariantNames, "ghost", new Set())).toEqual(allVariantNames);
  });

  it("selectionGroup: пул непуст -> только выбранные из пула входят в результат", () => {
    expect(
      resolveActiveSectionNames(selectableSpec, allSelectableNames, null, new Set(["Английский"])),
    ).toEqual(["Математика", "Английский"]);
  });

  it("selectionGroup: ничего не выбрано -> члены пула отсутствуют в результате", () => {
    // non-null (пусть и несуществующий) variantKey — обходит backlog wave
    // fix1 ранний выход ("truly empty config" -> ВСЕ секции без вычитания
    // группы), тот же приём, что и у "нет выбранного варианта" в
    // selection.test.ts (variantKey указан, просто не находится в spec.variants).
    expect(resolveActiveSectionNames(selectableSpec, allSelectableNames, "no-variants-in-this-spec", new Set())).toEqual([
      "Математика",
    ]);
  });

  it("деградированная группа (пул < chooseCount под вариантом) -> выбранный член пула добавляется", () => {
    expect(
      resolveActiveSectionNames(degradedSpec, allDegradedNames, "v1", new Set(["B"])),
    ).toEqual(["A", "B"]);
  });

  it("ортогональная группа (пул пуст относительно варианта) -> выбранный член добавляется в базу", () => {
    // variant v1 = ["A","B"]; group g = ["B","C"] пересекается с базой (B
    // общий) -> НЕ ортогональна в этой фикстуре; используем вариант без
    // пересечения вовсе, чтобы проверить orthogonal-ветку явно.
    const orthSpec = { variants: [{ key: "v2", label: "V2", sectionNames: ["A"] }], selectionGroups: degradedSpec.selectionGroups };
    expect(resolveActiveSectionNames(orthSpec, allDegradedNames, "v2", new Set(["C"]))).toEqual(["A", "C"]);
  });
});

describe("reconcileWeakSections (D1 🔴, Stage 5 Task 2)", () => {
  it("keeps weakSections that are still active", () => {
    expect(reconcileWeakSections(["Математика", "Физика"], ["Математика", "Физика", "Химия"])).toEqual([
      "Математика",
      "Физика",
    ]);
  });

  it("🔴 drops a weakSection no longer among the active sections", () => {
    expect(reconcileWeakSections(["Математика", "Немецкий"], ["Математика", "Английский"])).toEqual([
      "Математика",
    ]);
  });

  it("drops everything when none of the weakSections are active anymore (lockout-style)", () => {
    expect(reconcileWeakSections(["Немецкий"], ["Математика", "Английский"])).toEqual([]);
  });

  it("empty weakSections stays empty", () => {
    expect(reconcileWeakSections([], ["Математика"])).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const weak = ["Математика"];
    const active = ["Математика"];
    reconcileWeakSections(weak, active);
    expect(weak).toEqual(["Математика"]);
    expect(active).toEqual(["Математика"]);
  });
});
