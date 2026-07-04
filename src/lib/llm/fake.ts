import type { Llm } from "./types";

export function fakeLlm(responses: unknown[]): Llm {
  let i = 0;
  return {
    async complete({ schema }) {
      if (i >= responses.length) throw new Error("fakeLlm: no more queued responses");
      return schema.parse(responses[i++]);
    },
  };
}
