import { describe, expect, it } from "vitest";
import type { ExamProfileSpec } from "@/features/exam-profile/spec";
import {
  applyModalityProposals,
  computeProfileModalityDiff,
  formatModalityDiffLine,
  proposeModalityForSectionName,
} from "./backfill-modality";

// --- proposeModalityForSectionName -----------------------------------------

describe("proposeModalityForSectionName", () => {
  it.each([
    ["Listening", "audio"],
    ["Listening Comprehension", "audio"],
    ["Аудирование", "audio"],
    ["Тыңдалым", "audio"],
    ["Speaking", "speaking"],
    ["Говорение", "speaking"],
    ["Сөйлеу", "speaking"],
  ] as const)("proposes %s -> %s", (name, expected) => {
    expect(proposeModalityForSectionName(name)).toBe(expected);
  });

  it("is case-insensitive", () => {
    expect(proposeModalityForSectionName("LISTENING")).toBe("audio");
    expect(proposeModalityForSectionName("speaking part 2")).toBe("speaking");
  });

  it("returns null for a section name with no audio/speaking hint", () => {
    expect(proposeModalityForSectionName("Математика")).toBeNull();
    expect(proposeModalityForSectionName("Reading")).toBeNull();
  });
});

// --- computeProfileModalityDiff ---------------------------------------------

function spec(sections: ExamProfileSpec["sections"]): ExamProfileSpec {
  return {
    examName: "Test Exam",
    language: "en",
    description: "d",
    sections,
    variants: [],
    selectionGroups: [],
    scoring: { scaleMin: 0, scaleMax: 100, unit: "points" },
  };
}

describe("computeProfileModalityDiff", () => {
  it("proposes audio for an absent-modality Listening section", () => {
    const profile = {
      id: "p1",
      slug: "ielts",
      spec: spec([{ name: "Listening", taskTypes: [], topics: [] }]),
    };
    const diff = computeProfileModalityDiff(profile);
    expect(diff).toEqual([
      { profileId: "p1", profileSlug: "ielts", sectionName: "Listening", from: null, to: "audio" },
    ]);
  });

  it("proposes speaking for a modality:text Speaking section (absent/text both eligible)", () => {
    const profile = {
      id: "p1",
      slug: "ielts",
      spec: spec([{ name: "Speaking", taskTypes: [], topics: [], modality: "text" }]),
    };
    const diff = computeProfileModalityDiff(profile);
    expect(diff).toEqual([
      { profileId: "p1", profileSlug: "ielts", sectionName: "Speaking", from: "text", to: "speaking" },
    ]);
  });

  it("is idempotent: a section already marked audio is never re-proposed", () => {
    const profile = {
      id: "p1",
      slug: "ielts",
      spec: spec([{ name: "Listening", taskTypes: [], topics: [], modality: "audio" }]),
    };
    expect(computeProfileModalityDiff(profile)).toEqual([]);
  });

  it("is idempotent: a section already marked speaking is never re-proposed", () => {
    const profile = {
      id: "p1",
      slug: "ielts",
      spec: spec([{ name: "Speaking", taskTypes: [], topics: [], modality: "speaking" }]),
    };
    expect(computeProfileModalityDiff(profile)).toEqual([]);
  });

  it("skips sections whose name gives no audio/speaking hint", () => {
    const profile = {
      id: "p1",
      slug: "ielts",
      spec: spec([{ name: "Reading", taskTypes: [], topics: [] }]),
    };
    expect(computeProfileModalityDiff(profile)).toEqual([]);
  });

  it("handles a mixed section list, only proposing for the matching ones", () => {
    const profile = {
      id: "p1",
      slug: "ielts",
      spec: spec([
        { name: "Listening", taskTypes: [], topics: [] },
        { name: "Reading", taskTypes: [], topics: [] },
        { name: "Speaking", taskTypes: [], topics: [] },
        { name: "Writing", taskTypes: [], topics: [] },
      ]),
    };
    const diff = computeProfileModalityDiff(profile);
    expect(diff.map((p) => p.sectionName).sort()).toEqual(["Listening", "Speaking"]);
  });
});

// --- applyModalityProposals --------------------------------------------------

describe("applyModalityProposals", () => {
  it("writes the proposed modality onto matching sections, leaving others untouched", () => {
    const original = spec([
      { name: "Listening", taskTypes: [], topics: [] },
      { name: "Reading", taskTypes: [], topics: [] },
    ]);
    const proposals = computeProfileModalityDiff({ id: "p1", slug: "ielts", spec: original });
    const updated = applyModalityProposals(original, proposals);
    expect(updated.sections.find((s) => s.name === "Listening")?.modality).toBe("audio");
    expect(updated.sections.find((s) => s.name === "Reading")?.modality).toBeUndefined();
  });

  it("does not mutate the original spec object", () => {
    const original = spec([{ name: "Listening", taskTypes: [], topics: [] }]);
    const proposals = computeProfileModalityDiff({ id: "p1", slug: "ielts", spec: original });
    applyModalityProposals(original, proposals);
    expect(original.sections[0].modality).toBeUndefined();
  });

  it("is a no-op (returns an equivalent spec) when there are no proposals", () => {
    const original = spec([{ name: "Reading", taskTypes: [], topics: [] }]);
    const updated = applyModalityProposals(original, []);
    expect(updated).toEqual(original);
  });
});

// --- formatModalityDiffLine --------------------------------------------------

describe("formatModalityDiffLine", () => {
  it("formats an absent-from proposal", () => {
    const line = formatModalityDiffLine({
      profileId: "p1",
      profileSlug: "ielts",
      sectionName: "Listening",
      from: null,
      to: "audio",
    });
    expect(line).toBe('ielts :: "Listening" :: (absent) -> audio');
  });

  it("formats a text-from proposal", () => {
    const line = formatModalityDiffLine({
      profileId: "p1",
      profileSlug: "ielts",
      sectionName: "Speaking",
      from: "text",
      to: "speaking",
    });
    expect(line).toBe('ielts :: "Speaking" :: text -> speaking');
  });
});
