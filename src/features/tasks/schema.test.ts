import { describe, expect, it } from "vitest";
import {
  taskBodySchema,
  taskAnswerSchema,
  taskResponseSchema,
  validateTaskPair,
} from "./schema";

describe("taskBodySchema", () => {
  it("accepts a single_choice body with 2+ options", () => {
    const body = taskBodySchema.parse({
      format: "single_choice",
      prompt: "2+2=?",
      options: [
        { id: "a", text: "3" },
        { id: "b", text: "4" },
      ],
    });
    expect(body.format).toBe("single_choice");
  });

  it("rejects single_choice body with fewer than 2 options", () => {
    expect(() =>
      taskBodySchema.parse({
        format: "single_choice",
        prompt: "2+2=?",
        options: [{ id: "a", text: "4" }],
      }),
    ).toThrow();
  });

  it("accepts a multi_choice body with optional passage", () => {
    const body = taskBodySchema.parse({
      format: "multi_choice",
      prompt: "Select primes",
      passage: "Some passage text",
      options: [
        { id: "a", text: "2" },
        { id: "b", text: "3" },
        { id: "c", text: "4" },
      ],
    });
    expect(body.format).toBe("multi_choice");
  });

  it("accepts text_input body with inputKind number or string", () => {
    const numberBody = taskBodySchema.parse({
      format: "text_input",
      prompt: "What is pi rounded to 2 decimals?",
      inputKind: "number",
    });
    expect(numberBody.format).toBe("text_input");

    const stringBody = taskBodySchema.parse({
      format: "text_input",
      prompt: "Capital of France?",
      inputKind: "string",
    });
    expect(stringBody.format).toBe("text_input");
  });

  it("rejects an empty prompt", () => {
    expect(() =>
      taskBodySchema.parse({
        format: "text_input",
        prompt: "",
        inputKind: "string",
      }),
    ).toThrow();
  });

  it("rejects unknown format discriminant", () => {
    expect(() =>
      taskBodySchema.parse({
        format: "essay",
        prompt: "Write about your day",
      }),
    ).toThrow();
  });
});

describe("taskAnswerSchema", () => {
  it("accepts single_choice answer", () => {
    const answer = taskAnswerSchema.parse({
      format: "single_choice",
      correctOptionId: "b",
    });
    expect(answer.format).toBe("single_choice");
  });

  it("accepts multi_choice answer with 1+ ids", () => {
    const answer = taskAnswerSchema.parse({
      format: "multi_choice",
      correctOptionIds: ["a", "c"],
    });
    expect(answer.format).toBe("multi_choice");
  });

  it("rejects multi_choice answer with zero ids", () => {
    expect(() =>
      taskAnswerSchema.parse({ format: "multi_choice", correctOptionIds: [] }),
    ).toThrow();
  });

  it("defaults text_input caseSensitive to false", () => {
    const answer = taskAnswerSchema.parse({
      format: "text_input",
      accepted: ["Paris"],
    });
    expect(answer.format).toBe("text_input");
    if (answer.format === "text_input") {
      expect(answer.caseSensitive).toBe(false);
    }
  });

  it("accepts text_input answer with tolerance", () => {
    const answer = taskAnswerSchema.parse({
      format: "text_input",
      accepted: ["3.14"],
      tolerance: 0.01,
    });
    if (answer.format === "text_input") {
      expect(answer.tolerance).toBe(0.01);
    }
  });

  it("rejects text_input answer with zero accepted values", () => {
    expect(() =>
      taskAnswerSchema.parse({ format: "text_input", accepted: [] }),
    ).toThrow();
  });
});

describe("taskResponseSchema", () => {
  it("accepts single_choice response with null optionId", () => {
    const response = taskResponseSchema.parse({
      format: "single_choice",
      optionId: null,
    });
    expect(response.format).toBe("single_choice");
  });

  it("accepts multi_choice response with empty array", () => {
    const response = taskResponseSchema.parse({
      format: "multi_choice",
      optionIds: [],
    });
    expect(response.format).toBe("multi_choice");
  });

  it("accepts text_input response with null value", () => {
    const response = taskResponseSchema.parse({
      format: "text_input",
      value: null,
    });
    expect(response.format).toBe("text_input");
  });

  it("never carries answer fields (no correctOptionId/accepted keys in schema shape)", () => {
    const response = taskResponseSchema.parse({
      format: "single_choice",
      optionId: "a",
    });
    expect(response).not.toHaveProperty("correctOptionId");
  });
});

describe("validateTaskPair", () => {
  const singleChoiceBody = {
    format: "single_choice" as const,
    prompt: "2+2=?",
    options: [
      { id: "a", text: "3" },
      { id: "b", text: "4" },
    ],
  };

  it("accepts a matching single_choice pair with correctOptionId among options", () => {
    const { body, answer } = validateTaskPair(
      taskBodySchema.parse(singleChoiceBody),
      taskAnswerSchema.parse({ format: "single_choice", correctOptionId: "b" }),
    );
    expect(body.format).toBe("single_choice");
    expect(answer.format).toBe("single_choice");
  });

  it("rejects single_choice pair when correctOptionId is not among options", () => {
    expect(() =>
      validateTaskPair(
        taskBodySchema.parse(singleChoiceBody),
        taskAnswerSchema.parse({ format: "single_choice", correctOptionId: "z" }),
      ),
    ).toThrow();
  });

  it("accepts multi_choice pair when correctOptionIds is a subset of options", () => {
    const body = taskBodySchema.parse({
      format: "multi_choice",
      prompt: "Select primes",
      options: [
        { id: "a", text: "2" },
        { id: "b", text: "3" },
        { id: "c", text: "4" },
      ],
    });
    const answer = taskAnswerSchema.parse({
      format: "multi_choice",
      correctOptionIds: ["a", "b"],
    });
    expect(() => validateTaskPair(body, answer)).not.toThrow();
  });

  it("rejects multi_choice pair when correctOptionIds is not a subset of options", () => {
    const body = taskBodySchema.parse({
      format: "multi_choice",
      prompt: "Select primes",
      options: [
        { id: "a", text: "2" },
        { id: "b", text: "3" },
      ],
    });
    const answer = taskAnswerSchema.parse({
      format: "multi_choice",
      correctOptionIds: ["a", "z"],
    });
    expect(() => validateTaskPair(body, answer)).toThrow();
  });

  it("rejects a mismatched format pair (body single_choice vs answer text_input)", () => {
    const answer = taskAnswerSchema.parse({
      format: "text_input",
      accepted: ["4"],
    });
    expect(() =>
      validateTaskPair(taskBodySchema.parse(singleChoiceBody), answer),
    ).toThrow();
  });

  it("accepts a text_input pair unconditionally (no options to cross-check)", () => {
    const body = taskBodySchema.parse({
      format: "text_input",
      prompt: "Capital of France?",
      inputKind: "string",
    });
    const answer = taskAnswerSchema.parse({
      format: "text_input",
      accepted: ["Paris"],
    });
    expect(() => validateTaskPair(body, answer)).not.toThrow();
  });
});
