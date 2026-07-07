import { describe, expect, it } from "vitest";
import { gradeAnswer } from "./grade";
import type { TaskAnswer, TaskBody, TaskResponse } from "./schema";

describe("gradeAnswer: single_choice", () => {
  const body: TaskBody = {
    format: "single_choice",
    prompt: "2+2=?",
    options: [
      { id: "a", text: "3" },
      { id: "b", text: "4" },
    ],
  };
  const answer: TaskAnswer = { format: "single_choice", correctOptionId: "b" };

  it("grades a correct pick as true", () => {
    const response: TaskResponse = { format: "single_choice", optionId: "b" };
    expect(gradeAnswer(body, answer, response)).toBe(true);
  });

  it("grades a wrong pick as false", () => {
    const response: TaskResponse = { format: "single_choice", optionId: "a" };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });

  it("grades a null (unanswered) response as false", () => {
    const response: TaskResponse = { format: "single_choice", optionId: null };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });
});

describe("gradeAnswer: multi_choice (set equality)", () => {
  const body: TaskBody = {
    format: "multi_choice",
    prompt: "Select primes",
    options: [
      { id: "a", text: "2" },
      { id: "b", text: "3" },
      { id: "c", text: "4" },
    ],
  };
  const answer: TaskAnswer = {
    format: "multi_choice",
    correctOptionIds: ["a", "b"],
  };

  it("grades exact set match (different order) as true", () => {
    const response: TaskResponse = { format: "multi_choice", optionIds: ["b", "a"] };
    expect(gradeAnswer(body, answer, response)).toBe(true);
  });

  it("grades a partial subset as false", () => {
    const response: TaskResponse = { format: "multi_choice", optionIds: ["a"] };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });

  it("grades a superset (extra wrong option) as false", () => {
    const response: TaskResponse = {
      format: "multi_choice",
      optionIds: ["a", "b", "c"],
    };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });

  it("grades an empty (unanswered) response as false", () => {
    const response: TaskResponse = { format: "multi_choice", optionIds: [] };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });
});

describe("gradeAnswer: text_input string", () => {
  const body: TaskBody = {
    format: "text_input",
    prompt: "Capital of France?",
    inputKind: "string",
  };

  it("matches case-insensitively with trim + collapsed whitespace by default", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["Paris"],
      caseSensitive: false,
    };
    const response: TaskResponse = { format: "text_input", value: "  paris  " };
    expect(gradeAnswer(body, answer, response)).toBe(true);
  });

  it("collapses internal multiple spaces before comparing", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["New York"],
      caseSensitive: false,
    };
    const response: TaskResponse = { format: "text_input", value: "new    york" };
    expect(gradeAnswer(body, answer, response)).toBe(true);
  });

  it("respects caseSensitive: true and rejects a case mismatch", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["Paris"],
      caseSensitive: true,
    };
    const response: TaskResponse = { format: "text_input", value: "paris" };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });

  it("grades a null (unanswered) response as false", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["Paris"],
      caseSensitive: false,
    };
    const response: TaskResponse = { format: "text_input", value: null };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });

  it("matches against any of multiple accepted values", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["Paris", "City of Light"],
      caseSensitive: false,
    };
    const response: TaskResponse = {
      format: "text_input",
      value: "city of light",
    };
    expect(gradeAnswer(body, answer, response)).toBe(true);
  });
});

describe("gradeAnswer: text_input number", () => {
  const body: TaskBody = {
    format: "text_input",
    prompt: "Value of pi to 2 decimals?",
    inputKind: "number",
  };

  it("accepts a decimal-comma input as equal to the decimal-point accepted value", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["3.14"],
      caseSensitive: false,
    };
    const response: TaskResponse = { format: "text_input", value: "3,14" };
    expect(gradeAnswer(body, answer, response)).toBe(true);
  });

  it("accepts values within tolerance", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["3.14"],
      caseSensitive: false,
      tolerance: 0.02,
    };
    const response: TaskResponse = { format: "text_input", value: "3.16" };
    expect(gradeAnswer(body, answer, response)).toBe(true);
  });

  it("rejects values outside tolerance", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["3.14"],
      caseSensitive: false,
      tolerance: 0.01,
    };
    const response: TaskResponse = { format: "text_input", value: "3.16" };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });

  it("without tolerance requires an exact numeric match", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["3.14"],
      caseSensitive: false,
    };
    const response: TaskResponse = { format: "text_input", value: "3.15" };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });

  it("grades a non-numeric response as false", () => {
    const answer: TaskAnswer = {
      format: "text_input",
      accepted: ["3.14"],
      caseSensitive: false,
    };
    const response: TaskResponse = { format: "text_input", value: "pi" };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });
});

describe("gradeAnswer: format mismatch defensive behavior", () => {
  it("returns false when response format does not match body/answer format", () => {
    const body: TaskBody = {
      format: "single_choice",
      prompt: "2+2=?",
      options: [
        { id: "a", text: "3" },
        { id: "b", text: "4" },
      ],
    };
    const answer: TaskAnswer = { format: "single_choice", correctOptionId: "b" };
    const response: TaskResponse = { format: "multi_choice", optionIds: ["b"] };
    expect(gradeAnswer(body, answer, response)).toBe(false);
  });
});
