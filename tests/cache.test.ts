import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_PAIRS, DEFAULT_TTL_MS, SHARD_PREFIX, createCache, normText } from "../src/background/cache";
import { fakeKV } from "./helpers/fake";

const DAY = 24 * 3600 * 1000;
const mk = (text: string) => ({ id: text, text });

describe("cache (пары видео-тег)", () => {
  it("нормализация: регистр и пробелы не важны", () => {
    expect(normText("  Клик   БЕЙТ\n")).toBe("клик бейт");
  });
  it("значения по умолчанию: 30 суток, 20000 пар", () => {
    expect(DEFAULT_TTL_MS).toBe(30 * DAY);
    expect(DEFAULT_MAX_PAIRS).toBe(20000);
  });
  it("get по паре; id тега не важен; разные видео независимы", async () => {
    const c = createCache({ kv: fakeKV(), now: () => 1_000_000 });
    await c.set("v", [{ text: "Клик бейт", p: 0.9 }, { text: "политика", p: 0.1 }]);
    const g = await c.get("v", [{ id: "x", text: "клик  бейт" }, mk("другое")]);
    expect(g).toEqual([0.9, undefined]);
    expect(await c.get("w", [mk("политика")])).toEqual([undefined]);
  });
  it("вероятность квантуется до тысячных", async () => {
    const c = createCache({ kv: fakeKV(), now: () => 1_000_000 });
    await c.set("v", [{ text: "a", p: 0.7 }, { text: "b", p: 0.12345 }]);
    expect(await c.get("v", [mk("a"), mk("b")])).toEqual([0.7, 0.123]);
  });
  it("добавление пары к видео не теряет прежние", async () => {
    const c = createCache({ kv: fakeKV(), now: () => 1_000_000 });
    await c.set("v", [{ text: "a", p: 0.5 }]);
    await c.set("v", [{ text: "b", p: 0.6 }]);
    expect(await c.get("v", [mk("a"), mk("b")])).toEqual([0.5, 0.6]);
  });
  it("TTL: до истечения есть, после нет", async () => {
    let t = 1_000_000;
    const c = createCache({ kv: fakeKV(), now: () => t, ttlMs: 10 * 60_000 });
    await c.set("v", [{ text: "a", p: 0.5 }]);
    t += 9 * 60_000;
    expect(await c.get("v", [mk("a")])).toEqual([0.5]);
    t += 2 * 60_000;
    expect(await c.get("v", [mk("a")])).toEqual([undefined]);
  });
  it("переживает перезапуск (новый экземпляр на том же kv)", async () => {
    const kv = fakeKV();
    await createCache({ kv, now: () => 1_000_000 }).set("v", [{ text: "a", p: 0.5 }]);
    expect(await createCache({ kv, now: () => 1_000_000 }).get("v", [mk("a")])).toEqual([0.5]);
  });
  it("(д) переполнение вытесняет самые старые, число пар ≤ ёмкости", async () => {
    let t = 60_000;
    const kv = fakeKV();
    const c = createCache({ kv, now: () => (t += 60_000), maxPairs: 100 });
    for (let i = 0; i < 60; i++) await c.set(`v${String(i).padStart(3, "0")}`, [{ text: "a", p: 0.1 }, { text: "b", p: 0.2 }]);
    const present = (await Promise.all(Array.from({ length: 60 }, (_, i) => c.get(`v${String(i).padStart(3, "0")}`, [mk("a")])))).map((r) => r[0] !== undefined);
    expect(present.filter(Boolean).length).toBeLessThanOrEqual(50);
    expect(present[59]).toBe(true);
    expect(present[0]).toBe(false);
    expect(present.indexOf(true)).toBeGreaterThan(0);
    expect(present.slice(present.indexOf(true)).every(Boolean)).toBe(true); // вытеснен префикс самых старых
  });
  it("(д) 20000 пар: размер в байтах и запись — один шард", async () => {
    let t = 0;
    const kv = fakeKV();
    const sets: string[][] = [];
    const origSet = kv.set.bind(kv);
    kv.set = async (items) => { sets.push(Object.keys(items)); await origSet(items); };
    const c = createCache({ kv, now: () => (t += 60_000) });
    // 6666 видео × 3 пары ≈ 20000; пишем пачками параллельно (батчинг)
    for (let b = 0; b < 6666; b += 500) {
      await Promise.all(Array.from({ length: Math.min(500, 6666 - b) }, (_, i) => {
        const id = `vid${String(b + i).padStart(8, "0")}`;
        return c.set(id, [{ text: "кликбейт про похудение", p: 0.123 }, { text: "политика и выборы", p: 0.987 }, { text: "обзоры гаджетов", p: 0.5 }]);
      }));
    }
    const keys = Object.keys(kv.data).filter((k) => k.startsWith(SHARD_PREFIX));
    const bytes = keys.reduce((s, k) => s + k.length + JSON.stringify(kv.data[k]).length, 0);
    console.log(`[size] pairs=${6666 * 3} keys=${keys.length} bytes=${bytes}`);
    expect(keys.length).toBeLessThanOrEqual(256);
    expect(bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    // одна запись при полном кэше = только затронутые шарды
    sets.length = 0;
    await c.set("fresh0000001", [{ text: "новое", p: 0.5 }]);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.length).toBe(1);
    const shardBytes = sets[0]!.reduce((s, k) => s + k.length + JSON.stringify(kv.data[k]).length, 0);
    console.log(`[size] one-write bytes=${shardBytes}`);
    expect(shardBytes).toBeLessThan(bytes / 50);
  });
  it("параллельные set одного хода делят один kv.set", async () => {
    const kv = fakeKV();
    let n = 0;
    const origSet = kv.set.bind(kv);
    kv.set = async (items) => { n++; await origSet(items); };
    const c = createCache({ kv, now: () => 1_000_000 });
    await c.get("warm", [mk("a")]);
    n = 0;
    await Promise.all(Array.from({ length: 10 }, (_, i) => c.set(`v${i}`, [{ text: "a", p: i / 10 }])));
    expect(n).toBe(1);
    for (let i = 0; i < 10; i++) expect(await c.get(`v${i}`, [mk("a")])).toEqual([i / 10]);
  });
  it("миграция: старый decisionCache удаляется", async () => {
    const kv = fakeKV({ decisionCache: { "v:abc": { t: 1, p: { a: 1 } } }, openrouterKey: "k" });
    const c = createCache({ kv, now: () => 1_000_000 });
    expect(await c.get("v", [mk("a")])).toEqual([undefined]);
    expect("decisionCache" in kv.data).toBe(false);
    expect(kv.data.openrouterKey).toBe("k");
  });
});

describe("версия кэша", () => {
  it("записи dc2 не используются и удаляются при первом обращении", async () => {
    const kv = fakeKV({ "dc2:00": { v1: [1, { abc: 900 }] }, "dc2:ff": {} });
    const c = createCache({ kv, now: () => 1_000_000 });
    expect(await c.get("v1", [mk("a")])).toEqual([undefined]);
    expect(Object.keys(kv.data).filter((k) => k.startsWith("dc2:"))).toEqual([]);
  });
});
