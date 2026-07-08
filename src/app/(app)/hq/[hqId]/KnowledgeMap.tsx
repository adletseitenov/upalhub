"use client";
import { useTranslations } from "next-intl";
import type { KnowledgeBand } from "@/features/knowledge/constants";
import type { KnowledgeMapSection } from "@/features/hq/dashboard-view";

export type KnowledgeMapProps = { sections: KnowledgeMapSection[] };

const BAND_BAR_CLASS: Record<KnowledgeBand, string> = {
  weak: "bg-red-400",
  shaky: "bg-amber-400",
  strong: "bg-green-600",
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// D2/Task6: чисто презентационный компонент — band/stale/"не изведано" уже
// посчитаны сервером (src/features/hq/dashboard-view.ts,
// buildKnowledgeMapSections), здесь только рендер. "use client" по брифу
// задачи, не ради интерактивности: секции — нативные <details>/<summary>
// (аккордеон без единого байта JS-state), удобно и на мобиле, и на десктопе.
export function KnowledgeMap({ sections }: KnowledgeMapProps) {
  const t = useTranslations("hqDashboard");

  if (sections.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold">{t("mapTitle")}</h2>
      <div className="flex flex-col gap-2">
        {sections.map((section) => (
          <details key={section.name} open className="rounded border p-3">
            <summary className="cursor-pointer font-medium">{section.name}</summary>
            <ul className="mt-3 flex flex-col gap-3">
              {section.topics.map((topic) => (
                <li key={topic.topic} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span>{topic.topic}</span>
                    {topic.state ? (
                      <span className="flex items-center gap-2 text-gray-500">
                        <span>{t(`band${capitalize(topic.state.band)}`)}</span>
                        {topic.state.stale && (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                            {t("staleBadge")}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-400">{t("unexplored")}</span>
                    )}
                  </div>
                  {topic.state ? (
                    <div className="h-2 w-full rounded bg-gray-100">
                      <div
                        className={`h-2 rounded ${BAND_BAR_CLASS[topic.state.band]}`}
                        style={{ width: `${Math.round(topic.state.level * 100)}%` }}
                      />
                    </div>
                  ) : (
                    // "не изведано": серый пунктир БЕЗ процента (D2) — намеренно
                    // не бар с width=0, чтобы не читалось как "0%".
                    <div className="h-2 w-full rounded border border-dashed border-gray-300" />
                  )}
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}
