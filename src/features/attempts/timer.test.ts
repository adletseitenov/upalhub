// Клиентская логика таймера (D4: сервер — единственный источник истины по
// времени, этот таймер косметический). Чистые функции: детерминированы по
// (deadlineAt, now), никакого Date.now()/setInterval внутри — TDD.
import { describe, expect, it } from "vitest";
import { formatRemaining, isExpired, remainingMs } from "./timer";

describe("remainingMs", () => {
  it("returns null when there is no deadline (untimed test)", () => {
    expect(remainingMs(null, new Date("2026-07-07T12:00:00Z"))).toBeNull();
  });

  it("returns the millisecond gap when the deadline is in the future", () => {
    const deadline = new Date("2026-07-07T12:05:00Z");
    const now = new Date("2026-07-07T12:00:00Z");
    expect(remainingMs(deadline, now)).toBe(5 * 60_000);
  });

  it("clamps to 0 once the deadline has passed (never negative)", () => {
    const deadline = new Date("2026-07-07T12:00:00Z");
    const now = new Date("2026-07-07T12:05:00Z");
    expect(remainingMs(deadline, now)).toBe(0);
  });

  it("returns 0 exactly at the deadline", () => {
    const deadline = new Date("2026-07-07T12:00:00Z");
    expect(remainingMs(deadline, deadline)).toBe(0);
  });
});

describe("isExpired", () => {
  it("is never expired when there is no deadline", () => {
    expect(isExpired(null, new Date("2026-07-07T12:00:00Z"))).toBe(false);
  });

  it("is false while now is before the deadline", () => {
    const deadline = new Date("2026-07-07T12:05:00Z");
    expect(isExpired(deadline, new Date("2026-07-07T12:04:59Z"))).toBe(false);
  });

  it("is true exactly at the deadline", () => {
    const deadline = new Date("2026-07-07T12:05:00Z");
    expect(isExpired(deadline, deadline)).toBe(true);
  });

  it("is true after the deadline", () => {
    const deadline = new Date("2026-07-07T12:05:00Z");
    expect(isExpired(deadline, new Date("2026-07-07T12:05:01Z"))).toBe(true);
  });
});

describe("formatRemaining", () => {
  it("formats zero as 00:00", () => {
    expect(formatRemaining(0)).toBe("00:00");
  });

  it("clamps negative input to 00:00", () => {
    expect(formatRemaining(-5000)).toBe("00:00");
  });

  it("rounds sub-second remainders up (never shows 00:00 while time is left)", () => {
    expect(formatRemaining(500)).toBe("00:01");
  });

  it("formats under a minute as MM:SS", () => {
    expect(formatRemaining(45_000)).toBe("00:45");
  });

  it("formats several minutes as MM:SS", () => {
    expect(formatRemaining(65_000)).toBe("01:05");
  });

  it("formats exactly 60 minutes as MM:SS (still under the >60m threshold)", () => {
    expect(formatRemaining(60 * 60_000)).toBe("60:00");
  });

  it("switches to H:MM:SS once remaining time exceeds 60 minutes", () => {
    expect(formatRemaining(61 * 60_000 + 1_000)).toBe("1:01:01");
  });

  it("pads minutes/seconds with a leading zero in the hour format", () => {
    expect(formatRemaining(2 * 60 * 60_000 + 5_000)).toBe("2:00:05");
  });
});
