import { describe, expect, it } from "vitest";
import { createLlm } from "./index";

const okEnv = {
  LLM_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "k",
  LLM_MODEL: "some/model",
};

describe("createLlm", () => {
  it("creates openrouter llm from env", () => {
    expect(() => createLlm(okEnv)).not.toThrow();
  });
  it("defaults provider to openrouter when unset", () => {
    expect(() => createLlm({ OPENROUTER_API_KEY: "k", LLM_MODEL: "some/model" })).not.toThrow();
  });
  it("throws on missing key", () => {
    expect(() => createLlm({ LLM_PROVIDER: "openrouter", LLM_MODEL: "some/model" })).toThrow(
      "OPENROUTER_API_KEY",
    );
  });
  it("throws on missing model", () => {
    expect(() => createLlm({ LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: "k" })).toThrow(
      "LLM_MODEL",
    );
  });
  it("throws on unknown provider", () => {
    expect(() => createLlm({ LLM_PROVIDER: "gpt" })).toThrow("LLM_PROVIDER");
  });
});
