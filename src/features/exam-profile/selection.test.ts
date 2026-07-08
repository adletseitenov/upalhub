import { describe, expect, it } from "vitest";
import { examProfileSpecSchema, type ExamProfileSpec } from "./spec";
import { hqConfigSchema, parseHqConfig, resolveActiveSections, validateHqConfig } from "./selection";

const baseFields = {
  language: "ru",
  description: "Тестовая спека.",
  scoring: { scaleMin: 0, scaleMax: 100, unit: "баллов" },
};

// Старая (аддитивно совместимая) плоская спека — без variants/selectionGroups,
// как у IELTS/старых профилей в БД.
const flatSpec: ExamProfileSpec = examProfileSpecSchema.parse({
  ...baseFields,
  examName: "Плоский экзамен",
  sections: [
    { name: "Reading", taskTypes: [], topics: [] },
    { name: "Writing", taskTypes: [], topics: [] },
  ],
});

// Вариантная спека без selectionGroups — вариант сужает набор секций.
const variantSpec: ExamProfileSpec = examProfileSpecSchema.parse({
  ...baseFields,
  examName: "Вариантный экзамен",
  sections: [
    { name: "Математика", taskTypes: [], topics: [] },
    { name: "Физика", taskTypes: [], topics: [] },
    { name: "Химия", taskTypes: [], topics: [] },
    { name: "Биология", taskTypes: [], topics: [] },
  ],
  variants: [
    { key: "phys-math", label: "Физико-математическое", sectionNames: ["Математика", "Физика"] },
    {
      key: "chem-bio",
      label: "Химико-биологическое",
      sectionNames: ["Математика", "Химия", "Биология"],
    },
  ],
});

// Группа выбора, ВЛОЖЕННАЯ в оба варианта (пересечение группы с каждым
// вариантом непусто и >= chooseCount — недеградированный случай).
const groupSpec: ExamProfileSpec = examProfileSpecSchema.parse({
  ...baseFields,
  examName: "Экзамен с выбором языка",
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
});

// D1 деградация: пул группы, пересечённый с вариантом V1, МЕНЬШЕ chooseCount
// (2), хотя базовая спека-целостность (chooseCount <= |group.sectionNames|
// без учёта варианта) соблюдена.
const degradedSpec: ExamProfileSpec = examProfileSpecSchema.parse({
  ...baseFields,
  examName: "Экзамен с деградирующей группой",
  sections: [
    { name: "A", taskTypes: [], topics: [] },
    { name: "B", taskTypes: [], topics: [] },
    { name: "C", taskTypes: [], topics: [] },
  ],
  variants: [{ key: "v1", label: "V1", sectionNames: ["A", "B"] }],
  selectionGroups: [{ key: "g", title: "G", chooseCount: 2, sectionNames: ["B", "C"] }],
});

// Ортогональная группа: пересечение group.sectionNames с variant.sectionNames
// ПУСТО ("v2" содержит только "A") — по формуле пул падает обратно на
// полный group.sectionNames (группа независима от оси вариантов).
const orthogonalSpec: ExamProfileSpec = examProfileSpecSchema.parse({
  ...baseFields,
  examName: "Экзамен с ортогональной группой",
  sections: [
    { name: "A", taskTypes: [], topics: [] },
    { name: "B", taskTypes: [], topics: [] },
    { name: "C", taskTypes: [], topics: [] },
  ],
  variants: [{ key: "v2", label: "V2", sectionNames: ["A"] }],
  selectionGroups: [{ key: "g2", title: "G2", chooseCount: 1, sectionNames: ["B", "C"] }],
});

describe("hqConfigSchema", () => {
  it("defaults selectedSectionNames to [] and allows a nullish variantKey", () => {
    expect(hqConfigSchema.parse({})).toEqual({ selectedSectionNames: [] });
    expect(hqConfigSchema.parse({ variantKey: null })).toMatchObject({ variantKey: null });
  });
});

