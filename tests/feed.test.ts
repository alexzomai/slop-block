import { afterEach, describe, expect, it } from "vitest";
import type { IndicatorInfo } from "../src/content/autofill";
import { setI18nSource } from "../src/shared/i18n";
import { getMessageFor } from "./helpers/messages";
import { FILL_MARGIN, countRenderedShown, isRendered, indicatorTexts, isFilled, reenter, restoreScroll, type Geometry, type ReenterEnv } from "../src/content/feed";

describe("isFilled", () => {
  it.each([
    [[], 800, false],
    [[300, 500], 800, false],
    [[800 + FILL_MARGIN - 1], 800, false],
    [[799], 800, false],
    [[800 + FILL_MARGIN], 800, true],
    [[100, 1500, 900], 800, true],
  ])("bottoms=%j h=%j → %j", (bottoms, h, want) => {
    expect(isFilled(bottoms, h)).toBe(want);
  });
});

describe("тексты индикатора (через словарь)", () => {
  afterEach(() => setI18nSource(undefined));
  const info = (p: Partial<IndicatorInfo> = {}): IndicatorInfo => ({ found: 3, target: 12, checked: 48, reason: null, sinceGrowth: 0, failure: null, ...p });
  const use = (lang: "en" | "ru") => setI18nSource({ getMessage: getMessageFor(lang), getUILanguage: () => lang });

  it.each([
    ["ru", "Ищу подходящие видео…", "Найдено 3 из 12 · проверено 48 видео"],
    ["en", "Looking for matching videos…", "Found 3 of 12 · 48 checked"],
  ] as const)("поиск с прогрессом, язык %s", (lang, title, detail) => {
    use(lang);
    expect(indicatorTexts("searching", info())).toEqual({ title, detail });
  });
  it.each([
    ["ru", "Готово. Подходящих видео: 12", "Прокрутите вниз — подберу ещё"],
    ["en", "Done. Matching videos: 12", "Scroll down and I'll find more"],
  ] as const)("цель достигнута, язык %s", (lang, title, detail) => {
    use(lang);
    expect(indicatorTexts("done", info({ found: 12 }))).toEqual({ title, detail });
  });
  it("остановка: причина определяет текст", () => {
    use("ru");
    expect(indicatorTexts("exhausted", info({ reason: "empty", sinceGrowth: 75 })).title).toBe("Поиск остановлен — в последних 75 видео ничего подходящего");
    // пустая серия, но карточки не приходили вовсе — это YouTube, а не «ничего подходящего»
    expect(indicatorTexts("exhausted", info({ reason: "empty", sinceGrowth: 0 })).title).toBe("Поиск остановлен — YouTube не отдаёт новые видео");
    expect(indicatorTexts("exhausted", info({ reason: "ceiling" })).title).toBe("Поиск остановлен — YouTube не отдаёт новые видео");
    expect(indicatorTexts("exhausted", info({ reason: "stall" })).title).toBe("Поиск остановлен — проверка видео не отвечает");
    expect(indicatorTexts("exhausted", info({ reason: "total" })).title).toBe("Поиск остановлен — проверено 48 видео, найдено 3 из 12");
    use("en");
    expect(indicatorTexts("exhausted", info({ reason: "empty", sinceGrowth: 75 })).title).toBe("Search stopped — none of the last 75 videos matched");
    expect(indicatorTexts("exhausted", info({ reason: "stall" })).detail).toBe("Press the button to continue, or change your tags");
  });
  it("конец ленты и небезопасная геометрия", () => {
    use("ru");
    expect(indicatorTexts("end", info())).toEqual({ title: "Больше видео нет", detail: "Найдено: 3 · проверено: 48" });
    expect(indicatorTexts("unsafe", info())).toEqual({ title: "Прокрутите вниз, чтобы загрузить ещё", detail: "" });
  });
  it.each([
    ["no_key", "Фильтр не работает: нет ключа или ключ отклонён"],
    ["rate_limited", "Фильтр не работает: превышен лимит запросов"],
    ["network", "Фильтр не работает: нет связи с провайдером"],
    ["bad_response", "Фильтр не работает: провайдер вернул непонятный ответ"],
    ["no_credits", "Фильтр не работает: у провайдера нет кредитов — пополните баланс"],
    ["access_denied", "Фильтр не работает: провайдер закрыл доступ из вашей сети или региона — включите VPN"],
  ] as const)("ошибка фильтра: %s", (failure, title) => {
    use("ru");
    // без ключа шлюз снят и лента правда без фильтра; при сбое провайдера карточки до повторов скрыты — текст этого не обещает
    const detail = failure === "no_key" || failure === "no_credits" || failure === "access_denied" ? "Лента показана без фильтрации" : "Повторяю в фоне; видео появятся после проверки";
    expect(indicatorTexts("error", info({ failure }))).toEqual({ title, detail });
  });
});

