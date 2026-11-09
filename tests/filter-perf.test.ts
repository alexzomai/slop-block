import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecider } from "../src/background/decide";
import { registerListener } from "../src/background/listener";
import { createRevealer } from "../src/content/dom";
import { FeedFilter, MAX_PARALLEL, PEEK_TIMEOUT_MS } from "../src/content/filter";
import type { DecideRequest, DecideResponse, DecidedOk, PeekRequest, PeekResponse, VideoMeta } from "../src/shared/decision";
import type { Settings } from "../src/shared/settings";
import { SECRET, fakeKV, okBody, resp } from "./helpers/fake";

// --- background: slop/peek ---
const tags = [{ id: "a", text: "кликбейт" }, { id: "b", text: "политика" }];
const vid = (videoId: string) => ({ videoId, title: "T", channel: "C" });
const decideReq = (videoId: string): DecideRequest => ({ type: "slop/decide", video: vid(videoId), tags });

function bg() {
  const kv = fakeKV({ openrouterKey: SECRET });
  const fetchImpl = vi.fn(async () => resp(200, okBody({ t0: 0.9, t1: 0.1 })));
  const decide = createDecider({ kv, fetch: fetchImpl as unknown as typeof fetch, now: () => 1000, sleep: async () => {}, random: () => 0 });
  return { kv, fetchImpl, decide };
}

