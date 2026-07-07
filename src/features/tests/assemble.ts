import type { Llm } from "@/lib/llm";
import type { ExamProfileSpec } from "@/features/exam-profile/spec";
import type { StoredExamProfile } from "@/features/exam-profile/service";
import { resolveActiveSections } from "@/features/exam-profile/selection";
import type { HqConfig } from "@/features/exam-profile/selection";
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
      // D6 (T4 пересмотрит): modality/sectionTopics/sectionTaskTypes — контекст
      // секции для привязки промпта, минимальная проводка из спеки без
      // экзаменных констант.
      buckets.push({
        sectionName: section.name,
        type,
        topic,
        difficulty: FIXED_DIFFICULTY,
        count,
        modality: section.modality ?? "text",
        sectionTopics: section.topics ?? [],
        sectionTaskTypes: section.taskTypes ?? [],
      });
    });
  });

  return buckets;
}

/**
 * Round-robin интерливинг бакетов по секциям (D5), выполняется перед фазой
 * генерации: секция1-бакет1, секция2-бакет1, ..., секция1-бакет2, ... —
 * иначе секция с несколькими бакетами (несколько topics) в исходном
 * плоском порядке способна в одиночку съесть весь бюджет ≤3 вызовов
 * (MAX_LLM_CALLS_PER_ASSEMBLY), оставив следующие секции без единого
 * генерационного вызова (пустая секция в тесте — то, что честная сборка
 * обязана лечить).
 *
 * `offset` — с какой секции начинается интерливинг, считается вызывающей
 * стороной как `refillCount % sectionOrder.length` (D5 ротация): «Дособрать»
 * без этого каждый раз бил бы бюджет по одним и тем же первым секциям.
 * `sectionOrder` — activeSections в их естественном порядке (после
 * hqConfig-фильтрации), не порядок появления бакетов — так пустая (без
 * единого бакета) активная секция просто не участвует в интерливинге, не
 * ломая распределение остальных.
 */