describe("reenter: только transform вверх, раскладка не трогается", () => {
  function env(top = 100, height = 800, hgt = 60) {
    const frames: Array<() => void> = [];
    const timers: Array<() => void> = [];
    const events: string[] = [];
    const style: Record<string, string> = {};
    const touched = new Set<string>();
    const geo: Geometry = { height: 1000, top: 200, left: 0 };
    const restored: Geometry[] = [];
    /** «CSS страницы»: что происходит с геометрией при установке/снятии transform. */
    const page: { onSet(v: string): void; onRemove(): void } = { onSet: () => {}, onRemove: () => {} };
    const el = {
      style: {
        getPropertyValue: (n: string) => style[n] ?? "",
        getPropertyPriority: () => "",
        setProperty: (n: string, v: string) => { touched.add(n); style[n] = v; page.onSet(v); },
        removeProperty: (n: string) => { touched.add(n); const v = style[n] ?? ""; delete style[n]; page.onRemove(); return v; },
      },
      getBoundingClientRect: () => ({ top, bottom: top + hgt }),
    };
    const e: ReenterEnv = {
      raf: (cb) => void frames.push(cb),
      timeout: (cb) => void timers.push(cb),
      dispatch: (name) => void events.push(name),
      height: () => height,
      geometry: () => ({ ...geo }),
      restore: (g) => { restored.push(g); geo.top = g.top; geo.left = g.left; },
    };
    const frame = (n = 1) => { for (let i = 0; i < n; i++) { const cur = frames.splice(0); cur.forEach((f) => f()); } };
    return { el, e, style, touched, timers, events, frame, geo, restored, page };
  }
  const shiftOf = (t: string | undefined): number => Number(/translateY\((-?\d+)px\)/.exec(t ?? "")![1]);

  it("в окне: уводит выше верхней границы (выход), через 2 кадра возвращает (вход), затем scroll/resize", () => {
    const { el, e, style, frame, events } = env(100, 800, 60);
    reenter(el, e);
    expect(shiftOf(style.transform)).toBeLessThanOrEqual(-(160 + 1)); // bottom=160 → уход выше 0
    frame(); expect(style.transform).toBeDefined();
    frame(); expect(style.transform).toBeUndefined(); // вход
    expect(events).toEqual([]);
    frame(2);
    expect(events).toEqual(["scroll", "resize"]);
  });
  it("ниже окна: заводится в окно на PEEK_PX на 2 кадра, затем возвращается", () => {
    const { el, e, style, frame, events } = env(1000, 800);
    reenter(el, e);
    expect(shiftOf(style.transform)).toBe(-(1000 - (800 - 60)));
    frame(); expect(style.transform).toBeDefined();
    frame(); expect(style.transform).toBeUndefined();
    expect(events).toEqual(["scroll", "resize"]);
  });
  it("выше окна: ничего не двигаем, только события", () => {
    const { el, e, style, touched, events } = env(-500, 800, 60);
    reenter(el, e);
    expect(style.transform).toBeUndefined();
    expect(touched.has("transform")).toBe(true); // только возврат прежнего значения
    expect(events).toEqual(["scroll", "resize"]);
  });
  it("ИНВАРИАНТ: единственное свойство, которое трогается, — transform; сдвиги только вверх (отрицательные)", () => {
    for (const top of [-20, 0, 100, 700, 790, 800, 1500]) {
      const { el, e, touched, style, frame } = env(top, 800);
      const seen: string[] = [];
      const origSet = el.style.setProperty;
      el.style.setProperty = (n: string, v: string) => { seen.push(v); origSet(n, v); };
      reenter(el, e);
      frame(6);
      expect([...touched]).toEqual(["transform"]);
      for (const v of seen) expect(shiftOf(v)).toBeLessThan(0);
      expect(style.transform).toBeUndefined();
    }
  });
  it("страховка таймером возвращает transform, если кадры не идут", () => {
    const { el, e, style, timers, events } = env(1000);
    reenter(el, e);
    timers.shift()!();
    expect(style.transform).toBeUndefined();
    expect(events).toEqual(["scroll", "resize"]);
  });
  it("прежний inline transform возвращается", () => {
    const { el, e, style, frame } = env(100);
    style.transform = "scale(1)";
    reenter(el, e);
    frame(6);
    expect(style.transform).toBe("scale(1)");
  });
  it("не диспатчит дважды, если сработали и кадры, и таймер", () => {
    const { el, e, frame, timers, events } = env(1000);
    reenter(el, e);
    frame(6);
    timers.shift()!();
    expect(events).toEqual(["scroll", "resize"]);
  });

  describe("измерь → примени → измерь → откати (контракт не зависит от CSS страницы)", () => {
    it("геометрия не менялась: результат ok, откатов нет, onUnsafe не вызван", () => {
      const { el, e, frame, restored } = env(100);
      let unsafe = 0;
      expect(reenter(el, e, () => void unsafe++)).toBe("ok");
      frame(8);
      expect(unsafe).toBe(0);
      expect(restored).toEqual([]);
    });
    it("при применении изменилась высота (страничный transform перекрыт): откат в той же задаче, «unsafe», кадры не запрашиваются", () => {
      const { el, e, style, geo, page, frame, events, restored } = env(100);
      style.transform = "translateY(60px)";
      // страница: свой transform давал +60 к высоте; наш отрицательный перекрывает его, и браузер ограничивает scrollTop
      page.onSet = (v) => { if (v.includes("(-")) { geo.height = 940; geo.top = 140; } }; // эффект даёт только НАШ отрицательный transform
      page.onRemove = () => { geo.height = 1000; /* scrollTop сам не возвращается */ };
      let unsafe = 0;
      expect(reenter(el, e, () => void unsafe++)).toBe("unsafe");
      expect(style.transform).toBe("translateY(60px)"); // прежнее значение страницы возвращено
      expect(geo).toEqual({ height: 1000, top: 200, left: 0 }); // и scrollTop восстановлен к снимку
      expect(restored).toEqual([{ height: 1000, top: 200, left: 0 }]);
      frame(8);
      expect(events).toEqual([]); // события не шлём: триггер не применён
      expect(unsafe).toBe(0); // синхронный отказ сообщается результатом, не колбэком
    });
    it("изменился только scrollLeft или scrollTop → тоже unsafe", () => {
      for (const field of ["top", "left"] as const) {
        const { el, e, geo, page } = env(100);
        page.onSet = () => { geo[field] += 5; };
        expect(reenter(el, e)).toBe("unsafe");
        expect(geo[field]).toBe(field === "top" ? 200 : 0);
      }
    });
    it("геометрия меняется при снятии transform через 2 кадра: откат scrollTop к значению до снятия, onUnsafe", () => {
      const { el, e, geo, page, frame, restored } = env(100);
      let unsafe = 0;
      page.onRemove = () => { geo.height = 1060; geo.top = 150; }; // при снятии браузер сдвинул позицию
      expect(reenter(el, e, () => void unsafe++)).toBe("ok"); // применение само геометрию не меняло
      frame(6);
      expect(unsafe).toBe(1);
      expect(restored.at(-1)).toEqual({ height: 1000, top: 200, left: 0 });
      expect(geo.top).toBe(200);
    });
    it("изменение геометрии самой страницей между измерениями (порция) не считается нарушением: pre/post меряются в одной задаче", () => {
      const { el, e, geo, frame } = env(100);
      let unsafe = 0;
      reenter(el, e, () => void unsafe++);
      geo.height = 2000; // пришла порция, пока transform применён
      frame(6);
      expect(unsafe).toBe(0);
    });
    it("страховка таймером тоже проверяет геометрию при снятии", () => {
      const { el, e, geo, page, timers } = env(1000);
      let unsafe = 0;
      reenter(el, e, () => void unsafe++);
      page.onRemove = () => { geo.top = 100; };
      timers.shift()!();
      expect(unsafe).toBe(1);
      expect(geo.top).toBe(200);
    });
    it("перебор геометрий × эффекты CSS страницы: итог всегда либо ok без изменений, либо unsafe с восстановленной позицией", () => {
      const tops = [-500, -20, 100, 700, 790, 800, 1500];
      const effects: Array<[string, (g: Geometry, set: boolean) => void]> = [
        ["нет эффекта", () => {}],
        ["страничный transform вниз перекрыт", (g, set) => { if (set) { g.height -= 60; g.top = Math.min(g.top, g.height - 800); } }],
        ["margin/position: геометрия не зависит от transform", () => {}],
        ["scale перекрыт", (g, set) => { if (set) g.height -= 30; }],
      ];
      for (const top of tops) {
        for (const [, effect] of effects) {
          const { el, e, geo, page, frame } = env(top);
          const before = { ...geo };
          let unsafe = 0;
          page.onSet = () => effect(geo, true);
          page.onRemove = () => { geo.height = before.height; };
          const r = reenter(el, e, () => void unsafe++);
          frame(8);
          expect(geo).toEqual(before); // позиция и высота после триггера равны исходным
          expect(r === "unsafe" || r === "ok").toBe(true);
        }
      }
    });
  });
});

