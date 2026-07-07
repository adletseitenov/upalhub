// D8: юниты чистой логики Web Speech (НОЛЬ DOM — паттерн timer.test.ts).
import { describe, expect, it } from "vitest";
import {
  chunkText,
  pickVoice,
  primarySubtag,
  resolveAudioView,
  resolveCapability,
} from "./speech";
import type { VoiceInfo } from "./speech";

function voice(overrides: Partial<VoiceInfo> & { name: string; lang: string }): VoiceInfo {
  return { localService: false, default: false, ...overrides };
}

describe("primarySubtag", () => {
  it("extracts the primary subtag from a region-tagged locale", () => {
    expect(primarySubtag("kk-KZ")).toBe("kk");
  });

  it("is case-insensitive", () => {
    expect(primarySubtag("EN-US")).toBe("en");
    expect(primarySubtag("Kk-Kz")).toBe("kk");
  });

  it("handles a bare language tag without a region", () => {
    expect(primarySubtag("ru")).toBe("ru");
  });

  it("handles underscore-separated tags", () => {
    expect(primarySubtag("en_US")).toBe("en");
  });
});

describe("pickVoice", () => {
  it("returns null when only unrelated languages are available", () => {
    const voices = [voice({ name: "Alex", lang: "en-US" }), voice({ name: "Milena", lang: "ru-RU" })];
    expect(pickVoice(voices, "kk-KZ")).toBeNull();
  });

  it("matches by primary subtag regardless of region", () => {
    const voices = [voice({ name: "Alex", lang: "en-US" }), voice({ name: "Daniel", lang: "en-GB" })];
    const picked = pickVoice(voices, "en-AU");
    expect(picked?.name).toBe("Alex"); // tie -> alphabetical (both non-local, non-default)
  });

  it("prioritizes localService over default and name", () => {
    const voices = [
      voice({ name: "Zeta", lang: "en-US", localService: true, default: false }),
      voice({ name: "Alpha", lang: "en-US", localService: false, default: true }),
    ];
    expect(pickVoice(voices, "en-US")?.name).toBe("Zeta");
  });

  it("prioritizes default when localService is tied", () => {
    const voices = [
      voice({ name: "Zeta", lang: "en-US", localService: true, default: true }),
      voice({ name: "Alpha", lang: "en-US", localService: true, default: false }),
    ];
    expect(pickVoice(voices, "en-US")?.name).toBe("Zeta");
  });

  it("breaks ties deterministically by name.localeCompare", () => {
    const voices = [
      voice({ name: "Zeta", lang: "en-US", localService: true, default: true }),
      voice({ name: "Alpha", lang: "en-US", localService: true, default: true }),
    ];
    expect(pickVoice(voices, "en-US")?.name).toBe("Alpha");
  });

  it("returns null for an empty voice list", () => {
    expect(pickVoice([], "en-US")).toBeNull();
  });
});

describe("resolveCapability", () => {
  it("falls back to unsupported when the browser has no speechSynthesis, even if voices aren't ready", () => {
    const voices = [voice({ name: "Alex", lang: "en-US" })];
    expect(resolveCapability(false, voices, "en-US", false)).toEqual({
      mode: "fallback",
      reason: "unsupported",
    });
  });

  it("falls back to no_voice when supported, voices are ready, but nothing matches the language", () => {
    const voices = [voice({ name: "Alex", lang: "en-US" })];
    expect(resolveCapability(true, voices, "kk-KZ", true)).toEqual({
      mode: "fallback",
      reason: "no_voice",
    });
  });

  it("resolves to speak with the picked voice when a match exists and voices are ready", () => {
    const enVoice = voice({ name: "Alex", lang: "en-US", localService: true });
    const result = resolveCapability(true, [enVoice], "en-US", true);
    expect(result).toEqual({ mode: "speak", voice: enVoice });
  });

  it("resolves to loading when supported but voices aren't ready yet, regardless of the (stale) voice list", () => {
    // Cold-start: first getVoices() call in the session returns [] in
    // Chrome/Edge before voiceschanged fires. voicesReady=false must win
    // over an empty list -> 'loading', not 'fallback:no_voice'.
    expect(resolveCapability(true, [], "kk-KZ", false)).toEqual({ mode: "loading" });
  });

  it("resolves to loading when voices aren't ready even if a matching voice is already present in the (stale) list", () => {
    // Repeated renders can carry a non-empty voices array from a previous
    // capability check while voicesReady is still false (e.g. a brief
    // window before the ready-flag propagates) -> still 'loading', never
    // jump straight to 'speak' on an unconfirmed list.
    const enVoice = voice({ name: "Alex", lang: "en-US" });
    expect(resolveCapability(true, [enVoice], "en-US", false)).toEqual({ mode: "loading" });
  });
});

