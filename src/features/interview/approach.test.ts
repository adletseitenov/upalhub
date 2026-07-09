import { describe, expect, it } from "vitest";
import {
  APPROACH_LEVELS,
  APPROACH_TONES,
  DEFAULT_APPROACH,
  deriveApproachFromButtons,
  mergeApproach,
  parseApproach,
  studentApproachSchema,
  type InterviewButtons,
  type StudentApproach,
} from "./approach";

describe("parseApproach (D1, тотальная)", () => {
  it("null -> DEFAULT_APPROACH", () => {
    expect(parseApproach(null)).toEqual(DEFAULT_APPROACH);
  });

  it("не-объект (строка/число/boolean) -> DEFAULT_APPROACH", () => {
    expect(parseApproach("garbage")).toEqual(DEFAULT_APPROACH);
    expect(parseApproach(42)).toEqual(DEFAULT_APPROACH);
    expect(parseApproach(true)).toEqual(DEFAULT_APPROACH);
  });

  it("массив -> DEFAULT_APPROACH (не валидный объект approach)", () => {
    expect(parseApproach(["level", "intermediate"])).toEqual(DEFAULT_APPROACH);
  });

  it("пустой объект {} -> DEFAULT_APPROACH-эквивалент (каждое поле .catch()-ится в свой дефолт)", () => {
    expect(parseApproach({})).toEqual(DEFAULT_APPROACH);
  });

  it("полностью валидный объект проходит байт-в-байт", () => {
    const valid: StudentApproach = {
      level: "confident",
      intensity: "intense",
      focusSections: ["Математика"],
      explanationStyle: "detailed",
      concerns: ["время", "формулы"],
      tone: "challenging",
      summary: "Готовится к пересдаче, увереннее среднего.",
    };
    expect(parseApproach(valid)).toEqual(valid);
  });

  // 🔴 D1 пин: одно битое поле НЕ должно стирать валидные соседние поля —
  // field-level .catch, а не единый .parse() на весь объект.
  it("🔴 частично-битый объект -> default для битого поля, валидные соседи сохранены", () => {
    const partiallyBroken = {
      level: "not-a-real-level", // битое -> .catch("intermediate")
      intensity: "intense", // валидное -> сохраняется
      focusSections: ["Физика"], // валидное -> сохраняется
      explanationStyle: "detailed", // валидное -> сохраняется
      concerns: ["страх устного"], // валидное -> сохраняется
      tone: "reassuring", // валидное -> сохраняется
      summary: "реальное резюме прошлого интервью", // валидное -> сохраняется
    };
    expect(parseApproach(partiallyBroken)).toEqual({
      level: "intermediate",
      intensity: "intense",
      focusSections: ["Физика"],
      explanationStyle: "detailed",
      concerns: ["страх устного"],
      tone: "reassuring",
      summary: "реальное резюме прошлого интервью",
    });
  });

  it("🔴 concerns длиннее max(3) -> [] для этого поля, остальные поля не затронуты", () => {
    const tooManyConcerns = {
      ...DEFAULT_APPROACH,
      concerns: ["a", "b", "c", "d"],
      summary: "should survive",
    };
    const result = parseApproach(tooManyConcerns);
    expect(result.concerns).toEqual([]);
    expect(result.summary).toBe("should survive");
  });

  it("несколько битых полей одновременно -> каждое независимо дефолтится", () => {
    const multiplyBroken = {
      level: 123,
      intensity: null,
      focusSections: "not-an-array",
      explanationStyle: "detailed", // валидное
      concerns: "not-an-array",
      tone: "furious", // не входит в enum
      summary: 999,
    };
    expect(parseApproach(multiplyBroken)).toEqual({
      ...DEFAULT_APPROACH,
      explanationStyle: "detailed",
    });
  });
});

