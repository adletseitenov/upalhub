import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { supabaseServer } from "@/lib/supabase/server";
import { testSpecSchema } from "@/features/tests/spec";
import { taskBodySchema } from "@/features/tasks/schema";
import { computeDeadline } from "@/features/attempts/service";
import { RefillButton } from "@/components/refill-button";
import { TestRunner } from "./TestRunner";

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
    .select("id")
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

  if (attemptRow) {
    const deadlineAt = computeDeadline(spec, new Date(attemptRow.started_at));
    const { data: itemRows } = await supabase
      .from("attempt_items")
      .select("task_id, answer")
      .eq("attempt_id", attemptRow.id);
    attempt = {
      id: attemptRow.id,
      deadlineAtISO: deadlineAt ? deadlineAt.toISOString() : null,
      finished: attemptRow.finished_at !== null,
      savedItems: (itemRows ?? []).map((row) => ({ taskId: row.task_id, response: row.answer })),
    };
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
    </>
  );
}
