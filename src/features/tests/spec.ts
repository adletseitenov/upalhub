// D3: замороженная спека собранного теста (tests.spec). Пишется один раз при
// сборке (assembleTest) и больше никогда не меняется — детерминизм скоринга
// переживает последующий refine exam-profile (snapshot, не ссылка).
import { z } from "zod";
import { sectionModalitySchema } from "@/features/exam-profile/spec";
import { scoringSnapshotSchema } from "./scoring";

export const testKindSchema = z.enum(["diagnostic", "practice", "mock"]);
export type TestKind = z.infer<typeof testKindSchema>;

const testSectionSchema = z.object({
  name: z.string().min(1),
  taskIds: z.array(z.string()),
  // D5 freeze: план по секции на момент сборки (Σ bucket.count секции, ПО
  // ИНДЕКСУ секции, не по имени) — переживает refill/partial-сборку.
  plannedCount: z.number().int().nonnegative().nullish(),
  // D5/D8 freeze: модальность секции на момент сборки (снапшот из
  // exam-profile spec, absent = text).
  modality: sectionModalitySchema.nullish(),
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
  // D5: счётчик пересборок («Дособрать») — ротация round-robin офсета при
  // reassembleTest и признак «без прогресса» после refill (T4/T6).
  refillCount: z.number().int().nonnegative().nullish(),
});
export type TestSpec = z.infer<typeof testSpecSchema>;