// Stage3 T1: parseHqConfig консолидирован из дублей в /api/tests/route.ts и
// (app)/onboarding/[slug]/page.tsx — единая точка истины для чтения
// study_hqs.config (jsonb, приходит как unknown до типизации/после cast).
describe("parseHqConfig (Stage3 T1 consolidation)", () => {
  it("returns null for null/undefined raw config (legacy hq without onboarding)", () => {
    expect(parseHqConfig(null)).toBeNull();
    expect(parseHqConfig(undefined)).toBeNull();
  });

  it("returns null for an array (unexpected jsonb shape)", () => {
    expect(parseHqConfig(["not", "an", "object"])).toBeNull();
  });

  it("returns null for garbage that does not match hqConfigSchema", () => {
    expect(parseHqConfig("just a string")).toBeNull();
    expect(parseHqConfig(42)).toBeNull();
    expect(parseHqConfig({ variantKey: 123 })).toBeNull(); // wrong type
    expect(parseHqConfig({ selectedSectionNames: "not-an-array" })).toBeNull();
  });

  it("parses a valid, empty config object", () => {
    expect(parseHqConfig({})).toEqual({ selectedSectionNames: [] });
  });

  it("parses a fully populated valid config", () => {
    expect(
      parseHqConfig({ variantKey: "phys-math", selectedSectionNames: ["Английский"] }),
    ).toEqual({ variantKey: "phys-math", selectedSectionNames: ["Английский"] });
  });
});

describe("resolveActiveSections (totality, D2)", () => {
  it("returns all sections for a flat spec regardless of config shape", () => {
    expect(resolveActiveSections(flatSpec, null).map((s) => s.name)).toEqual([
      "Reading",
      "Writing",
    ]);
    expect(resolveActiveSections(flatSpec, undefined).map((s) => s.name)).toEqual([
      "Reading",
      "Writing",
    ]);
    expect(
      resolveActiveSections(flatSpec, { selectedSectionNames: [] }).map((s) => s.name),
    ).toEqual(["Reading", "Writing"]);
  });

  it("narrows to the selected variant's sections", () => {
    const active = resolveActiveSections(variantSpec, {
      variantKey: "phys-math",
      selectedSectionNames: [],
    });
    expect(active.map((s) => s.name)).toEqual(["Математика", "Физика"]);
  });

  it("falls back to all sections when variantKey does not exist (stale, no throw)", () => {
    expect(() =>
      resolveActiveSections(variantSpec, {
        variantKey: "does-not-exist",
        selectedSectionNames: [],
      }),
    ).not.toThrow();
    const active = resolveActiveSections(variantSpec, {
      variantKey: "does-not-exist",
      selectedSectionNames: [],
    });
    expect(active.map((s) => s.name)).toEqual(["Математика", "Физика", "Химия", "Биология"]);
  });

  it("excludes selectionGroup members from the base and returns only selected ones", () => {
    const active = resolveActiveSections(groupSpec, {
      variantKey: "phys-math",
      selectedSectionNames: ["Английский"],
    });
    expect(active.map((s) => s.name).sort()).toEqual(["Английский", "Математика", "Физика"]);
  });

  it("drops stale selectedSectionNames that do not exist in the spec (no throw)", () => {
    const active = resolveActiveSections(groupSpec, {
      variantKey: "phys-math",
      selectedSectionNames: ["Английский", "Испанский"],
    });
    expect(active.map((s) => s.name).sort()).toEqual(["Английский", "Математика", "Физика"]);
  });

  it("drops a group member entirely when nothing valid is selected", () => {
    const active = resolveActiveSections(groupSpec, {
      variantKey: "phys-math",
      selectedSectionNames: [],
    });
    expect(active.map((s) => s.name).sort()).toEqual(["Математика", "Физика"]);
  });

  // D-important3: resolveActiveSections must agree with validateHqConfig on
  // orthogonal groups (group.sectionNames disjoint from the variant base) —
  // validateHqConfig falls back to the FULL group pool and accepts the
  // selection, so resolveActiveSections must union the chosen out-of-variant
  // member INTO the base instead of silently skipping the group (previously
  // a validated config could still lose the user's selected section).
  it("unions a selected orthogonal-group section (disjoint from the variant) into the base", () => {
    const config = { variantKey: "v2", selectedSectionNames: ["B"] };
    // pin agreement: validateHqConfig must accept this exact config...
    expect(validateHqConfig(orthogonalSpec, config)).toEqual({ ok: true });
    // ...and resolveActiveSections must not silently drop "B".
    const active = resolveActiveSections(orthogonalSpec, config);
    expect(active.map((s) => s.name).sort()).toEqual(["A", "B"]);
  });

  it("drops the orthogonal group entirely when nothing from it is selected (still total, no throw)", () => {
    const active = resolveActiveSections(orthogonalSpec, {
      variantKey: "v2",
      selectedSectionNames: [],
    });
    expect(active.map((s) => s.name)).toEqual(["A"]);
  });

  it("is total even for a degraded (unsatisfiable) group selection: returns whatever was actually selected", () => {
    expect(() =>
      resolveActiveSections(degradedSpec, { variantKey: "v1", selectedSectionNames: ["B"] }),
    ).not.toThrow();
    const active = resolveActiveSections(degradedSpec, {
      variantKey: "v1",
      selectedSectionNames: ["B"],
    });
    expect(active.map((s) => s.name).sort()).toEqual(["A", "B"]);
  });
});

