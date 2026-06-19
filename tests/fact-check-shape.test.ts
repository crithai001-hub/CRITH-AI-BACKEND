// tests/fact-check-shape.test.ts
import { describe, expect, it } from "vitest";
import { isValidFactCheckBody } from "../api/fact-check.js";

const valid = {
  prompt: "What's the best go-to-market for B2B SaaS?",
  response: "A".repeat(500),
  platform: "chatgpt",
  conversation_id: "conv-1",
  message_id: "msg-1"
};

describe("isValidFactCheckBody", () => {
  it("accepts a minimal valid body", () => {
    expect(isValidFactCheckBody(valid)).toBe(true);
  });

  it("rejects missing fields", () => {
    const { prompt: _, ...rest } = valid;
    expect(isValidFactCheckBody(rest)).toBe(false);
  });

  it("rejects unknown platforms", () => {
    expect(isValidFactCheckBody({ ...valid, platform: "groot" })).toBe(false);
  });

  it("rejects prompt over 20000 chars", () => {
    expect(isValidFactCheckBody({ ...valid, prompt: "x".repeat(20001) })).toBe(false);
  });

  it("accepts optional conversation_history when valid", () => {
    expect(
      isValidFactCheckBody({
        ...valid,
        conversation_history: [{ role: "user", content: "hi" }]
      })
    ).toBe(true);
  });

  it("rejects bad conversation_history entries", () => {
    expect(
      isValidFactCheckBody({
        ...valid,
        conversation_history: [{ role: "system", content: "x" }]
      })
    ).toBe(false);
  });
});
