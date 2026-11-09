import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTEMPT_TIMEOUT_MS, FeedFilter } from "../src/content/filter";
import type { DecideRequest, DecideResponse } from "../src/shared/decision";
import type { Mode, Settings } from "../src/shared/settings";

interface Card { id: string; hidden: boolean; shown: boolean }
const S = (mode: Mode, o: Partial<Settings> = {}): Settings => ({ enabled: true, tags: [{ id: "t0", text: "IT", enabled: true }], mode, skipSubscriptions: true, filterSearch: false, feedTarget: 12, ...o });
const ok = (hide: boolean, matched: string[]): DecideResponse => ({ ok: true, hide, matchedTagIds: matched, probabilities: {} });
type Answer = (r: DecideRequest) => Promise<DecideResponse> | DecideResponse;

function setup(settings: Settings, answer: Answer, ids = ["v1"]) {
  const cards: Card[] = ids.map((id) => ({ id, hidden: false, shown: false }));
  const sent: DecideRequest[] = [];
  const env = { gate: false };
  const f = new FeedFilter<Card>({
    findCards: () => cards,
    extract: (c) => (c.id ? { videoId: c.id, title: "t", channel: "c" } : null),
    hide: (c) => void (c.hidden = true),
    show: (c) => void (c.hidden = false),
    allow: (c) => void (c.shown = true),
    disallow: (c) => void (c.shown = false),
    setGate: (on) => void (env.gate = on),
    send: async (r) => { sent.push(r); return answer(r); },
  }, settings);
  /** итоговая видимость глазами пользователя */
  const visible = (c: Card) => (env.gate ? c.shown : !c.hidden);
  return { f, cards, sent, env, visible };
}
const at = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("таблица режим × ответ", () => {
  type Row = [string, Answer, { allow: boolean; block: boolean }];
  const rows: Row[] = [
    ["подходит (hide:true, matched)", () => ok(true, ["t0"]), { allow: true, block: false }],
    ["подходит (hide:false, matched) — hide игнорируется", () => ok(false, ["t0"]), { allow: true, block: true }],
    ["не подходит (hide:false, [])", () => ok(false, []), { allow: false, block: true }],
    ["не подходит (hide:true, []) — hide игнорируется", () => ok(true, []), { allow: false, block: false }],
    ["bad_response", () => ({ ok: false, error: "bad_response" }), { allow: true, block: true }],
    ["no_key", () => ({ ok: false, error: "no_key" }), { allow: true, block: true }],
    ["неразборчивый ответ", () => undefined as never, { allow: true, block: true }],
    ["мусорный ответ", () => ({ ok: "yes" }) as never, { allow: true, block: true }],
  ];
  it.each(rows)("%s", async (_n, answer, want) => {
    const a = setup(S("allowlist"), answer);
    a.f.schedule(); await at(400);
    expect(a.visible(a.cards[0]!)).toBe(want.allow);
    const b = setup(S("blocklist"), answer);
    b.f.schedule(); await at(400);
    expect(b.visible(b.cards[0]!)).toBe(want.block);
  });
});

describe("allowlist: временные сбои и граница исчерпания", () => {
  const temp: [string, Answer][] = [
    ["network", () => ({ ok: false, error: "network" })],
    ["rate_limited", () => ({ ok: false, error: "rate_limited" })],
    ["исключение", () => { throw new Error("no receiver"); }],
  ];
  it.each(temp)("%s: скрыта между попытками, видна после 3-й неудачи, ровно 3 отправки", async (_n, answer) => {
    const a = setup(S("allowlist"), answer);
    a.f.schedule();
    await at(400);
    expect(a.sent).toHaveLength(1);
    expect(a.visible(a.cards[0]!)).toBe(false);
    await at(30_000);
    expect(a.sent).toHaveLength(2);
    expect(a.visible(a.cards[0]!)).toBe(false);
    await at(119_000); // 149,4 с
    expect(a.sent).toHaveLength(2);
    expect(a.visible(a.cards[0]!)).toBe(false);
    await at(1_000); // 150,4 с: третья отправка ушла и провалилась
    expect(a.sent).toHaveLength(3);
    expect(a.visible(a.cards[0]!)).toBe(true);
    await at(600_000);
    expect(a.sent).toHaveLength(3);
    expect(a.visible(a.cards[0]!)).toBe(true);
  });

  it("blocklist: при тех же сбоях всегда видна", async () => {
    const a = setup(S("blocklist"), () => ({ ok: false, error: "network" }));
    a.f.schedule();
    for (const ms of [400, 30_000, 120_000, 5_000]) { await at(ms); expect(a.visible(a.cards[0]!)).toBe(true); }
  });

  it("дедлайн попытки: молчащий background → 3 просроченные попытки, затем видна", async () => {
    const a = setup(S("allowlist"), () => new Promise<DecideResponse>(() => {}));
    a.f.schedule();
    await at(300 + ATTEMPT_TIMEOUT_MS - 1_000);
    expect(a.visible(a.cards[0]!)).toBe(false);
    await at(2_000);
    expect(a.sent).toHaveLength(1);
    await at(30_000 + 20_000 + 120_000 + 20_000); // верхняя граница 210,3 с
    expect(a.sent).toHaveLength(3);
    expect(a.visible(a.cards[0]!)).toBe(true);
  });

  it("запоздалый ответ после дедлайна игнорируется", async () => {
    let resolve!: (r: DecideResponse) => void;
    const a = setup(S("allowlist"), () => new Promise<DecideResponse>((r) => { resolve = r; }));
    a.f.schedule();
    await at(300 + ATTEMPT_TIMEOUT_MS + 100);
    resolve(ok(false, ["t0"]));
    await at(10);
    expect(a.visible(a.cards[0]!)).toBe(false);
  });
});

