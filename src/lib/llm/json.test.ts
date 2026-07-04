import { describe, expect, it } from "vitest";
import { extractJson } from "./json";

describe("extractJson", () => {
  it("parses bare json object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses json wrapped in prose and code fences", () => {
    expect(extractJson('Вот ответ:\n```json\n{"a":1}\n```\nготово')).toEqual({ a: 1 });
  });
  it("parses arrays", () => {
    expect(extractJson("prefix [1,2,3] suffix")).toEqual([1, 2, 3]);
  });
  it("throws when no json present", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});
