import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setI18nSource } from "../src/shared/i18n";
import { getMessageFor } from "./helpers/messages";
import { createDecider } from "../src/background/decide";
import { createRejections, fingerprint } from "../src/background/rejected";
import { createLimiter } from "../src/background/limiter";
import { setKey } from "../src/background/settings";
import { createUsageService } from "../src/background/usage";
import { usageView } from "../src/popup/usage";
import type { DecideRequest } from "../src/shared/decision";
import { SECRET, fakeKV, okBody, resp } from "./helpers/fake";

const TS_KEY = "TYPESAFESECRET1234567890";
const req = (id = "v1"): DecideRequest => ({ type: "slop/decide", video: { videoId: id, title: "T", channel: "C" }, tags: [{ id: "a", text: "кликбейт" }] });
const peekReq = (id = "v1") => ({ type: "slop/peek", videos: [{ videoId: id, title: "T", channel: "C" }], tags: [{ id: "a", text: "кликбейт" }] });

function setup(kvInit: Record<string, unknown>, f: any) {
  const kv = fakeKV(kvInit);
  const rejections = createRejections(kv);
  const limiter = createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now: () => 1000, sleep: async () => {} });
  const decide = createDecider({ kv, fetch: f, now: () => 1000, sleep: async () => {}, random: () => 0, limiter, rejections });
  const usage = createUsageService({ kv, fetch: f, now: () => 1000, sleep: async () => {}, random: () => 0, limiter, rejections });
  return { kv, rejections, decide, usage };
}

describe("B2: отклонённый ключ", () => {
  it.each([401, 403])("HTTP %i: no_key, дальше 0 fetch для decide и peek", async (s) => {
    const f = vi.fn(async () => resp(s, { error: SECRET }));
    const { decide } = setup({ openrouterKey: SECRET }, f);
    expect(await decide(req("v1"))).toEqual({ ok: false, error: "no_key" });
    expect(f).toHaveBeenCalledTimes(1);
    for (let i = 2; i < 8; i++) expect(await decide(req(`v${i}`))).toEqual({ ok: false, error: "no_key" });
    expect(await decide.peek(peekReq())).toEqual({ ok: false, error: "no_key" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it.each([429, 503, 400, 402])("HTTP %i не помечает ключ", async (s) => {
    const f = vi.fn(async () => resp(s));
    const { decide, kv } = setup({ openrouterKey: SECRET }, f);
    await decide(req("a1"));
    const n = f.mock.calls.length;
    await decide(req("a2"));
    expect(f.mock.calls.length).toBeGreaterThan(n);
    expect(kv.data["keyRejected.openrouter"]).toBeUndefined();
  });
  it("в хранилище только отпечаток, ключа нет", async () => {
    const { decide, kv } = setup({ openrouterKey: SECRET }, vi.fn(async () => resp(401)));
    await decide(req());
    expect(kv.data["keyRejected.openrouter"]).toEqual({ fp: await fingerprint(SECRET), gen: "" });
    expect(JSON.stringify(kv.data["keyRejected.openrouter"])).not.toContain(SECRET);
  });
  it("смена ключа через setKey снимает отметку", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(401)).mockImplementation(async () => resp(200, okBody({ t0: 0.9 })));
    const { decide, kv } = setup({ openrouterKey: SECRET }, f);
    await decide(req("v1"));
    expect(await decide(req("v2"))).toEqual({ ok: false, error: "no_key" });
    await setKey(kv, SECRET + "2");
    expect(((await decide(req("v2"))) as any).ok).toBe(true);
  });
  it("повторное сохранение ТОГО ЖЕ ключа через setKey (без onChanged) снимает отметку", async () => {
    const f = vi.fn().mockResolvedValueOnce(resp(401)).mockImplementation(async () => resp(200, okBody({ t0: 0.9 })));
    const { decide, kv } = setup({}, f);
    await setKey(kv, SECRET);
    await decide(req("v1"));
    expect(await decide(req("v2"))).toEqual({ ok: false, error: "no_key" });
    expect(f).toHaveBeenCalledTimes(1);
    await setKey(kv, SECRET);
    expect(((await decide(req("v2"))) as any).ok).toBe(true);
  });
  it("запоздалый 401 старого ключа A не затирает отказ текущего B", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const f = vi.fn(async (_u: string, init: any) => {
      if (init.headers.Authorization.includes("KEYA")) { await gateA; }
      return resp(401);
    });
    const { decide, kv } = setup({}, f);
    await setKey(kv, "KEYA-aaaaaaaaaaaa");
    const late = decide(req("x"));
    await new Promise((r) => setTimeout(r, 10));
    await setKey(kv, "KEYB-bbbbbbbbbbbb");
    await decide(req("y")); // B: 401 → отказ B
    releaseA();
    await late;
    const n = f.mock.calls.length;
    expect(await decide(req("z"))).toEqual({ ok: false, error: "no_key" });
    expect(f.mock.calls.length).toBe(n);
  });
  it("A→B→A и повторное сохранение A: запоздалый 401 первого A не помечает свежий A", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let first = true;
    const f = vi.fn(async () => {
      if (first) { first = false; await gateA; return resp(401); }
      return resp(200, okBody({ t0: 0.9 }));
    });
    const { decide, kv } = setup({}, f);
    await setKey(kv, "KEYA-aaaaaaaaaaaa");
    const late = decide(req("x"));
    await new Promise((r) => setTimeout(r, 10));
    await setKey(kv, "KEYB-bbbbbbbbbbbb");
    await setKey(kv, "KEYA-aaaaaaaaaaaa");
    releaseA();
    await late;
    expect(((await decide(req("z"))) as any).ok).toBe(true);
  });
  it("параллельные отказы двух провайдеров не теряют отметки", async () => {
    const kv = fakeKV({ openrouterKey: SECRET, typesafeKey: TS_KEY });
    // оба чтения до первой записи: имитируем гонку, откладывая set
    const origSet = kv.set.bind(kv);
    kv.set = async (items) => { await new Promise((r) => setTimeout(r, 5)); await origSet(items); };
    const r = createRejections(kv);
    await Promise.all([r.mark("openrouter", SECRET, ""), r.mark("typesafe", TS_KEY, "")]);
    expect(await r.has("openrouter", SECRET, "")).toBe(true);
    expect(await r.has("typesafe", TS_KEY, "")).toBe(true);
  });
  it("отказ OpenRouter не влияет на TypeSafe (и наоборот)", async () => {
    const f = vi.fn(async () => resp(200, okBody({ t0: 0.9 })));
    const { decide, rejections, kv } = setup({ openrouterKey: SECRET, typesafeKey: TS_KEY, settings: { provider: "typesafe", model: "m", modelTypesafe: "jev-1.13.0", threshold: 0.7 } }, f);
    await rejections.mark("openrouter", SECRET, "");
    expect(((await decide(req("v1"))) as any).ok).toBe(true);
    await kv.set({ settings: { provider: "openrouter", model: "typesafe/jev-1.13", modelTypesafe: "jev-1.13.0", threshold: 0.7 } });
    expect(await decide(req("v2"))).toEqual({ ok: false, error: "no_key" });
  });
  it("TypeSafe 401 на decide помечает ключ TypeSafe", async () => {
    const f = vi.fn(async () => resp(401));
    const { decide, kv } = setup({ typesafeKey: TS_KEY, settings: { provider: "typesafe", model: "m", modelTypesafe: "jev-1.13.0", threshold: 0.7 } }, f);
    await decide(req("v1"));
    await decide(req("v2"));
    expect(f).toHaveBeenCalledTimes(1);
    expect(kv.data["keyRejected.typesafe"]).toEqual({ fp: await fingerprint(TS_KEY), gen: "" });
  });
});

