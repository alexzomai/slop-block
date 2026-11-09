import { describe, expect, it, vi } from "vitest";
import { Autofill, INTENT_COOLDOWN_MS, LOAD_TIMEOUT_MS, MAX_EMPTY, type Snapshot } from "../src/content/autofill";
import { createHider, HIDE_BATCH_MS } from "../src/content/dom";
import { createHold } from "../src/content/feed";
import { readFileSync } from "node:fs";

const base: Snapshot = { eligible: true, target: 6, visible: 0, cards: 6, pending: 0, filled: false, hasContinuation: true };

function setup(init: Partial<Snapshot> = {}) {
  let snap: Snapshot = { ...base, ...init };
  let live = snap.cards;
  let t = 0;
  const holds: boolean[] = [];
  let triggers = 0;
  const a = new Autofill({
    snapshot: () => snap,
    trigger: () => (triggers++, "ok"),
    indicator: () => {},
    now: () => t,
    wake: () => {},
    hold: (on) => void holds.push(on),
    liveCards: () => live,
  });
  a.observe();
  return {
    a,
    holds,
    triggers: () => triggers,
    held: () => holds.at(-1),
    set: (p: Partial<Snapshot>) => void (snap = { ...snap, ...p }),
    /** Порция пришла в DOM (раньше, чем сканирование фильтра её увидит). */
    dom: (cards: number) => void (live = cards),
    tick: (ms: number) => void (t += ms),
  };
}

describe("Autofill: удержание continuation (F1/F2)", () => {
  it("на время триггера удержание снято, после прихода порции в DOM — возвращается синхронно, до сканирования", () => {
    const s = setup();
    s.a.evaluate();
    expect(s.triggers()).toBe(1);
    expect(s.holds).toContain(false);
    expect(s.held()).toBe(false); // порция открыта: YouTube должен её загрузить
    s.dom(36); // MutationObserver увидел новые карточки; scan() фильтра ещё не прошёл
    s.a.onDomChange();
    expect(s.held()).toBe(true);
  });

  it("порция пришла, решения идут → удержание, следующей порции нет, YouTube цепочкой не грузит", () => {
    const s = setup();
    s.a.evaluate();
    s.set({ cards: 36, pending: 30 });
    s.a.evaluate();
    expect(s.triggers()).toBe(1);
    expect(s.held()).toBe(true);
  });

  it("цель достигнута и страница заполнена → удержания нет (прокрутка пользователя штатная)", () => {
    const s = setup({ visible: 6, filled: true });
    s.a.evaluate();
    expect(s.triggers()).toBe(0);
    expect(s.held()).toBe(false);
  });

  it("пустое совпадение: N порций, стоп по лимиту, удержание остаётся (YouTube сам не догружает)", () => {
    const s = setup();
    for (let i = 0; i < MAX_EMPTY; i++) {
      s.a.evaluate();
      s.set({ cards: s.triggers() * 30 + 6 });
      s.dom(s.triggers() * 30 + 6);
      s.a.onDomChange();
      s.a.evaluate();
    }
    s.a.evaluate();
    expect(s.triggers()).toBe(MAX_EMPTY);
    expect(s.held()).toBe(true);
    s.a.evaluate();
    expect(s.triggers()).toBe(MAX_EMPTY);
  });

  it("не eligible, конец ленты, ошибка: удержания нет", () => {
    const a = setup({ eligible: false });
    a.a.evaluate();
    expect(a.held()).toBe(false);
    const b = setup({ hasContinuation: false });
    b.a.evaluate();
    expect(b.held()).toBe(false);
    const c = new Autofill({
      snapshot: () => {
        throw new Error("dom");
      },
      trigger: () => "ok",
      indicator: () => {},
      now: () => 0,
      wake: () => {},
      hold: (on) => void (c2 = on),
    });
    let c2: boolean | undefined;
    c.evaluate();
    expect(c2).toBe(false);
  });

  it("порция не пришла за тайм-аут: удержание не навсегда (повтор триггера или лимит)", () => {
    const s = setup();
    s.a.evaluate();
    s.tick(LOAD_TIMEOUT_MS + 1);
    s.a.evaluate();
    expect(s.triggers()).toBe(2);
  });
});

