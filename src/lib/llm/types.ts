import type { z } from "zod";

export interface LlmCompleteArgs<T> {
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
}

export interface Llm {
  complete<T>(args: LlmCompleteArgs<T>): Promise<T>;
}

export type RawComplete = (args: {
  system?: string;
  prompt: string;
  maxTokens?: number;
}) => Promise<string>;
