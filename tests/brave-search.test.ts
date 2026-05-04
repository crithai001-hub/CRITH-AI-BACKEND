import { describe, expect, it } from "vitest";
import { parseBraveResponse } from "../lib/brave-search.js";

describe("parseBraveResponse", () => {
  it("extracts up to 5 web results", () => {
    const payload = {
      web: {
        results: [
          { title: "A", description: "snippet a", url: "https://a.com" },
          { title: "B", description: "snippet b", url: "https://b.com" },
          { title: "C", description: "snippet c", url: "https://c.com" },
          { title: "D", description: "snippet d", url: "https://d.com" },
          { title: "E", description: "snippet e", url: "https://e.com" },
          { title: "F", description: "snippet f", url: "https://f.com" }
        ]
      }
    };
    const out = parseBraveResponse(payload);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ title: "A", snippet: "snippet a", url: "https://a.com" });
  });

  it("handles missing description gracefully", () => {
    const payload = {
      web: { results: [{ title: "A", url: "https://a.com" }] }
    };
    const out = parseBraveResponse(payload);
    expect(out).toHaveLength(1);
    expect(out[0]?.snippet).toBe("");
  });

  it("returns empty when no results", () => {
    expect(parseBraveResponse({})).toEqual([]);
    expect(parseBraveResponse({ web: { results: [] } })).toEqual([]);
    expect(parseBraveResponse(null)).toEqual([]);
  });

  it("filters out entries missing title or url", () => {
    const payload = {
      web: {
        results: [
          { description: "no title", url: "https://x.com" },
          { title: "no url", description: "x" },
          { title: "good", url: "https://good.com", description: "yes" }
        ]
      }
    };
    const out = parseBraveResponse(payload);
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe("https://good.com");
  });
});
