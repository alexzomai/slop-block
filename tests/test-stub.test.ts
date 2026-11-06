import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "../scripts/build.mjs";
import { decide, usage } from "../src/background/test-stub";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "slop-stub-")); dirs.push(d); return d; };

describe("заглушка background", () => {
  it("decide: совпадение по слову тега, ERR → network", () => {
    const tags = [{ id: "t", text: "кликбейт про похудение" }];
    const r = decide({ type: "slop/decide", video: { videoId: "x", title: "Секрет ПОХУДЕНИЕ", channel: "" }, tags });
    expect(r).toMatchObject({ ok: true, hide: true, matchedTagIds: ["t"] });
    expect(decide({ type: "slop/decide", video: { videoId: "x", title: "Борщ", channel: "" }, tags })).toMatchObject({ ok: true, hide: false });
    expect(decide({ type: "slop/decide", video: { videoId: "x", title: "ERR", channel: "" }, tags })).toEqual({ ok: false, error: "network" });
  });
  it("usage: фиксированные числа", () => {
    expect(usage()).toMatchObject({ ok: true, remote: { usage: 0.0123, limitRemaining: 74.5 }, local: { requestsToday: 3 } });
  });
  it("рабочий dist не содержит заглушку, тестовая — содержит", async () => {
    const prod = tmp(), test = tmp();
    await build(prod);
    await build(test, { testBackground: true });
    expect(existsSync(join(prod, "background.js"))).toBe(true);
    const prodJs = readFileSync(join(prod, "background.js"), "utf8");
    expect(prodJs).not.toContain("__SLOP_TEST_STUB__");
    expect(prodJs).toContain("slop/decide");
    expect(prodJs).toContain("slop/usage"); // боевой background обрабатывает контракт
    expect(readFileSync(join(test, "background.js"), "utf8")).toContain("__SLOP_TEST_STUB__");
  });
});

describe("заглушка: управляемые ошибки и счётчик", () => {
  const req = { type: "slop/decide" as const, video: { videoId: "x", title: "Борщ", channel: "" }, tags: [{ id: "t", text: "борщ" }] };
  it.each(["no_key", "network", "bad_response", "rate_limited"] as const)("forceError=%s", (e) => {
    expect(decide(req, e)).toEqual({ ok: false, error: e });
  });
  it("без forceError — обычное решение", () => {
    expect(decide(req, undefined)).toMatchObject({ ok: true });
  });
});
