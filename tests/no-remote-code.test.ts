import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("no remote or dynamic code", () => {
  const sources = [...walk("src"), ...walk("static")];

  it("has sources to scan", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("source has no eval / new Function / importScripts / remote imports", () => {
    for (const f of sources.filter((p) => /\.(ts|js|mjs)$/.test(p))) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/\beval\s*\(|new\s+Function\b|importScripts\s*\(|import\s*\(\s*["'`]https?:/);
    }
  });

  it("html pages use only local external scripts, no inline scripts", () => {
    for (const f of sources.filter((p) => p.endsWith(".html"))) {
      const text = readFileSync(f, "utf8");
      const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      expect(scripts.length, f).toBeGreaterThan(0);
      for (const m of scripts) {
        expect(m[1], f).toMatch(/\bsrc="[^":/]+\.js"/);
        expect((m[2] ?? "").trim(), f).toBe("");
      }
    }
  });
});
