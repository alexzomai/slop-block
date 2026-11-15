import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RECHECKS, RECHECK_MS, FeedFilter } from "../src/content/filter";
import type { DecideRequest, DecideResponse, VideoMeta } from "../src/shared/decision";
import { DEFAULT_SETTINGS, normalize, setCompatUbol, type Mode, type Settings } from "../src/shared/settings";
import { fromItems, loadSettings, saveSettings, toItems } from "../src/shared/storage";
import { PopupController } from "../src/popup/controller";

// Режим совместимости с uBlock Origin Lite: карточки, спрятанные чужим CSS, не считаются, а в blocklist ещё и не оцениваются.
interface Card { id: string; title: string; shown: boolean; hidden: boolean; ext: boolean }
const S = (mode: Mode, compat: boolean): Settings => ({
  enabled: true, tags: [{ id: "t0", text: "кликбейт", enabled: true }], mode, skipSubscriptions: false, filterSearch: false, compatUbol: compat, feedTarget: 12,
});
const ok = (hide: boolean): DecideResponse => ({ ok: true, hide, matchedTagIds: hide ? ["t0"] : [], probabilities: {} });

function setup(settings: Settings, withRendered = true) {
  const cards: Card[] = [];
  const sent: DecideRequest[] = [];
  const f = new FeedFilter<Card>(
    {
      findCards: () => cards,
      extract: (c): VideoMeta | null => (c.id ? { videoId: c.id, title: c.title, channel: "ch" } : null),
      hide: (c) => void (c.hidden = true),
      show: (c) => void (c.hidden = false),
      allow: (c) => void (c.shown = true),
      disallow: (c) => void (c.shown = false),
      send: async (r) => { sent.push(r); return ok(r.video.videoId.startsWith("bad")); },
      ...(withRendered ? { rendered: (c: Card) => !c.ext } : {}),
    },
    settings,
  );
  const card = (id: string, ext = false): Card => { const c = { id, title: "t " + id, shown: false, hidden: false, ext }; cards.push(c); return c; };
  return { f, cards, sent, card };
}
const flush = async (ms = 350) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("настройка compatUbol", () => {
  it("по умолчанию выключена; мусор → false; true сохраняется", () => {
    expect(DEFAULT_SETTINGS.compatUbol).toBe(false);
    expect(normalize(undefined).compatUbol).toBe(false);
    expect(normalize({ enabled: true, tags: [] }).compatUbol).toBe(false); // миграция: поля не было
    for (const v of ["yes", 1, null, "true", {}]) expect(normalize({ compatUbol: v }).compatUbol).toBe(false);
    expect(normalize({ compatUbol: true }).compatUbol).toBe(true);
    expect(setCompatUbol(DEFAULT_SETTINGS, true).compatUbol).toBe(true);
  });
  it("хранится в sync-item slop.settings и читается обратно", async () => {
    const s = setCompatUbol({ ...DEFAULT_SETTINGS, tags: [] }, true);
    expect((toItems(s)["slop.settings"] as { compatUbol: boolean }).compatUbol).toBe(true);
    expect(fromItems(toItems(s)).compatUbol).toBe(true);
    const mem: Record<string, unknown> = {};
    const area = {
      get: async (k: string | string[] | null) => (k === null ? { ...mem } : Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in mem).map((x) => [x, mem[x]]))),
      set: async (i: Record<string, unknown>) => void Object.assign(mem, i),
      remove: async (ks: string[]) => void ks.forEach((k) => delete mem[k]),
    };
    await saveSettings(area, s);
    expect((await loadSettings(area)).compatUbol).toBe(true);
  });
  it("PopupController.setCompatUbol сохраняет и перерисовывает", async () => {
    const saved: Settings[] = [];
    const c = new PopupController({ save: async (s) => void saved.push(s), render: () => {} }, { ...DEFAULT_SETTINGS, tags: [] });
    expect(await c.setCompatUbol(true)).toBe(true);
    expect(c.state.compatUbol).toBe(true);
    expect(saved.at(-1)?.compatUbol).toBe(true);
  });
});

