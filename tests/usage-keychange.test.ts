import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createLimiter } from "../src/background/limiter";
import { createUsageService } from "../src/background/usage";
import { fakeKV } from "./helpers/fake";

// Пара РАЗНЫХ вымышленных ключей с одинаковым FNV-1a 32 (от ревьюера usage-r1): прежний отпечаток их путал.
// В фикстуре только суффиксы (без префикса), чтобы secret scanning не принимал их за настоящие ключи.
const { aSuffix, bSuffix } = JSON.parse(readFileSync("tests/fixtures/usage-collision.json", "utf8")) as { aSuffix: string; bSuffix: string };
const KA = "sk-or-v1-" + aSuffix;
const KB = "sk-or-v1-" + bSuffix;

const body = (usage: number) => JSON.stringify({ data: { usage, usage_daily: 0, usage_monthly: 0, limit: null, limit_remaining: null } });
/** usage ответа определяется ключом из Authorization: A→1, B→2, C→3. */
const byKey = (keys: Record<string, number>) =>
  vi.fn(async (_u: unknown, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).Authorization!.slice("Bearer ".length);
    return new Response(body(keys[auth] ?? 99));
  });

function mk(f: any, initial: string | undefined = KA) {
  const kv = fakeKV(initial ? { openrouterKey: initial } : {});
  const now = () => 1000;
  const svc = createUsageService({ kv, fetch: f, now, sleep: async () => {}, random: () => 0, limiter: createLimiter({ maxConcurrent: 4, perMinute: 60, maxQueue: 50, now, sleep: async () => {} }) });
  return { kv, svc };
}
const usageOf = (r: any) => (r.ok ? r.remote.usage : r.error);

describe("ответ с ключом K не показывается при другом текущем ключе", () => {
  it("коллизионная пара ревьюера: A→B в пределах 60 с — запрос с B, данные B", async () => {
    expect(KA).not.toBe(KB);
    const f = byKey({ [KA]: 1, [KB]: 2 });
    const { svc, kv } = mk(f);
    expect(usageOf(await svc.get())).toBe(1);
    await kv.set({ openrouterKey: KB }); // без invalidate: защита не зависит от onChanged
    expect(usageOf(await svc.get())).toBe(2);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("A→B→A в пределах 60 с: данные всегда текущего ключа", async () => {
    const f = byKey({ [KA]: 1, [KB]: 2 });
    const { svc, kv } = mk(f);
    const seen = [usageOf(await svc.get())];
    await kv.set({ openrouterKey: KB });
    svc.invalidate();
    seen.push(usageOf(await svc.get()));
    await kv.set({ openrouterKey: KA });
    svc.invalidate();
    seen.push(usageOf(await svc.get()));
    expect(seen).toEqual([1, 2, 1]);
  });
  it("A→B→A без invalidate — то же самое", async () => {
    const f = byKey({ [KA]: 1, [KB]: 2 });
    const { svc, kv } = mk(f);
    const seen = [usageOf(await svc.get())];
    await kv.set({ openrouterKey: KB });
    seen.push(usageOf(await svc.get()));
    await kv.set({ openrouterKey: KA });
    seen.push(usageOf(await svc.get()));
    expect(seen).toEqual([1, 2, 1]);
  });
  it("смена ключа во время запроса в полёте: ответ A отбрасывается и не кэшируется", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async (_u: unknown, init: RequestInit) => {
      const k = (init.headers as Record<string, string>).Authorization!.slice(7);
      if (k === KA) await gate;
      return new Response(body(k === KA ? 1 : 2));
    });
    const { svc, kv } = mk(f);
    const p = svc.get();
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await kv.set({ openrouterKey: KB });
    svc.invalidate();
    release();
    expect(usageOf(await p)).toBe(2); // не 1
    expect(usageOf(await svc.get())).toBe(2);
    expect(f).toHaveBeenCalledTimes(2); // B запрошен один раз, затем кэш
  });
  it("смена во время полёта без invalidate (только сравнение ключа) — тоже отбрасывается", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async (_u: unknown, init: RequestInit) => {
      const k = (init.headers as Record<string, string>).Authorization!.slice(7);
      if (k === KA) await gate;
      return new Response(body(k === KA ? 1 : 2));
    });
    const { svc, kv } = mk(f);
    const p = svc.get();
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await kv.set({ openrouterKey: KB });
    release();
    expect(usageOf(await p)).toBe(2);
  });
  it("A→B→A во время полёта: ответ первого запроса отброшен (поколение), данные — свежие", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const f = vi.fn(async () => {
      if (first) { first = false; await gate; return new Response(body(1)); }
      return new Response(body(7));
    });
    const { svc, kv } = mk(f);
    const p = svc.get();
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await kv.set({ openrouterKey: KB }); svc.invalidate();
    await kv.set({ openrouterKey: KA }); svc.invalidate();
    release();
    expect(usageOf(await p)).toBe(7);
  });
  it("удаление ключа во время полёта и после: no_key, кэша нет; возврат ключа → новый запрос", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const f = vi.fn(async () => { calls++; if (calls === 1) await gate; return new Response(body(calls)); });
    const { svc, kv } = mk(f);
    const p = svc.get();
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await kv.remove("openrouterKey");
    svc.invalidate();
    release();
    expect(await p).toMatchObject({ ok: false, error: "no_key" });
    expect(await svc.get()).toMatchObject({ ok: false, error: "no_key" });
    await kv.set({ openrouterKey: KA });
    svc.invalidate();
    expect(usageOf(await svc.get())).toBe(2);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("удаление ключа после успешного кэша: no_key, а не данные из кэша", async () => {
    const { svc, kv } = mk(byKey({ [KA]: 1 }));
    await svc.get();
    await kv.remove("openrouterKey");
    expect(await svc.get()).toMatchObject({ ok: false, error: "no_key" });
  });
  it("ответ не содержит ключей и их частей", async () => {
    const { svc } = mk(byKey({ [KA]: 1 }));
    const s = JSON.stringify(await svc.get());
    expect(s).not.toContain(KA);
    expect(s).not.toContain(KA.slice(0, 12));
  });
});
