import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { llmFromRaw } from "./provider";

const schema = z.object({ name: z.string() });

describe("llmFromRaw", () => {
  it("parses valid output on first try", async () => {
    const raw = vi.fn().mockResolvedValue('{"name":"ЕНТ"}');
    const llm = llmFromRaw(raw);
    await expect(llm.complete({ prompt: "p", schema })).resolves.toEqual({ name: "ЕНТ" });
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it("retries once with error feedback on invalid output", async () => {
    const raw = vi
      .fn()
      .mockResolvedValueOnce('{"wrong":true}')
      .mockResolvedValueOnce('{"name":"IELTS"}');
    const llm = llmFromRaw(raw);
    await expect(llm.complete({ prompt: "p", schema })).resolves.toEqual({ name: "IELTS" });
    expect(raw).toHaveBeenCalledTimes(2);
    expect(raw.mock.calls[1][0].prompt).toContain("не прошёл валидацию");
  });

  it("throws after second invalid output", async () => {
    const raw = vi.fn().mockResolvedValue("garbage");
    const llm = llmFromRaw(raw);
    await expect(llm.complete({ prompt: "p", schema })).rejects.toThrow();
    expect(raw).toHaveBeenCalledTimes(2);
  });
});