describe("B1: ключ отклонён в блоке трат", () => {
  beforeEach(() => setI18nSource({ getMessage: getMessageFor("en"), getUILanguage: () => "en-US" }));
  afterEach(() => setI18nSource(undefined));
  it("/key 401 → key_rejected, повтор без запроса, decide тоже молчит", async () => {
    const f = vi.fn(async () => resp(401));
    const { usage, decide } = setup({ openrouterKey: SECRET }, f);
    expect(await usage.get()).toMatchObject({ ok: false, error: "key_rejected" });
    expect(await usage.get()).toMatchObject({ ok: false, error: "key_rejected" });
    expect(await decide(req())).toEqual({ ok: false, error: "no_key" });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("TypeSafe: после отказа на decide usage даёт key_rejected с provider", async () => {
    const { usage, rejections } = setup({ typesafeKey: TS_KEY, settings: { provider: "typesafe", model: "m", modelTypesafe: "jev-1.13.0", threshold: 0.7 } }, vi.fn());
    await rejections.mark("typesafe", TS_KEY, "");
    expect(await usage.get()).toMatchObject({ ok: false, error: "key_rejected", provider: "typesafe" });
  });
  it("нет ключа остаётся no_key", async () => {
    expect(await setup({}, vi.fn()).usage.get()).toMatchObject({ ok: false, error: "no_key" });
  });
  it("popup: отдельные строки, не «не задан»", () => {
    const local = { requestsToday: 0, requestsTotal: 0, tokensToday: 0, tokensTotal: 0 };
    expect(usageView({ ok: false, error: "key_rejected", local })).toMatchObject({ state: "key_rejected", text: "OpenRouter rejected the key" });
    expect(usageView({ ok: false, error: "key_rejected", provider: "typesafe", local })).toMatchObject({ state: "key_rejected", text: "TypeSafe rejected the key" });
  });
});
