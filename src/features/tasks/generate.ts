import { z } from "zod";
import type { Llm } from "@/lib/llm";
import type { ExamProfileSpec, SectionModality } from "@/features/exam-profile/spec";
import { taskAnswerSchema, taskBodySchema, validateTaskPair } from "./schema";
import { contentHash } from "./repo";
import type { NewTaskRow, StoredTask, TaskBankRepo } from "./repo";

// D2/D3/D6: бакет сборки — конкретная комбинация (секция, тип задания, тема,
// сложность), для которой в банке нужно `count` заданий. Строится в T4
// (buildPlan); здесь — только форма данных, которую принимает генерация.
// D6: modality/sectionTopics/sectionTaskTypes — контекст ВСЕЙ секции
// (не только этого бакета/темы), in-memory поля для привязки промпта к
// секции; не персистятся отдельно (задание после генерации несёт только
// bucket.topic/type/difficulty, см. requestValidTasksUnsafe -> rows ниже).
export type Bucket = {
  sectionName: string;
  type: string;
  topic: string;
  difficulty: number;
  count: number;
  modality: SectionModality;
  sectionTopics: string[];
  sectionTaskTypes: string[];
};

// D2: элемент батча = body+answer+explanation(обязателен)+difficulty(1..5),
// с кросс-рефайнментом body/answer (тот же инвариант, что и validateTaskPair
// из Task 1: формат совпадает, correctOptionId(s) существуют среди options).
const genTaskSchema = z
  .object({
    body: taskBodySchema,
    answer: taskAnswerSchema,
    explanation: z.string().min(1),
    difficulty: z.number().int().min(1).max(5),
  })
  .superRefine((task, ctx) => {
    try {
      validateTaskPair(task.body, task.answer);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "body/answer pair is invalid (format mismatch or dangling option id)",
        path: ["answer"],
      });
    }
  });

type GenTask = z.infer<typeof genTaskSchema>;

// Overshoot (D2): первый батч всегда просят на MAX_BATCH, даже если дефицит
// бакета меньше — банк греется впрок для будущих сборок.
const MAX_BATCH = 10;

const SYSTEM_PROMPT =
  "Ты — генератор заданий для подготовки к экзаменам. Отвечай ТОЛЬКО валидным JSON-массивом, без markdown и без пояснений вне JSON.";

// D6: блок привязки к секции — ноль exam-специфичных if (никаких проверок на
// конкретные названия секций/экзаменов), только данные из bucket/spec.
// sectionTopics/sectionTaskTypes — темы/типы ВСЕЙ секции (шире, чем
// bucket.topic/type этого конкретного бакета); пустой список -> строка
// пропускается, а не рендерится пустой.
function sectionAnchorBlock(bucket: Bucket): string {
  const topicsLine =
    bucket.sectionTopics.length > 0 ? `Темы секции: ${bucket.sectionTopics.join(", ")}.\n` : "";
  const typesLine =
    bucket.sectionTaskTypes.length > 0
      ? `Типы заданий секции: ${bucket.sectionTaskTypes.join(", ")}.\n`
      : "";
  return `Задание принадлежит секции "${bucket.sectionName}".
${topicsLine}${typesLine}КАЖДОЕ задание ОБЯЗАНО проверять навык именно этой секции по этой теме. ЗАПРЕЩЕНО генерировать задания из других разделов экзамена.`;
}

// D6: аудирование — задание подаётся клиенту как транскрипт (Web Speech TTS
// озвучивает body.passage, D8). Это только просьба к модели; фактический
// enforcement (дроп задания без passage) — hasRequiredPassage ниже.
function audioTranscriptBlock(examSpec: ExamProfileSpec): string {
  return `Это секция аудирования; задание подаётся как ТРАНСКРИПТ. Для КАЖДОГО задания поле body.passage ОБЯЗАТЕЛЬНО: транскрипт аудиофрагмента (диалог или монолог, 80–150 слов) на языке "${examSpec.language}". Вопрос ОБЯЗАН проверять понимание СОДЕРЖАНИЯ транскрипта; без транскрипта задание невалидно.`;
}

