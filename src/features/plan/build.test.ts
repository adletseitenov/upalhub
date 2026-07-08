import { describe, expect, it } from "vitest";
import type { ExamSection } from "@/features/exam-profile/spec";
import type { TopicState } from "@/features/knowledge/compute";
import { BAND_STRONG, BAND_WEAK, levelToBand } from "@/features/knowledge/constants";
import { buildStudyPlan, mondayUtc, planWeekTopicsSchema } from "./build";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

function section(name: string, topics: string[]): ExamSection {
  return { name, taskTypes: [], topics };
}

function state(overrides: Partial<TopicState> = {}): TopicState {
  return { level: 0.5, answeredCount: 3, lastSeenAt: new Date("2026-07-08T00:00:00Z"), ...overrides };
}

// --- planWeekTopicsSchema ----------------------------------------------------

describe("planWeekTopicsSchema", () => {
  it("accepts a well-formed week payload", () => {
    const payload = {
      focus: [{ topic: "algebra", section: "Математика", band: "weak", reason: "weak" }],
      suggestedTest: { kind: "practice" },
    };
    expect(planWeekTopicsSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects an unknown band value", () => {
    const payload = {
      focus: [{ topic: "algebra", section: "Математика", band: "red", reason: "weak" }],
      suggestedTest: { kind: "practice" },
    };
    expect(planWeekTopicsSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects an unknown suggestedTest.kind", () => {
    const payload = { focus: [], suggestedTest: { kind: "final" } };
    expect(planWeekTopicsSchema.safeParse(payload).success).toBe(false);
  });
});

// --- mondayUtc ---------------------------------------------------------------

describe("mondayUtc", () => {
  it("returns the same date when today already is a Monday", () => {
    // 2026-07-06 is a Monday (verified against NOW=2026-07-08 Wednesday used
    // across the Stage3 suite: 2026-07-08 - 2 days = Monday).
    expect(mondayUtc(new Date("2026-07-06T12:00:00Z"))).toBe("2026-07-06");
  });

  it("resolves a mid-week date back to that week's Monday", () => {
    expect(mondayUtc(new Date("2026-07-08T00:00:00Z"))).toBe("2026-07-06");
  });

  it("resolves a Sunday to the Monday six days earlier (not the following Monday)", () => {
    expect(mondayUtc(new Date("2026-07-05T12:00:00Z"))).toBe("2026-06-29");
  });

  // 🔴 TZ-independence: these two instants are 2 hours apart in UTC and land
  // on opposite sides of the Sun/Mon boundary. If the implementation used
  // local getDay()/getDate() instead of the UTC variants, a host running in
  // a positive UTC offset (e.g. Asia/Almaty, UTC+5) would see 2026-07-05
  // 23:00Z as already local Monday 2026-07-06 04:00 and misreport the Monday
  // as 2026-07-06 instead of the correct 2026-06-29 — a whole week off.
  it("is TZ-independent: 23:00 UTC Sunday resolves to the Monday six days earlier", () => {
    const sundayLate = new Date("2026-07-05T23:00:00Z");
    expect(mondayUtc(sundayLate)).toBe("2026-06-29");
  });

  it("is TZ-independent: 01:00 UTC Monday resolves to that same Monday", () => {
    const mondayEarly = new Date("2026-07-06T01:00:00Z");
    expect(mondayUtc(mondayEarly)).toBe("2026-07-06");
  });
});

// --- buildStudyPlan: examDate handling ---------------------------------------

describe("buildStudyPlan: examDate handling", () => {
  const today = new Date("2026-07-08T00:00:00Z"); // Wednesday; Monday = 2026-07-06
  const sections: ExamSection[] = [section("Математика", ["algebra"])];
  const states = new Map<string, TopicState>([["algebra", state({ level: 0.5 })]]);

  it("null examDate -> status noExamDate, exactly 8 weeks", () => {
    const plan = buildStudyPlan(states, sections, null, today);
    expect(plan.status).toBe("noExamDate");
    expect(plan.weeks).toHaveLength(8);
  });

  it("examDate before this week's Monday -> status examDatePassed, zero weeks (plan not written)", () => {
    const pastExamDate = new Date("2026-06-01T00:00:00Z");
    const plan = buildStudyPlan(states, sections, pastExamDate, today);
    expect(plan.status).toBe("examDatePassed");
    expect(plan.weeks).toEqual([]);
  });

  it("examDate exactly on this week's Monday is NOT passed (boundary is exclusive on the past side)", () => {
    const examDate = new Date("2026-07-06T00:00:00Z"); // == mondayUtc(today)
    const plan = buildStudyPlan(states, sections, examDate, today);
    expect(plan.status).toBe("ok");
    expect(plan.weeks.length).toBeGreaterThanOrEqual(1);
  });

  it("weeksLeft is clamped to a minimum of 1 even when the exam is later this same week", () => {
    const examDate = new Date("2026-07-09T00:00:00Z"); // Thursday, same week as today
    const plan = buildStudyPlan(states, sections, examDate, today);
    expect(plan.status).toBe("ok");
    expect(plan.weeks).toHaveLength(1);
  });

  it("weeksLeft is clamped to a maximum of 12 for a far-future exam date", () => {
    const examDate = new Date("2028-01-01T00:00:00Z");
    const plan = buildStudyPlan(states, sections, examDate, today);
    expect(plan.status).toBe("ok");
    expect(plan.weeks).toHaveLength(12);
  });

  it("computes ceil((examDate - mondayUtc(today))/7d) weeks within the clamp range", () => {
    // Monday(today) = 2026-07-06. 3 weeks later = 2026-07-27. examDate falls
    // one day into the 3rd week boundary -> ceil gives exactly 3.
    const examDate = new Date("2026-07-21T00:00:00Z"); // 15 days after Monday -> ceil(15/7)=3
    const plan = buildStudyPlan(states, sections, examDate, today);
    expect(plan.status).toBe("ok");
    expect(plan.weeks).toHaveLength(3);
  });
});

// --- buildStudyPlan: weekStart formatting -------------------------------------

describe("buildStudyPlan: weekStart sequence", () => {
  it("emits consecutive Mondays as 'yyyy-mm-dd' UTC date strings, starting at mondayUtc(today)", () => {
    const today = new Date("2026-07-08T00:00:00Z");
    const sections: ExamSection[] = [section("Математика", ["algebra"])];
    const states = new Map<string, TopicState>();
    const examDate = new Date("2026-09-01T00:00:00Z");

    const plan = buildStudyPlan(states, sections, examDate, today);

    const mondayBase = Date.UTC(2026, 6, 6); // 2026-07-06
    const expected = plan.weeks.map((_, i) => {
      const d = new Date(mondayBase + i * 7 * MS_PER_DAY);
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    });
    expect(plan.weeks.map((w) => w.weekStart)).toEqual(expected);
    expect(plan.weeks[0].weekStart).toBe(mondayUtc(today));
  });
});

// --- buildStudyPlan: deterministic concrete assignment ------------------------

describe("buildStudyPlan: concrete deterministic assignment", () => {
  const today = new Date("2026-07-08T00:00:00Z");

  const sections: ExamSection[] = [
    section("Математика", ["algebra", "geometry", "trig"]),
    section("Физика", ["physicsA"]),
  ];

  function makeStates(): Map<string, TopicState> {
    return new Map<string, TopicState>([
      // strong: level >= BAND_STRONG -> never appears in any week's focus.
      ["algebra", state({ level: 0.9, lastSeenAt: today })],
      // shaky, fresh -> need = 1-0.5 = 0.5, reason 'weak'.
      ["geometry", state({ level: 0.5, lastSeenAt: today })],
      // weak, stale (35d > STALE_DAYS=21) -> need = 1-0.3+0.1 = 0.8, reason 'stale'.
      ["physicsA", state({ level: 0.3, lastSeenAt: daysAgo(today, 35) })],
      // trig has no row at all -> need = 0.8, reason 'unexplored'.
    ]);
  }

  it("never places the strong topic (algebra) in any week's focus", () => {
    const plan = buildStudyPlan(makeStates(), sections, null, today);
    const allFocusTopics = plan.weeks.flatMap((w) => w.topics.focus.map((f) => f.topic));
    expect(allFocusTopics).not.toContain("algebra");
    expect(levelToBand(0.9)).toBe("strong"); // sanity: fixture actually is strong
  });

  it("week 0 carries all three non-strong topics, sorted need desc, with correct reasons", () => {
    const plan = buildStudyPlan(makeStates(), sections, null, today);
    const week0 = plan.weeks[0];

    // trig (need=0.8 exactly, no row) edges out physicsA (need=1-0.3+0.1,
    // which is 0.7999999999999999 in IEEE754 double arithmetic — not a
    // literal tie) ahead of geometry (need=0.5).
    expect(week0.topics.focus.map((f) => f.topic)).toEqual(["trig", "physicsA", "geometry"]);
    expect(week0.topics.focus).toEqual([
      { topic: "trig", section: "Математика", band: "unknown", reason: "unexplored" },
      { topic: "physicsA", section: "Физика", band: "weak", reason: "stale" },
      { topic: "geometry", section: "Математика", band: "shaky", reason: "weak" },
    ]);
    expect(week0.topics.suggestedTest).toEqual({ kind: "practice" });
  });

  it("the last week repeats the weakest topics with reason 'review' and suggests a mock test", () => {
    const plan = buildStudyPlan(makeStates(), sections, null, today);
    const lastWeek = plan.weeks[plan.weeks.length - 1];

    expect(lastWeek.topics.suggestedTest).toEqual({ kind: "mock" });
    expect(lastWeek.topics.focus.every((f) => f.reason === "review")).toBe(true);
    expect(lastWeek.topics.focus.map((f) => f.topic)).toEqual(["trig", "physicsA", "geometry"]);
  });

  it("middle weeks (all non-strong topics already covered in week 0) carry no focus topics", () => {
    const plan = buildStudyPlan(makeStates(), sections, null, today);
    for (const week of plan.weeks.slice(1, -1)) {
      expect(week.topics.focus).toEqual([]);
      expect(week.topics.suggestedTest).toEqual({ kind: "practice" });
    }
  });
});

describe("buildStudyPlan: tie-break by topic name on a genuine need tie", () => {
  it("breaks an exact need tie (two unexplored topics, both need=0.8) by ascending topic name", () => {
    const today = new Date("2026-07-08T00:00:00Z");
    // Both "zeta" and "beta" have no row -> need=0.8 exactly (literal
    // constant, no floating-point drift) -> a genuine tie, unlike the
    // trig/physicsA case above.
    const sections: ExamSection[] = [section("Раздел", ["zeta", "beta"])];
    const states = new Map<string, TopicState>();
    const examDate = new Date(Date.UTC(2026, 6, 6) + 7 * MS_PER_DAY); // weeksLeft=1

    const plan = buildStudyPlan(states, sections, examDate, today);

    expect(plan.weeks[0].topics.focus.map((f) => f.topic)).toEqual(["beta", "zeta"]);
  });
});

// --- buildStudyPlan: coverage guarantee (property-style, 20 topics) -----------

describe("buildStudyPlan: full non-strong coverage guarantee (20 topics)", () => {
  const today = new Date("2026-07-08T00:00:00Z");

  // Deterministic PRNG (mulberry32) — no new test dependency, fully
  // reproducible across CI/local runs (no Math.random flakiness).
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildFixture(seed: number) {
    const rand = mulberry32(seed);
    const topics = Array.from({ length: 20 }, (_, i) => `topic-${String(i).padStart(2, "0")}`);
    const sections: ExamSection[] = [section("Раздел", topics)];
    const states = new Map<string, TopicState>();
    for (const topic of topics) {
      const roll = rand();
      if (roll < 0.2) continue; // ~20% stay unexplored (no row at all)
      const level = rand(); // uniform [0,1) -> mix of weak/shaky/strong
      const stale = rand() < 0.3;
      states.set(topic, state({ level, lastSeenAt: stale ? daysAgo(today, 30) : today }));
    }
    return { topics, sections, states };
  }

  const mondayOfToday = Date.UTC(2026, 6, 6); // mondayUtc(today) as ms

  it.each([1, 2, 3, 5, 8, 12])(
    "every non-strong topic appears in at least one week when weeksLeft=%i",
    (weeksLeft) => {
      const { topics, sections, states } = buildFixture(weeksLeft * 7919); // vary fixture per case
      // examDate lands exactly on the boundary Monday `weeksLeft` weeks out
      // from THIS week's Monday -> ceil((examDate-mondayUtc(today))/7d) is
      // exactly weeksLeft (today itself is a Wednesday, 2 days past Monday).
      const examDate = new Date(mondayOfToday + weeksLeft * 7 * MS_PER_DAY);

      const plan = buildStudyPlan(states, sections, examDate, today);
      expect(plan.weeks).toHaveLength(weeksLeft);

      const nonStrongTopics = topics.filter((topic) => {
        const s = states.get(topic);
        return !s || levelToBand(s.level) !== "strong";
      });
      const coveredTopics = new Set(plan.weeks.flatMap((w) => w.topics.focus.map((f) => f.topic)));

      for (const topic of nonStrongTopics) {
        expect(coveredTopics.has(topic)).toBe(true);
      }
      // Strong topics must never be scheduled at all.
      const strongTopics = topics.filter((t) => !nonStrongTopics.includes(t));
      for (const topic of strongTopics) {
        expect(coveredTopics.has(topic)).toBe(false);
      }
    },
  );

  it("is deterministic: calling twice with identical inputs yields byte-identical output", () => {
    const { sections, states } = buildFixture(42);
    const examDate = new Date(today.getTime() + 6 * 7 * MS_PER_DAY);

    const first = buildStudyPlan(new Map(states), sections, examDate, today);
    const second = buildStudyPlan(new Map(states), sections, examDate, today);

    expect(first).toEqual(second);
  });
});

// --- sanity: constants sourced from the shared knowledge convention ----------

describe("buildStudyPlan: reuses the shared band convention (no local threshold duplication)", () => {
  it("BAND_WEAK/BAND_STRONG are re-exported from knowledge/constants and drive band classification here too", () => {
    expect(levelToBand(BAND_STRONG)).toBe("strong");
    expect(levelToBand(BAND_WEAK)).toBe("shaky");
  });
});
