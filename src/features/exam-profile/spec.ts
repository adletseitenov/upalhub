import { z } from "zod";

// D2: audio-секции (напр. Listening) требуют Web Speech воспроизведения
// (этап Stage 2.5, D8) — absent модальность трактуется как "text" (обратная
// совместимость со всеми старыми профилями).
export const sectionModalitySchema = z.enum(["text", "audio"]);
export type SectionModality = z.infer<typeof sectionModalitySchema>;

export const examSectionSchema = z.object({
  name: z.string().min(1),
  taskCount: z.number().int().positive().nullish(),
  timeLimitMinutes: z.number().positive().nullish(),
  taskTypes: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  modality: sectionModalitySchema.nullish(), // absent = text
});
export type ExamSection = z.infer<typeof examSectionSchema>;

// D2/D4: взаимоисключающий набор секций экзамена (напр. НИШ
// физ-мат/хим-био профили). sectionNames — референсы по имени секции
// (sections[] не переструктурируем, см. Global Constraints).
export const examVariantSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  sectionNames: z.array(z.string()).min(1),
});
export type ExamVariant = z.infer<typeof examVariantSchema>;

// D2/D4: «выбери ровно chooseCount из sectionNames» (напр. ЕНТ профильные
// предметы). Может быть вложена в один/несколько вариантов или ортогональна
// им (см. selection.ts).
export const selectionGroupSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  chooseCount: z.number().int().positive(),
  sectionNames: z.array(z.string()).min(2),
});
export type SelectionGroup = z.infer<typeof selectionGroupSchema>;

export const examProfileSpecSchema = z
  .object({
    examName: z.string().min(1),
    language: z.string().min(2), // основной язык экзамена: "ru", "kk", "en", ...
    country: z.string().nullish(),
    description: z.string().min(1),
    sections: z.array(examSectionSchema).min(1),
    // D2/D4: аддитивно — старые профили без variants/selectionGroups парсятся
    // (дефолт []), визард трактует пустые массивы как "плоский" экзамен.
    variants: z.array(examVariantSchema).default([]),
    selectionGroups: z.array(selectionGroupSchema).default([]),
    scoring: z.object({
      scaleMin: z.number(),
      scaleMax: z.number(),
      passingScore: z.number().nullish(),
      unit: z.string().min(1), // «баллов», «band», ...
      step: z.number().positive().nullish(), // шаг округления шкалы (D5); опционально, старые профили парсятся
    }),
    totalTimeMinutes: z.number().positive().nullish(),
    typicalDates: z.string().nullish(),
  })
  .superRefine((spec, ctx) => {
    // (a) sections[].name уникальны — закрывает и Minor этапа 2 про дубли.
    // Новое правило: применяется при research/refine-валидации НОВЫХ спек;
    // существующие тестовые фикстуры дублей не имеют (см. Task 1 notes).
    const seen = new Set<string>();
    spec.sections.forEach((section, i) => {
      if (seen.has(section.name)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate section name: "${section.name}"`,
          path: ["sections", i, "name"],
        });
      }
      seen.add(section.name);
    });
    const sectionNames = new Set(spec.sections.map((s) => s.name));

    // (b) variants[].sectionNames ⊆ sections[].name.
    spec.variants.forEach((variant, i) => {
      variant.sectionNames.forEach((name, j) => {
        if (!sectionNames.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `variants[${i}] ("${variant.key}") references unknown section "${name}"`,
            path: ["variants", i, "sectionNames", j],
          });
        }
      });
    });

    // (b) selectionGroups[].sectionNames ⊆ sections[].name;
    // (c) chooseCount <= |group.sectionNames| — базовая проверка выполнимости
    // ВНЕ контекста конкретного варианта. Деградация группы относительно
    // ОДНОГО варианта (|group ∩ variant| < chooseCount) — это НЕ ошибка
    // целостности спеки: визард деградирует группу в рантайме (D1), поэтому
    // здесь намеренно НЕ проверяется.
    spec.selectionGroups.forEach((group, i) => {
      group.sectionNames.forEach((name, j) => {
        if (!sectionNames.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `selectionGroups[${i}] ("${group.key}") references unknown section "${name}"`,
            path: ["selectionGroups", i, "sectionNames", j],
          });
        }
      });
      if (group.chooseCount > group.sectionNames.length) {
        ctx.addIssue({
          code: "custom",
          message: `selectionGroups[${i}] ("${group.key}") chooseCount (${group.chooseCount}) exceeds its section count (${group.sectionNames.length})`,
          path: ["selectionGroups", i, "chooseCount"],
        });
      }
    });

    // Backlog wave fix5: variants[].key / selectionGroups[].key are used as
    // lookup keys (spec.variants.find(v => v.key === config.variantKey),
    // and to identify a group in error messages/resolveActiveSections'
    // group loop) — a duplicate key makes `.find` silently pick the FIRST
    // match, hiding the other one. sectionNames WITHIN a single group must
    // also be unique: resolveActiveSections/validateHqConfig both build
    // `new Set(group.sectionNames)`-shaped pools, so a duplicate name would
    // silently collapse without ever surfacing as a spec error.
    const variantKeysSeen = new Set<string>();
    spec.variants.forEach((variant, i) => {
      if (variantKeysSeen.has(variant.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate variant key: "${variant.key}"`,
          path: ["variants", i, "key"],
        });
      }
      variantKeysSeen.add(variant.key);
    });

    const groupKeysSeen = new Set<string>();
    spec.selectionGroups.forEach((group, i) => {
      if (groupKeysSeen.has(group.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate selectionGroups key: "${group.key}"`,
          path: ["selectionGroups", i, "key"],
        });
      }
      groupKeysSeen.add(group.key);

      const namesSeen = new Set<string>();
      group.sectionNames.forEach((name, j) => {
        if (namesSeen.has(name)) {
          ctx.addIssue({
            code: "custom",
            message: `selectionGroups[${i}] ("${group.key}") has duplicate sectionNames: "${name}"`,
            path: ["selectionGroups", i, "sectionNames", j],
          });
        }
        namesSeen.add(name);
      });
    });
  });

export type ExamProfileSpec = z.infer<typeof examProfileSpecSchema>;

export const sourceRefSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  title: z.string(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;