// Промпт строится ТОЛЬКО из спеки экзамена и бакета (D2/D6) — никаких
// экзаменных констант в коде.
function taskShapePrompt(examSpec: ExamProfileSpec, bucket: Bucket, count: number): string {
  const anchor = sectionAnchorBlock(bucket);
  const audio = bucket.modality === "audio" ? `\n${audioTranscriptBlock(examSpec)}\n` : "";

  return `Экзамен: "${examSpec.examName}" (язык контента: ${examSpec.language}).
Секция: "${bucket.sectionName}". Тип задания (таксономия экзамена): "${bucket.type}".
Тема: "${bucket.topic}". Целевая сложность (шкала 1-5): ${bucket.difficulty}.

${anchor}
${audio}
Составь РОВНО ${count} заданий. Для каждого задания сам выбери подходящий
формат из трёх: "single_choice" (один правильный вариант), "multi_choice"
(несколько правильных вариантов), "text_input" (короткий текстовый или
числовой ответ). Explanation (объяснение правильного ответа) ОБЯЗАТЕЛЬНО для
каждого задания.

Верни JSON-массив из ${count} объектов строго такой структуры:
[{
  "body": {
    "format": "single_choice" | "multi_choice" | "text_input",
    "prompt": "текст задания",
    "passage": "вспомогательный текст/отрывок или null",
    "options": [{ "id": "a", "text": "..." }, ...],  // только single_choice/multi_choice, минимум 2
    "inputKind": "number" | "string"                  // только text_input
  },
  "answer": {
    "format": "тот же format, что в body",
    "correctOptionId": "id из options",                // только single_choice
    "correctOptionIds": ["id из options", ...],         // только multi_choice, минимум 1
    "accepted": ["строка", ...],                        // только text_input, минимум 1
    "caseSensitive": true | false,                       // только text_input
    "tolerance": число или null                          // только text_input с числами
  },
  "explanation": "объяснение правильного ответа",
  "difficulty": число от 1 до 5
}]

Все задания — на языке "${examSpec.language}". Не повторяй формулировки между заданиями внутри массива.`;
}

function firstBatchPrompt(examSpec: ExamProfileSpec, bucket: Bucket): string {
  return taskShapePrompt(examSpec, bucket, MAX_BATCH);
}

function retryPrompt(examSpec: ExamProfileSpec, bucket: Bucket, deficit: number): string {
  return `${taskShapePrompt(examSpec, bucket, deficit)}

Это ДОБОР: часть заданий из предыдущей попытки не прошла проверку. Составь
ЕЩЁ ${deficit} заданий, не повторяя формулировки из предыдущей попытки.`;
}

// D6 enforcement: bucket.modality==='audio' требует body.passage ≥50
// символов после trim — не только просьба в промпте (модель иногда её
// игнорирует). Живёт вне genTaskSchema, потому что genTaskSchema не видит
// bucket (формат/кросс-рефайнмент body/answer не зависит от модальности
// секции); для modality==='text' passage остаётся полностью опциональным.
function hasRequiredPassage(body: GenTask["body"]): boolean {
  return typeof body.passage === "string" && body.passage.trim().length >= 50;
}

/**
 * Один LLM-запрос батча. Любой сбой самого запроса (непарсибельный после
 * встроенного ретрая JSON, сетевая ошибка провайдера) трактуется как «0
 * валидных заданий» — graceful degrade вместо падения всей сборки (живой
 * инцидент: SyntaxError из extractJson ронял assembleTest целиком).
 * Исключение: BudgetExceededError (кэп сборки T4) пробрасывается — это
 * управляющий сигнал assembleTest, не сбой генерации.
 */
async function requestValidTasks(
  llm: Llm,
  prompt: string,
  maxCount: number,
  bucket: Bucket,
): Promise<GenTask[]> {
  try {
    return await requestValidTasksUnsafe(llm, prompt, maxCount, bucket);
  } catch (err) {
    if (err instanceof Error && err.name === "BudgetExceededError") throw err;
    console.warn("task generation batch failed, degrading to empty batch:", err);
    return [];
  }
}

