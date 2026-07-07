import { describe, expect, it } from "vitest";
import { slugifyExamQuery, ensureRerollSlug } from "./slug";

describe("slugifyExamQuery", () => {
  it("transliterates russian", () => {
    expect(slugifyExamQuery("ЕНТ 2027")).toBe("ent-2027");
  });
  it("transliterates kazakh-specific letters", () => {
    expect(slugifyExamQuery("ҰБТ")).toBe("ubt");
  });
  it("normalizes latin with punctuation and case", () => {
    expect(slugifyExamQuery("  IELTS  (Academic)! ")).toBe("ielts-academic");
  });
  it("is idempotent for equivalent queries", () => {
    expect(slugifyExamQuery("ент 2027")).toBe(slugifyExamQuery("ЕНТ 2027"));
  });
  it("falls back to 'exam' for empty result", () => {
    expect(slugifyExamQuery("!!!")).toBe("exam");
  });
  it("never ends with a hyphen after 64-char truncation", () => {
    const slug = slugifyExamQuery("a".repeat(63) + " b");
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("ensureRerollSlug", () => {
  it("returns newSlug unchanged when it already differs from excludeSlug", () => {
    expect(ensureRerollSlug("ielts-academic", "toefl", "clarification")).toBe("ielts-academic");
  });

  it("appends a -x<hash6> suffix when newSlug collides with excludeSlug", () => {
    const result = ensureRerollSlug("ent-2027", "ent-2027", "это не тот ЕНТ");
    expect(result).not.toBe("ent-2027");
    expect(result).toMatch(/^ent-2027-x[0-9a-f]{6}$/);
  });

  it("is deterministic for the same seed (stable across retries with same input)", () => {
    const a = ensureRerollSlug("ent-2027", "ent-2027", "уточнение");
    const b = ensureRerollSlug("ent-2027", "ent-2027", "уточнение");
    expect(a).toBe(b);
  });

  it("never equals excludeSlug, even across many different seeds", () => {
    const excludeSlug = "nis-fizmat";
    for (const seed of ["a", "b", "c", "", "уточнение", "clarification with spaces"]) {
      expect(ensureRerollSlug(excludeSlug, excludeSlug, seed)).not.toBe(excludeSlug);
    }
  });
});
