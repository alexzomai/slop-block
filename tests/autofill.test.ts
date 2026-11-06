import { describe, expect, it } from "vitest";
import { Autofill, LOAD_TIMEOUT_MS, MAX_EMPTY, MAX_TOTAL, type Indicator, type Snapshot } from "../src/content/autofill";

const base: Snapshot = { eligible: true, target: 12, visible: 0, cards: 0, pending: 0, filled: false, hasContinuation: true };

let triggerResult: "ok" | "unsafe" = "ok";
function setup(init: Partial<Snapshot> = {}) {
  triggerResult = "ok";
  let snap: Snapshot = { ...base, ...init };
  let t = 0;
  const log = { triggers: 0, indicators: [] as Indicator[], wakes: [] as number[] };
  const a = new Autofill({
    snapshot: () => snap,
    trigger: () => { log.triggers++; return triggerResult; },
    indicator: (i) => void log.indicators.push(i),
    now: () => t,
    wake: (ms) => void log.wakes.push(ms),
  });
  return {
    a, log,
    set: (p: Partial<Snapshot>) => { snap = { ...snap, ...p }; },
    tick: (ms: number) => { t += ms; },
    last: () => log.indicators.at(-1),
    /** Порция: добавить карточки (и разрешённые) и сразу оценить. */
    portion(addCards: number, addVisible: number, pending = 0) {
      snap = { ...snap, cards: snap.cards + addCards, visible: snap.visible + addVisible, pending };
      a.evaluate();
    },
  };
}

describe("Autofill: условие подгрузки", () => {
  it("пустая страница: подгрузка, индикатор «ищу»", () => {
    const s = setup();
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
    expect(s.last()).toBe("searching");
    expect(s.log.wakes).toEqual([LOAD_TIMEOUT_MS]);
  });
  it("цель достигнута и страница заполнена → стоп", () => {
    const s = setup({ visible: 12, cards: 30, filled: true });
    s.a.evaluate();
    expect(s.log.triggers).toBe(0);
    expect(s.last()).toBe("off");
  });
  it("видимых ≥ цели, но не заполнено → подгрузка", () => {
    const s = setup({ visible: 14, cards: 30, filled: false });
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
  });
  it("заполнено, но видимых < цели → подгрузка", () => {
    const s = setup({ visible: 7, cards: 30, filled: true });
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
  });
  it("нет continuation → стоп, индикатор скрыт, навсегда до сброса", () => {
    const s = setup({ hasContinuation: false, visible: 3, cards: 10 });
    s.a.evaluate();
    expect(s.log.triggers).toBe(0);
    expect(s.last()).toBe("off");
    s.set({ hasContinuation: true });
    s.a.evaluate();
    expect(s.log.triggers).toBe(0);
  });
  it("не eligible → ничего", () => {
    const s = setup({ eligible: false });
    s.a.evaluate();
    expect(s.log.triggers).toBe(0);
    expect(s.last()).toBe("off");
  });
  it("повторные evaluate() идемпотентны: одна подгрузка", () => {
    const s = setup();
    for (let i = 0; i < 10; i++) s.a.evaluate();
    expect(s.log.triggers).toBe(1);
  });
});

describe("Autofill: ожидание решений", () => {
  it("порция пришла, но есть необработанные → следующей подгрузки нет", () => {
    const s = setup();
    s.a.evaluate();
    s.portion(10, 0, 3);
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
    expect(s.last()).toBe("searching");
    s.tick(60_000); // время само по себе не разрешает подгрузку
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
    s.set({ pending: 0, visible: 2 });
    s.a.evaluate();
    expect(s.log.triggers).toBe(2);
  });
  it("порция не пришла до таймаута → пустая, подгрузка снова", () => {
    const s = setup();
    s.a.evaluate();
    s.tick(LOAD_TIMEOUT_MS - 1);
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
    s.tick(1);
    s.a.evaluate();
    expect(s.log.triggers).toBe(2);
  });
  it("пока порции нет и таймаут не вышел — вторая подгрузка не стартует", () => {
    const s = setup();
    s.a.evaluate();
    s.tick(1000);
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
  });
});

