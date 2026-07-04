import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fakeLlm } from "./fake";

describe("fakeLlm", () => {
  it("returns queued responses validated by schema", async () => {
    const llm = fakeLlm([{ n: 1 }, { n: 2 }]);
    const schema = z.object({ n: z.number() });
    expect(await llm.complete({ prompt: "a", schema })).toEqual({ n: 1 });
    expect(await llm.complete({ prompt: "b", schema })).toEqual({ n: 2 });
    await expect(llm.complete({ prompt: "c", schema })).rejects.toThrow("no more");
  });
});
