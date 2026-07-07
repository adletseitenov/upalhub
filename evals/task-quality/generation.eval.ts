import { describe, expect, it, beforeAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createLlm, type Llm } from "@/lib/llm";
import type { ExamProfileSpec } from "@/features/exam-profile/spec";
import { generateForBucket, type Bucket } from "@/features/tasks/generate";
import type { NewTaskRow, StoredTask, TaskBankRepo } from "@/features/tasks/repo";

// Stage 2.5 Task 9 — «обещание максимального качества»: живой eval (вне CI,
// паттерн evals/live-smoke), который генерирует задания живым LLM для трёх
// фикстур-профилей (БЕЗ обращения к БД — repo ниже in-memory fake) и
// прогоняет КАЖДОЕ задание через LLM-судью (промпт судьи ОТДЕЛЬНЫЙ от
// генераторского в src/features/tasks/generate.ts) по 4 бинарным критериям.
// Сравнивает google/gemini-2.5-flash, google/gemini-2.5-pro и qwen-plus как
// модель генерации; судья — ВСЕГДА google/gemini-2.5-pro (постоянный эталон,
// иначе сравнение «модель судит сама себя» несопоставимо между прогонами).
//
// Единственный hard-gate — flash.onTopicRate >= 0.8 (цель плана после
// T2-промптов секционной привязки). Все остальные метрики — замер: при <80%
// пишем console.warn, но НЕ роняем прогон (первый прогон = baseline, не gate).
// Отдельно репортится languageOk по КАЗАХСКОЙ фикстуре (ent-math-kk):
// казахский — потенциально слабое место qwen-линейки, основателю критично.

// Каждая позиция — цепочка кандидатов id: берётся ПЕРВЫЙ, ответивший на
// probe-вызов. Плоского `qwen/qwen-plus` на OpenRouter нет (проверено по
// /api/v1/models, 2026-07-08) — фолбэк на новейший plus-алиас qwen3-линейки.
const GENERATION_MODEL_CANDIDATES: readonly string[][] = [
  ["google/gemini-2.5-flash"],
  ["google/gemini-2.5-pro"],
  ["qwen/qwen-plus", "qwen/qwen3.7-plus"],
];
const JUDGE_MODEL = "google/gemini-2.5-pro";
// Фикстура, по которой languageOk репортится отдельно (см. коммент выше).
const KK_FIXTURE_KEY = "ent-math-kk";
// Fake-repo id — никогда не читается из БД (insertMany/findBucket ниже
// целиком in-memory), нужен только чтобы NewTaskRow.examProfileId был непустым.
const EVAL_PROFILE_ID = "eval-task-quality";

const OUT_DIR = join(process.cwd(), "evals", "task-quality", "out");