describe("validateHqConfig (D2)", () => {
  it("ok for a flat spec with an empty/legacy config", () => {
    expect(validateHqConfig(flatSpec, null)).toEqual({ ok: true });
    expect(validateHqConfig(flatSpec, { selectedSectionNames: [] })).toEqual({ ok: true });
  });

  it("fails when variants exist but variantKey is missing", () => {
    const result = validateHqConfig(variantSpec, { selectedSectionNames: [] });
    expect(result.ok).toBe(false);
  });

  it("fails when variantKey does not exist among spec.variants", () => {
    const result = validateHqConfig(variantSpec, {
      variantKey: "ghost",
      selectedSectionNames: [],
    });
    expect(result.ok).toBe(false);
  });

  it("ok when a valid variantKey is provided and there are no selectionGroups", () => {
    expect(
      validateHqConfig(variantSpec, { variantKey: "phys-math", selectedSectionNames: [] }),
    ).toEqual({ ok: true });
  });

  it("fails when the selected count for a non-degraded group does not equal chooseCount", () => {
    const zero = validateHqConfig(groupSpec, {
      variantKey: "phys-math",
      selectedSectionNames: [],
    });
    expect(zero.ok).toBe(false);

    const two = validateHqConfig(groupSpec, {
      variantKey: "phys-math",
      selectedSectionNames: ["Английский", "Немецкий"],
    });
    expect(two.ok).toBe(false);
  });

  it("ok when the selected count for a non-degraded group equals chooseCount", () => {
    expect(
      validateHqConfig(groupSpec, {
        variantKey: "phys-math",
        selectedSectionNames: ["Английский"],
      }),
    ).toEqual({ ok: true });
  });

  it("ok for a degraded group (pool < chooseCount) when selected covers the whole pool", () => {
    expect(
      validateHqConfig(degradedSpec, { variantKey: "v1", selectedSectionNames: ["B"] }),
    ).toEqual({ ok: true });
  });

  it("fails for a degraded group when the available pool is not fully selected", () => {
    const result = validateHqConfig(degradedSpec, { variantKey: "v1", selectedSectionNames: [] });
    expect(result.ok).toBe(false);
  });

  it("falls back to the full group pool when the group does not intersect the selected variant", () => {
    const ok = validateHqConfig(orthogonalSpec, {
      variantKey: "v2",
      selectedSectionNames: ["B"],
    });
    expect(ok).toEqual({ ok: true });

    const fail = validateHqConfig(orthogonalSpec, {
      variantKey: "v2",
      selectedSectionNames: ["B", "C"],
    });
    expect(fail.ok).toBe(false);
  });

  it("fails when selectedSectionNames references a section name that does not exist", () => {
    const result = validateHqConfig(flatSpec, { selectedSectionNames: ["Nonexistent"] });
    expect(result.ok).toBe(false);
  });
});
