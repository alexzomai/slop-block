import { describe, expect, it } from "vitest";
import { hideCard, showCard, type Hideable } from "../src/content/dom";

function fake() {
  const attrs = new Map<string, string>();
  const style = new Map<string, string>();
  const el: Hideable = {
    style: {
      getPropertyValue: (n) => style.get(n) ?? "",
      setProperty: (n, v) => void style.set(n, v),
      removeProperty: (n) => { const o = style.get(n) ?? ""; style.delete(n); return o; },
    },
    setAttribute: (n, v) => void attrs.set(n, v),
    removeAttribute: (n) => void attrs.delete(n),
  };
  return { el, attrs, style };
}

describe("hide/show", () => {
  it("обратимо", () => {
    const { el, attrs, style } = fake();
    hideCard(el);
    expect(style.get("display")).toBe("none");
    expect(attrs.get("data-slop-hidden")).toBe("1");
    showCard(el);
    expect(style.size).toBe(0);
    expect(attrs.size).toBe(0);
  });
});
