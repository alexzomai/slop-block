import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// storage.local в main переведён в TRUSTED_CONTEXTS (там ключ OpenRouter): content script и общий код его не трогают.
describe("content script использует только storage.sync", () => {
  for (const f of ["src/content/index.ts", "src/content/filter.ts", "src/content/selectors.ts", "src/content/dom.ts", "src/shared/storage.ts", "src/shared/settings.ts"]) {
    it(f, () => {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/storage\.local|storage\.session|openrouter|apiKey|Authorization/i);
    });
  }
  it("content/index.ts читает именно storage.sync", () => {
    expect(readFileSync("src/content/index.ts", "utf8")).toContain("chrome.storage.sync");
  });
});