describe("slop/peek (background)", () => {
  it("возвращает кэшированные решения, как decide; промахи отсутствуют; fetch не вызывается", async () => {
    const { decide, fetchImpl } = bg();
    const hit = await decide(decideReq("hit"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const r = await decide.peek({ type: "slop/peek", videos: [vid("hit"), vid("miss")], tags });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: true, decisions: { hit } });
  });
  it("без ключа → no_key, без fetch", async () => {
    const kv = fakeKV({});
    const f = vi.fn();
    const decide = createDecider({ kv, fetch: f as unknown as typeof fetch, now: () => 1, sleep: async () => {}, random: () => 0 });
    expect(await decide.peek({ type: "slop/peek", videos: [vid("a")], tags })).toEqual({ ok: false, error: "no_key" });
    expect(f).not.toHaveBeenCalled();
  });
  it.each([
    ["пусто", { videos: [], tags }],
    ["больше 100", { videos: Array.from({ length: 101 }, (_, i) => vid("v" + i)), tags }],
    ["элемент без videoId", { videos: [vid("a"), { title: "x", channel: "c" }], tags }],
    ["нет тегов", { videos: [vid("a")], tags: [] }],
    ["null", null],
  ])("некорректный запрос (%s) → bad_response без fetch", async (_n, body) => {
    const { decide, fetchImpl } = bg();
    expect(await decide.peek(body)).toEqual({ ok: false, error: "bad_response" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("ровно 100 видео допустимо", async () => {
    const { decide } = bg();
    const r = await decide.peek({ type: "slop/peek", videos: Array.from({ length: 100 }, (_, i) => vid("v" + i)), tags });
    expect(r).toEqual({ ok: true, decisions: {} });
  });
  it("peek учитывает пространство кэша модели: другая модель — промах; ключ — активного провайдера", async () => {
    const { decide, kv, fetchImpl } = bg();
    await decide(decideReq("x"));
    expect(Object.keys((await decide.peek({ type: "slop/peek", videos: [vid("x")], tags }) as { decisions: object }).decisions)).toEqual(["x"]);
    await kv.set({ settings: { model: "typesafe/jev-9.99", threshold: 0.7 } }); // другая версия модели → другое пространство
    expect(await decide.peek({ type: "slop/peek", videos: [vid("x")], tags })).toEqual({ ok: true, decisions: {} });
    await kv.set({ settings: { provider: "typesafe", threshold: 0.7 } }); // ключ TypeSafe не задан
    expect(await decide.peek({ type: "slop/peek", videos: [vid("x")], tags })).toEqual({ ok: false, error: "no_key" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("peek не мешает single-flight: после промаха decide платит один раз на пару", async () => {
    const { decide, fetchImpl } = bg();
    await decide.peek({ type: "slop/peek", videos: [vid("x")], tags });
    await Promise.all([decide(decideReq("x")), decide(decideReq("x"))]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("listener: slop/peek", () => {
  const mk = () => {
    let cb!: (m: unknown, s: { id?: string }, r: (x: unknown) => void) => boolean | void;
    const h = { decide: vi.fn(async () => ({ ok: true })), peek: vi.fn(async () => ({ ok: true, decisions: {} })), usage: vi.fn() };
    registerListener({ addListener: (f) => { cb = f; } }, "me", h as never);
    return { h, send: (m: unknown, id: string | null) => { const r = vi.fn(); return { ret: cb(m, id === null ? {} : { id }, r), r }; } };
  };
  it("от себя — отвечает", async () => {
    const { send, h } = mk();
    const { ret, r } = send({ type: "slop/peek" }, "me");
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(r).toHaveBeenCalledWith({ ok: true, decisions: {} }));
    expect(h.peek).toHaveBeenCalledOnce();
  });
  it.each([["чужой", "evil"], ["без id", null]])("%s sender.id — игнорируется", (_n, id) => {
    const { send, h } = mk();
    const { ret, r } = send({ type: "slop/peek" }, id);
    expect(ret).toBe(false);
    expect(r).not.toHaveBeenCalled();
    expect(h.peek).not.toHaveBeenCalled();
  });
});

// --- content: FeedFilter + peek ---
interface Card { id: string; hidden: boolean; shown: boolean; instant?: boolean }
const S = (mode: "allowlist" | "blocklist" = "allowlist"): Settings => ({ enabled: true, tags: [{ id: "t0", text: "x", enabled: true }], mode, skipSubscriptions: false, filterSearch: false, feedTarget: 12 });
const ok = (hide: boolean): DecidedOk => ({ ok: true, hide, matchedTagIds: hide ? [] : ["t0"], probabilities: {} });
const at = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function make(opts: { ids: string[]; peek?: (r: PeekRequest) => Promise<PeekResponse>; send?: (r: DecideRequest) => Promise<DecideResponse>; mode?: "allowlist" | "blocklist" }) {
  const cards: Card[] = opts.ids.map((id) => ({ id, hidden: false, shown: false }));
  const sent: string[] = [];
  const peeks: PeekRequest[] = [];
  const f = new FeedFilter<Card>({
    findCards: () => cards,
    extract: (c): VideoMeta => ({ videoId: c.id, title: "t", channel: "c" }),
    hide: (c) => void (c.hidden = true),
    show: (c) => void (c.hidden = false),
    allow: (c, instant) => { c.shown = true; c.instant = !!instant; },
    disallow: (c) => void (c.shown = false),
    send: async (r) => { sent.push(r.video.videoId); return (opts.send ?? (async () => ok(false)))(r); },
    ...(opts.peek ? { peek: async (r: PeekRequest) => { peeks.push(r); return opts.peek!(r); } } : {}),
  }, S(opts.mode));
  return { f, cards, sent, peeks };
}
const hitAll = (ids: string[]): PeekResponse => ({ ok: true, decisions: Object.fromEntries(ids.map((i) => [i, ok(false)])) });

describe("FeedFilter + slop/peek", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("повторный визит: одно сообщение peek, ноль decide, карточки проявлены как мгновенные", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => "v" + i);
    const a = make({ ids, peek: async () => hitAll(ids) });
    a.f.schedule(); await at(10);
    expect(a.peeks).toHaveLength(1);
    expect(a.peeks[0]!.videos.map((v) => v.videoId)).toEqual(ids);
    expect(a.sent).toHaveLength(0);
    expect(a.cards.every((c) => c.shown && c.instant)).toBe(true);
  });
  it("частичное попадание: хиты проявлены сразу, промахи уходят в decide в порядке страницы", async () => {
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"];
    const a = make({ ids, peek: async () => hitAll(["a2", "a5"]), send: () => new Promise(() => {}) });
    a.f.schedule(); await at(10);
    expect(a.cards.filter((c) => c.shown).map((c) => c.id)).toEqual(["a2", "a5"]);
    expect(a.sent).toEqual(["a1", "a3", "a4", "a6", "a7"]); // MAX_PARALLEL первых промахов по порядку
    expect(a.sent).toHaveLength(MAX_PARALLEL);
  });
  it("хиты не ждут занятых платных слотов", async () => {
    const a = make({ ids: ["m1", "m2", "m3", "m4", "m5", "m6", "h1"], peek: async () => hitAll(["h1"]), send: () => new Promise(() => {}) });
    a.f.schedule(); await at(10);
    expect(a.cards.find((c) => c.id === "h1")!.shown).toBe(true);
  });
  it.each([
    ["исключение", async () => { throw new Error("no receiver"); }],
    ["ok:false", async (): Promise<PeekResponse> => ({ ok: false, error: "bad_response" })],
    ["мусор", async () => ({}) as PeekResponse],
    ["просрочка", () => new Promise<PeekResponse>(() => {})],
  ])("сбой peek (%s) → все в decide, ничего не скрыто навсегда", async (_n, peek) => {
    const ids = ["a", "b", "c"];
    const a = make({ ids, peek });
    a.f.schedule(); await at(PEEK_TIMEOUT_MS + 100);
    expect(a.sent).toEqual(ids);
    expect(a.cards.every((c) => c.shown && !c.instant)).toBe(true);
  });
  it("no_key от peek → режим неактивен, decide не шлётся", async () => {
    const a = make({ ids: ["a", "b"], peek: async () => ({ ok: false, error: "no_key" }) });
    a.f.schedule(); await at(10);
    expect(a.sent).toHaveLength(0);
    expect(a.f.snapshot().active).toBe(false);
  });
  it("устаревший ответ peek (смена тегов) игнорируется", async () => {
    let release!: (r: PeekResponse) => void;
    const a = make({ ids: ["a"], peek: () => new Promise<PeekResponse>((r) => { release = r; }) });
    a.f.schedule(); await at(10);
    a.f.reconfigure({ ...S(), tags: [{ id: "t9", text: "другое", enabled: true }] }, { onSubscriptions: false });
    release(hitAll(["a"]));
    await at(5);
    expect(a.cards[0]!.instant).not.toBe(true);
  });
  it("без peek в deps поведение прежнее (всё в decide)", async () => {
    const a = make({ ids: ["a", "b"] });
    a.f.schedule(); await at(10);
    expect(a.sent).toEqual(["a", "b"]);
  });
  it("повторный проход не шлёт peek по уже проверенным видео", async () => {
    const a = make({ ids: ["a", "b"], peek: async () => hitAll([]) });
    a.f.schedule(); await at(400);
    a.f.schedule(); await at(400);
    expect(a.peeks).toHaveLength(1);
    expect(a.sent).toEqual(["a", "b"]);
  });
  it("blocklist: hide:true из peek скрывает карточку сразу", async () => {
    const a = make({ ids: ["a"], mode: "blocklist", peek: async () => ({ ok: true, decisions: { a: ok(true) } }) });
    a.f.schedule(); await at(10);
    expect(a.cards[0]!.hidden).toBe(true);
    expect(a.sent).toHaveLength(0);
  });
});

describe("FeedFilter: порядок платной очереди при параллельных peek-пакетах", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const ids101 = Array.from({ length: 101 }, (_, i) => "c" + String(i).padStart(3, "0"));
  const hold = () => { let release!: (r: PeekResponse) => void; const p = new Promise<PeekResponse>((r) => { release = r; }); return { p, release }; };

  it("101 карточка: второй пакет (1 видео) отвечает раньше первого (100) — первым платным уходит c000", async () => {
    const first = hold();
    const a = make({ ids: ids101, peek: (r) => (r.videos.length === 100 ? first.p : Promise.resolve(hitAll([]))), send: () => new Promise(() => {}) });
    a.f.schedule(); await at(10);
    expect(a.peeks.map((p) => p.videos.length)).toEqual([100, 1]);
    expect(a.sent).toEqual([]); // c100 не обгоняет более ранние карточки
    first.release(hitAll([]));
    await at(5);
    expect(a.sent).toEqual(ids101.slice(0, MAX_PARALLEL));
  });
  it("хиты первого пакета выпускают промахи дальше по порядку; хиты применяются сразу", async () => {
    const first = hold();
    const a = make({ ids: ids101, peek: (r) => (r.videos.length === 100 ? first.p : Promise.resolve(hitAll(["c100"]))), send: () => new Promise(() => {}) });
    a.f.schedule(); await at(10);
    expect(a.cards[100]!.shown).toBe(true); // хит второго пакета проявлен, не дожидаясь первого
    expect(a.sent).toEqual([]);
    first.release(hitAll(ids101.slice(0, 10)));
    await at(5);
    expect(a.sent).toEqual(ids101.slice(10, 10 + MAX_PARALLEL));
  });
  it("просрочка первого пакета не блокирует навсегда: после дедлайна порядок сохраняется", async () => {
    const a = make({ ids: ids101, peek: (r) => (r.videos.length === 100 ? new Promise<PeekResponse>(() => {}) : Promise.resolve(hitAll([]))), send: () => new Promise(() => {}) });
    a.f.schedule(); await at(10);
    expect(a.sent).toEqual([]);
    await at(PEEK_TIMEOUT_MS + 50);
    expect(a.sent).toEqual(ids101.slice(0, MAX_PARALLEL));
  });
  it("порции разных проходов: поздняя порция не обгоняет раннюю", async () => {
    const early = hold();
    let n = 0;
    const a = make({ ids: ["a1", "a2"], peek: () => (n++ === 0 ? early.p : Promise.resolve(hitAll([]))), send: () => new Promise(() => {}) });
    a.f.schedule(); await at(10);
    a.cards.push({ id: "b1", hidden: false, shown: false });
    a.f.schedule(); await at(400);
    expect(a.peeks).toHaveLength(2);
    expect(a.sent).toEqual([]);
    early.release(hitAll([]));
    await at(5);
    expect(a.sent).toEqual(["a1", "a2", "b1"]);
  });
  it("сбой пакета (исключение) отдаёт его промахи на своём месте", async () => {
    const a = make({ ids: ids101, peek: async (r) => { if (r.videos.length === 100) throw new Error("x"); return hitAll([]); }, send: () => new Promise(() => {}) });
    a.f.schedule(); await at(10);
    expect(a.sent).toEqual(ids101.slice(0, MAX_PARALLEL));
  });
});

describe("createRevealer: мгновенное проявление", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("instant: без лесенки (индекс 0) и без ожидания пачки 120 мс", () => {
    const calls: [string, number][] = [];
    const r = createRevealer<string>({ reveal: (e, i) => calls.push([e, i]), hide: () => {} });
    for (let i = 0; i < 5; i++) r.allow(`c${i}`, true);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([0, 1, 2, 3, 4].map((i) => [`c${i}`, 0]));
  });
  it("disallow отменяет мгновенный показ; обычные идут пачкой как раньше", () => {
    const calls: [string, number][] = [];
    const r = createRevealer<string>({ reveal: (e, i) => calls.push([e, i]), hide: () => {} });
    r.allow("a", true); r.allow("b", true); r.disallow("a"); r.allow("c");
    vi.advanceTimersByTime(1);
    expect(calls).toEqual([["b", 0]]);
    vi.advanceTimersByTime(130);
    expect(calls).toEqual([["b", 0], ["c", 0]]);
  });
});
