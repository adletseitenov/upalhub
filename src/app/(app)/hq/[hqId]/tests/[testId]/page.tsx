import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { testSpecSchema } from "@/features/tests/spec";
import { taskAnswerSchema, taskBodySchema } from "@/features/tasks/schema";
import { computeDeadline } from "@/features/attempts/service";
import { loadSimilarTasks } from "@/features/review/similar";
import type { SimilarBucket } from "@/features/review/similar";
import { buildReviewViewModel } from "@/features/review/view";
import type { ReviewTask, ReviewViewItem } from "@/features/review/view";
import { RefillButton } from "@/components/refill-button";
import { TestRunner } from "./TestRunner";
import { ReviewList } from "./ReviewList";

export default async function TestPage({
  params,
}: {
  params: Promise<{ hqId: string; testId: string }>;
}) {
  const { hqId, testId } = await params;
  const supabase = await supabaseServer();

  // (app) layout уже гейтит анонимов на /sign-in, но страница всё равно
  // сама проверяет владение hq/тестом — не полагаемся молча на RLS
  // (паттерн /api/tests, /api/attempts).
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) notFound();

  const { data: hq } = await supabase
    .from("study_hqs")
    .select("id, exam_profile_id")
    .eq("id", hqId)
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (!hq) notFound();

  const { data: testRow } = await supabase
    .from("tests")
    .select("*")
    .eq("id", testId)
    .maybeSingle();
  if (!testRow || testRow.hq_id !== hqId) notFound();

  const parsedSpec = testSpecSchema.safeParse(testRow.spec);
  if (!parsedSpec.success) notFound();
  const spec = parsedSpec.data;

  // tasks.answer НИКОГДА не селектится здесь — только id + body (D-констрейнт
  // из брифа T7). Порядок задач — канонический из spec.taskIds.
  const { data: taskRows } = await supabase
    .from("tasks")
    .select("id, body")
    .in("id", spec.taskIds);
  const taskById = new Map(
    (taskRows ?? []).flatMap((row) => {
      const parsed = taskBodySchema.safeParse(row.body);
      return parsed.success ? [[row.id, { id: row.id, body: parsed.data }] as const] : [];
    }),
  );
  const tasks = spec.taskIds.flatMap((id) => {
    const task = taskById.get(id);
    return task ? [task] : [];
  });

  // Самая свежая попытка этого юзера на этот тест — открытая (resume) или
  // уже завершённая (повторный визит показывает готовый результат через
  // идемпотентный /submit, см. TestRunner). Ни одной — рендерим "Начать".
  const { data: attemptRow } = await supabase
    .from("attempts")
    .select("*")
    .eq("test_id", testId)
    .eq("user_id", userData.user.id)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let attempt: {
    id: string;
    deadlineAtISO: string | null;
    finished: boolean;
    savedItems: { taskId: string; response: unknown }[];
  } | null = null;

  // D5/Task7: разбор ошибок (ReviewList) — построен ТОЛЬКО когда попытка уже
  // завершена. При открытой попытке этот массив остаётся [] и
  // buildReviewViewModel не вызывается вовсе (инвариант (а) из брифа T7,
  // задокументирован повторно в src/features/review/view.ts) — ни одного
  // лишнего запроса (supabaseAdmin/similar) для активного прохождения.
  let reviewItems: ReviewViewItem[] = [];

  if (attemptRow) {
    const deadlineAt = computeDeadline(spec, new Date(attemptRow.started_at));
    const { data: itemRows } = await supabase
      .from("attempt_items")
      .select("task_id, answer, is_correct")
      .eq("attempt_id", attemptRow.id);
    attempt = {
      id: attemptRow.id,
      deadlineAtISO: deadlineAt ? deadlineAt.toISOString() : null,
      finished: attemptRow.finished_at !== null,
      savedItems: (itemRows ?? []).map((row) => ({ taskId: row.task_id, response: row.answer })),
    };

    if (attemptRow.finished_at !== null) {
      // Ownership уже подтверждён выше (user-клиент) — ТЕПЕРЬ можно читать
      // tasks.answer/explanation через service-role клиент (тот же паттерн,
      // что и /api/attempts/[id]/submit): будущая миграция уберёт эти
      // колонки у роли authenticated.
      const { data: fullTaskRows } = await supabaseAdmin()
        .from("tasks")
        .select("id, type, topic, body, answer, explanation")
        .in("id", spec.taskIds);
      const tasksById = new Map<string, ReviewTask>();
      for (const row of fullTaskRows ?? []) {
        const bodyParsed = taskBodySchema.safeParse(row.body);
        const answerParsed = taskAnswerSchema.safeParse(row.answer);
        if (!bodyParsed.success || !answerParsed.success) {
          console.warn(`review: skipping malformed task row id=${row.id}`);
          continue;
        }
        tasksById.set(row.id, {
          id: row.id,
          type: row.type,
          topic: row.topic,
          body: bodyParsed.data,
          answer: answerParsed.data,
          explanation: row.explanation ?? "",
        });
      }

      // 🔴 Кросс-попыточный гейт (D5): taskIds всех НЕзавершённых попыток
      // этого юзера (по ВСЕМ hq/тестам, не только текущему) — answer/
      // explanation для них не должны дойти до ReviewList (плашка
      // 'inActiveTest' вместо разбора). Текущая попытка сюда попасть не
      // может: finished_at is null исключает её (она уже завершена).
      const { data: openAttemptRows } = await supabase
        .from("attempts")
        .select("test_id")
        .eq("user_id", userData.user.id)
        .is("finished_at", null);
      const openTestIds = Array.from(new Set((openAttemptRows ?? []).map((row) => row.test_id)));
      const openTaskIds = new Set<string>();
      if (openTestIds.length > 0) {
        const { data: openTestRows } = await supabase
          .from("tests")
          .select("id, spec")
          .in("id", openTestIds);
        for (const row of openTestRows ?? []) {
          const parsedOpenSpec = testSpecSchema.safeParse(row.spec);
          if (!parsedOpenSpec.success) continue; // битая spec — скип, не 500
          for (const taskId of parsedOpenSpec.data.taskIds) openTaskIds.add(taskId);
        }
      }

      // Похожие: 🔴 buckets — РАЗЛИЧИМЫЕ (type,topic) ОШИБОЧНЫХ items
      // (is_correct=false), как в D5 дословно. Дедуп ОБЯЗАТЕЛЕН: view.ts
      // группирует похожие обратно по (type,topic) и показывает ОДИН и тот
      // же капнутый набор ВСЕМ ошибкам этой темы (review — независимый
      // ревьюер поймал баг: без дедупа буквально в бакетах два промаха на
      // одну тему давали каждый СВОЙ бюджет capPerBucket в pickSimilar, а
      // view.ts потом сливал оба набора в один общий список — на выходе
      // каждая из двух ошибок показывала уже ОБЪЕДИНЁННЫЙ (до 4, не 2)
      // список вместо капнутых 2). Дедуп здесь делает "cap 2/ошибку" из D5
      // фактически "cap 2 на различимую тему промаха" — ровно то, что
      // написано в брифе ("буккеты из различимых (type,topic) ошибок").
      // excludeIds = taskIds этого теста ∪ openTaskIds юзера.
      const bucketKeys = new Set<string>();
      const buckets: SimilarBucket[] = [];
      for (const row of itemRows ?? []) {
        if (row.is_correct !== false) continue;
        const task = tasksById.get(row.task_id);
        if (!task) continue; // задание вне банка — бакет строить не из чего
        const key = `${task.type}::${task.topic}`;
        if (bucketKeys.has(key)) continue;
        bucketKeys.add(key);
        buckets.push({ type: task.type, topic: task.topic });
      }
      const excludeIds = new Set<string>([...spec.taskIds, ...openTaskIds]);
      const similarRows = await loadSimilarTasks(supabase, {
        profileId: hq.exam_profile_id,
        buckets,
        excludeIds,
      });

      const audioTaskIds = new Set<string>(
        spec.sections.filter((section) => section.modality === "audio").flatMap((section) => section.taskIds),
      );

      reviewItems = buildReviewViewModel({
        taskIds: spec.taskIds,
        items: (itemRows ?? []).map((row) => ({
          taskId: row.task_id,
          response: row.answer,
          isCorrect: row.is_correct,
        })),
        tasksById,
        openTaskIds,
        audioTaskIds,
        language: spec.language,
        similarRows,
      });
    }
  }

  // D5 честная UI: партиал считается только если спека вообще размечена
  // plannedCount (T4 freeze) — старые тесты без этого поля показывают
  // partial=false (нет баннера, нет "Дособрать"), а не ложную тревогу.
  const hasPlannedCounts = spec.sections.some((section) => section.plannedCount != null);
  const planned = hasPlannedCounts
    ? spec.sections.reduce((sum, section) => sum + (section.plannedCount ?? 0), 0)
    : null;
  const actual = spec.sections.reduce((sum, section) => sum + section.taskIds.length, 0);
  const partial = planned != null && actual < planned;
  const refillCount = spec.refillCount ?? 0;
  const attemptExists = attempt !== null;

  const t = await getTranslations("testRunner");

  return (
    <>
      {partial && !attemptExists && (
        <div className="mx-auto flex max-w-2xl flex-col items-start gap-2 rounded border border-amber-300 bg-amber-50 p-4 mt-6">
          <p className="text-sm text-amber-800">
            {t("partialBanner", { actual, planned: planned ?? 0 })}
          </p>
          <RefillButton key={refillCount} testId={testId} refillCount={refillCount} actual={actual} />
        </div>
      )}
      <TestRunner
        testId={testId}
        hqId={hqId}
        kind={spec.kind}
        sections={spec.sections}
        taskIds={spec.taskIds}
        totalTimeMinutes={spec.totalTimeMinutes ?? null}
        scoringSnapshot={spec.scoringSnapshot}
        tasks={tasks}
        attempt={attempt}
        language={spec.language}
      />
      {attempt?.finished && <ReviewList items={reviewItems} />}
    </>
  );
}
