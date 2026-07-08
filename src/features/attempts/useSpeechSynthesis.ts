"use client";
// D8: браузерные эффекты Web Speech API (паттерн timer.ts: чистая логика
// в speech.ts, setInterval/window-события живут здесь). НЕ тестируется
// юнитами (JSDOM speechSynthesis не в репо) — покрыто через speech.ts'ные
// resolveCapability/chunkText и ручной прод-smoke (T10).
import { useCallback, useEffect, useRef, useState } from "react";
import { chunkText, resolveCapability } from "./speech";
import type { SpeechCapability, VoiceInfo } from "./speech";

export type SpeechPlaybackState = "idle" | "speaking" | "paused" | "ended";

export type UseSpeechSynthesisResult = {
  capability: SpeechCapability;
  state: SpeechPlaybackState;
  playCount: number;
  play: () => void;
  pause: () => void;
  resume: () => void;
  replay: () => void;
};

const KEEP_ALIVE_MS = 10_000; // Chrome pause-bug: speechSynthesis молча
// засыпает на длинных очередях без периодического resume().

// Backlog wave fix9: window.speechSynthesis — глобальный singleton, но
// каждый смонтированный useSpeechSynthesis() — свой независимый инстанс
// (напр. несколько audio-заданий на странице теста). play() ВСЕГДА зовёт
// cancel() на singleton перед стартом (см. startPlayback ниже) — если
// инстанс A уже играет и держит keep-alive setInterval, а инстанс B
// вызывает play(), B молча обрывает очередь A, но A ничего об этом не
// знает: его keepAliveRef живёт своей жизнью и продолжает resume()
// глобальный synth каждые 10с, воюя с B за тот же singleton. Module-level
// счётчик — "кто сейчас реально владеет synth": play()/replay() инкрементят
// его и запоминают свой токен; keep-alive/pause/resume сверяют СВОЙ токен с
// текущим владельцем и становятся no-op, если их перехватили — без этого
// поля инстанс, foreignным play() уже вытесненный, не может отличить себя
// от актуального владельца.
let activeSpeechOwner = 0;

const VOICES_READY_TIMEOUT_MS = 1_500; // страховка для браузеров без
// voiceschanged и без голосов вовсе (iOS Safari в некоторых версиях): после
// таймаута считаем список голосов финальным, даже если он пуст.

function isSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function currentVoices(): VoiceInfo[] {
  if (!isSupported()) return [];
  return window.speechSynthesis.getVoices().map((voice) => ({
    name: voice.name,
    lang: voice.lang,
    localService: voice.localService,
    default: voice.default,
  }));
}

