import { describe, expect, it } from "vitest";
import { healthcheck } from "./health";

describe("healthcheck", () => {
  it("returns ok", () => {
    expect(healthcheck()).toEqual({ ok: true, app: "U-Pal" });
  });
});
