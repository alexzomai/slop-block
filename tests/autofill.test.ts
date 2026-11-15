import { describe, expect, it } from "vitest";
import { Autofill, END_GRACE_MS, LOAD_TIMEOUT_MS, MAX_EMPTY, MAX_RETRIGGER, MAX_TOTAL, RETRIGGER_MS, SEARCH_CEILING_MS, STALL_MS, type Indicator, type IndicatorInfo, type Snapshot } from "../src/content/autofill";

const base: Snapshot = { eligible: true, target: 12, visible: 0, cards: 0, pending: 0, filled: false, hasContinuation: true };

let triggerResult: "ok" | "unsafe" = "ok";
function setup(init: Partial<Snapshot> = {}) {
  triggerResult = "ok";
  let snap: Snapshot = { ...base, ...init };
  let t = 0;
  const log = { triggers: 0, indicators: [] as Indicator[], infos: [] as IndicatorInfo[], wakes: [] as number[] };
  const a = new Autofill({
    snapshot: () => snap,
    trigger: () => { log.triggers++; return triggerResult; },
    indicator: (i, info) => void (log.indicators.push(i), log.infos.push(info)),
    now: () => t,
    wake: (ms) => void log.wakes.push(ms),
  });
  return {
    a, log,
    set: (p: Partial<Snapshot>) => { snap = { ...snap, ...p }; },
    tick: (ms: number) => { t += ms; },
    last: () => log.indicators.at(-1),
    info: () => log.infos.at(-1)!,
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
    expect(s.log.wakes).toEqual([RETRIGGER_MS]);
  });
  it("цель достигнута и страница заполнена → стоп", () => {
    const s = setup({ visible: 12, cards: 30, filled: true });
    s.a.evaluate();
    expect(s.log.triggers).toBe(0);
    expect(s.last()).toBe("done");
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
  it("нет continuation → подгрузки нет, индикатор скрыт; появился — работаем (не липкий «конец»)", () => {
    const s = setup({ hasContinuation: false, visible: 3, cards: 10 });
    s.a.evaluate();
    expect(s.log.triggers).toBe(0);
    expect(s.last()).toBe("off");
    s.set({ hasContinuation: true });
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
  });
  it("первый проход до отрисовки continuation (карточек 0) не останавливает автодогрузку на весь заход", () => {
    const s = setup({ hasContinuation: false, cards: 0 });
    s.a.evaluate();
    s.a.evaluate();
    s.set({ hasContinuation: true, cards: 6, pending: 6 });
    s.a.evaluate();
    s.set({ pending: 0 });
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
    expect(s.last()).toBe("searching");
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
    s.tick(25_000); // время само по себе не разрешает подгрузку
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
    s.set({ pending: 0, visible: 2 });
    s.a.evaluate();
    expect(s.log.triggers).toBe(2);
  });
  it("порция не пришла до таймаута → повторы триггера, затем пустая, подгрузка снова", () => {
    const s = setup();
    s.a.evaluate();
    s.tick(RETRIGGER_MS);
    s.a.evaluate();
    s.tick(RETRIGGER_MS);
    s.a.evaluate();
    s.tick(LOAD_TIMEOUT_MS - 2 * RETRIGGER_MS - 1);
    s.a.evaluate();
    expect(s.log.triggers).toBe(1 + MAX_RETRIGGER); // повторы внутри той же порции
    s.tick(1);
    s.a.evaluate();
    expect(s.log.triggers).toBe(2 + MAX_RETRIGGER); // порция пустая, начата следующая
  });
  it("пока порции нет и таймаут не вышел — новая порция не стартует, только повторы триггера", () => {
    const s = setup();
    s.a.evaluate();
    s.tick(RETRIGGER_MS - 1);
    s.a.evaluate();
    expect(s.log.triggers).toBe(1);
    s.tick(1);
    s.a.evaluate();
    expect(s.log.triggers).toBe(2);
    s.tick(RETRIGGER_MS);
    s.a.evaluate();
    expect(s.log.triggers).toBe(3);
    s.tick(RETRIGGER_MS - 1); // повторов больше MAX_RETRIGGER нет
    s.a.evaluate();
    expect(s.log.triggers).toBe(3);
    expect(s.log.wakes.every((w) => w > 0)).toBe(true);
  });
  it("ожидание порции без изменений DOM: каждый проход будит на ближайшую границу (повтор/таймаут), без дублей", () => {
    const s = setup();
    s.a.evaluate();
    expect(s.log.wakes.filter((w) => w <= LOAD_TIMEOUT_MS)).toEqual([RETRIGGER_MS]);
    s.tick(100);
    s.a.evaluate(); // запрошенное пробуждение ещё впереди: не дублируем
    s.a.evaluate();
    expect(s.log.wakes.filter((w) => w <= LOAD_TIMEOUT_MS)).toEqual([RETRIGGER_MS]);
    s.tick(RETRIGGER_MS - 100); // сработало пробуждение: повтор + следующая граница
    s.a.evaluate();
    expect(s.log.wakes.filter((w) => w <= LOAD_TIMEOUT_MS).at(-1)).toBe(RETRIGGER_MS);
    s.tick(RETRIGGER_MS);
    s.a.evaluate();
    expect(s.log.wakes.filter((w) => w <= LOAD_TIMEOUT_MS).at(-1)).toBe(LOAD_TIMEOUT_MS - 2 * RETRIGGER_MS); // остаток до таймаута, а не вечное ожидание
    s.tick(LOAD_TIMEOUT_MS - 2 * RETRIGGER_MS);
    s.a.evaluate();
    expect(s.log.triggers).toBe(2 + MAX_RETRIGGER); // таймаут → пустая → следующая порция
  });
  it("повторный триггер при unsafe → остановка unsafe, дальше повторов нет", () => {
    const s = setup();
    s.a.evaluate();
    triggerResult = "unsafe";
    s.tick(RETRIGGER_MS);
    s.a.evaluate();
    expect(s.last()).toBe("unsafe");
    const n = s.log.triggers;
    s.tick(LOAD_TIMEOUT_MS * 3);
    s.a.evaluate();
    expect(s.log.triggers).toBe(n);
  });
  it("повторы не расходуют бюджет порций: total растёт на порцию, пустая серия — на порцию, не на повтор", () => {
    const s = setup();
    s.a.evaluate();
    for (let i = 0; i < MAX_EMPTY; i++) {
      s.tick(LOAD_TIMEOUT_MS);
      s.a.evaluate();
    }
    expect(s.last()).toBe("exhausted");
    expect(s.log.triggers).toBeLessThanOrEqual(MAX_EMPTY * (1 + MAX_RETRIGGER) + 1);
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
    expect(s.last()).toBe("done");
  });
  it("continuation исчез после порции → конец, без сообщения об исчерпании", () => {
    const s = setup();
    s.a.evaluate();
    s.set({ hasContinuation: false });
    s.portion(10, 1);
    expect(s.log.triggers).toBe(1);
    expect(s.last()).toBe("searching"); // пауза END_GRACE_MS: индикатор «ищу» сохраняется, «конец» — позже
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

describe("Autofill: потолок ожидания и кнопка (feed-hang)", () => {
  it("непрерывное «ищу» без роста видимых упирается в SEARCH_CEILING_MS → остановка с кнопкой", () => {
    const s = setup({ pending: 2, cards: 10, visible: 3 });
    s.a.evaluate();
    expect(s.last()).toBe("searching");
    for (let i = 0; i < 4; i++) { s.tick(14_000); s.a.evaluate(); }
    s.tick(10_000);
    s.a.evaluate();
    expect(s.last()).toBe("exhausted");
  });
  it("рост видимых сдвигает потолок", () => {
    const s = setup({ pending: 2, cards: 10, visible: 3 });
    s.a.evaluate();
    s.tick(50_000);
    s.set({ visible: 4 });
    s.a.evaluate();
    s.tick(20_000);
    s.set({ pending: 2 });
    s.a.evaluate();
    expect(s.last()).toBe("searching");
  });
  it("потолок запрашивает пробуждение на остаток", () => {
    const s = setup({ pending: 1, cards: 10, visible: 3 });
    s.a.evaluate();
    s.tick(1000);
    s.a.evaluate();
    expect(s.log.wakes.some((w) => w > 50_000 && w <= SEARCH_CEILING_MS)).toBe(true);
  });
  it("кнопка при висящих решениях всё равно запускает загрузку (force)", () => {
    const s = setup({ pending: 2, cards: 10, visible: 3 });
    s.a.evaluate();
    s.tick(STALL_MS + 100);
    s.a.evaluate();
    expect(s.last()).toBe("exhausted");
    const before = s.log.triggers;
    s.a.loadMore();
    expect(s.log.triggers).toBe(before + 1);
    expect(s.last()).toBe("searching");
  });
  it("жест после зависания возобновляет загрузку", () => {
    const s = setup({ pending: 2, cards: 10, visible: 3 });
    s.a.evaluate();
    s.tick(STALL_MS + 100);
    s.a.evaluate();
    expect(s.last()).toBe("exhausted");
    const t1 = s.log.triggers;
    s.a.userIntent();
    expect(s.log.triggers).toBe(t1 + 1);
  });
  it("debug: состояние/причина и счётчики без лишнего", () => {
    const out: string[] = [];
    let t = 0;
    const a = new Autofill({
      snapshot: () => ({ ...base, cards: 3, visible: 1 }),
      trigger: () => "ok",
      indicator: () => {},
      now: () => t,
      wake: () => {},
      debug: (st, info) => void out.push(`${st}|${info}`),
    });
    a.evaluate();
    expect(out.at(-1)).toMatch(/^searching\/triggered\|cards=3 visible=1 pending=0 total=0 empty=0/);
    t += LOAD_TIMEOUT_MS * (MAX_EMPTY + 1);
    for (let i = 0; i < MAX_EMPTY + 1; i++) { t += LOAD_TIMEOUT_MS + 1; a.evaluate(); }
    expect(out.at(-1)).toMatch(/^exhausted\/empty/);
  });
});

describe("Autofill: мерцание счёта видимых не сдвигает потолок", () => {
  it("падение и возврат visible к прежнему значению — не рост", () => {
    const s = setup({ pending: 1, cards: 10, visible: 6 });
    s.a.evaluate();
    s.tick(SEARCH_CEILING_MS - 20_000);
    s.set({ visible: 0 });
    s.a.evaluate();
    s.tick(10_000);
    s.set({ visible: 6 });
    s.a.evaluate();
    s.tick(10_001);
    s.a.evaluate();
    expect(s.last()).toBe("exhausted");
  });
});

describe("Autofill: индикатор (только отображение)", () => {
  it("поиск: числа найдено/цель/проверено из snapshot", () => {
    const s = setup({ target: 12, visible: 3, cards: 48, pending: 5 });
    s.a.evaluate();
    expect(s.last()).toBe("searching");
    expect(s.info()).toMatchObject({ found: 3, target: 12, checked: 43, failure: null });
  });
  it("цель достигнута → done с числом найденных", () => {
    const s = setup({ visible: 14, cards: 40, filled: true });
    s.a.evaluate();
    expect(s.last()).toBe("done");
    expect(s.info()).toMatchObject({ found: 14, target: 12, checked: 40 });
  });
  it("остановка по пустой серии: reason=empty, sinceGrowth — карточки после последнего роста", () => {
    const s = setup();
    s.a.evaluate();
    s.portion(10, 2); // рост видимых
    for (let i = 0; i < MAX_EMPTY; i++) s.portion(10, 0);
    expect(s.last()).toBe("exhausted");
    expect(s.info()).toMatchObject({ reason: "empty", found: 2, sinceGrowth: 10 * MAX_EMPTY });
  });
  it("порции не приходят вовсе: empty при sinceGrowth=0 (текст «YouTube не отдаёт»)", () => {
    const s = setup({ cards: 20, visible: 0 });
    s.a.evaluate();
    for (let i = 0; i < MAX_EMPTY; i++) {
      s.tick(LOAD_TIMEOUT_MS);
      s.a.evaluate();
    }
    expect(s.last()).toBe("exhausted");
    expect(s.info()).toMatchObject({ reason: "empty" });
    expect(s.info().sinceGrowth).toBe(20); // карточки были с самого начала, но подходящих не было ни разу
  });
  it("зависание решений: reason=stall; потолок: reason=ceiling", () => {
    const a = setup({ cards: 10, pending: 4 });
    a.a.evaluate();
    a.portion(10, 0, 4);
    a.tick(STALL_MS);
    a.a.evaluate();
    expect(a.last()).toBe("exhausted");
    expect(a.info().reason).toBe("stall");
    const b = setup({ cards: 5 });
    b.a.evaluate();
    b.tick(SEARCH_CEILING_MS);
    b.a.evaluate();
    expect(b.last()).toBe("exhausted");
    expect(b.info().reason).toBe("ceiling");
  });
  it("конец ленты: нет continuation ≥ END_GRACE_MS → end; раньше — скрыт и будит себя", () => {
    const s = setup({ hasContinuation: false, visible: 3, cards: 10 });
    s.a.evaluate();
    expect(s.last()).toBe("off");
    expect(s.log.wakes).toContain(END_GRACE_MS);
    s.tick(END_GRACE_MS);
    s.a.evaluate();
    expect(s.last()).toBe("end");
    expect(s.log.triggers).toBe(0);
    s.set({ hasContinuation: true });
    s.a.evaluate();
    expect(s.last()).toBe("searching"); // появился continuation — «конец» снят
  });
  it("continuation пропал во время поиска: «ищу» сохраняется на паузе, потом «конец» (индикатор не мигает)", () => {
    const s = setup({ cards: 6, visible: 2 });
    s.a.evaluate();
    expect(s.last()).toBe("searching");
    s.set({ cards: 7, hasContinuation: false });
    s.a.evaluate();
    expect(s.log.indicators).not.toContain("off");
    expect(s.last()).toBe("searching");
    s.tick(END_GRACE_MS - 1);
    s.a.evaluate();
    expect(s.last()).toBe("searching");
    s.tick(1);
    s.a.evaluate();
    expect(s.last()).toBe("end");
  });
  it("мерцание continuation между порциями не даёт «конец»", () => {
    const s = setup({ hasContinuation: false, visible: 3, cards: 10 });
    s.a.evaluate();
    s.tick(END_GRACE_MS - 100);
    s.set({ hasContinuation: true });
    s.a.evaluate();
    s.tick(500);
    s.set({ hasContinuation: false });
    s.a.evaluate();
    expect(s.last()).not.toBe("end"); // порция идёт (searching), а не «конец ленты»
  });
  it("нет карточек и нет continuation → не «конец»", () => {
    const s = setup({ hasContinuation: false, cards: 0 });
    s.a.evaluate();
    s.tick(END_GRACE_MS * 5);
    s.a.evaluate();
    expect(s.last()).toBe("off");
  });
  it("сбой фильтра: error поверх любого состояния, в том числе при не-eligible; unsafe остаётся unsafe", () => {
    const s = setup({ eligible: false, failure: "no_key" });
    s.a.evaluate();
    expect(s.last()).toBe("error");
    expect(s.info().failure).toBe("no_key");
    const p = setup({ failure: "network" });
    p.a.evaluate();
    expect(p.last()).toBe("error");
    expect(p.log.triggers).toBe(1); // логика автодогрузки не меняется: порция запущена как обычно
    const u = setup({ failure: "network" });
    triggerResult = "unsafe";
    u.a.evaluate();
    expect(u.last()).toBe("unsafe");
    triggerResult = "ok";
  });
  it("зависание решений при сбое провайдера остаётся остановкой (с кнопкой), а не error", () => {
    const s = setup({ cards: 10, pending: 4, failure: "network" });
    s.a.evaluate();
    s.tick(STALL_MS);
    s.a.evaluate();
    expect(s.last()).toBe("exhausted");
    expect(s.info().reason).toBe("stall");
  });
  it("сбой исчез — индикатор возвращается к обычному состоянию", () => {
    const s = setup({ failure: "rate_limited" });
    s.a.evaluate();
    expect(s.last()).toBe("error");
    s.set({ failure: null });
    s.a.evaluate();
    expect(s.last()).toBe("searching");
  });
});
