"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { taskResponseSchema } from "@/features/tasks/schema";
import type { TaskBody, TaskResponse } from "@/features/tasks/schema";
import type { ScoringSnapshot } from "@/features/tests/scoring";
import { formatRemaining, isExpired, remainingMs } from "@/features/attempts/timer";
import { AudioPassage } from "@/features/attempts/AudioPassage";
import { ResultView } from "./ResultView";

type SectionSpec = { name: string; taskIds: string[]; modality?: "text" | "audio" | null };
type TaskItem = { id: string; body: TaskBody };
type SavedItem = { taskId: string; response: unknown };
type InitialAttempt = {
  id: string;
  deadlineAtISO: string | null;
  finished: boolean;
  savedItems: SavedItem[];
} | null;

export type TestRunnerProps = {
  testId: string;
  hqId: string;
  kind: string;
  sections: SectionSpec[];
  taskIds: string[];
  totalTimeMinutes: number | null;
  scoringSnapshot: ScoringSnapshot;
  tasks: TaskItem[];
  attempt: InitialAttempt;
  language: string;
};

type AttemptResult = { raw: number; scaled: number; total: number };

const AUTOSAVE_DEBOUNCE_MS = 1500;

function responsesFromSaved(savedItems: SavedItem[]): Map<string, TaskResponse> {
  const map = new Map<string, TaskResponse>();
  for (const item of savedItems) {
    const parsed = taskResponseSchema.safeParse(item.response);
    if (parsed.success) map.set(item.taskId, parsed.data);
  }
  return map;
}

function isAnswered(response: TaskResponse | undefined): boolean {
  if (!response) return false;
  switch (response.format) {
    case "single_choice":
      return response.optionId !== null;
    case "multi_choice":
      return response.optionIds.length > 0;
    case "text_input":
      return response.value !== null && response.value.trim() !== "";
  }
}

// submitOnce/startOnce (D-fix4): сетевой запрос + try/catch живут в
// module-level функциях, ВНЕ handleSubmit/handleStart — react-hooks'
// set-state-in-effect консервативно считает любой catch внутри функции,
// достижимой из useEffect (handleSubmit зовётся из авто-сабмита на дедлайн),
// потенциально синхронным. Вынос try/catch в функцию, которая сама не
// вызывает setState и не передаётся в effect напрямую, снимает false positive
// — вызывающий код (handleSubmit/handleStart) просто ветвится по исходу.
type SubmitOutcome =
  | { kind: "success"; data: AttemptResult }
  | { kind: "http_error" }
  | { kind: "exception" };

async function submitOnce(id: string, flushSave: () => Promise<void>): Promise<SubmitOutcome> {
  try {
    await flushSave();
    const res = await fetch(`/api/attempts/${id}/submit`, { method: "POST" });
    if (!res.ok) return { kind: "http_error" };
    const data = (await res.json()) as AttemptResult & { alreadyFinished: boolean };
    return { kind: "success", data: { raw: data.raw, scaled: data.scaled, total: data.total } };
  } catch {
    return { kind: "exception" };
  }
}

type StartOutcome =
  | { kind: "success"; attemptId: string; deadlineAt: string | null }
  | { kind: "http_error" }
  | { kind: "exception" };

async function startOnce(testId: string): Promise<StartOutcome> {
  try {
    const res = await fetch("/api/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testId }),
    });
    if (!res.ok) return { kind: "http_error" };
    const data = (await res.json()) as { attemptId: string; deadlineAt: string | null };
    return { kind: "success", attemptId: data.attemptId, deadlineAt: data.deadlineAt };
  } catch {
    return { kind: "exception" };
  }
}