beforeAll(() => {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // ключи должны быть в окружении (CI/прод) — молча продолжаем
  }
  mkdirSync(OUT_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// In-memory TaskBankRepo (задание требует «БЕЗ обращения к БД»): findBucket
// всегда пуст (эта сборка не переиспользует тёплый банк — каждый бакет здесь
// генерируется с нуля), insertMany просто копит строки в массиве и присваивает
// последовательный id. Идентичен fakeRepo() из src/features/tasks/generate.test.ts.
// ---------------------------------------------------------------------------
function fakeRepo(): TaskBankRepo & { rows: NewTaskRow[] } {
  const rows: NewTaskRow[] = [];
  let nextId = 1;
  return {
    rows,
    async findBucket() {
      return [];
    },
    async insertMany(newRows) {
      const inserted: StoredTask[] = [];
      for (const row of newRows) {
        rows.push(row);
        inserted.push({
          id: String(nextId++),
          type: row.type,
          topic: row.topic,
          difficulty: row.difficulty,
          language: row.language,
          body: row.body,
          answer: row.answer,
          explanation: row.explanation,
        });
      }
      return { inserted, skipped: 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// Фикстуры-профили — три реальных сценария D6 (секционная привязка +
// audio-транскрипт), по одному бакету на каждый. Языки нарочно разные
// (kk/en/ru), чтобы languageOk-критерий судьи покрывал все три языка
// интерфейса U-Pal одним прогоном.
// ---------------------------------------------------------------------------

type FixtureCase = { key: string; label: string; spec: ExamProfileSpec; bucket: Bucket };

// (а) ЕНТ-математика — text-модальность. ЕНТ реально сдаётся на ru ИЛИ kk;
// здесь фиксируем kk (ru уже покрыт фикстурой (в) ниже), чтобы три фикстуры
// вместе покрывали ru+kk+en без раздувания числа бакетов/LLM-вызовов.
const entMathSpec: ExamProfileSpec = {
  examName: "Единое национальное тестирование (ЕНТ)",
  language: "kk",
  country: "Казахстан",
  description: "ЕНТ — отборочный экзамен для поступления в вузы Казахстана.",
  sections: [
    {
      name: "Математика",
      taskCount: 20,
      timeLimitMinutes: null,
      taskTypes: ["есептеу есебі", "тест сұрағы"],
      topics: ["Уравнения", "Функции"],
      modality: "text",
    },
  ],
  variants: [],
  selectionGroups: [],
  scoring: { scaleMin: 0, scaleMax: 140, passingScore: 50, unit: "балл" },
  totalTimeMinutes: 180,
  typicalDates: null,
};

const entMathBucket: Bucket = {
  sectionName: "Математика",
  type: "algebra",
  topic: "Уравнения",
  difficulty: 3,
  count: 5,
  modality: "text",
  sectionTopics: ["Уравнения", "Функции"],
  sectionTaskTypes: ["есептеу есебі", "тест сұрағы"],
};

// (б) IELTS Listening — audio-модальность (D6 требует body.passage-транскрипт
// 80–150 слов; passageAnswerable-критерий судьи проверяет именно это).
const ieltsListeningSpec: ExamProfileSpec = {
  examName: "IELTS Academic",
  language: "en",
  country: null,
  description: "International English Language Testing System — Academic module.",
  sections: [
    {
      name: "Listening",
      taskCount: 40,
      timeLimitMinutes: 30,
      taskTypes: ["multiple_choice", "note_completion"],
      topics: ["Everyday conversations", "Academic lectures"],
      modality: "audio",
    },
  ],
  variants: [],
  selectionGroups: [],
  scoring: { scaleMin: 0, scaleMax: 9, unit: "band" },
  totalTimeMinutes: null,
  typicalDates: null,
};

const ieltsListeningBucket: Bucket = {
  sectionName: "Listening",
  type: "multiple_choice",
  topic: "Everyday conversations",
  difficulty: 3,
  count: 5,
  modality: "audio",
  sectionTopics: ["Everyday conversations", "Academic lectures"],
  sectionTaskTypes: ["multiple_choice", "note_completion"],
};

// (в) НИШ-вариант — многовариантный экзамен (D4), бакет из гуманитарной
// секции ("История", входит в вариант "humanities", НЕ в "phys-math").
const nisHumanitiesSpec: ExamProfileSpec = {
  examName: "NIS — вступительный тест",
  language: "ru",
  country: "Казахстан",
  description: "Экзамен для поступления в Назарбаев Интеллектуальные школы.",
  sections: [
    { name: "Критическое мышление", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] },
    {
      name: "История",
      taskCount: null,
      timeLimitMinutes: null,
      taskTypes: ["выбор одного ответа", "работа с историческим источником"],
      topics: ["История Казахстана", "Всемирная история"],
    },
    { name: "Английский язык", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] },
    { name: "Физика", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] },
    { name: "Химия", taskCount: null, timeLimitMinutes: null, taskTypes: [], topics: [] },
  ],
  variants: [
    {
      key: "humanities",
      label: "Гуманитарное направление",
      sectionNames: ["Критическое мышление", "История", "Английский язык"],
    },
    {
      key: "phys-math",
      label: "Физико-математическое направление",
      sectionNames: ["Критическое мышление", "Физика", "Химия"],
    },
  ],
  selectionGroups: [],
  scoring: { scaleMin: 0, scaleMax: 100, unit: "балл" },
  totalTimeMinutes: null,
  typicalDates: null,
};

const nisHumanitiesBucket: Bucket = {
  sectionName: "История",
  type: "source_analysis",
  topic: "История Казахстана",
  difficulty: 3,
  count: 5,
  modality: "text",
  sectionTopics: ["История Казахстана", "Всемирная история"],
  sectionTaskTypes: ["выбор одного ответа", "работа с историческим источником"],
};

const FIXTURES: FixtureCase[] = [
  { key: "ent-math-kk", label: "ЕНТ · Математика (kk, text)", spec: entMathSpec, bucket: entMathBucket },
  {
    key: "ielts-listening-en",
    label: "IELTS · Listening (en, audio)",
    spec: ieltsListeningSpec,
    bucket: ieltsListeningBucket,
  },
  {
    key: "nis-humanities-ru",
    label: "NIS · История, гуманитарный вариант (ru, text)",
    spec: nisHumanitiesSpec,
    bucket: nisHumanitiesBucket,
  },
];

// ---------------------------------------------------------------------------
// LLM-судья — промпт СОЗНАТЕЛЬНО отдельный от генераторского SYSTEM_PROMPT
// (src/features/tasks/generate.ts): судья не генерирует, только проверяет
// готовое задание по рубрике из плана Task 9.
// ---------------------------------------------------------------------------

const judgeVerdictSchema = z.object({
  onTopic: z.boolean(),
  keyCorrect: z.boolean(),
  languageOk: z.boolean(),
  passageAnswerable: z.boolean(),
  reasoning: z.string().max(300),
});
type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

const JUDGE_SYSTEM_PROMPT =
  "Ты — независимый эксперт-экзаменатор. Твоя ЕДИНСТВЕННАЯ задача — проверить уже готовое экзаменационное задание по рубрике и вернуть строгий JSON-вердикт. Ты НИКОГДА не генерируешь и не переписываешь задания — только оцениваешь существующее. Будь придирчив: любое сомнение в фактической точности ключа ответа — keyCorrect:false. Отвечай ТОЛЬКО валидным JSON-объектом, без markdown и пояснений вне JSON.";

function judgePrompt(examSpec: ExamProfileSpec, bucket: Bucket, task: StoredTask): string {
  const passageNote =
    bucket.modality === "audio"
      ? `Это задание аудирования: body.passage — транскрипт, который ученик СЛЫШИТ (не видит). passageAnswerable = true ТОЛЬКО если на вопрос можно ответить, опираясь ИСКЛЮЧИТЕЛЬНО на содержание passage, без внешних знаний. Пустой/отсутствующий passage или вопрос, требующий знаний вне passage, — passageAnswerable:false.`
      : `Это текстовое (не аудио) задание секции — критерий passageAnswerable к нему неприменим, всегда верни true.`;

  return `Экзамен: "${examSpec.examName}" (язык контента: "${examSpec.language}").
Секция: "${bucket.sectionName}". Модальность секции: "${bucket.modality}".
Тема бакета (ожидаемая): "${bucket.topic}". Все темы секции: ${bucket.sectionTopics.join(", ") || "—"}.

Оцени СЛЕДУЮЩЕЕ готовое задание по 4 критериям:
1. onTopic — вопрос проверяет навык именно секции "${bucket.sectionName}" (по теме "${bucket.topic}" или любой другой теме ЭТОЙ секции), а НЕ постороннего раздела экзамена.
2. keyCorrect — правильный ответ (answer) действительно корректен и однозначен для данного prompt/passage; explanation не противоречит answer и не содержит фактических ошибок.
3. languageOk — prompt/passage/options/explanation написаны на языке "${examSpec.language}" (единичные термины/имена собственные на другом языке не считаются нарушением).
4. passageAnswerable — ${passageNote}

Задание (JSON, answer клиенту в проде НЕ показывается, но тебе нужен для проверки):
${JSON.stringify({ body: task.body, answer: task.answer, explanation: task.explanation }, null, 2)}

Верни JSON строго такой структуры:
{"onTopic": true|false, "keyCorrect": true|false, "languageOk": true|false, "passageAnswerable": true|false, "reasoning": "краткое объяснение вердикта (макс. 300 символов), обязательно если хоть один критерий false"}`;
}

// maxTokens 8000, НЕ 1000: gemini-2.5-pro — reasoning-модель, у OpenRouter
// max_tokens покрывает и reasoning-токены; при 1000 бюджет съедался
// размышлениями и content приходил без JSON («no JSON found» — живой
// инцидент первого прогона этого eval).
async function judgeStoredTask(
  judgeLlm: Llm,
  examSpec: ExamProfileSpec,
  bucket: Bucket,
  task: StoredTask,
): Promise<JudgeVerdict> {
  return judgeLlm.complete({
    system: JUDGE_SYSTEM_PROMPT,
    prompt: judgePrompt(examSpec, bucket, task),
    schema: judgeVerdictSchema,
    maxTokens: 8000,
  });
}

// Провал ОДНОГО судейского вызова (после встроенного ретрая адаптера) не
// должен ронять отчёт всей модели: null-вердикт исключается из знаменателя
// метрик и считается отдельно как judgeErrors.
async function judgeStoredTaskSafe(
  judgeLlm: Llm,
  examSpec: ExamProfileSpec,
  bucket: Bucket,
  task: StoredTask,
): Promise<JudgeVerdict | null> {
  try {
    return await judgeStoredTask(judgeLlm, examSpec, bucket, task);
  } catch (err) {
    console.warn(
      `судья не вынес вердикт (задание пропущено из метрик): ${err instanceof Error ? err.message.slice(0, 200) : err}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Генерация (одна модель на прогон, задаётся через env override — createLlm
// читает LLM_MODEL, см. src/lib/llm/index.ts) + судейство каждого задания.
// ---------------------------------------------------------------------------

type JudgedTask = {
  fixtureKey: string;
  fixtureLabel: string;
  task: StoredTask;
  verdict: JudgeVerdict | null; // null = судья упал, исключено из метрик
};

async function generateAndJudgeFixture(
  genLlm: Llm,
  judgeLlm: Llm,
  fixture: FixtureCase,
): Promise<JudgedTask[]> {
  const repo = fakeRepo();
  const tasks = await generateForBucket(
    { llm: genLlm, repo },
    fixture.spec,
    EVAL_PROFILE_ID,
    fixture.bucket,
  );
  return Promise.all(
    tasks.map(async (task) => ({
      fixtureKey: fixture.key,
      fixtureLabel: fixture.label,
      task,
      verdict: await judgeStoredTaskSafe(judgeLlm, fixture.spec, fixture.bucket, task),
    })),
  );
}

type Scored = JudgedTask & { verdict: JudgeVerdict };

type FixtureBreakdown = { fixture: string; n: number; languageOkRate: number };

type ModelReport = {
  model: string;
  requestedAs: string; // первый кандидат цепочки (что просил основатель)
  n: number; // всего сгенерировано
  judgeErrors: number; // заданий без вердикта (исключены из знаменателя)
  onTopicRate: number;
  keyCorrectRate: number;
  languageOkRate: number;
  passageAnswerableRate: number;
  languageOkByFixture: FixtureBreakdown[];
  judged: JudgedTask[];
};

function scored(judged: JudgedTask[]): Scored[] {
  return judged.filter((j): j is Scored => j.verdict !== null);
}

function rate(items: Scored[], pick: (v: JudgeVerdict) => boolean): number {
  if (items.length === 0) return 0;
  return items.filter((j) => pick(j.verdict)).length / items.length;
}

function languageOkByFixture(items: Scored[]): FixtureBreakdown[] {
  return FIXTURES.map((fixture) => {
    const own = items.filter((j) => j.fixtureKey === fixture.key);
    return { fixture: fixture.key, n: own.length, languageOkRate: rate(own, (v) => v.languageOk) };
  });
}

// Probe: крошечный запрос по каждому кандидату цепочки, берём первый живой id.
// Дешёвая страховка от «модель молча дала 0 заданий»: generateForBucket
// деградирует ЛЮБУЮ ошибку генерации в пустой батч, поэтому несуществующий
// model id без probe выглядел бы как n=0, а не как ошибка конфигурации.
const probeSchema = z.object({ ok: z.boolean() });

async function resolveModel(candidates: readonly string[]): Promise<string | null> {
  for (const model of candidates) {
    try {
      const llm = createLlm({ ...process.env, LLM_MODEL: model });
      await llm.complete({
        prompt: 'Верни JSON {"ok": true} и ничего больше.',
        schema: probeSchema,
        maxTokens: 2000,
      });
      return model;
    } catch (err) {
      console.warn(
        `кандидат "${model}" недоступен (probe failed): ${err instanceof Error ? err.message.slice(0, 200) : err}`,
      );
    }
  }
  return null;
}

async function evaluateModel(model: string, requestedAs: string, judgeLlm: Llm): Promise<ModelReport> {
  const genLlm = createLlm({ ...process.env, LLM_MODEL: model });
  // Последовательно (не Promise.all): если первая фикстура дала 0 заданий —
  // модель фактически нежива (probe прошёл, но генерация возвращает пустое,
  // живой случай: qwen-алиас с null-контентом) — снимаем её с прогона сразу,
  // не сжигая таймаут на остальных фикстурах и их ретраях.
  const perFixture: Awaited<ReturnType<typeof generateAndJudgeFixture>>[] = [];
  for (const fixture of FIXTURES) {
    const judgedFixture = await generateAndJudgeFixture(genLlm, judgeLlm, fixture);
    perFixture.push(judgedFixture);
    if (perFixture.length === 1 && judgedFixture.length === 0) {
      console.warn(
        `модель "${model}": первая фикстура дала 0 заданий — считаю модель неживой, снимаю с прогона`,
      );
      break;
    }
  }
  const judged = perFixture.flat();
  const withVerdict = scored(judged);
  return {
    model,
    requestedAs,
    n: judged.length,
    judgeErrors: judged.length - withVerdict.length,
    onTopicRate: rate(withVerdict, (v) => v.onTopic),
    keyCorrectRate: rate(withVerdict, (v) => v.keyCorrect),
    languageOkRate: rate(withVerdict, (v) => v.languageOk),
    passageAnswerableRate: rate(withVerdict, (v) => v.passageAnswerable),
    languageOkByFixture: languageOkByFixture(withVerdict),
    judged,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function isFailure(v: JudgeVerdict): boolean {
  return !v.onTopic || !v.keyCorrect || !v.languageOk || !v.passageAnswerable;
}

function printReport(report: ModelReport) {
  console.log(`\n=== ${report.model}${report.model !== report.requestedAs ? ` (запрошена как ${report.requestedAs})` : ""} ===`);
  console.log(
    `N=${report.n}  judgeErrors=${report.judgeErrors}  onTopic=${pct(report.onTopicRate)}  ` +
      `keyCorrect=${pct(report.keyCorrectRate)}  languageOk=${pct(report.languageOkRate)}  ` +
      `passageAnswerable=${pct(report.passageAnswerableRate)}`,
  );
  for (const fb of report.languageOkByFixture) {
    const mark = fb.fixture === KK_FIXTURE_KEY ? " <- KK (критично основателю)" : "";
    console.log(`  languageOk[${fb.fixture}] = ${pct(fb.languageOkRate)} (n=${fb.n})${mark}`);
  }
  const failures = scored(report.judged).filter((j) => isFailure(j.verdict));
  if (failures.length === 0) {
    console.log("провалов не найдено");
    return;
  }
  console.log(`провалы: ${failures.length}/${report.n}, примеры (до 2):`);
  for (const f of failures.slice(0, 2)) {
    console.log(`  [${f.fixtureLabel}] ${f.verdict.reasoning}`);
  }
}

function warnIfBelow80(model: string, metric: string, value: number) {
  if (value < 0.8) {
    console.warn(`${model}: ${metric} = ${pct(value)} < 80% — замер первого прогона, не fail`);
  }
}

describe("task generation quality eval (live, llm judge)", () => {
  it(
    "compares gemini-2.5-flash vs gemini-2.5-pro vs qwen-plus as the generation model",
    async () => {
      const judgeLlm = createLlm({ ...process.env, LLM_MODEL: JUDGE_MODEL });

      const reports: ModelReport[] = [];
      for (const candidates of GENERATION_MODEL_CANDIDATES) {
        const requestedAs = candidates[0];
        const model = await resolveModel(candidates);
        if (!model) {
          console.warn(
            `TODO: ни один кандидат из [${candidates.join(", ")}] недоступен — модель пропущена, повторить когда появится`,
          );
          continue;
        }
        try {
          const report = await evaluateModel(model, requestedAs, judgeLlm);
          reports.push(report);
          printReport(report);
        } catch (err) {
          // D-fix (план, Task 9 notes): модель недоступна/дорогая ошибка ->
          // документируем и продолжаем с остальными, а не роняем весь прогон.
          console.error(`модель "${model}" упала при генерации/судействе, пропускаю:`, err);
        }
      }

      expect(reports.length).toBeGreaterThan(0);

      writeFileSync(
        join(OUT_DIR, "report.json"),
        JSON.stringify(
          reports.map((r) => ({
            model: r.model,
            requestedAs: r.requestedAs,
            n: r.n,
            judgeErrors: r.judgeErrors,
            onTopicRate: r.onTopicRate,
            keyCorrectRate: r.keyCorrectRate,
            languageOkRate: r.languageOkRate,
            passageAnswerableRate: r.passageAnswerableRate,
            languageOkByFixture: r.languageOkByFixture,
            failures: scored(r.judged)
              .filter((j) => isFailure(j.verdict))
              .map((j) => ({ fixture: j.fixtureLabel, reasoning: j.verdict.reasoning })),
          })),
          null,
          2,
        ),
        "utf8",
      );

      const flash = reports.find((r) => r.model === "google/gemini-2.5-flash");
      if (flash) {
        // Единственный hard-gate плана (D6/Task 9 acceptance): ≥80% "по теме
        // секции" на flash после T2-промптов секционной привязки.
        expect(flash.onTopicRate).toBeGreaterThanOrEqual(0.8);
      } else {
        console.warn(
          "TODO: google/gemini-2.5-flash не оценена (ошибка генерации/судьи) — см. лог выше, повторить прогон",
        );
      }

      // Мягкие метрики всех моделей (включая flash, кроме её hard-gate выше):
      // console.warn при <80%, НЕ fail — первый прогон это замер.
      for (const report of reports) {
        if (report.model !== "google/gemini-2.5-flash") {
          warnIfBelow80(report.model, "onTopicRate", report.onTopicRate);
        }
        warnIfBelow80(report.model, "keyCorrectRate", report.keyCorrectRate);
        warnIfBelow80(report.model, "languageOkRate", report.languageOkRate);
        warnIfBelow80(report.model, "passageAnswerableRate", report.passageAnswerableRate);
      }
    },
    // 3 модели × 3 фикстуры × (генерация ≤2 вызова + 10 судейских) — живой
    // прогон легко переваливает за 10 минут при медленных провайдерах.
    900_000,
  );
});
