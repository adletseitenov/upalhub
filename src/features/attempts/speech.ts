// D8: аудио для listening-секций через Web Speech API. Эта функция — НОЛЬ
// DOM/эффектов (паттерн timer.ts): чистая логика тестируется без браузера,
// побочные эффекты (speechSynthesis, события) живут в useSpeechSynthesis.ts.

export type VoiceInfo = {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
};

export type SpeechCapability =
  | { mode: "speak"; voice: VoiceInfo }
  | { mode: "fallback"; reason: "unsupported" | "no_voice" };

/**
 * primarySubtag — BCP-47 primary language subtag, регистронезависимо:
 * 'kk-KZ' -> 'kk', 'EN_us' -> 'en', 'ru' -> 'ru'.
 */
export function primarySubtag(lang: string): string {
  return lang.trim().split(/[-_]/)[0]?.toLowerCase() ?? "";
}

/**
 * pickVoice — голос браузера для языка секции по совпадению primary
 * subtag'а. Среди совпадений приоритет: localService (офлайн, стабильнее
 * на мобильных) -> default (браузерный дефолт для языка) -> детерминированный
 * тайбрейк по name.localeCompare. Нет совпадений -> null (вызывающий код
 * уходит в fallback).
 */
export function pickVoice(voices: VoiceInfo[], language: string): VoiceInfo | null {
  const subtag = primarySubtag(language);
  const matches = voices.filter((voice) => primarySubtag(voice.lang) === subtag);
  if (matches.length === 0) return null;

  const sorted = [...matches].sort((a, b) => {
    if (a.localService !== b.localService) return a.localService ? -1 : 1;
    if (a.default !== b.default) return a.default ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return sorted[0] ?? null;
}

/**
 * resolveCapability — три ветки: браузер не поддерживает speechSynthesis
 * вовсе ('unsupported'); поддерживает, но нет голоса под язык секции
 * ('no_voice', ожидаемо почти для всего kk); есть подходящий голос ('speak').
 */
export function resolveCapability(
  supported: boolean,
  voices: VoiceInfo[],
  language: string,
): SpeechCapability {
  if (!supported) return { mode: "fallback", reason: "unsupported" };
  const voice = pickVoice(voices, language);
  if (!voice) return { mode: "fallback", reason: "no_voice" };
  return { mode: "speak", voice };
}

const SENTENCE_SPLIT_RE = /[.!?…]+\s|\n+/;
const DELIMITER_TEST_RE = /^([.!?…]+\s|\n+)$/;

function splitSentences(text: string): string[] {
  // Split с capturing-group сохраняет терминатор как отдельный элемент
  // массива (String.split включает захваченные группы) — склеиваем его
  // обратно с предыдущим куском, чтобы точка/восклицание не терялись.
  const parts = text.split(new RegExp(`(${SENTENCE_SPLIT_RE.source})`));
  const sentences: string[] = [];
  let current = "";
  for (const part of parts) {
    if (!part) continue;
    current += part;
    if (DELIMITER_TEST_RE.test(part)) {
      const trimmed = current.trim();
      if (trimmed) sentences.push(trimmed);
      current = "";
    }
  }
  const remainder = current.trim();
  if (remainder) sentences.push(remainder);
  return sentences;
}

/**
 * hardSplit — режет сверхдлинное (>maxChars) предложение на куски по
 * ближайшему пробелу/запятой не позже maxChars; если границы нет (одно
 * гигантское "слово") — жёсткий разрез ровно по maxChars.
 */
function hardSplit(sentence: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let remaining = sentence.trim();
  while (remaining.length > maxChars) {
    let splitAt = -1;
    for (let i = maxChars; i > 0; i--) {
      const ch = remaining[i];
      if (ch === " " || ch === ",") {
        splitAt = i;
        break;
      }
    }
    if (splitAt <= 0) splitAt = maxChars;
    const piece = remaining.slice(0, splitAt).trim();
    if (piece) pieces.push(piece);
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces;
}

/**
 * chunkText — режет транскрипт на куски ≤maxChars для очереди
 * SpeechSynthesisUtterance (лечит обрыв ~15с в Chrome на длинных
 * utterance). Сентенс-сплит с сохранением терминатора, жадная склейка
 * соседних предложений в один чанк, сверхдлинное предложение — hard-split.
 * Пустые чанки дропаются; join(' ') результата сохраняет все слова текста.
 */
export function chunkText(text: string, maxChars = 200): string[] {
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...hardSplit(sentence, maxChars));
      continue;
    }
    if (current === "") {
      current = sentence;
    } else if (current.length + 1 + sentence.length <= maxChars) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);

  return chunks.filter((chunk) => chunk.trim() !== "");
}

export type AudioView = "controls" | "fallback" | "reveal";

/**
 * resolveAudioView — чистая проекция (capability, reveal) -> какую ветку
 * рендерить в AudioPassage. Вынесена из компонента, т.к. в репо нет
 * @testing-library/react (компоненты по конвенции не тестируются) —
 * ветвление всё равно покрыто юнитами здесь.
 */
export function resolveAudioView(capability: SpeechCapability, reveal: boolean): AudioView {
  if (capability.mode === "fallback") return "fallback";
  return reveal ? "reveal" : "controls";
}