describe("Autofill: жест пользователя после остановки", () => {
  function stopByLimit() {
    const s = setup();
    for (let i = 0; i < MAX_EMPTY; i++) {
      s.a.evaluate();
      s.set({ cards: (i + 1) * 30 + 6 });
      s.a.evaluate();
    }
    s.a.evaluate();
    return s;
  }
  it("после лимита жест возобновляет с новым бюджетом, не чаще раза за INTENT_COOLDOWN_MS", () => {
    const s = stopByLimit();
    const n = s.triggers();
    s.tick(INTENT_COOLDOWN_MS);
    s.a.userIntent();
    expect(s.triggers()).toBe(n + 1);
    // снова доходим до лимита; жест сразу (без ожидания кулдауна) ничего не даёт
    for (let i = 0; i < MAX_EMPTY + 1; i++) {
      s.set({ cards: 1000 + i * 30 });
      s.a.evaluate();
    }
    const m = s.triggers();
    s.a.userIntent();
    expect(s.triggers()).toBe(m);
  });
  it("жест без остановки ничего не меняет", () => {
    const s = setup();
    s.a.userIntent();
    expect(s.triggers()).toBe(0);
  });
});

describe("createHider: пачечное скрытие blocklist (F3)", () => {
  function env() {
    const timers: Array<{ at: number; cb: () => void }> = [];
    let now = 0;
    const applied: string[] = [];
    const h = createHider<string>({ hide: (e) => void applied.push(`hide:${e}`), show: (e) => void applied.push(`show:${e}`) });
    const real = globalThis.setTimeout;
    return { h, applied, real, timers, advance: (_ms: number) => now += _ms };
  }
  it("скрытия копятся и применяются одним пакетом через HIDE_BATCH_MS", async () => {
    vi.useFakeTimers();
    try {
      const { h, applied } = env();
      h.hide("a");
      vi.advanceTimersByTime(50);
      h.hide("b");
      vi.advanceTimersByTime(50);
      h.hide("c");
      expect(applied).toEqual([]); // fail-open: до применения карточки видны
      vi.advanceTimersByTime(HIDE_BATCH_MS);
      expect(applied).toEqual(["hide:a", "hide:b", "hide:c"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("show отменяет отложенное скрытие", async () => {
    vi.useFakeTimers();
    try {
      const { h, applied } = env();
      h.hide("a");
      h.show("a");
      vi.advanceTimersByTime(HIDE_BATCH_MS * 2);
      expect(applied).toEqual(["show:a"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("gate.css: удержание continuation", () => {
  it("правило действует только при шлюзе allowlist и атрибуте удержания, смещение вверх", () => {
    const css = readFileSync("static/gate.css", "utf8");
    expect(css).toMatch(/html\[data-slop-gate="allowlist"\]\[data-slop-hold\] ytd-continuation-item-renderer\s*\{\s*transform: translateY\(-\d+px\) !important;/);
  });
});

describe("createHold: удержание не меняет геометрию (инвариант)", () => {
  function env(shiftOnHold: number, cont = true) {
    const attrs = new Set<string>();
    const root = { setAttribute: (n: string) => void attrs.add(n), removeAttribute: (n: string) => void attrs.delete(n) };
    const geometry = () => ({ height: 1000 + (attrs.has("data-slop-hold") ? shiftOnHold : 0), top: 0, left: 0 });
    return { attrs, hold: createHold(root, geometry, () => cont) };
  }
  it("геометрия та же — удержание работает и переключается", () => {
    const { attrs, hold } = env(0);
    hold(true);
    expect(attrs.has("data-slop-hold")).toBe(true);
    hold(false);
    expect(attrs.has("data-slop-hold")).toBe(false);
    hold(true);
    expect(attrs.has("data-slop-hold")).toBe(true);
  });
  it("геометрия меняется (страничный transform у continuation) — удержание отключено навсегда", () => {
    const { attrs, hold } = env(60);
    hold(true);
    expect(attrs.has("data-slop-hold")).toBe(false);
    hold(true);
    expect(attrs.has("data-slop-hold")).toBe(false);
  });
  it("у continuation свой transform/позиционирование (plain=false) — не держим, но и не отключаем навсегда", () => {
    const attrs = new Set<string>();
    const root = { setAttribute: (n: string) => void attrs.add(n), removeAttribute: (n: string) => void attrs.delete(n) };
    let plain = false;
    const hold = createHold(root, () => ({ height: 1000, top: 0, left: 0 }), () => true, () => plain);
    hold(true);
    expect(attrs.has("data-slop-hold")).toBe(false);
    plain = true;
    hold(true);
    expect(attrs.has("data-slop-hold")).toBe(true);
  });
  it("нет continuation — проверять не на чем, атрибут не трогаем", () => {
    const { attrs, hold } = env(60, false);
    attrs.add("data-slop-hold"); // стартовое удержание шлюза
    hold(true);
    expect(attrs.has("data-slop-hold")).toBe(true);
    hold(false);
    expect(attrs.has("data-slop-hold")).toBe(false);
  });
});

describe("Autofill: удержание до первого evaluate()", () => {
  it("изменение DOM до первого снимка взводит удержание (шлюз уже скрыл карточки)", () => {
    const s = setup();
    s.a.onDomChange();
    expect(s.held()).toBe(true);
    s.set({ eligible: false });
    s.a.evaluate();
    expect(s.held()).toBe(false);
  });
});

describe("createHold: позиция прокрутки при откате (ревью P2-1)", () => {
  /** Документ 1500 px; при включении удержания сжимается до 900 и браузер ограничивает scrollTop (800 → 200). */
  function env() {
    let held = false;
    let top = 800;
    const h = () => (held ? 900 : 1500);
    const root = {
      setAttribute: () => void (held = true),
      removeAttribute: () => {
        held = false; // высота возвращается, scrollTop не возвращается
      },
    };
    const geometry = () => {
      top = Math.min(top, Math.max(0, h() - 700));
      return { height: h(), top, left: 0 };
    };
    const restore = (g: { top: number }) => void (top = g.top);
    return { hold: createHold(root, geometry, () => true, () => true, restore), top: () => top, held: () => held };
  }
  it("включение сжало документ: удержание отключено, scrollTop возвращён (800)", () => {
    const e = env();
    e.hold(true);
    expect(e.held()).toBe(false);
    expect(e.top()).toBe(800);
    e.hold(true);
    expect(e.held()).toBe(false);
    expect(e.top()).toBe(800);
  });
});

describe("Autofill: порция, начатая YouTube до удержания, входит в бюджет (ревью P2-2)", () => {
  it("исходные карточки → нативная порция считается пустой: всего MAX_EMPTY порций, не MAX_EMPTY+1", () => {
    let snap: Snapshot = { ...base, cards: 6 };
    let live = 6;
    const t = 0;
    let triggers = 0;
    const a = new Autofill({ snapshot: () => snap, trigger: () => (triggers++, "ok"), indicator: () => {}, now: () => t, wake: () => {}, hold: () => {}, liveCards: () => live });
    a.observe(); // исходные 6 карточек при подключении наблюдателя
    live = 36; // нативная порция до первого evaluate
    snap = { ...snap, cards: 36 };
    a.onDomChange();
    let seen = triggers;
    for (let i = 0; i < 30; i++) {
      a.evaluate(); // первый вызов: нативная порция = порция 1 (пустая)
      if (triggers > seen) {
        seen = triggers;
        snap = { ...snap, cards: snap.cards + 30 }; // порция, вызванная триггером, пришла
      }
    }
    const portions = 1 + triggers;
    expect(portions).toBe(MAX_EMPTY);
    expect(triggers).toBe(MAX_EMPTY - 1);
  });
});

describe("Autofill: быстрые нативные порции после старта (ревью r2)", () => {
  it("несколько нативных порций между evaluate() считаются каждая; больше порций, чем лимит, не набирается", () => {
    let snap: Snapshot = { ...base, cards: 6 };
    let live = 6;
    const t = 0;
    let triggers = 0;
    const holds: boolean[] = [];
    const a = new Autofill({ snapshot: () => snap, trigger: () => (triggers++, "ok"), indicator: () => {}, now: () => t, wake: () => {}, hold: (on) => void holds.push(on), liveCards: () => live });
    a.observe();
    let portions = 0;
    const portion = () => {
      live += 30;
      portions++;
      a.onDomChange();
    };
    portion(); // нативная до первого evaluate
    portion(); // и ещё одна до evaluate
    snap = { ...snap, cards: live };
    for (let i = 0; i < 40; i++) {
      const before = triggers;
      a.evaluate();
      if (triggers > before) {
        portion(); // порция по нашему триггеру
        snap = { ...snap, cards: live };
      }
    }
    expect(portions).toBeLessThanOrEqual(MAX_EMPTY);
    expect(holds.at(-1)).toBe(true);
  });
});
