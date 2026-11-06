import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it(".gitignore ignores .data/", () => {
  expect(readFileSync(new URL("../.gitignore", import.meta.url), "utf8").split("\n")).toContain(".data/");
});