export function useSpeechSynthesis(text: string, language: string): UseSpeechSynthesisResult {
  const supported = isSupported();
  const [voices, setVoices] = useState<VoiceInfo[]>(() => currentVoices());
  // voicesReady различает "ещё не спрашивали браузер" от "спросили и
  // получили []": на Chrome/Edge первый getVoices() в сессии почти всегда
  // возвращает [] до voiceschanged, даже когда голоса для языка реально
  // есть. Без этого различия resolveCapability не может отличить "голоса
  // грузятся" от "голосов для языка нет вообще" (см. speech.ts).
  const [voicesReady, setVoicesReady] = useState<boolean>(() => currentVoices().length > 0);
  const [state, setState] = useState<SpeechPlaybackState>("idle");
  const [playCount, setPlayCount] = useState(0);

  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Backlog wave fix9: 0 = "never claimed ownership yet" (distinct from any
  // real token, which starts at 1 — see activeSpeechOwner increments below).
  const ownerTokenRef = useRef(0);

  // Async голоса (Chrome): подписка на voiceschanged держит capability в
  // актуальном состоянии, как только браузер догружает голосовой список.
  // Событие voiceschanged — сигнал "браузер отдал финальный список" даже
  // если он пустой, поэтому оно всегда взводит voicesReady; синхронная
  // проверка на mount взводит его только если список уже непуст (иначе мы
  // бы считали "ещё не готово" готовым с самого начала).
  useEffect(() => {
    if (!supported) return;
    function handleVoicesChanged() {
      setVoices(currentVoices());
      setVoicesReady(true);
    }
    // Indirection (named function, not an inline setState call) matches the
    // existing handleVoicesChanged pattern above and keeps
    // react-hooks/set-state-in-effect (React Compiler ESLint plugin) happy
    // — see s25-task-8-report.md "Проблема по пути" for the same rule
    // tripping on a direct setState-in-effect earlier in this feature.
    function checkInitialVoices() {
      const initial = currentVoices();
      if (initial.length > 0) {
        setVoices(initial);
        setVoicesReady(true);
      }
    }
    window.speechSynthesis.addEventListener("voiceschanged", handleVoicesChanged);
    checkInitialVoices();
    return () => window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
  }, [supported]);

  // Таймаут-страховка: браузеры без voiceschanged и без единого голоса
  // (некоторые версии iOS Safari) иначе держали бы нас в 'loading' вечно.
  useEffect(() => {
    if (!supported || voicesReady) return;
    const timer = setTimeout(() => setVoicesReady(true), VOICES_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [supported, voicesReady]);

  const clearKeepAlive = useCallback(() => {
    if (keepAliveRef.current !== null) {
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
    }
  }, []);

  const startKeepAlive = useCallback(() => {
    clearKeepAlive();
    // Backlog wave fix9: closes over the token captured at THIS call's
    // owner (not a live ref read) — if a later play() from ANY instance
    // (including a different mount) bumps activeSpeechOwner, this interval
    // becomes an inert no-op instead of fighting the new owner's playback.
    const myToken = ownerTokenRef.current;
    keepAliveRef.current = setInterval(() => {
      if (isSupported() && myToken === activeSpeechOwner) window.speechSynthesis.resume();
    }, KEEP_ALIVE_MS);
  }, [clearKeepAlive]);

  // cancel() гарантированно останавливает звук при размонтировании
  // (переход между заданиями/секциями) — singleton speechSynthesis иначе
  // продолжает играть поверх следующего экрана.
  useEffect(() => {
    return () => {
      clearKeepAlive();
      if (isSupported()) window.speechSynthesis.cancel();
    };
  }, [clearKeepAlive]);

  const startPlayback = useCallback(() => {
    if (!isSupported()) return;
    // Повторный getVoices() на каждый play (не только на mount) — iOS не
    // всегда шлёт voiceschanged, но к моменту первого user-gesture голоса
    // уже могут быть загружены браузером.
    const freshVoices = currentVoices();
    setVoices(freshVoices);
    // play()/replay() только доступны из controls/reveal-разметки, которая
    // сама требует mode:"speak" (см. resolveAudioView) — voicesReady уже
    // true к этому моменту. Передаём его как есть, а не жёстко true: если
    // это когда-нибудь вызовут раньше готовности, бейлаут ниже (mode !==
    // "speak") сработает безопасно вместо озвучки неполного состояния.
    const freshCapability = resolveCapability(true, freshVoices, language, voicesReady);
    if (freshCapability.mode !== "speak") return;

    // Backlog wave fix9: claim ownership of the singleton BEFORE cancel()
    // — any other instance's keep-alive/pause/resume checks this same
    // counter and stands down once it no longer matches their captured
    // token.
    activeSpeechOwner += 1;
    ownerTokenRef.current = activeSpeechOwner;

    // cancel() ПЕРЕД стартом — speechSynthesis глобальный singleton, без
    // этого новая очередь наслаивается поверх недоигранной старой.
    window.speechSynthesis.cancel();

    const chunks = chunkText(text);
    if (chunks.length === 0) return;

    const synthVoices = window.speechSynthesis.getVoices();
    const matchedVoice =
      synthVoices.find(
        (voice) => voice.name === freshCapability.voice.name && voice.lang === freshCapability.voice.lang,
      ) ?? null;

    chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.lang = freshCapability.voice.lang;
      if (matchedVoice) utterance.voice = matchedVoice;
      if (index === chunks.length - 1) {
        utterance.onend = () => {
          setState("ended");
          clearKeepAlive();
        };
      }
      window.speechSynthesis.speak(utterance);
    });

    setState("speaking");
    startKeepAlive();
  }, [text, language, voicesReady, clearKeepAlive, startKeepAlive]);

  // play()/replay() из onClick — user gesture требование браузеров для
  // разрешения аудио. playCount растёт на каждый явный старт заново, но
  // НЕ на resume() (это продолжение того же прослушивания).
  const play = useCallback(() => {
    setPlayCount((count) => count + 1);
    startPlayback();
  }, [startPlayback]);

  const replay = useCallback(() => {
    setPlayCount((count) => count + 1);
    startPlayback();
  }, [startPlayback]);

  // Backlog wave fix9: no-op if a later play() (this instance's own replay,
  // or a DIFFERENT instance) has already taken over the singleton — a stale
  // owner pausing/resuming would otherwise act on whatever the new owner is
  // actually playing.
  const isOwner = useCallback(() => ownerTokenRef.current === activeSpeechOwner, []);

  const pause = useCallback(() => {
    if (!isSupported() || !isOwner()) return;
    window.speechSynthesis.pause();
    clearKeepAlive();
    setState("paused");
  }, [clearKeepAlive, isOwner]);

  const resume = useCallback(() => {
    if (!isSupported() || !isOwner()) return;
    window.speechSynthesis.resume();
    startKeepAlive();
    setState("speaking");
  }, [startKeepAlive, isOwner]);

  const capability = resolveCapability(supported, voices, language, voicesReady);

  return { capability, state, playCount, play, pause, resume, replay };
}
