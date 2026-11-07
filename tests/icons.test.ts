import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8")) as Record<string, any>;
const SIZES = ["16", "32", "48", "128"];

function pngSize(path: string): [number, number] {
  const b = readFileSync(path);
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("extension icons (extension-shell)", () => {
  it.each([
    ["icons", () => manifest.icons],
    ["action.default_icon", () => manifest.action.default_icon],
  ])("%s lists existing PNGs of the declared size", (_name, get) => {
    const icons = get() as Record<string, string>;
    expect(Object.keys(icons).sort((a, b) => +a - +b)).toEqual(SIZES);
    for (const size of SIZES) {
      const path = `static/${icons[size]}`;
      expect(existsSync(path), path).toBe(true);
      expect(pngSize(path)).toEqual([+size, +size]);
    }
  });
});