async function requestValidTasksUnsafe(
  llm: Llm,
  prompt: string,
  maxCount: number,
  bucket: Bucket,
): Promise<GenTask[]> {
  const raw = await llm.complete({
    system: SYSTEM_PROMPT,
    prompt,
    // Схема на уровне llm.complete намеренно нестрогая (D2 addendum): она
    // валидирует только форму массива (1..maxCount элементов). Каждый
    // элемент по отдельности прогоняется через genTaskSchema.safeParse ниже
    // — так один невалидный элемент не роняет весь батч (и не запускает
    // встроенный ретрай llm.complete на весь ответ, см. jsdoc ниже).
    schema: z.array(z.unknown()).min(1).max(maxCount),
    // 10 заданий с пассажами/объяснениями на русском легко превышают 8k
    // выходных токенов — обрезанный JSON не парсится вовсе (живой инцидент
    // на gemini-2.5-flash). Запас с горкой: модель отдаёт меньше — дешевле.
    maxTokens: 24_000,
  });

  const valid: GenTask[] = [];
  for (const item of raw) {
    const parsed = genTaskSchema.safeParse(item);
    if (!parsed.success) continue;
    // D6: audio-бакет — элемент без полноценного транскрипта дропается как
    // невалидный (дефицит добирает существующий одиночный ретрай ниже).
    if (bucket.modality === "audio" && !hasRequiredPassage(parsed.data.body)) continue;
    valid.push(parsed.data);
  }
  return valid;
}

/**
 * Генерирует и сохраняет задания под дефицит одного бакета (D2).
 *
 * Контракт вызова: deps.llm.complete вызывается ВСЕГДА минимум один раз при
 * каждом вызове этой функции — она не проверяет сама, «нужна ли» генерация
 * (нет внутренней логики вида «bucket.count === 0 → no-op» или «банк уже
 * тёплый → skip»). Решение звать ли generateForBucket вообще принимает
 * вызывающая сторона (T4 assembleTest: она вызывает generate только после
 * select банка, когда реально есть дефицит). Поэтому «тёплый банк не
 * генерирует» — это свойство T4, а не этой функции.
 *
 * Максимум ДВА вызова deps.llm.complete за вызов (батч на MAX_BATCH + не
 * более одного ретрая на дефицит); общий кэп «≤3 вызова на сборку теста»
 * живёт в T4 (там же складываются вызовы разных бакетов), не здесь.
 *
 * Невалидные элементы батча дропаются поэлементно (не роняют весь батч).
 * Если после первого батча валидных меньше bucket.count — ровно один
 * повторный запрос на дефицит; если и после него недобор — возвращается
 * то, что есть (graceful degrade, без throw).
 */
export async function generateForBucket(
  deps: { llm: Llm; repo: TaskBankRepo },
  examSpec: ExamProfileSpec,
  examProfileId: string,
  bucket: Bucket,
): Promise<StoredTask[]> {
  let valid = await requestValidTasks(deps.llm, firstBatchPrompt(examSpec, bucket), MAX_BATCH, bucket);

  if (valid.length < bucket.count) {
    const deficit = Math.min(MAX_BATCH, Math.max(1, bucket.count - valid.length));
    const retryValid = await requestValidTasks(
      deps.llm,
      retryPrompt(examSpec, bucket, deficit),
      deficit,
      bucket,
    );
    valid = valid.concat(retryValid);
  }

  if (valid.length === 0) return [];

  // Бакет — источник истины для type/topic/difficulty (D2/D3): findBucket
  // ищет задания по точному совпадению этой тройки, поэтому сохраняем
  // именно bucket.difficulty, а не самоприписанную LLM difficulty элемента
  // (та существовала только чтобы заставить модель явно её обозначить).
  const rows: NewTaskRow[] = valid.map((task) => ({
    type: bucket.type,
    topic: bucket.topic,
    difficulty: bucket.difficulty,
    language: examSpec.language,
    body: task.body,
    answer: task.answer,
    explanation: task.explanation,
    contentHash: contentHash(task.body),
    examProfileId,
    origin: "ai",
  }));

  const { inserted } = await deps.repo.insertMany(rows);
  return inserted;
}