describe("compatUbol выключен: поведение прежнее", () => {
  it("blocklist: спрятанные чужим карточки оцениваются и считаются", async () => {
    const { f, sent, card } = setup(S("blocklist", false));
    card("a"); card("b", true);
    f.schedule(); await flush();
    expect(sent.map((r) => r.video.videoId).sort()).toEqual(["a", "b"]);
    expect(f.snapshot().cards).toBe(2);
  });
  it("allowlist: безымянная спрятанная карточка считается видимой (как раньше)", async () => {
    const { f, card } = setup(S("allowlist", false));
    card("", true);
    f.schedule(); await flush();
    expect(f.snapshot().visible).toBe(1);
    expect(f.snapshot().cards).toBe(1);
  });
});

describe("compatUbol включён", () => {
  it("allowlist: безымянная (реклама) спрятанная чужим карточка не входит ни в visible, ни в cards; видимая входит", async () => {
    const { f, card } = setup(S("allowlist", true));
    card("", true); card("");
    f.schedule(); await flush();
    const s = f.snapshot();
    expect(s.visible).toBe(1);
    expect(s.cards).toBe(1);
  });

  it("allowlist: карточки с id по-прежнему оцениваются (шлюз скрывает невыявленные, причину скрытия не отличить)", async () => {
    const { f, sent, card } = setup(S("allowlist", true));
    card("a", true); card("b");
    f.schedule(); await flush();
    expect(sent.map((r) => r.video.videoId).sort()).toEqual(["a", "b"]);
  });

  it("blocklist: спрятанная чужим карточка без решения не оценивается и не считается", async () => {
    const { f, sent, card } = setup(S("blocklist", true));
    card("a"); card("z", true);
    f.schedule(); await flush();
    expect(sent.map((r) => r.video.videoId)).toEqual(["a"]);
    expect(f.snapshot().cards).toBe(1);
    expect(f.snapshot().pending).toBe(0);
  });

  it("blocklist: после снятия чужого скрытия карточка оценивается и скрывается по решению (повторная проверка по таймеру)", async () => {
    const { f, sent, card } = setup(S("blocklist", true));
    const c = card("bad1", true);
    f.schedule(); await flush();
    expect(sent).toHaveLength(0);
    c.ext = false; // uBOL снял скрытие без изменения DOM: наблюдатели молчат
    await flush(RECHECK_MS + 400);
    expect(sent.map((r) => r.video.videoId)).toEqual(["bad1"]);
    expect(c.hidden).toBe(true);
    expect(f.snapshot().cards).toBe(1);
  });

  it("повторные проверки ограничены MAX_RECHECKS; затем ждём обычного сигнала", async () => {
    const { f, sent, card } = setup(S("blocklist", true));
    const c = card("x", true);
    f.schedule(); await flush();
    await flush(RECHECK_MS * (MAX_RECHECKS + 5));
    expect(sent).toHaveLength(0);
    c.ext = false; // скрытие снялось уже после исчерпания таймерных проверок
    await flush(RECHECK_MS * 3);
    expect(sent).toHaveLength(0); // таймеры больше не взводятся
    f.schedule(); await flush(); // обычный сигнал (мутация DOM) подхватывает карточку
    expect(sent.map((r) => r.video.videoId)).toEqual(["x"]);
  });

  it("blocklist: уже принятое решение для спрятанной карточки применяется (скрытие остаётся нашим)", async () => {
    const { f, card } = setup(S("blocklist", true));
    const a = card("bad2");
    f.schedule(); await flush();
    expect(a.hidden).toBe(true);
    a.ext = true; // теперь карточку прячет ещё и чужой CSS
    f.schedule(); await flush();
    expect(a.hidden).toBe(true);
  });

  it("без метода rendered режим совместимости ничего не меняет", async () => {
    const { f, sent, card } = setup(S("blocklist", true), false);
    card("a"); card("b", true);
    f.schedule(); await flush();
    expect(sent).toHaveLength(2);
    expect(f.snapshot().cards).toBe(2);
  });

  it("смена настройки через reconfigure применяется сразу", async () => {
    const { f, card } = setup(S("allowlist", false));
    card("", true);
    f.schedule(); await flush();
    expect(f.snapshot().cards).toBe(1);
    f.reconfigure(S("allowlist", true), { onSubscriptions: false });
    f.schedule(); await flush();
    expect(f.snapshot().cards).toBe(0);
  });
});
