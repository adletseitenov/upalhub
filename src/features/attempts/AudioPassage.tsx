"use client";
// D8: аудио-виджет listening-секций. hidden = честный формат экзамена
// (в реальном listening ты тоже не видишь скрипт), НЕ анти-чит — passage
// неизбежно присутствует в client props уже сейчас, потому что клиентский
// TTS (Web Speech API) может озвучить только текст, который у него есть.
import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { resolveAudioView } from "./speech";
import { useSpeechSynthesis } from "./useSpeechSynthesis";

export type AudioPassageProps = {
  text: string;
  lang: string;
  /** Показать транскрипт (этап 3: разбор после сабмита). Default false. */
  reveal?: boolean;
};

function subscribeNoop() {
  return () => {};
}
function getClientSnapshot() {
  return true;
}
function getServerSnapshot() {
  return false;
}

// Гейт на "смонтировано на клиенте" через useSyncExternalStore (а не
// useEffect+setState — та форма триггерит react-hooks/set-state-in-effect
// и всё равно красит лишний кадр). На сервере speechSynthesis всегда
// "unsupported" (window нет): без гейта fallback-ветка утекла бы полный
// транскрипт в SSR-разметку даже для браузеров, которые реально его озвучат.
function useHasMounted(): boolean {
  return useSyncExternalStore(subscribeNoop, getClientSnapshot, getServerSnapshot);
}

export function AudioPassage({ text, lang, reveal = false }: AudioPassageProps) {
  const t = useTranslations("audio");
  const { capability, state, playCount, play, pause, resume, replay } = useSpeechSynthesis(text, lang);
  const mounted = useHasMounted();

  if (!mounted) {
    return <p className="mb-3 text-sm text-gray-500">{t("preparing")}</p>;
  }

  const view = resolveAudioView(capability, reveal);

  // Голоса браузера ещё не подгрузились (Chrome/Edge cold-start: первый
  // getVoices() почти всегда []) — рано решать speak vs fallback, поэтому
  // тот же preparing-плейсхолдер, что и до гидратации. Транскрипт сюда
  // НЕ идёт: инвариант "speak && !reveal → транскрипта нет в DOM" не должен
  // на мгновение нарушаться, пока мы просто ждём voiceschanged.
  if (view === "loading") {
    return <p className="mb-3 text-sm text-gray-500">{t("preparing")}</p>;
  }

  if (view === "fallback") {
    const note = capability.mode === "fallback" && capability.reason === "no_voice"
      ? t("noVoiceNote")
      : t("unsupportedNote");
    return (
      <div className="mb-3 flex flex-col gap-2">
        <p className="text-sm text-gray-500">{note}</p>
        <p className="text-sm font-medium text-gray-700">{t("transcriptLabel")}</p>
        <blockquote className="rounded bg-gray-50 p-3 text-sm text-gray-700">{text}</blockquote>
      </div>
    );
  }

  if (view === "reveal") {
    return (
      <div className="mb-3 flex flex-col gap-2">
        <blockquote className="rounded bg-gray-50 p-3 text-sm text-gray-700">{text}</blockquote>
        <button
          type="button"
          onClick={replay}
          aria-label={t("replay")}
          className="self-start rounded border px-3 py-1 text-sm"
        >
          {t("replay")}
        </button>
      </div>
    );
  }

  // view === "controls": транскрипт намеренно НЕ в DOM.
  return (
    <div className="mb-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {state === "speaking" && (
          <button
            type="button"
            onClick={pause}
            aria-label={t("pause")}
            className="rounded border px-3 py-1 text-sm"
          >
            {t("pause")}
          </button>
        )}
        {state === "paused" && (
          <button
            type="button"
            onClick={resume}
            aria-label={t("resume")}
            className="rounded border px-3 py-1 text-sm"
          >
            {t("resume")}
          </button>
        )}
        {(state === "idle" || state === "ended") && (
          <button
            type="button"
            onClick={play}
            aria-label={t("play")}
            className="rounded border px-3 py-1 text-sm"
          >
            {t("play")}
          </button>
        )}
        <button
          type="button"
          onClick={replay}
          aria-label={t("replay")}
          className="rounded border px-3 py-1 text-sm"
        >
          {t("replay")}
        </button>
      </div>
      {playCount > 0 && <p className="text-sm text-gray-500">{t("listenCount", { count: playCount })}</p>}
      <p className="text-xs text-gray-400">{t("hint")}</p>
    </div>
  );
}