describe("deriveApproachFromButtons (pure, ноль LLM)", () => {
  const base: InterviewButtons = {
    level: "beginner",
    hoursPerWeek: "<3",
    weakSections: ["Математика"],
    explanationStyle: "detailed",
  };

  it("hoursPerWeek '<3' -> intensity 'light'", () => {
    expect(deriveApproachFromButtons(base).intensity).toBe("light");
  });

  it("hoursPerWeek '3-6' -> intensity 'steady'", () => {
    expect(deriveApproachFromButtons({ ...base, hoursPerWeek: "3-6" }).intensity).toBe("steady");
  });

  it("hoursPerWeek '7+' -> intensity 'intense'", () => {
    expect(deriveApproachFromButtons({ ...base, hoursPerWeek: "7+" }).intensity).toBe("intense");
  });

  it("level/weakSections/explanationStyle передаются как есть (focusSections = weakSections)", () => {
    expect(deriveApproachFromButtons(base)).toEqual({
      level: "beginner",
      intensity: "light",
      focusSections: ["Математика"],
      explanationStyle: "detailed",
    });
  });

  it("pure: одинаковый вход -> глубоко равный результат (без побочных эффектов)", () => {
    const a = deriveApproachFromButtons(base);
    const b = deriveApproachFromButtons(base);
    expect(a).toEqual(b);
    expect(base.weakSections).toEqual(["Математика"]); // вход не мутирован
  });
});

describe("mergeApproach (🔴 D1 partial-merge)", () => {
  const derived = {
    level: "confident" as const,
    intensity: "intense" as const,
    focusSections: ["Химия"],
    explanationStyle: "concise" as const,
  };

  it("existing=null, analyzed есть -> derive- и analyze-поля поверх DEFAULT_APPROACH", () => {
    const analyzed = { concerns: ["страх"], tone: "reassuring" as const, summary: "первое интервью" };
    expect(mergeApproach(null, derived, analyzed)).toEqual({
      ...derived,
      concerns: ["страх"],
      tone: "reassuring",
      summary: "первое интервью",
    });
  });

  it("existing=null, analyzed=null -> analyze-поля берутся из DEFAULT_APPROACH (пустые)", () => {
    expect(mergeApproach(null, derived, null)).toEqual({
      ...derived,
      concerns: [],
      tone: "neutral",
      summary: "",
    });
  });

  // 🔴 D1 regression pin: повторное интервью со скипнутыми открытыми
  // (analyzed=null) обязано СОХРАНИТЬ существующие concerns/tone/summary,
  // а не затереть их пустыми значениями.
  it("🔴 re-интервью со скипнутыми открытыми (analyzed=null) сохраняет старые concerns/tone/summary", () => {
    const existing: StudentApproach = {
      level: "beginner",
      intensity: "light",
      focusSections: ["Старое"],
      explanationStyle: "concise",
      concerns: ["старый страх"],
      tone: "challenging",
      summary: "старое резюме",
    };
    const result = mergeApproach(existing, derived, null);
    expect(result.concerns).toEqual(["старый страх"]);
    expect(result.tone).toBe("challenging");
    expect(result.summary).toBe("старое резюме");
    // derive-поля патчатся ВСЕГДА, даже когда analyze-шаг пропущен.
    expect(result.level).toBe("confident");
    expect(result.intensity).toBe("intense");
    expect(result.focusSections).toEqual(["Химия"]);
    expect(result.explanationStyle).toBe("concise");
  });

  it("existing и analyzed оба присутствуют -> analyze-поля перезаписываются новыми значениями", () => {
    const existing: StudentApproach = {
      ...DEFAULT_APPROACH,
      concerns: ["старый страх"],
      tone: "challenging",
      summary: "старое резюме",
    };
    const analyzed = { concerns: ["новый страх"], tone: "neutral" as const, summary: "новое резюме" };
    const result = mergeApproach(existing, derived, analyzed);
    expect(result.concerns).toEqual(["новый страх"]);
    expect(result.tone).toBe("neutral");
    expect(result.summary).toBe("новое резюме");
  });

  it("не мутирует existing/derived, возвращает новый объект", () => {
    const existing: StudentApproach = { ...DEFAULT_APPROACH, summary: "исходное" };
    const existingCopy = { ...existing };
    const result = mergeApproach(existing, derived, null);
    expect(existing).toEqual(existingCopy);
    expect(result).not.toBe(existing);
  });
});

describe("studentApproachSchema sanity", () => {
  it("принимает каждое объявленное значение level/tone", () => {
    for (const level of APPROACH_LEVELS) {
      expect(studentApproachSchema.safeParse({ ...DEFAULT_APPROACH, level }).success).toBe(true);
    }
    for (const tone of APPROACH_TONES) {
      expect(studentApproachSchema.safeParse({ ...DEFAULT_APPROACH, tone }).success).toBe(true);
    }
  });
});
