import type { Llm } from "@/lib/llm";
import type { ExamProfileSpec } from "@/features/exam-profile/spec";
import type { StoredExamProfile } from "@/features/exam-profile/service";
import { generateForBucket, type Bucket } from "@/features/tasks/generate";
import type { StoredTask, TaskBankRepo } from "@/features/tasks/repo";
import { testSpecSchema } from "./spec";
import type { TestKind, TestSpec } from "./spec";
import type { StoredTest, TestRepo } from "./repo";

// D3 квоты.
const DIAGNOSTIC_CAP = 12;
const PRACTICE_MOCK_DEFAULT_COUNT = 8;
// Сложность-band по kind сознательно не вводим (YAGNI, см. Task 4 brief) —
// середина шкалы 1..5 (см. Task 3 genTaskSchema) для всех бакетов сборки.
const FIXED_DIFFICULTY = 3;

/**
 * Делит `total` на `n` частей поровну, остаток раздаёт первым частям.
 * При `n > total` — первые `total` частей получают по 1, остальные 0
 * (используется и для распределения diagnostic-капа по секциям, и для
 * распределения count секции по её topics — единая формула для обоих
 * случаев из D3).
 */
function distribute(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const remainder = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * buildPlan (D3): спека экзамена -> список бакетов сборки. Толерантна к
 * отсутствию topics/taskTypes/taskCount/timeLimit — ни одно опциональное
 * поле спеки не роняет сборку.
 */
export function buildPlan(spec: ExamProfileSpec, kind: TestKind): Bucket[] {
  const sectionCounts =
    kind === "diagnostic"
      ? distribute(DIAGNOSTIC_CAP, spec.sections.length)
      : spec.sections.map((section) => section.taskCount ?? PRACTICE_MOCK_DEFAULT_COUNT);

  const buckets: Bucket[] = [];

  spec.sections.forEach((section, sectionIdx) => {
    const sectionCount = sectionCounts[sectionIdx];
    if (sectionCount <= 0) return;

    const type = section.taskTypes[0] ?? "default";
    const topics = section.topics.length > 0 ? section.topics : [section.name];
    const topicCounts = distribute(sectionCount, topics.length);

    topics.forEach((topic, topicIdx) => {
      const count = topicCounts[topicIdx];
      if (count <= 0) return;
      buckets.push({ sectionName: section.name, type, topic, difficulty: FIXED_DIFFICULTY, count });
    });
  });

  return buckets;
}

const MAX_LLM_CALLS_PER_ASSEMBLY = 3;

// Обёртка над Llm, которая считает ФАКТИЧЕСКИЕ вызовы .complete (не вызовы
// generateForBucket — та может сделать 1 или 2 за бакет) и бросает после
// того, как бюджет исчерпан. assembleTest ловит эту ошибку как грациозный
// стоп генерации (см. jsdoc на assembleTest) — не меняя сигнатуру
// generateForBucket.
class BudgetExceededError extends Error {
  constructor() {
    super("llm generation budget exceeded for this test assembly");
    this.name = "BudgetExceededError";
  }
}

function budgetedLlm(llm: Llm, max: number): Llm {
  let used = 0;
  return {
    async complete(completeArgs) {
      if (used >= max) throw new BudgetExceededError();
      used += 1;
      return llm.complete(completeArgs);
    },
  };
}

/**
 * assembleTest (D3): buildPlan -> select банка по каждому бакету (exact
 * difficulty=FIXED_DIFFICULTY) -> на недобор релакс-фолбэк select с
 * difficulty=null (подхватывает импортированные/сгенерированные задания вне
 * FIXED_DIFFICULTY, acceptance 2.5) -> на оставшийся дефицит генерация
 * (суммарно ≤3 фактических llm.complete на всю сборку, считая через
 * budgetedLlm, а не через число вызовов generateForBucket) -> re-select ->
 * distinct taskIds по секциям -> заморозка spec (снапшот scoring на момент
 * сборки, не ссылка) -> testRepo.insertTest.
 *
 * Исчерпание бюджета — не ошибка сборки: остаток бакетов просто не
 * генерируется (findBucket отдаёт что есть в банке, может быть меньше
 * bucket.count) и тест собирается короче, а не падает.
 */
export async function assembleTest(
  deps: { taskRepo: TaskBankRepo; testRepo: TestRepo; llm: Llm },
  args: { hqId: string; examProfile: StoredExamProfile; kind: TestKind },
): Promise<StoredTest> {
  const { hqId, examProfile, kind } = args;
  const spec = examProfile.spec;
  const buckets = buildPlan(spec, kind);
  const llm = budgetedLlm(deps.llm, MAX_LLM_CALLS_PER_ASSEMBLY);

  let budgetExhausted = false;
  const sectionTasks = new Map<string, StoredTask[]>();

  for (const bucket of buckets) {
    let found = await deps.taskRepo.findBucket(
      examProfile.id,
      bucket.type,
      bucket.topic,
      bucket.difficulty,
      bucket.count,
    );

    // Релакс-фолбэк (acceptance 2.5): точный select бьёт по FIXED_DIFFICULTY,
    // поэтому импортированные/сгенерированные ранее задания с иной
    // сложностью иначе никогда бы не выбирались. difficulty=null снимает
    // фильтр по сложности в repo; уже отобранные exact-match id исключаем
    // вручную (repo не умеет excludeIds) — фолбэк не должен задваивать их.
    // Никакого бюджета LLM это не трогает — обычный select банка.
    if (found.length < bucket.count) {
      const takenIds = new Set(found.map((task) => task.id));
      const fallback = await deps.taskRepo.findBucket(
        examProfile.id,
        bucket.type,
        bucket.topic,
        null,
        bucket.count,
      );
      const fresh = fallback.filter((task) => !takenIds.has(task.id));
      found = found.concat(fresh.slice(0, bucket.count - found.length));
    }

    // Только оставшийся дефицит (после точного select + релакс-фолбэка)
    // идёт в генерацию.
    if (found.length < bucket.count && !budgetExhausted) {
      try {
        await generateForBucket({ llm, repo: deps.taskRepo }, spec, examProfile.id, bucket);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetExhausted = true;
        } else {
          throw err;
        }
      }
      const takenIds = new Set(found.map((task) => task.id));
      const afterGen = await deps.taskRepo.findBucket(
        examProfile.id,
        bucket.type,
        bucket.topic,
        bucket.difficulty,
        bucket.count,
      );
      const fresh = afterGen.filter((task) => !takenIds.has(task.id));
      found = found.concat(fresh.slice(0, bucket.count - found.length));
    }

    const existing = sectionTasks.get(bucket.sectionName) ?? [];
    sectionTasks.set(bucket.sectionName, existing.concat(found));
  }

  // D3 шаг 5: distinct taskIds по секциям. Один глобальный Set (не по секции
  // отдельно) — так плоский taskIds всегда РОВНО конкатенация
  // sections[].taskIds, без осиротевших дублей между секциями.
  const seen = new Set<string>();
  const sections = spec.sections.map((section) => {
    const tasks = sectionTasks.get(section.name) ?? [];
    const taskIds: string[] = [];
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      taskIds.push(task.id);
    }
    return { name: section.name, taskIds };
  });
  const taskIds = sections.flatMap((section) => section.taskIds);

  // D3 шаг 6: totalTimeMinutes = сумма section.timeLimitMinutes, если ВСЕ
  // секции его задают; иначе — spec.totalTimeMinutes (может быть null).
  const everySectionHasTimeLimit = spec.sections.every(
    (section) => typeof section.timeLimitMinutes === "number",
  );
  const totalTimeMinutes = everySectionHasTimeLimit
    ? spec.sections.reduce((sum, section) => sum + (section.timeLimitMinutes as number), 0)
    : (spec.totalTimeMinutes ?? null);

  // D3 шаг 7: копия scoring на момент сборки (не ссылка на examProfile.spec) —
  // последующий refine профиля не должен задним числом менять уже
  // замороженный тест. scoring — плоский объект из примитивов, поэтому
  // shallow-копии достаточно для полной развязки.
  const testSpec: TestSpec = testSpecSchema.parse({
    version: 1,
    kind,
    language: spec.language,
    sections,
    taskIds,
    totalTimeMinutes,
    scoringSnapshot: { ...spec.scoring },
  });

  return deps.testRepo.insertTest(hqId, kind, testSpec);
}