function interleaveBySection(buckets: Bucket[], sectionOrder: string[], offset: number): Bucket[] {
  if (sectionOrder.length === 0) return buckets;

  const bySection = new Map<string, Bucket[]>(sectionOrder.map((name) => [name, []]));
  for (const bucket of buckets) {
    // Защитно: бакет с именем вне sectionOrder не должен случаться (buildPlan
    // строится из того же списка секций), но лучше сохранить бакет в своей
    // группе, чем молча потерять его.
    if (!bySection.has(bucket.sectionName)) bySection.set(bucket.sectionName, []);
    bySection.get(bucket.sectionName)!.push(bucket);
  }

  const n = sectionOrder.length;
  const shift = offset % n;
  const rotatedNames = [...sectionOrder.slice(shift), ...sectionOrder.slice(0, shift)];
  const maxLen = Math.max(0, ...[...bySection.values()].map((b) => b.length));

  const result: Bucket[] = [];
  for (let col = 0; col < maxLen; col++) {
    for (const name of rotatedNames) {
      const bucket = bySection.get(name)?.[col];
      if (bucket) result.push(bucket);
    }
  }
  return result;
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
 * buildTestSpec (D3/D5): buildPlan (только по activeSections — hqConfig
 * решает, какие секции спеки вообще участвуют в сборке) -> round-robin
 * интерливинг бакетов с ротацией офсета от refillCount -> select банка по
 * каждому бакету (exact difficulty=FIXED_DIFFICULTY) -> на недобор
 * релакс-фолбэк select с difficulty=null (подхватывает
 * импортированные/сгенерированные задания вне FIXED_DIFFICULTY, acceptance
 * 2.5) -> на оставшийся дефицит генерация (суммарно ≤3 фактических
 * llm.complete на всю сборку, считая через budgetedLlm, а не через число
 * вызовов generateForBucket) -> re-select -> distinct taskIds по секциям ->
 * заморозка spec (plannedCount/modality по секции, snapshot scoring,
 * refillCount) — не пишет в БД, это общий для assembleTest/reassembleTest
 * чистый шаг сборки.
 *
 * Исчерпание бюджета — не ошибка сборки: остаток бакетов просто не
 * генерируется (findBucket отдаёт что есть в банке, может быть меньше
 * bucket.count) и тест собирается короче, а не падает (round-robin следит,
 * чтобы «короче» не значило «секция-сирота с нулём заданий»).
 */
async function buildTestSpec(
  deps: { taskRepo: TaskBankRepo; llm: Llm },
  args: {
    examProfile: StoredExamProfile;
    kind: TestKind;
    hqConfig?: HqConfig | null;
    refillCount?: number;
  },
): Promise<TestSpec> {
  const { examProfile, kind } = args;
  const spec = examProfile.spec;
  const refillCount = args.refillCount ?? 0;

  // D5: resolveActiveSections — единственная точка истины «config ->
  // активные секции». Невыбранные секции не попадают в план и, ниже, вообще
  // не попадают в замороженный spec.
  const activeSections = resolveActiveSections(spec, args.hqConfig);
  const activeSpec: ExamProfileSpec = { ...spec, sections: activeSections };
  const rawBuckets = buildPlan(activeSpec, kind);

  const sectionOrder = activeSections.map((section) => section.name);
  const offset = sectionOrder.length > 0 ? refillCount % sectionOrder.length : 0;
  const buckets = interleaveBySection(rawBuckets, sectionOrder, offset);

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

  // D5 freeze: Σ bucket.count секции — из rawBuckets (план ДО round-robin
  // переупорядочивания; порядок для суммы неважен). Ключ — sectionName; имена
  // секций уникальны (superRefine спеки), поэтому группировка по имени здесь
  // эквивалентна группировке по индексу секции — но именно по этой причине
  // (не полагаясь на группировку по индексу вручную) дубли имён не могут
  // задвоить/потерять план (красная команда).
  const plannedCountBySection = new Map<string, number>();
  for (const bucket of rawBuckets) {
    plannedCountBySection.set(
      bucket.sectionName,
      (plannedCountBySection.get(bucket.sectionName) ?? 0) + bucket.count,
    );
  }

  // D3 шаг 5: distinct taskIds по секциям. Один глобальный Set (не по секции
  // отдельно) — так плоский taskIds всегда РОВНО конкатенация
  // sections[].taskIds, без осиротевших дублей между секциями.
  // D5: sections строится из activeSections (не spec.sections) — невыбранные
  // секции вообще не попадают в замороженный spec.
  const seen = new Set<string>();
  const sections = activeSections.map((section) => {
    const tasks = sectionTasks.get(section.name) ?? [];
    const taskIds: string[] = [];
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      taskIds.push(task.id);
    }
    return {
      name: section.name,
      taskIds,
      plannedCount: plannedCountBySection.get(section.name) ?? 0,
      modality: section.modality ?? null,
    };
  });
  const taskIds = sections.flatMap((section) => section.taskIds);

  // D3 шаг 6: totalTimeMinutes = сумма section.timeLimitMinutes, если ВСЕ
  // АКТИВНЫЕ секции его задают; иначе — spec.totalTimeMinutes (может быть
  // null). Считается по activeSections — исключённая hqConfig'ом секция не
  // должна влиять на бюджет времени теста, в который она не попала.
  const everySectionHasTimeLimit = activeSections.every(
    (section) => typeof section.timeLimitMinutes === "number",
  );
  const totalTimeMinutes = everySectionHasTimeLimit
    ? activeSections.reduce((sum, section) => sum + (section.timeLimitMinutes as number), 0)
    : (spec.totalTimeMinutes ?? null);

  // D3 шаг 7: копия scoring на момент сборки (не ссылка на examProfile.spec) —
  // последующий refine профиля не должен задним числом менять уже
  // замороженный тест. scoring — плоский объект из примитивов, поэтому
  // shallow-копии достаточно для полной развязки.
  return testSpecSchema.parse({
    version: 1,
    kind,
    language: spec.language,
    sections,
    taskIds,
    totalTimeMinutes,
    scoringSnapshot: { ...spec.scoring },
    refillCount,
  });
}

/**
 * assembleTest (D3/D5): buildTestSpec -> testRepo.insertTest (первая сборка
 * теста, refillCount по умолчанию 0).
 */
export async function assembleTest(
  deps: { taskRepo: TaskBankRepo; testRepo: TestRepo; llm: Llm },
  args: {
    hqId: string;
    examProfile: StoredExamProfile;
    kind: TestKind;
    hqConfig?: HqConfig | null;
    refillCount?: number;
  },
): Promise<StoredTest> {
  const testSpec = await buildTestSpec(deps, args);
  return deps.testRepo.insertTest(args.hqId, args.kind, testSpec);
}

/**
 * reassembleTest (D5 «Дособрать»): пере-прогон buildTestSpec для уже
 * существующего теста — kind берётся из его замороженного spec, refillCount
 * инкрементируется (двигает ротацию round-robin офсета на следующий заход),
 * бюджет LLM свежий (budgetedLlm внутри buildTestSpec заново оборачивает
 * deps.llm, кап снова ≤3). НЕ пишет в БД: атомарную замену (RPC,
 * TOCTOU-фикс красной команды) делает T6-роут через
 * TestRepo.replaceTestSpecIfNoAttempts.
 */
export async function reassembleTest(
  deps: { taskRepo: TaskBankRepo; llm: Llm },
  args: { test: StoredTest; examProfile: StoredExamProfile; hqConfig?: HqConfig | null },
): Promise<TestSpec> {
  const { test, examProfile, hqConfig } = args;
  return buildTestSpec(deps, {
    examProfile,
    kind: test.spec.kind,
    hqConfig,
    refillCount: (test.spec.refillCount ?? 0) + 1,
  });
}
