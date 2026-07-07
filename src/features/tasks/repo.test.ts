import { describe, expect, it } from "vitest";
import { contentHash } from "./repo";
import type { TaskBody } from "./schema";

function singleChoiceBody(prompt: string, optionText = "Answer A"): TaskBody {
  return {
    format: "single_choice",
    prompt,
    options: [
      { id: "a", text: optionText },
      { id: "b", text: "Other option" },
    ],
  };
}

describe("contentHash", () => {
  it("produces a 64-char hex sha256 digest", () => {
    const hash = contentHash(singleChoiceBody("Hello"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across different casing and whitespace in the prompt", () => {
    const a = contentHash(singleChoiceBody("What   is  2+2 ?"));
    const b = contentHash(singleChoiceBody("what is 2+2 ?"));
    expect(a).toBe(b);
  });

  it("trims leading/trailing whitespace in the prompt", () => {
    const a = contentHash(singleChoiceBody("  What is 2+2?  "));
    const b = contentHash(singleChoiceBody("What is 2+2?"));
    expect(a).toBe(b);
  });

  it("changes when options differ", () => {
    const a = contentHash(singleChoiceBody("Same prompt", "Answer A"));
    const b = contentHash(singleChoiceBody("Same prompt", "Answer B"));
    expect(a).not.toBe(b);
  });

  it("is order-independent over options (sorted before hashing)", () => {
    const a: TaskBody = {
      format: "multi_choice",
      prompt: "Pick primes",
      options: [
        { id: "a", text: "2" },
        { id: "b", text: "3" },
      ],
    };
    const b: TaskBody = {
      format: "multi_choice",
      prompt: "Pick primes",
      options: [
        { id: "b", text: "3" },
        { id: "a", text: "2" },
      ],
    };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("uses only the prompt for text_input tasks (inputKind does not affect hash)", () => {
    const a: TaskBody = {
      format: "text_input",
      prompt: "  What  IS the capital? ",
      inputKind: "string",
    };
    const b: TaskBody = {
      format: "text_input",
      prompt: "what is the capital?",
      inputKind: "number",
    };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("changes when the prompt differs even with identical options", () => {
    const a = contentHash(singleChoiceBody("Prompt one"));
    const b = contentHash(singleChoiceBody("Prompt two"));
    expect(a).not.toBe(b);
  });
});
