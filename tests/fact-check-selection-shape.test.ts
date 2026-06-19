// tests/fact-check-selection-shape.test.ts
import { describe, expect, it } from "vitest";
import { isValidFactCheckSelectionBody } from "../api/fact-check-selection.js";

const valid = {
  selected_text: "A".repeat(60),
  context_before: "before context",
  context_after: "after context",
  prompt: "original prompt",
  platform: "chatgpt",
  conversation_id: "conv-1",
  message_id: "msg-1"
};

describe("isValidFactCheckSelectionBody", () => {
  it("accepts a valid body", () => {
    expect(isValidFactCheckSelectionBody(valid)).toBe(true);
  });
  it("rejects selected_text under 40 chars", () => {
    expect(isValidFactCheckSelectionBody({ ...valid, selected_text: "short" })).toBe(false);
  });
  it("rejects selected_text over 5000 chars", () => {
    expect(
      isValidFactCheckSelectionBody({ ...valid, selected_text: "x".repeat(5001) })
    ).toBe(false);
  });
  it("rejects context_before over 200 chars", () => {
    expect(
      isValidFactCheckSelectionBody({ ...valid, context_before: "x".repeat(201) })
    ).toBe(false);
  });
  it("rejects prompt over 2000 chars", () => {
    expect(isValidFactCheckSelectionBody({ ...valid, prompt: "x".repeat(2001) })).toBe(false);
  });
  it("rejects unknown platform", () => {
    expect(isValidFactCheckSelectionBody({ ...valid, platform: "groot" })).toBe(false);
  });
});