describe("откат позиции не зависит от CSS scroll-behavior", () => {
  it("restoreScroll вызывает scrollTo с behavior: 'instant' (а не присваивание scrollTop/scrollLeft, которое при smooth анимируется)", () => {
    const calls: unknown[] = [];
    let assigned = 0;
    const se = {
      scrollTo: (o: unknown) => void calls.push(o),
      set scrollTop(_v: number) { assigned++; },
      set scrollLeft(_v: number) { assigned++; },
    };
    restoreScroll(se, { height: 1060, top: 260, left: 7 });
    expect(calls).toEqual([{ top: 260, left: 7, behavior: "instant" }]);
    expect(assigned).toBe(0);
  });
  it("после отката геометрия перечитывается; если она не равна снимку, результат всё равно unsafe и повторов нет", () => {
    const frames: Array<() => void> = [];
    const style: Record<string, string> = {};
    const geo = { height: 1000, top: 200, left: 0 };
    const el = {
      style: {
        getPropertyValue: (n: string) => style[n] ?? "",
        getPropertyPriority: () => "",
        setProperty: (n: string, v: string) => { style[n] = v; if (v.includes("(-")) { geo.height = 940; geo.top = 140; } },
        removeProperty: (n: string) => { const v = style[n] ?? ""; delete style[n]; geo.height = 1000; return v; },
      },
      getBoundingClientRect: () => ({ top: 100, bottom: 160 }),
    };
    const restored: Geometry[] = [];
    const e: ReenterEnv = {
      raf: (cb) => void frames.push(cb), timeout: () => {}, dispatch: () => {}, height: () => 800,
      geometry: () => ({ ...geo }),
      restore: (g) => void restored.push(g), // откат «не сработал»: позиция осталась ограниченной
    };
    expect(reenter(el, e)).toBe("unsafe");
    expect(restored).toEqual([{ height: 1000, top: 200, left: 0 }]);
    expect(frames).toHaveLength(0); // дальнейших кадров/попыток нет
  });
});

