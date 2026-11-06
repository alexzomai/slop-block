import { describe, expect, it } from "vitest";
import { markLoaded } from "../src/content/mark";

describe("content script marker", () => {
  it("sets data-slop-block=loaded and nothing else", () => {
    const attrs = new Map<string, string>();
    const el = { setAttribute: (k: string, v: string) => void attrs.set(k, v) };
    markLoaded(el);
    expect([...attrs]).toEqual([["data-slop-block", "loaded"]]);
  });
});
