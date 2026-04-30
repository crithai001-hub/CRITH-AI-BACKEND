import { describe, expect, it } from "vitest";
import { monthKey } from "../lib/quota.js";

describe("monthKey", () => {
  it("formats as YYYY-MM in UTC", () => {
    expect(monthKey(new Date(Date.UTC(2026, 0, 15)))).toBe("2026-01");
    expect(monthKey(new Date(Date.UTC(2026, 11, 31)))).toBe("2026-12");
  });
  it("zero-pads single-digit months", () => {
    expect(monthKey(new Date(Date.UTC(2026, 3, 1)))).toBe("2026-04");
  });
  it("handles month boundary at UTC midnight", () => {
    // 2026-01-31 23:59 UTC → 2026-01
    expect(monthKey(new Date(Date.UTC(2026, 0, 31, 23, 59)))).toBe("2026-01");
    // 2026-02-01 00:00 UTC → 2026-02
    expect(monthKey(new Date(Date.UTC(2026, 1, 1, 0, 0)))).toBe("2026-02");
  });
});
