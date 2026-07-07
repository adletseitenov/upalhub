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
  const [state, setState] = useState<SpeechPlaybackState>("idle");
  const [playCount, setPlayCount] = useState(0);

  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Async голоса (Chrome): подписка на voiceschanged держит capability в
  // актуальном состоянии, как только браузер догружает голосовой список.
  useEffect(() => {
    if (!supported) return;
    function handleVoicesChanged() {
      setVoices(currentVoices());
    }
    window.speechSynthesis.addEventListener("voiceschanged", handleVoicesChanged);
    handleVoicesChanged();
    return () => window.speechSynthesis.removeEventListener("voiceschanged", handleVoicesChanged);
  }, [supported]);

  const clearKeepAlive = useCallback(() => {
    if (keepAliveRef.current !== null) {
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
    }
  }, []);

  const startKeepAlive = useCallback(() => {
    clearKeepAlive();
    keepAliveRef.current = setInterval(() => {
      if (isSupported()) window.speechSynthesis.resume();
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
    const freshCapability = resolveCapability(true, freshVoices, language);
    if (freshCapability.mode !== "speak") return;

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
  }, [text, language, clearKeepAlive, startKeepAlive]);

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

  const pause = useCallback(() => {
    if (!isSupported()) return;
    window.speechSynthesis.pause();
    clearKeepAlive();
    setState("paused");
  }, [clearKeepAlive]);

  const resume = useCallback(() => {
    if (!isSupported()) return;
    window.speechSynthesis.resume();
    startKeepAlive();
    setState("speaking");
  }, [startKeepAlive]);

  const capability = resolveCapability(supported, voices, language);

  return { capability, state, playCount, play, pause, resume, replay };
}
