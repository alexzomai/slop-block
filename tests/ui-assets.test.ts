import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pages = ["static/base.css", "static/popup.html", "static/options.html"];

describe("extension-ui assets", () => {
  it("pages and styles reference no remote resources", () => {
    for (const f of pages) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
      expect(text, f).not.toMatch(/@import/);
    }
  });

  it("every font file referenced by base.css exists and is licensed (OFL) next to it", () => {
    const css = readFileSync("static/base.css", "utf8");
    const urls = [...css.matchAll(/url\("([^"]+\.woff2)"\)/g)].map((m) => m[1]);
    expect(urls.length).toBe(2);
    let total = 0;
    for (const u of urls) {
      expect(existsSync(`static/${u}`), u).toBe(true);
      total += statSync(`static/${u}`).size;
    }
    expect(total).toBeLessThan(60 * 1024);
    expect(readFileSync("static/fonts/OFL.txt", "utf8")).toMatch(/SIL Open Font License/);
  });

  it("base.css defines tokens and both themes", () => {
    const css = readFileSync("static/base.css", "utf8");
    expect(css).toMatch(/:root\s*{[^}]*--accent:/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
  });

  it("YouTube-facing gate.css has no font injection", () => {
    const gate = readFileSync("static/gate.css", "utf8");
    expect(gate).not.toMatch(/@font-face|font-family|JetBrains/i);
  });
});
