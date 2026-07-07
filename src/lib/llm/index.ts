import { llmFromRaw } from "./provider";
import { openRouterRaw } from "./openrouter";
import type { Llm } from "./types";

export type { Llm, LlmCompleteArgs, RawComplete } from "./types";
export { fakeLlm } from "./fake";
export { llmFromRaw } from "./provider";

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function createLlm(env: Record<string, string | undefined> = process.env): Llm {
  const provider = env.LLM_PROVIDER ?? "openrouter";
  if (provider === "openrouter") {
    return llmFromRaw(
      openRouterRaw({
        apiKey: required(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY"),
        model: required(env.LLM_MODEL, "LLM_MODEL"),
      }),
    );
  }
  // новый провайдер = файл с RawComplete + ветка здесь
  throw new Error(`unknown LLM_PROVIDER: ${provider}`);
}