describe("chunkText", () => {
  const transcript =
    "The morning lecture covers three main topics in modern economics. First, we examine " +
    "how supply and demand interact in competitive markets, tracing the effect of a small " +
    "price change on overall consumer behavior. Second, the lecturer introduces the concept " +
    "of elasticity, explaining why some goods respond sharply to price shifts while others " +
    "remain stable regardless of cost. Third, the discussion turns to government intervention, " +
    "weighing the benefits of subsidies against the risks of long-term market distortion. " +
    "Students are encouraged to take notes on each example, since the following seminar will " +
    "require them to apply these ideas to a real case study drawn from recent trade policy.";

  it("splits a normal transcript into chunks no longer than maxChars", () => {
    const chunks = chunkText(transcript);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
      expect(chunk.trim()).not.toBe("");
    }
  });

  it("preserves every word when chunks are rejoined with spaces", () => {
    const chunks = chunkText(transcript);
    const rejoinedWords = chunks.join(" ").split(/\s+/).filter(Boolean);
    const originalWords = transcript.split(/\s+/).filter(Boolean);
    expect(rejoinedWords).toEqual(originalWords);
  });

  it("hard-splits a single sentence longer than maxChars at a word boundary", () => {
    const longSentence = `This is a single very long sentence without any punctuation break ${"word ".repeat(40)}end.`;
    const chunks = chunkText(longSentence, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    // No chunk boundary should have sliced a word in half: every chunk after
    // trimming still consists of whole space-separated tokens.
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^\s|\s$/);
    }
  });

  it("hard-splits a run without any spaces at exactly maxChars", () => {
    const noBoundary = "a".repeat(450);
    const chunks = chunkText(noBoundary, 200);
    expect(chunks).toEqual(["a".repeat(200), "a".repeat(200), "a".repeat(50)]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("greedily packs short sentences into a single chunk", () => {
    const chunks = chunkText("One. Two. Three.", 200);
    expect(chunks).toEqual(["One. Two. Three."]);
  });

  it("respects a custom maxChars", () => {
    const chunks = chunkText("One. Two. Three.", 5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(5);
    }
    expect(chunks.join(" ")).toContain("One");
    expect(chunks.join(" ")).toContain("Two");
    expect(chunks.join(" ")).toContain("Three");
  });
});

describe("resolveAudioView", () => {
  it("returns fallback whenever capability is a fallback, regardless of reveal", () => {
    expect(resolveAudioView({ mode: "fallback", reason: "no_voice" }, false)).toBe("fallback");
    expect(resolveAudioView({ mode: "fallback", reason: "unsupported" }, true)).toBe("fallback");
  });

  it("returns controls when speak capability and reveal is false", () => {
    const cap = { mode: "speak" as const, voice: voice({ name: "Alex", lang: "en-US" }) };
    expect(resolveAudioView(cap, false)).toBe("controls");
  });

  it("returns reveal when speak capability and reveal is true", () => {
    const cap = { mode: "speak" as const, voice: voice({ name: "Alex", lang: "en-US" }) };
    expect(resolveAudioView(cap, true)).toBe("reveal");
  });

  it("returns loading whenever capability is loading, regardless of reveal", () => {
    // This is the branch that closes the cold-start transcript-flash bug:
    // 'loading' must win over both fallback and reveal so AudioPassage
    // never renders the transcript before voice discovery settles.
    expect(resolveAudioView({ mode: "loading" }, false)).toBe("loading");
    expect(resolveAudioView({ mode: "loading" }, true)).toBe("loading");
  });
});
