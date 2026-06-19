// tests/quota-counts-verification-only.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { incrementVerificationQuota, monthKey } from "../lib/quota.js";
import { supabaseService } from "../lib/supabase.js";
import * as plan from "../lib/plan.js";

vi.mock("../lib/supabase.js", () => ({
  supabaseService: {
    from: vi.fn()
  }
}));
vi.mock("../lib/plan.js", () => ({ isProUser: vi.fn() }));

describe("incrementVerificationQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments and returns post-increment count, exceeded=false under limit", async () => {
    (plan.isProUser as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (supabaseService.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: { response_analyses: 4 } }) })
        })
      }),
      upsert: () => Promise.resolve({ error: null })
    }));
    const result = await incrementVerificationQuota("user-1");
    expect(result.used).toBe(5);
    expect(result.exceeded).toBe(false);
  });

  it("returns exceeded=true when over limit and not pro", async () => {
    (plan.isProUser as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (supabaseService.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { response_analyses: 10 } })
          })
        })
      }),
      upsert: () => Promise.resolve({ error: null })
    }));
    const result = await incrementVerificationQuota("user-2");
    expect(result.used).toBe(11);
    expect(result.exceeded).toBe(true);
  });

  it("pro users are never exceeded", async () => {
    (plan.isProUser as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (supabaseService.from as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: { response_analyses: 100 } })
          })
        })
      }),
      upsert: () => Promise.resolve({ error: null })
    }));
    const result = await incrementVerificationQuota("user-3");
    expect(result.exceeded).toBe(false);
  });
});

describe("monthKey", () => {
  it("returns YYYY-MM in UTC", () => {
    expect(monthKey(new Date("2026-06-19T12:00:00Z"))).toBe("2026-06");
  });
});
