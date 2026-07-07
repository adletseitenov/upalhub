import { z } from "zod";

export const examSectionSchema = z.object({
  name: z.string().min(1),
  taskCount: z.number().int().positive().nullish(),
  timeLimitMinutes: z.number().positive().nullish(),
  taskTypes: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
});

export const examProfileSpecSchema = z.object({
  examName: z.string().min(1),
  language: z.string().min(2), // основной язык экзамена: "ru", "kk", "en", ...
  country: z.string().nullish(),
  description: z.string().min(1),
  sections: z.array(examSectionSchema).min(1),
  scoring: z.object({
    scaleMin: z.number(),
    scaleMax: z.number(),
    passingScore: z.number().nullish(),
    unit: z.string().min(1), // «баллов», «band», ...
  }),
  totalTimeMinutes: z.number().positive().nullish(),
  typicalDates: z.string().nullish(),
});

export type ExamProfileSpec = z.infer<typeof examProfileSpecSchema>;

export const sourceRefSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;
