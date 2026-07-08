"use client";
// D5/Task7: разбор ошибок level 0 (0 LLM) — рендерится РЯДОМ с ResultView
// (после него), только когда попытка завершена (page.tsx решает это, не
// этот компонент — см. buildReviewViewModel doc-комментарий про инвариант
// (а)). Чисто презентационный: весь домен (locked/similar/audio-wiring/
// correctLabel) уже посчитан на сервере в src/features/review/view.ts —
// здесь только маппинг optionId -> текст для отображения ответа ученика
// (view-model намеренно хранит "сырой" TaskResponse, а не готовую строку,
// т.к. это чисто презентационная деталь, для которой body уже есть в пропсах).
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { TaskBody, TaskResponse } from "@/features/tasks/schema";
import { AudioPassage } from "@/features/attempts/AudioPassage";
import type { ReviewViewItem } from "@/features/review/view";

export type ReviewListProps = { items: ReviewViewItem[]; attemptId: string };

type ExplainResult = { explanation: string; hint?: string };
type ExplainError = "rate_limited" | "error";

function formatUserResponse(body: TaskBody, response: TaskResponse | null): string | null {
  if (!response) return null;
  if (body.format === "single_choice" && response.format === "single_choice") {
    return body.options.find((o) => o.id === response.optionId)?.text ?? null;
  }
  if (body.format === "multi_choice" && response.format === "multi_choice") {
    const ids = new Set(response.optionIds);
    const texts = body.options.filter((o) => ids.has(o.id)).map((o) => o.text);
    return texts.length > 0 ? texts.join(", ") : null;
  }
  if (body.format === "text_input" && response.format === "text_input") {
    return response.value;
  }
  return null;
}

export function ReviewList({ items, attemptId }: ReviewListProps) {
  const t = useTranslations("review");
  const [showAll, setShowAll] = useState(false);

  // D5/Task9: AI-explain — busy per-item (Set, не единый флаг: несколько
  // карточек могут стучаться в кнопку независимо), результат/ошибка per-item
  // (Map taskId -> ...) — переживает toggle showAll (state живёт на
  // ReviewList, не на размонтируемых карточках).
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [explainResults, setExplainResults] = useState<Map<string, ExplainResult>>(new Map());
  const [explainErrors, setExplainErrors] = useState<Map<string, ExplainError>>(new Map());

  async function requestExplain(taskId: string) {
    if (busyIds.has(taskId)) return; // busy-lock: повторный клик по этой карточке игнорируется
    setBusyIds((prev) => new Set(prev).add(taskId));
    setExplainErrors((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
    try {
      const res = await fetch(`/api/attempts/${attemptId}/items/${taskId}/explain`, { method: "POST" });
      if (res.status === 429) {
        setExplainErrors((prev) => new Map(prev).set(taskId, "rate_limited"));
        return;
      }
      if (!res.ok) {
        // 502 (llm_unavailable) и любой прочий провал — мягкая деградация,
        // level-0 разбор (уже отрендерен) остаётся рабочим без этой кнопки.
        setExplainErrors((prev) => new Map(prev).set(taskId, "error"));
        return;
      }
      const data = (await res.json()) as ExplainResult;
      setExplainResults((prev) => new Map(prev).set(taskId, data));
    } catch {
      setExplainErrors((prev) => new Map(prev).set(taskId, "error"));
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  }

  if (items.length === 0) return null;

  // Ни одной ошибки — тумблер всё равно рендерится (items.length > 0), чтобы
  // можно было просмотреть полный разбор (в т.ч. верные задания), даже когда
  // ошибок нет вовсе.
  const visible = showAll ? items : items.filter((item) => !item.correct);

  return (
    <section className="mx-auto mt-6 flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="rounded border px-3 py-1 text-sm"
        >
          {showAll ? t("showErrorsOnly") : t("showAll")}
        </button>
      </div>

      {visible.length > 0 && (
        <ul className="flex flex-col gap-4">
          {visible.map((item) => (
            <li key={item.taskId} className="rounded border p-4">
              <p className="mb-2 text-sm text-gray-500">
                {item.orderIndex + 1}. {item.correct && <span className="text-green-700">{t("correct")}</span>}
              </p>

              {item.kind === "unavailable" ? (
                <p className="text-sm text-gray-500">{t("taskUnavailable")}</p>
              ) : (
                <ReviewItemCard
                  item={item}
                  busy={busyIds.has(item.taskId)}
                  result={explainResults.get(item.taskId)}
                  error={explainErrors.get(item.taskId)}
                  onExplain={() => requestExplain(item.taskId)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReviewItemCard({
  item,
  busy,
  result,
  error,
  onExplain,
}: {
  item: Extract<ReviewViewItem, { kind: "available" }>;
  busy: boolean;
  result: ExplainResult | undefined;
  error: ExplainError | undefined;
  onExplain: () => void;
}) {
  const t = useTranslations("review");
  const userAnswerText = formatUserResponse(item.body, item.userResponse);

  return (
    <div className="flex flex-col gap-3">
      {item.body.passage &&
        (item.audio ? (
          <AudioPassage text={item.audio.passage} lang={item.audio.lang} reveal />
        ) : (
          <blockquote className="rounded bg-gray-50 p-3 text-sm text-gray-700">{item.body.passage}</blockquote>
        ))}

      <p className="font-medium">{item.body.prompt}</p>

      <p className="text-sm">
        <span className="text-gray-500">{t("yourAnswer")}: </span>
        {userAnswerText ?? <span className="text-gray-400">{t("unanswered")}</span>}
      </p>

      {item.answerView.kind === "locked" ? (
        <p className="rounded bg-gray-50 p-3 text-sm text-gray-600">{t("inActiveTest")}</p>
      ) : (
        <>
          <p className="text-sm">
            <span className="text-gray-500">{t("correctAnswer")}: </span>
            {item.answerView.correctLabel}
          </p>
          {item.answerView.explanation && (
            <p className="text-sm text-gray-700">
              <span className="text-gray-500">{t("explanation")}: </span>
              {item.answerView.explanation}
            </p>
          )}

          {/* D5/Task9: AI-explain — единственный LLM-путь этапа 3. Только
              full-answerView (locked-карточки кнопку вообще не рендерят —
              см. gate выше "kind === locked"). Только для неправильных ответов. */}
          {!item.correct && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={onExplain}
                disabled={busy}
                className="self-start rounded border px-3 py-1 text-sm font-medium"
              >
                {busy ? t("explainBusy") : t("explainButton")}
              </button>
              {result && (
                <div className="rounded bg-gray-50 p-3 text-sm text-gray-700">
                  <p>{result.explanation}</p>
                  {result.hint && (
                    <p className="mt-1 text-gray-500">
                      <span className="font-medium">{t("explainHint")}: </span>
                      {result.hint}
                    </p>
                  )}
                </div>
              )}
              {error === "rate_limited" && (
                <p className="text-sm text-red-600">{t("explainRateLimited")}</p>
              )}
              {error === "error" && <p className="text-sm text-red-600">{t("explainUnavailable")}</p>}
            </div>
          )}
        </>
      )}

      {!item.correct &&
        (item.similar.length > 0 ? (
          <details className="rounded border border-dashed p-3">
            <summary className="cursor-pointer text-sm font-medium">{t("similarTitle")}</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {item.similar.map((s) => (
                <li key={s.id} className="text-sm text-gray-700">
                  {s.body.prompt}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="text-xs text-gray-400">{t("similarEmpty")}</p>
        ))}
    </div>
  );
}
