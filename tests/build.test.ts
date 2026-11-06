import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "../scripts/build.mjs";

let out: string;
beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "slop-block-build-"));
  await build(out);
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("build (dev-toolchain)", () => {
  it("emits every file referenced by the manifest", () => {
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    const refs = [
      m.background.service_worker,
      ...m.content_scripts.flatMap((c: any) => [...c.js, ...(c.css ?? [])]),
      m.action.default_popup,
      m.options_ui.page,
    ];
    for (const r of refs) expect(existsSync(join(out, r)), r).toBe(true);
  });

  it("content.js is a classic script (no top-level import/export)", () => {
    const js = readFileSync(join(out, "content.js"), "utf8");
    expect(js).not.toMatch(/^\s*(import|export)\b/m);
  });

  it("html pages reference built local scripts that exist", () => {
    for (const page of ["options.html", "popup.html"]) {
      const html = readFileSync(join(out, page), "utf8");
      const src = /<script[^>]*src="([^"]+)"/.exec(html)?.[1];
      expect(src, page).toBeTruthy();
      expect(existsSync(join(out, src!)), `${page} -> ${src}`).toBe(true);
    }
  });

  it("built output has no eval / remote code", () => {
    for (const f of ["background.js", "content.js", "options.js", "popup.js"]) {
      expect(readFileSync(join(out, f), "utf8"), f).not.toMatch(/\beval\s*\(|new Function\(/);
    }
  });
});
