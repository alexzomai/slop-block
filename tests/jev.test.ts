import { describe, expect, it } from "vitest";
import { buildRequest, parseResponse } from "../src/background/jev";
import { okBody } from "./helpers/fake";

const video = { videoId: "VID123", title: "T", channel: "C", description: "d".repeat(900) };
const tags = [{ id: "tag-a", text: "кликбейт" }, { id: "tag-b", text: "новости" }];

describe("jev adapter", () => {
  it("one noul question per tag, minimal data", () => {
    const b = buildRequest("typesafe/jev-1.13", video, tags);
    expect(b.model).toBe("typesafe/jev-1.13");
    expect(Object.keys(b.questions)).toEqual(["t0", "t1"]);
    expect(b.questions.t0?.type).toBe("noul");
    expect(b.questions.t0?.instructions).toContain("кликбейт");
    expect(b.state.title).toBe("T");
    expect(b.state.description?.length).toBe(500);
    const s = JSON.stringify(b);
    expect(s).not.toContain("VID123");
    expect(s).not.toContain("tag-a");
  });
  it("caps tags and tag length", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, text: "x".repeat(300) }));
    const b = buildRequest("m", video, many);
    expect(Object.keys(b.questions)).toHaveLength(20);
    expect(b.questions.t0?.instructions.length).toBeLessThan(400);
  });
  it("parses probabilities by tag id", () => {
    expect(parseResponse(okBody({ t0: 0.9, t1: 0.1 }), tags)).toEqual({ "tag-a": 0.9, "tag-b": 0.1 });
  });
  it("rejects incomplete / malformed", () => {
    expect(parseResponse(okBody({ t0: 0.9 }), tags)).toBeNull();
    expect(parseResponse(okBody({ t0: 1.2, t1: 0.1 }), tags)).toBeNull();
    expect(parseResponse({ answers: { t0: { type: "choice" }, t1: { type: "noul", noul: 0.1 } } }, tags)).toBeNull();
    expect(parseResponse(null, tags)).toBeNull();
    expect(parseResponse("x", tags)).toBeNull();
  });
});
