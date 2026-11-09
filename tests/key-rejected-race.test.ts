import { describe, expect, it, vi } from "vitest";
import { createDecider } from "../src/background/decide";
import { createLimiter } from "../src/background/limiter";
import { createRejections } from "../src/background/rejected";
import { setKey } from "../src/background/settings";
import type { DecideRequest } from "../src/shared/decision";
import { fakeKV, resp } from "./helpers/fake";

const req = (id: string): DecideRequest => ({ type: "slop/decide", video: { videoId: id, title: "T", channel: "C" }, tags: [{ id: "a", text: "кликбейт" }] });
const A = "KEYA-aaaaaaaaaaaa";
const B = "KEYB-bbbbbbbbbbbb";
const tick = () => new Promise((r) => setTimeout(r, 10));

function setup(f: any) {
  const kv = fakeKV();
  const orig = kv.get.bind(kv);
  const hold = { next: false, gate: Promise.resolve() as Promise<void>, release: () => {} };
  // снимок берётся в момент вызова, а возвращается после задержки: «чтение завершилось позже»
  kv.get = async (keys) => {
    const r = await orig(keys);
    if (hold.next && Array.isArray(keys)) {
      hold.next = false;
      await hold.gate;
    }
    return r;
  };
  const arm = () => {
    hold.gate = new Promise<void>((r) => (hold.release = r));
    hold.next = true;
  };
  const rejections = createRejections(kv);
  const limiter = createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now: () => 1000, sleep: async () => {} });
  const decide = createDecider({ kv, fetch: f, now: () => 1000, sleep: async () => {}, random: () => 0, limiter, rejections });
  return { kv, decide, rejections, arm, hold };
}

describe("гонки поколения", () => {
  it("старый mark(A) с задержанным чтением не затирает отказ B", async () => {
    const ctx: { arm?: () => void } = {};
    const used: string[] = [];
    const f = vi.fn(async (_u: string, init: any) => {
      const k = init.headers.Authorization.includes("KEYA") ? "A" : "B";
      used.push(k);
      if (k === "A") ctx.arm!(); // следующее чтение «ключ+поколение» (внутри mark(A)) задержится
      return resp(401);
    });
    const s = setup(f);
    ctx.arm = s.arm;
    await setKey(s.kv, A);
    const first = s.decide(req("x"));
    await tick(); // mark(A) стоит на задержанном чтении
    await setKey(s.kv, B);
    const second = s.decide(req("y")); // 401 B → mark(B) встаёт в очередь за mark(A)
    await tick();
    s.hold.release();
    await Promise.all([first, second]);
    const n = f.mock.calls.length;
    expect(await s.decide(req("z"))).toEqual({ ok: false, error: "no_key" });
    expect(f.mock.calls.length).toBe(n);
    expect(used).toEqual(["A", "B"]);
  });
  it("ключ и поколение — один снимок: B не уходит в fetch со снимком поколения A", async () => {
    const f = vi.fn(async () => resp(401));
    const s = setup(f);
    await setKey(s.kv, A);
    s.arm(); // задержать первое чтение снимка в decide
    const first = s.decide(req("x"));
    await tick();
    await setKey(s.kv, B);
    s.hold.release();
    await first; // ушёл с (A, genA) — согласованно; его отказ относится к A и B не помечает
    const n = f.mock.calls.length;
    await s.decide(req("y")); // B: 401, запоминается
    expect(f.mock.calls.length).toBe(n + 1);
    expect(await s.decide(req("z"))).toEqual({ ok: false, error: "no_key" });
    expect(f.mock.calls.length).toBe(n + 1);
  });
  it("задержка внутри set: параллельные mark одного провайдера идут по очереди", async () => {
    const kv = fakeKV();
    const orig = kv.set.bind(kv);
    kv.set = async (i) => { await tick(); await orig(i); };
    const r = createRejections(kv);
    await setKey(kv, A);
    const gen = (kv.data.openrouterKeyGen as string);
    await Promise.all([r.mark("openrouter", A, gen), r.mark("openrouter", A, gen)]);
    expect(await r.has("openrouter", A, gen)).toBe(true);
  });
  it("устаревший keyRejected удаляется при старте без переноса", async () => {
    const kv = fakeKV({ openrouterKey: A, keyRejected: { openrouter: "abc" }, other: 1 });
    const r = createRejections(kv);
    await r.purgeLegacy();
    expect(kv.data.keyRejected).toBeUndefined();
    expect(kv.data["keyRejected.openrouter"]).toBeUndefined();
    expect(kv.data.other).toBe(1);
    expect(await r.has("openrouter", A, "")).toBe(false);
  });
});
