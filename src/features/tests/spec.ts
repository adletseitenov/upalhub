// D3: замороженная спека собранного теста (tests.spec). Пишется один раз при
// сборке (assembleTest) и больше никогда не меняется — детерминизм скоринга
// переживает последующий refine exam-profile (snapshot, не ссылка).
import { z } from "zod";
import { scoringSnapshotSchema } from "./scoring";

export const testKindSchema = z.enum(["diagnostic", "practice", "mock"]);
export type TestKind = z.infer<typeof testKindSchema>;

const testSectionSchema = z.object({
  name: z.string().min(1),
  taskIds: z.array(z.string()),
});

export const testSpecSchema = z.object({
  version: z.literal(1),
  kind: testKindSchema,
  language: z.string().min(2),
  sections: z.array(testSectionSchema),
  // Плоский канонический порядок — конкатенация sections[].taskIds, distinct.
  taskIds: z.array(z.string()),
  totalTimeMinutes: z.number().positive().nullish(),
  scoringSnapshot: scoringSnapshotSchema,
});
export type TestSpec = z.infer<typeof testSpecSchema>;