describe("Autofill: ограничители", () => {
  it("N пустых подряд → стоп и сообщение", () => {
    const s = setup();
    s.a.evaluate();
    for (let i = 0; i < MAX_EMPTY; i++) s.portion(10, 0); // порция без разрешённых
    expect(s.log.triggers).toBe(MAX_EMPTY);
    expect(s.last()).toBe("exhausted");
    s.portion(10, 0);
    s.a.evaluate();
    expect(s.log.triggers).toBe(MAX_EMPTY);
  });
  it("порции без прихода за таймаут тоже считаются пустыми", () => {
    const s = setup();
    s.a.evaluate();
    for (let i = 0; i < MAX_EMPTY; i++) { s.tick(LOAD_TIMEOUT_MS); s.a.evaluate(); }
    expect(s.log.triggers).toBe(MAX_EMPTY);
    expect(s.last()).toBe("exhausted");
  });
  it("M всего (по одной карточке за порцию) → стоп", () => {
    const s = setup({ target: 30 });
    s.a.evaluate();
    for (let i = 0; i < 40; i++) s.portion(5, 1);
    expect(s.log.triggers).toBe(MAX_TOTAL);
    expect(s.last()).toBe("exhausted");
  });
  it("пустая, затем успешная порция: счётчик пустых обнуляется, общий нет", () => {
    const s = setup({ target: 30 });
    s.a.evaluate();
    s.portion(10, 0); s.portion(10, 0); // 2 пустых → 3-я подгрузка
    s.portion(10, 2); // успех → 4-я подгрузка
    expect(s.log.triggers).toBe(4);
    for (let i = 0; i < MAX_EMPTY - 1; i++) s.portion(10, 0);
    expect(s.last()).toBe("searching"); // ещё не 5 подряд
    s.portion(10, 0);
    expect(s.last()).toBe("exhausted");
    expect(s.log.triggers).toBe(4 + MAX_EMPTY - 1);
  });
  it("цель достигнута посреди — стоп без исчерпания", () => {
    const s = setup();
    s.a.evaluate();
    s.set({ filled: true });
    s.portion(10, 12);
    expect(s.log.triggers).toBe(1);
    expect(s.last()).toBe("off");
  });
  it("continuation исчез после порции → конец, без сообщения об исчерпании", () => {
    const s = setup();
    s.a.evaluate();
    s.set({ hasContinuation: false });
    s.portion(10, 1);
    expect(s.log.triggers).toBe(1);
    expect(s.last()).toBe("off");
  });
});

describe("Autofill: сброс", () => {
  it("resetIfChanged с новым ключом снимает остановку и счётчики", () => {
    const s = setup();
    s.a.resetIfChanged("home|a");
    s.a.evaluate();
    for (let i = 0; i < MAX_EMPTY; i++) s.portion(10, 0);
    expect(s.last()).toBe("exhausted");
    s.a.resetIfChanged("watch|a"); // навигация
    expect(s.last()).toBe("off");
    s.set({ cards: 0, visible: 0 });
    s.a.evaluate();
    expect(s.log.triggers).toBe(MAX_EMPTY + 1);
  });
  it("тот же ключ бюджет не сбрасывает", () => {
    const s = setup();
    s.a.resetIfChanged("k");
    s.a.evaluate();
    for (let i = 0; i < MAX_EMPTY; i++) s.portion(10, 0);
    s.a.resetIfChanged("k");
    s.a.evaluate();
    expect(s.last()).toBe("exhausted");
    expect(s.log.triggers).toBe(MAX_EMPTY);
  });
  it("смена настроек (другой ключ) посреди загрузки: старая порция не засчитывается", () => {
    const s = setup();
    s.a.resetIfChanged("k1");
    s.a.evaluate();
    s.a.resetIfChanged("k2");
    s.a.evaluate();
    expect(s.log.triggers).toBe(2); // новая подгрузка после сброса, а не ожидание старой
  });
  it("ошибка снимка → стоп без исключения", () => {
    let boom = false;
    const log: Indicator[] = [];
    const a = new Autofill({
      snapshot: () => { if (boom) throw new Error("dom"); return base; },
      trigger: () => "ok", indicator: (i) => void log.push(i), now: () => 0, wake: () => {},
    });
    a.evaluate();
    boom = true;
    expect(() => a.evaluate()).not.toThrow();
    boom = false;
    a.evaluate();
    expect(log.at(-1)).toBe("off");
  });
});

describe("Autofill: небезопасный триггер", () => {
  it("trigger() вернул unsafe → остановка до навигации, индикатор unsafe, больше подгрузок нет", () => {
    const s = setup();
    triggerResult = "unsafe";
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
    expect(s.last()).toBe("unsafe");
    triggerResult = "ok";
    for (let i = 0; i < 5; i++) { s.tick(10_000); s.a.evaluate(); }
    expect(s.log.triggers).toBe(1);
    expect(s.last()).toBe("unsafe");
  });
  it("markUnsafe() (обнаружено при снятии через 2 кадра) → то же состояние", () => {
    const s = setup();
    s.a.evaluate();
    s.a.markUnsafe();
    expect(s.last()).toBe("unsafe");
    s.tick(10_000);
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
  });
  it("сброс при смене ключа (навигация/настройки) снимает unsafe", () => {
    const s = setup();
    s.a.resetIfChanged("k1");
    triggerResult = "unsafe";
    s.a.evaluate();
    triggerResult = "ok";
    s.a.resetIfChanged("k1");
    expect(s.last()).toBe("unsafe");
    s.a.resetIfChanged("k2");
    expect(s.last()).toBe("off");
    s.a.evaluate();
    expect(s.log.triggers).toBe(2);
  });
  it("неактивные состояния не показывают unsafe", () => {
    const s = setup({ eligible: false });
    s.a.markUnsafe();
    s.a.evaluate();
    expect(s.last()).toBe("off");
  });
});
