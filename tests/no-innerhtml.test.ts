import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("недоверенный текст", () => {
  it("в src нет innerHTML/outerHTML/insertAdjacentHTML/document.write/eval", () => {
    const bad = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\s*\()/;
    const offenders = files("src").filter((f) => bad.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
