import { describe, expect, it } from "vitest";
import { slugifyExamQuery } from "./slug";

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