describe("allowlist: no_key, неактивность, шлюз", () => {
  it("no_key: все карточки видны, шлюз снят, новых запросов нет", async () => {
    const a = setup(S("allowlist"), () => ({ ok: false, error: "no_key" }), ["v1", "v2", "v3", "v4", "v5"]);
    a.f.schedule(); await at(400);
    expect(a.cards.every((c) => a.visible(c))).toBe(true);
    expect(a.env.gate).toBe(false);
    const n = a.sent.length;
    expect(n).toBeLessThanOrEqual(5); // не больше параллельности; остальные не отправлялись
    a.f.schedule(); await at(400);
    expect(a.sent).toHaveLength(n);
  });
  it("после no_key смена настроек сбрасывает состояние: одна новая проверка", async () => {
    const a = setup(S("allowlist"), () => ({ ok: false, error: "no_key" }));
    a.f.schedule(); await at(400);
    expect(a.sent).toHaveLength(1);
    a.f.reconfigure(S("allowlist", { tags: [{ id: "t0", text: "другое", enabled: true }] }), { onSubscriptions: false });
    expect(a.env.gate).toBe(true);
    await at(400);
    expect(a.sent).toHaveLength(2);
    expect(a.env.gate).toBe(false);
  });
  it("шлюз взводится в allowlist при активном фильтре и снят во всех других случаях", () => {
    const cases: [Settings, boolean][] = [
      [S("allowlist"), true],
      [S("blocklist"), false],
      [S("allowlist", { enabled: false }), false],
      [S("allowlist", { tags: [] }), false],
    ];
    for (const [s, want] of cases) {
      const a = setup(s, () => ok(false, []));
      a.f.reconfigure(s, { onSubscriptions: false });
      expect(a.env.gate).toBe(want);
    }
  });
  it("выключение фильтра мгновенно возвращает всё (без таймеров и запросов)", async () => {
    const a = setup(S("allowlist"), (r) => ok(false, r.video.videoId === "v1" ? ["t0"] : []), ["v1", "v2"]);
    a.f.schedule(); await at(400);
    expect(a.cards.map((c) => a.visible(c))).toEqual([true, false]);
    const n = a.sent.length;
    a.f.reconfigure(S("allowlist", { enabled: false }), { onSubscriptions: false });
    expect(a.cards.every((c) => a.visible(c))).toBe(true);
    expect(a.env.gate).toBe(false);
    expect(a.cards.every((c) => !c.shown)).toBe(true);
    await at(1_000);
    expect(a.sent).toHaveLength(n);
  });
  it("смена режима переиспользует решения: нет повторных запросов, видимость пересчитана", async () => {
    const a = setup(S("allowlist"), (r) => ok(r.video.videoId === "v1", r.video.videoId === "v1" ? ["t0"] : []), ["v1", "v2"]);
    a.f.schedule(); await at(400);
    expect(a.cards.map((c) => a.visible(c))).toEqual([true, false]);
    a.f.reconfigure(S("blocklist"), { onSubscriptions: false });
    expect(a.cards.map((c) => a.visible(c))).toEqual([false, true]);
    a.f.reconfigure(S("allowlist"), { onSubscriptions: false });
    expect(a.cards.map((c) => a.visible(c))).toEqual([true, false]);
    await at(1_000);
    expect(a.sent).toHaveLength(2);
  });
  it("карточка без videoId в allowlist не остаётся скрытой", async () => {
    const a = setup(S("allowlist"), () => ok(false, []), [""]);
    a.f.schedule(); await at(400);
    expect(a.visible(a.cards[0]!)).toBe(true);
    expect(a.sent).toHaveLength(0);
  });
});

describe("подписки", () => {
  it.each(["allowlist", "blocklist"] as const)("%s + skip: всё видно, 0 запросов", async (mode) => {
    const a = setup(S(mode), () => ok(true, ["t0"]));
    a.f.reconfigure(S(mode), { onSubscriptions: true });
    a.f.schedule(); await at(2_000);
    expect(a.sent).toHaveLength(0);
    expect(a.env.gate).toBe(false);
    expect(a.visible(a.cards[0]!)).toBe(true);
  });
  it("skip выключен: подписки фильтруются как лента", async () => {
    const a = setup(S("allowlist", { skipSubscriptions: false, filterSearch: false, feedTarget: 12 }), () => ok(false, []));
    a.f.reconfigure(S("allowlist", { skipSubscriptions: false, filterSearch: false, feedTarget: 12 }), { onSubscriptions: true });
    a.f.schedule(); await at(400);
    expect(a.sent).toHaveLength(1);
    expect(a.visible(a.cards[0]!)).toBe(false);
  });
  it("SPA главная → подписки → главная; ответ запроса «в полёте» игнорируется", async () => {
    let resolve!: (r: DecideResponse) => void;
    const a = setup(S("allowlist"), () => new Promise<DecideResponse>((r) => { resolve = r; }));
    a.f.schedule(); await at(400);
    expect(a.sent).toHaveLength(1);
    expect(a.visible(a.cards[0]!)).toBe(false);
    a.f.reconfigure(S("allowlist"), { onSubscriptions: true });
    expect(a.visible(a.cards[0]!)).toBe(true);
    resolve(ok(false, []));
    await at(10);
    expect(a.visible(a.cards[0]!)).toBe(true);
    expect(a.sent).toHaveLength(1);
    a.f.reconfigure(S("allowlist"), { onSubscriptions: false });
    expect(a.env.gate).toBe(true);
    expect(a.visible(a.cards[0]!)).toBe(false);
  });
});