export function TestRunner(props: TestRunnerProps) {
  const t = useTranslations("testRunner");
  const tAudio = useTranslations("audio");
  const taskById = useMemo(() => new Map(props.tasks.map((task) => [task.id, task])), [props.tasks]);
  const orderIndex = useMemo(
    () => new Map(props.taskIds.map((id, i) => [id, i])),
    [props.taskIds],
  );

  const [attemptId, setAttemptId] = useState<string | null>(props.attempt?.id ?? null);
  const [deadlineAt, setDeadlineAt] = useState<Date | null>(
    props.attempt?.deadlineAtISO ? new Date(props.attempt.deadlineAtISO) : null,
  );
  const [finished, setFinished] = useState<boolean>(props.attempt?.finished ?? false);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [responses, setResponses] = useState<Map<string, TaskResponse>>(() =>
    responsesFromSaved(props.attempt?.savedItems ?? []),
  );
  const [now, setNow] = useState<Date>(() => new Date());
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  const responsesRef = useRef(responses);
  const attemptIdRef = useRef(attemptId);
  const dirtyRef = useRef(false);
  const mountTimeRef = useRef<number | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSubmittedRef = useRef(false);

  // Ref-синки живут в эффектах, а не во время рендера (React Compiler
  // purity-правило запрещает мутировать ref/звать Date.now() при рендере).
  useEffect(() => {
    responsesRef.current = responses;
  }, [responses]);
  useEffect(() => {
    attemptIdRef.current = attemptId;
  }, [attemptId]);
  useEffect(() => {
    mountTimeRef.current = Date.now();
  }, []);

  // Косметический флаш автосейва (D4: сервер — единственный источник
  // истины по времени). timeMs — elapsed от загрузки страницы для ВСЕХ
  // сохраняемых пунктов разом, без per-задание точности (по брифу T7 —
  // "не усложняй"). keepalive гарантирует доставку при закрытии вкладки.
  const flushSave = useCallback(async () => {
    const id = attemptIdRef.current;
    if (!id || !dirtyRef.current) return;
    const elapsed = Date.now() - (mountTimeRef.current ?? Date.now());
    const items = Array.from(responsesRef.current.entries()).map(([taskId, response]) => ({
      taskId,
      response,
      timeMs: elapsed,
    }));
    if (items.length === 0) return;
    dirtyRef.current = false;
    setSavingState("saving");
    try {
      const res = await fetch(`/api/attempts/${id}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
        keepalive: true,
      });
      if (res.ok) {
        setSavingState("saved");
      } else {
        dirtyRef.current = true; // ретрай на следующий edit/flush
      }
    } catch {
      dirtyRef.current = true;
    }
  }, []);

  function updateResponse(taskId: string, response: TaskResponse) {
    setResponses((prev) => {
      const next = new Map(prev);
      next.set(taskId, response);
      return next;
    });
    dirtyRef.current = true;
    setSavingState("idle");
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      void flushSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  // Flush на переключение вкладки / закрытие окна — не теряем последние
  // правки, которые не успели дождаться debounce.
  useEffect(() => {
    function handleVisibility() {
      if (document.visibilityState === "hidden") void flushSave();
    }
    function handleBeforeUnload() {
      void flushSave();
    }
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [flushSave]);

  // Косметический countdown: пересчёт раз в секунду + принудительно на
  // возврат фокуса (фоновые вкладки троттлят setInterval — фокус чинит дрейф).
  useEffect(() => {
    if (deadlineAt === null || finished) return;
    const interval = setInterval(() => setNow(new Date()), 1000);
    function handleFocus() {
      setNow(new Date());
    }
    window.addEventListener("focus", handleFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
  }, [deadlineAt, finished]);

  const handleSubmit = useCallback(async () => {
    const id = attemptIdRef.current;
    if (!id || submitting || finished) return;
    setSubmitting(true);
    setError(null);
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const outcome = await submitOnce(id, flushSave);
    if (outcome.kind === "success") {
      setResult(outcome.data);
      setFinished(true);
    } else if (outcome.kind === "exception") {
      // Сетевой сбой/исключение (не HTTP-ошибка — та молча оставляет
      // попытку незавершённой для ретрая): явно показываем ошибку, а не
      // оставляем кнопку зависшей в disabled без обратной связи.
      setError(t("error"));
    }
    setSubmitting(false);
  }, [submitting, finished, flushSave, t]);

  // Автосабмит при истечении дедлайна — без confirm, ровно один раз.
  useEffect(() => {
    if (finished || submitting || autoSubmittedRef.current) return;
    if (deadlineAt !== null && isExpired(deadlineAt, now)) {
      autoSubmittedRef.current = true;
      void handleSubmit();
    }
  }, [now, deadlineAt, finished, submitting, handleSubmit]);

  // Резюм уже завершённой попытки (повторный визит на страницу): submit
  // идемпотентен (D4) — повторный вызов не перегрейдит, а вернёт готовый
  // persisted-результат. НОЛЬ доп. API-контракта, ровно один раз на монтаж.
  useEffect(() => {
    const initial = props.attempt;
    if (!initial?.finished) return;
    (async () => {
      const res = await fetch(`/api/attempts/${initial.id}/submit`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as AttemptResult & { alreadyFinished: boolean };
        setResult({ raw: data.raw, scaled: data.scaled, total: data.total });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleStart() {
    setStarting(true);
    setError(null);
    const outcome = await startOnce(props.testId);
    if (outcome.kind === "success") {
      setAttemptId(outcome.attemptId);
      setDeadlineAt(outcome.deadlineAt ? new Date(outcome.deadlineAt) : null);
    } else if (outcome.kind === "exception") {
      setError(t("error"));
    }
    setStarting(false);
  }

  function onSubmitClick() {
    if (!window.confirm(t("confirmSubmit"))) return;
    void handleSubmit();
  }

  // Нет попытки вообще — предлагаем начать.
  if (attemptId === null) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <button
          onClick={handleStart}
          disabled={starting}
          className="rounded border px-6 py-3 font-medium"
        >
          {starting ? "…" : t("start")}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </main>
    );
  }

  // Попытка завершена — показываем результат (либо только что просабмиченный,
  // либо подгруженный идемпотентным submit при резюме).
  if (finished) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        {result ? (
          <ResultView
            raw={result.raw}
            scaled={result.scaled}
            total={result.total}
            unit={props.scoringSnapshot.unit}
            passingScore={props.scoringSnapshot.passingScore}
          />
        ) : (
          <p className="text-sm text-gray-500">…</p>
        )}
      </main>
    );
  }

  const remaining = deadlineAt !== null ? remainingMs(deadlineAt, now) : null;
  const unansweredCount = props.taskIds.filter((id) => !isAnswered(responses.get(id))).length;
  const sections = props.sections.length > 0 ? props.sections : [{ name: "", taskIds: props.taskIds }];

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        {remaining !== null ? (
          <p className="text-sm">
            {t("timeLeft")}: <span className="font-medium">{formatRemaining(remaining)}</span>
          </p>
        ) : (
          <span />
        )}
        <p className="text-sm text-gray-500">
          {savingState === "saving" && t("saving")}
          {savingState === "saved" && t("saved")}
        </p>
      </header>

      {sections.map((section, sectionIndex) => {
        const isAudio = section.modality === "audio";
        return (
        <section key={section.name || sectionIndex} className="flex flex-col gap-3">
          {section.name && (
            <h2 className="font-semibold">
              {section.name}
              {isAudio && (
                <span className="ml-2 rounded bg-gray-100 px-2 py-0.5 text-xs font-normal text-gray-600">
                  {tAudio("sectionBadge")}
                </span>
              )}
            </h2>
          )}
          <ul className="flex flex-col gap-3">
            {section.taskIds.map((taskId) => {
              const task = taskById.get(taskId);
              if (!task) return null;
              const response = responses.get(taskId);
              const number = (orderIndex.get(taskId) ?? 0) + 1;
              return (
                <li key={taskId} className="rounded border p-4">
                  <p className="mb-2 text-sm text-gray-500">{number}.</p>
                  {task.body.passage && (
                    isAudio ? (
                      <AudioPassage text={task.body.passage} lang={props.language} />
                    ) : (
                      <blockquote className="mb-3 rounded bg-gray-50 p-3 text-sm text-gray-700">
                        {task.body.passage}
                      </blockquote>
                    )
                  )}
                  <p className="mb-3 font-medium">{task.body.prompt}</p>

                  {task.body.format === "single_choice" && (
                    <div className="flex flex-col gap-2">
                      {task.body.options.map((opt) => (
                        <label key={opt.id} className="flex items-center gap-2">
                          <input
                            type="radio"
                            name={`task-${taskId}`}
                            checked={response?.format === "single_choice" && response.optionId === opt.id}
                            onChange={() =>
                              updateResponse(taskId, { format: "single_choice", optionId: opt.id })
                            }
                          />
                          <span>{opt.text}</span>
                        </label>
                      ))}
                    </div>
                  )}

                  {task.body.format === "multi_choice" && (
                    <div className="flex flex-col gap-2">
                      {task.body.options.map((opt) => {
                        const selected =
                          response?.format === "multi_choice" && response.optionIds.includes(opt.id);
                        return (
                          <label key={opt.id} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={(e) => {
                                const current =
                                  response?.format === "multi_choice" ? response.optionIds : [];
                                const next = e.target.checked
                                  ? [...current, opt.id]
                                  : current.filter((id) => id !== opt.id);
                                updateResponse(taskId, { format: "multi_choice", optionIds: next });
                              }}
                            />
                            <span>{opt.text}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}

                  {task.body.format === "text_input" && (
                    <input
                      type="text"
                      inputMode={task.body.inputKind === "number" ? "decimal" : "text"}
                      className="w-full rounded border p-2"
                      value={response?.format === "text_input" ? (response.value ?? "") : ""}
                      onChange={(e) =>
                        updateResponse(taskId, {
                          format: "text_input",
                          value: e.target.value === "" ? null : e.target.value,
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        );
      })}

      <footer className="flex flex-col gap-2">
        <p className="text-sm text-gray-500">
          {t("unanswered")}: {unansweredCount}
        </p>
        {submitting && remaining === 0 && (
          <p className="text-sm text-gray-500">{t("expiredSubmitting")}</p>
        )}
        <button
          onClick={onSubmitClick}
          disabled={submitting}
          className="rounded border px-6 py-3 font-medium"
        >
          {t("submit")}
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </footer>
    </main>
  );
}