describe("countRenderedShown: в цель идут только отображаемые карточки", () => {
  const card = (id: string | null, w: number, h: number, visible = true) =>
    ({ id, getBoundingClientRect: () => ({ width: w, height: h }), checkVisibility: () => visible }) as unknown as Element;
  const doc = (els: Element[]) => ({ querySelectorAll: () => els }) as unknown as Pick<Document, "querySelectorAll">;
  const idOf = (e: Element) => (e as unknown as { id: string | null }).id;
  it("нулевой размер (display:none у себя или предка, страница SPA в фоне) и visibility:hidden не считаются", () => {
    const els = [card("a", 200, 100), card("b", 0, 0), card("c", 200, 0), card("d", 200, 100, false), card("e", 200, 100)];
    expect(countRenderedShown(doc(els), idOf)).toBe(2);
  });
  it("клоны одного видео считаются один раз, карточки без id — по узлу", () => {
    const els = [card("a", 1, 1), card("a", 1, 1), card(null, 1, 1), card(null, 1, 1)];
    expect(countRenderedShown(doc(els), idOf)).toBe(3);
  });
  it("без checkVisibility (старый браузер) решает размер", () => {
    const e = { getBoundingClientRect: () => ({ width: 5, height: 5 }) } as unknown as Element;
    expect(isRendered(e)).toBe(true);
  });
});
