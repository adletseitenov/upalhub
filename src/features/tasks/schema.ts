import { z } from "zod";

// Экзаменная таксономия (spec.sections[].taskTypes) живёт в колонке tasks.type —
// сюда НЕ попадает. Здесь только грейдинг-формат (D1): дискриминант внутри body/answer.

const optionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

export const taskBodySchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("single_choice"),
    prompt: z.string().min(1),
    passage: z.string().nullish(),
    options: z.array(optionSchema).min(2),
  }),
  z.object({
    format: z.literal("multi_choice"),
    prompt: z.string().min(1),
    passage: z.string().nullish(),
    options: z.array(optionSchema).min(2),
  }),
  z.object({
    format: z.literal("text_input"),
    prompt: z.string().min(1),
    passage: z.string().nullish(),
    inputKind: z.enum(["number", "string"]),
  }),
]);
export type TaskBody = z.infer<typeof taskBodySchema>;

export const taskAnswerSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("single_choice"),
    correctOptionId: z.string().min(1),
  }),
  z.object({
    format: z.literal("multi_choice"),
    correctOptionIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    format: z.literal("text_input"),
    accepted: z.array(z.string().min(1)).min(1),
    caseSensitive: z.boolean().default(false),
    tolerance: z.number().nonnegative().nullish(),
  }),
]);
export type TaskAnswer = z.infer<typeof taskAnswerSchema>;

// То, что шлёт клиент во время прохождения; answer клиенту не течёт.
export const taskResponseSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("single_choice"),
    optionId: z.string().nullable(),
  }),
  z.object({
    format: z.literal("multi_choice"),
    optionIds: z.array(z.string()),
  }),
  z.object({
    format: z.literal("text_input"),
    value: z.string().nullable(),
  }),
]);
export type TaskResponse = z.infer<typeof taskResponseSchema>;

export type NewTask = {
  type: string;
  topic: string;
  difficulty: number;
  language: string;
  body: TaskBody;
  answer: TaskAnswer;
  explanation: string;
};

// Кросс-рефайнменты между body и answer (хранятся в разных jsonb-колонках,
// поэтому не могут жить в одной discriminatedUnion): формат должен совпадать,
// а correctOptionId(s) должны существовать среди options body.
const taskPairSchema = z
  .object({ body: taskBodySchema, answer: taskAnswerSchema })
  .superRefine((pair, ctx) => {
    if (pair.body.format !== pair.answer.format) {
      ctx.addIssue({
        code: "custom",
        message: "answer.format must match body.format",
        path: ["answer", "format"],
      });
      return;
    }

    if (pair.body.format === "single_choice" && pair.answer.format === "single_choice") {
      const ids = new Set(pair.body.options.map((o) => o.id));
      if (!ids.has(pair.answer.correctOptionId)) {
        ctx.addIssue({
          code: "custom",
          message: "correctOptionId must reference an existing option",
          path: ["answer", "correctOptionId"],
        });
      }
    }

    if (pair.body.format === "multi_choice" && pair.answer.format === "multi_choice") {
      const ids = new Set(pair.body.options.map((o) => o.id));
      const missing = pair.answer.correctOptionIds.filter((id) => !ids.has(id));
      if (missing.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: "correctOptionIds must be a subset of options",
          path: ["answer", "correctOptionIds"],
        });
      }
    }
  });

export function validateTaskPair(
  body: TaskBody,
  answer: TaskAnswer,
): { body: TaskBody; answer: TaskAnswer } {
  return taskPairSchema.parse({ body, answer });
}
