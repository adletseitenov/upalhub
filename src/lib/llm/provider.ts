import type { Llm, LlmCompleteArgs, RawComplete } from "./types";
import { extractJson } from "./json";

export function llmFromRaw(raw: RawComplete): Llm {
  return {
    async complete<T>({ system, prompt, schema, maxTokens }: LlmCompleteArgs<T>): Promise<T> {
      const attempt = async (p: string): Promise<T> =>
        schema.parse(extractJson(await raw({ system, prompt: p, maxTokens })));
      try {
        return await attempt(prompt);
      } catch (e) {
        const reason = e instanceof Error ? e.message.slice(0, 300) : "unknown";
        return await attempt(
          `${prompt}\n\nПредыдущий ответ не прошёл валидацию (${reason}). Верни СТРОГО валидный JSON нужной структуры, без пояснений и без markdown.`,
        );
      }
    },
  };
}
