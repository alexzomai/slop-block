// Живая проверка: загружает dist/ в Chromium, проверяет заглушки, снимает скриншоты.
/* global getComputedStyle, TextEncoder, setTimeout, window, innerHeight, innerWidth, scrollY */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { build } from "../scripts/build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Два набора проверок (запускаются раздельно, см. e2e/all.mjs):
//  tags       — тестовая сборка dist-test/: боевой background заменён детерминированной заглушкой (в dist/ её нет)
//  openrouter — боевая сборка dist/ с настоящим background (fetch в service worker подменяется моком)
//  typesafe   — та же боевая сборка: выбор провайдера TypeSafe в options, решения через мок api.typesafe.ai
const suite = (process.argv.find((a) => a.startsWith("--suite=")) ?? "--suite=tags").slice("--suite=".length);
if (!["tags", "openrouter", "typesafe", "i18n"].includes(suite)) throw new Error(`неизвестный набор: ${suite}`);
// Язык интерфейса Chromium: --lang=<код> задаёт язык сообщений, переменная LANGUAGE — chrome.i18n.getUILanguage().
// Нужны оба (проверено: один флаг даёт тексты ru, но getUILanguage()=en-US). Прежние наборы проверяют русские тексты → по умолчанию ru.
const lang = (process.argv.find((a) => a.startsWith("--lang=")) ?? "--lang=ru").slice("--lang=".length);
if (lang !== "ru" && lang !== "en") throw new Error(`неизвестный язык: ${lang}`);
// Тексты UI по ключу из словаря выбранного языка (а не литералами).
const catalog = JSON.parse(readFileSync(join(root, "static", "_locales", lang, "messages.json"), "utf8"));
const msg = (key) => catalog[key].message;
const dist = join(root, suite === "openrouter" || suite === "typesafe" ? "dist" : "dist-test");
const fixture = readFileSync(join(root, "e2e", "fixtures", "youtube.html"), "utf8");
const shots = join(root, "artifacts", "screenshots");
const widths = [390, 1280];
const errors = [];
const results = [];

// мок fetch в service worker: /key (режимы через __keyMode) и /systemone; переустанавливается перед блоком трат
const usageMock = () => {
  globalThis.__calls = [];
  globalThis.__keyCalls = [];
  globalThis.__keyMode = "limit";
  globalThis.fetch = async (url, init) => {
    if (String(url) === "https://openrouter.ai/api/v1/key") {
      globalThis.__keyCalls.push({ method: init.method, auth: init.headers.Authorization, body: init.body, ct: init.headers["Content-Type"] });
      const mode = globalThis.__keyMode;
      if (mode === "net") throw new Error("boom");
      if (mode === "401") return new Response(JSON.stringify({ error: { code: 401, message: "SERVERTEXT-INVALID" } }), { status: 401 });
      const data = { label: "sk-or-v1-au7...890", usage: 0.0123, usage_daily: 0.0004, usage_weekly: 0.005, usage_monthly: 0.01, limit: null, limit_remaining: null };
      if (mode === "limit") Object.assign(data, { limit: 100, limit_remaining: 74.5 });
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    globalThis.__calls.push({ url: String(url), auth: init.headers.Authorization, body: init.body });
    return new Response(JSON.stringify({ answers: { t0: { type: "noul", noul: 0.9 }, t1: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 476, output_tokens: 70 } }), { status: 200 });
  };
};

// суммы и числа форматируются по локали браузера (ru: «0,0004 $», группы с узким пробелом) — сравниваем без пробельных символов
const ws = (x) => x.replace(/\s/g, "");

function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

await build(dist, { testBackground: suite !== "openrouter" && suite !== "typesafe" });
console.log(`# набор: ${suite} (${dist}), язык: ${lang}`);
mkdirSync(shots, { recursive: true });

const executablePath = process.env.CHROMIUM_PATH || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const userDataDir = mkdtempSync(join(tmpdir(), "slop-block-e2e-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath,
  headless: false,
  args: [
    "--headless=new",
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    "--no-sandbox",
    "--disable-gpu",
    `--lang=${lang}`,
  ],
  env: { ...process.env, LANGUAGE: lang, LC_ALL: `${lang}.UTF-8` },
});

try {
  context.on("weberror", (e) => errors.push(`weberror: ${e.error()}`));

  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  check("service worker поднялся", sw.url().endsWith("/background.js"), sw.url());

  // youtube.com подменяется заглушкой: сети не нужно, content script внедряется по matches
  await context.route("https://www.youtube.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>yt stub</title><body>stub</body>" }),
  );
  const yt = await context.newPage();
  yt.on("console", (m) => m.type() === "error" && errors.push(`yt console: ${m.text()}`));
  await yt.goto("https://www.youtube.com/");
  await yt.waitForFunction(() => document.documentElement.getAttribute("data-slop-block") === "loaded", null, { timeout: 10000 }).catch(() => {});
  const mark = await yt.evaluate(() => document.documentElement.getAttribute("data-slop-block"));
  check("content script ставит метку на youtube.com", mark === "loaded", `data-slop-block=${mark}`);
  const bodyText = await yt.evaluate(() => document.body.textContent);
  check("content script не меняет страницу", bodyText === "stub");
  await yt.close();

  await context.route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>x</title>" }),
  );
  const other = await context.newPage();
  await other.goto("https://example.com/");
  await other.waitForTimeout(500);
  const otherMark = await other.evaluate(() => document.documentElement.getAttribute("data-slop-block"));
  check("вне youtube.com метки нет", otherMark === null);
  await other.close();

  if (suite === "tags") {
  // --- фильтр на фикстуре YouTube + управление тегами через настоящий popup ---
  const HIDDEN = ["h1", "h4", "s1", "r1", "sh1"];
  const VISIBLE = ["h2", "h3", "s2", "r2", "sh2"];
  const waitState = (page, hiddenIds, visibleIds) =>
    page
      .waitForFunction(
        ([hs, vs]) =>
          hs.every((i) => getComputedStyle(document.getElementById(i)).display === "none") &&
          vs.every((i) => getComputedStyle(document.getElementById(i)).display !== "none"),
        [hiddenIds, visibleIds],
        { timeout: 8000 },
      )
      .then(() => true, () => false);
  const stateOf = (page) =>
    page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[id]")].filter((e) => /^(h|s|r|sh)\d$/.test(e.id)).map((e) => [e.id, getComputedStyle(e).display === "none"])));
  // собирает настройки из item'ов storage: slop.settings (enabled, order) + slop.tag.<id>
  const readStored = (page) =>
    page.evaluate(async () => {
      const all = await chrome.storage.sync.get(null);
      const head = all["slop.settings"] ?? { enabled: true, order: [] };
      return { enabled: head.enabled, tags: head.order.map((id) => ({ id, ...all[`slop.tag.${id}`] })) };
    });

  await context.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
  for (const width of widths) {
    const tag = `@${width}`;
    const popup = await context.newPage();
    await popup.setViewportSize({ width, height: 800 });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.evaluate(() => chrome.storage.sync.clear());
    await popup.reload();
    await popup.selectOption("#mode", "blocklist"); // этот блок проверяет прежнее поведение (blocklist)

    // popup: добавить / отклонить дубликат / переключить / удалить
    await popup.fill("#text", "кликбейт про похудение");
    await popup.click("#add button");
    check(`popup${tag}: тег добавлен в список`, (await popup.locator("#tags li .label").allTextContents()).join() === "кликбейт про похудение");
    await popup.fill("#text", "Кликбейт про похудение");
    await popup.click("#add button");
    check(`popup${tag}: дубликат отклонён`, (await popup.locator("#tags li").count()) === 1 && (await popup.textContent("#msg")).length > 0);
    const tgt = await popup.evaluate(() => {
      const cb = document.querySelector("#tags li input[type=checkbox]");
      const del = document.querySelector("#tags li button");
      return { h: cb.labels[0].getBoundingClientRect().height, labels: cb.labels.length, name: cb.getAttribute("aria-label"), delInLabel: del.closest("label") !== null };
    });
    check(`popup${tag}: флажок тега — цель ≥36 px, есть label, имя сохранено, «Удалить» вне label`, tgt.h >= 36 && tgt.labels === 1 && !!tgt.name && !tgt.delInLabel, JSON.stringify(tgt));
    await popup.locator("#tags li .label").click();
    await popup.waitForFunction(() => !document.querySelector("#tags li input[type=checkbox]").checked);
    check(`popup${tag}: клик по тексту тега выключает его`, (await readStored(popup)).tags[0].enabled === false);
    await popup.locator("#tags li .label").click();
    await popup.waitForFunction(() => document.querySelector("#tags li input[type=checkbox]").checked);
    check(`popup${tag}: повторный клик по тексту включает`, (await readStored(popup)).tags[0].enabled === true);
    await popup.locator("#tags li input[type=checkbox]").uncheck();
    let stored = await readStored(popup);
    check(`popup${tag}: выключение тега сохранено`, stored.tags[0].enabled === false);
    await popup.locator("#tags li button").click();
    stored = await readStored(popup);
    check(`popup${tag}: удаление сохранено`, stored.tags.length === 0 && (await popup.locator("#tags li").count()) === 0);
    await popup.fill("#text", "похудение");
    await popup.click("#add button");
    await popup.waitForFunction(() => document.getElementById("usage").dataset.state === "ok", null, { timeout: 5000 }).catch(() => {});
    const usageRows = await popup.locator("#usage-rows dt, #usage-rows dd").allTextContents();
    check(`popup${tag}: блок «Траты» (заглушка): цифры и остаток лимита`, ws(usageRows.join("|")) === ws("Сегодня|0,0004 $|Всего|0,0123 $|Остаток лимита|74,50 $|Запросов сегодня|3|Токенов сегодня / всего|1 500 / 12 345|≈ по цене Jev (всего)|0,0005 $"), usageRows.join("|"));
    const overflowPopup = await popup.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`popup${tag}: нет горизонтальной прокрутки`, overflowPopup <= 0, `overflow=${overflowPopup}`);
    await popup.screenshot({ path: join(shots, `popup-tags-${width}.png`), fullPage: true });

    // страница: скрытие, ok:false, подгрузка
    const yt = await context.newPage();
    yt.on("console", (m) => m.type() === "error" && errors.push(`fixture${tag} console: ${m.text()}`));
    yt.on("pageerror", (e) => errors.push(`fixture${tag} pageerror: ${e.message}`));
    await yt.setViewportSize({ width, height: 900 });
    await yt.goto("https://www.youtube.com/watch-fixture");
    check(`фильтр${tag}: совпавшие скрыты, остальные видны (в т.ч. при ok:false)`, await waitState(yt, HIDDEN, VISIBLE), JSON.stringify(await stateOf(yt)));
    check(`фильтр${tag}: карточки остались в DOM`, (await yt.$$("[data-slop-hidden]")).length === HIDDEN.length);
    check(`фильтр${tag}: заголовок-разметка не интерпретирована`, (await yt.$$("#h4 img")).length === 0 && (await yt.title()) === "yt fixture");
    await yt.screenshot({ path: join(shots, `feed-filtered-${width}.png`), fullPage: true });

    await yt.click("#more");
    check(`фильтр${tag}: подгруженная карточка оценена`, await waitState(yt, [...HIDDEN, "h5"], VISIBLE));

    // глобальный выключатель возвращает карточки без перезагрузки
    await popup.locator("#enabled").uncheck();
    check(`фильтр${tag}: выключение возвращает карточки`, await waitState(yt, [], [...HIDDEN, ...VISIBLE, "h5"]));
    await yt.screenshot({ path: join(shots, `feed-restored-${width}.png`), fullPage: true });
    await popup.locator("#enabled").check();
    check(`фильтр${tag}: включение скрывает снова`, await waitState(yt, [...HIDDEN, "h5"], VISIBLE));

    // новый тег при открытой вкладке
    await popup.fill("#text", "ноутбука");
    await popup.click("#add button");
    check(`фильтр${tag}: новый тег применяется без перезагрузки`, await waitState(yt, [...HIDDEN, "h5", "s2"], ["h2", "h3", "r2", "sh2"]));
    await yt.close();
    await popup.close();
  }
  await context.unroute("https://www.youtube.com/**");

  // регрессия r1: 20 допустимых тегов по 200 символов кириллицы сохраняются, переключатель не расходится со storage
  {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.evaluate(() => chrome.storage.sync.clear());
    await popup.reload();
    for (let i = 0; i < 20; i++) {
      await popup.fill("#text", String(i).padStart(2, "0") + "я".repeat(198));
      await popup.click("#add button");
      await popup.waitForFunction((n) => document.querySelectorAll("#tags li").length === n, i + 1, { timeout: 5000 }).catch(() => {});
    }
    const msg = await popup.textContent("#msg");
    const storedCount = async () => (await readStored(popup)).tags?.length;
    check("квота: 20 × 200 символов сохранены, сообщения об ошибке нет", (await storedCount()) === 20 && msg === "", `stored=${await storedCount()} msg=${msg}`);
    await popup.locator("#enabled").uncheck();
    await popup.waitForTimeout(200);
    check("квота: выключение фильтра сохранено", (await readStored(popup)).enabled === false);
    await popup.reload();
    const after = await popup.locator("#tags li").count();
    check("квота: после повторного открытия 20 тегов и фильтр выключен", after === 20 && !(await popup.locator("#enabled").isChecked()), `tags=${after}`);
    const maxItem = await popup.evaluate(async () => {
      const all = await chrome.storage.sync.get(null);
      return Math.max(...Object.entries(all).map(([k, v]) => new TextEncoder().encode(k + JSON.stringify(v)).length));
    });
    check("квота: максимальный item < 8192 байт", maxItem < 8192, `max=${maxItem}`);
    await popup.close();
  }

  // --- allowlist-reveal: режим «показывать только подходящие», no_key, подписки ---
  {
    await context.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
    const ALLOWED = ["h1", "h4", "s1", "r1", "sh1"]; // заголовки со словом «похудение»
    const DENIED = ["h2", "h3", "s2", "r2", "sh2"]; // h3 = ERR (network): скрыта на время повторов
    const ALL = [...ALLOWED, ...DENIED];
    const calls = () => sw.evaluate(() => (globalThis.__calls ?? []).length);
    const gate = (page) => page.evaluate(() => document.documentElement.getAttribute("data-slop-gate"));
    const allHidden = (page) => page.evaluate((ids) => ids.every((i) => getComputedStyle(document.getElementById(i)).display === "none"), ALL);
    const setStub = (delay, force) =>
      sw.evaluate(([d, f]) => { globalThis.__calls = []; globalThis.__delay = d; globalThis.__forceError = f; }, [delay, force]);
    for (const width of widths) {
      const tag = `@${width}`;
      const popup = await context.newPage();
      popup.on("pageerror", (e) => errors.push(`allowlist-popup${tag} pageerror: ${e.message}`));
      await popup.setViewportSize({ width, height: 800 });
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await popup.evaluate(() => chrome.storage.sync.clear());
      await popup.reload();
      await popup.waitForFunction(() => document.getElementById("skip-subs").checked, null, { timeout: 5000 }).catch(() => {}); // popup дорисовывается после чтения storage
      const defMode = await popup.inputValue("#mode");
      const defSkip = await popup.isChecked("#skip-subs");
      check(`allowlist${tag}: по умолчанию режим allowlist, «не фильтровать подписки» включено`, defMode === "allowlist" && defSkip, `mode=${defMode} skip=${defSkip}`);
      check(`allowlist${tag}: плейсхолдер «Что показывать»`, (await popup.getAttribute("#text", "placeholder")) === "Что показывать: продуктивность, IT, нейросети");
      await popup.fill("#text", "похудение");
      await popup.click("#add button");
      await popup.waitForFunction(() => document.querySelectorAll("#tags li").length === 1);
      check(`allowlist${tag}: подсказка «нет ключа» видна (в e2e ключа нет)`, !(await popup.isHidden("#key-hint")));
      const overflowPopup = await popup.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`allowlist${tag}: popup без горизонтальной прокрутки`, overflowPopup <= 0, `overflow=${overflowPopup}`);
      await popup.screenshot({ path: join(shots, `popup-allowlist-${width}.png`), fullPage: true });

      // 1) сначала скрыто, после ответа разрешённые проявляются с анимацией
      await setStub(1500, undefined);
      const yt = await context.newPage();
      yt.on("console", (m) => m.type() === "error" && errors.push(`allowlist${tag} console: ${m.text()}`));
      yt.on("pageerror", (e) => errors.push(`allowlist${tag} pageerror: ${e.message}`));
      await yt.setViewportSize({ width, height: 900 });
      await yt.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });
      check(`allowlist${tag}: сначала всё скрыто (до ответа)`, (await allHidden(yt)) && (await gate(yt)) === "allowlist");
      await yt.screenshot({ path: join(shots, `allowlist-pending-${width}.png`), fullPage: true });
      check(`allowlist${tag}: разрешённые появились, неразрешённые скрыты`, await waitState(yt, DENIED, ALLOWED), JSON.stringify(await stateOf(yt)));
      await yt.waitForTimeout(600);
      const reveal = await yt.evaluate((ids) => ids.map((i) => { const e = document.getElementById(i); return [e.classList.contains("slop-reveal"), getComputedStyle(e).opacity, e.getAttribute("data-slop-show")]; }), ALLOWED);
      check(`allowlist${tag}: класс анимации выставлен, конечная opacity 1`, reveal.every(([c, o, s]) => c && o === "1" && s === "1"), JSON.stringify(reveal));
      check(`allowlist${tag}: XSS-заголовок не интерпретирован`, (await yt.$$("#h4 img")).length === 0 && (await yt.title()) === "yt fixture");
      await yt.screenshot({ path: join(shots, `allowlist-revealed-${width}.png`), fullPage: true });
      if (width === 390) {
        await yt.emulateMedia({ reducedMotion: "reduce" });
        const an = await yt.evaluate(() => getComputedStyle(document.getElementById("h1")).animationName);
        check("allowlist: prefers-reduced-motion отключает анимацию", an === "none", an);
        await yt.emulateMedia({ reducedMotion: "no-preference" });
      }

      // 2) переключение режима и выключение фильтра без перезагрузки
      await popup.selectOption("#mode", "blocklist");
      check(`allowlist${tag}: переключение в blocklist без перезагрузки`, await waitState(yt, ALLOWED, DENIED), JSON.stringify(await stateOf(yt)));
      check(`allowlist${tag}: в blocklist шлюз снят`, (await gate(yt)) === null);
      await popup.selectOption("#mode", "allowlist");
      check(`allowlist${tag}: возврат в allowlist`, await waitState(yt, DENIED, ALLOWED));
      await popup.locator("#enabled").uncheck();
      check(`allowlist${tag}: выключение фильтра мгновенно возвращает всё`, (await waitState(yt, [], ALL)) && (await gate(yt)) === null);
      await popup.locator("#enabled").check();
      check(`allowlist${tag}: включение снова`, await waitState(yt, DENIED, ALLOWED));
      await yt.close();

      // 3) no_key → режим неактивен, всё видно
      await setStub(0, "no_key");
      const nk = await context.newPage();
      await nk.setViewportSize({ width, height: 900 });
      await nk.goto("https://www.youtube.com/");
      check(`no_key${tag}: всё видно, шлюз снят`, (await waitState(nk, [], ALL)) && (await gate(nk)) === null);
      await nk.waitForTimeout(800);
      check(`no_key${tag}: повторных запросов нет`, (await calls()) <= 5, `calls=${await calls()}`);
      await nk.screenshot({ path: join(shots, `allowlist-no-key-${width}.png`), fullPage: true });
      await nk.close();

      // 4) подписки: при включённой опции 0 запросов и всё видно
      await setStub(0, undefined);
      const subs = await context.newPage();
      await subs.setViewportSize({ width, height: 900 });
      await subs.goto("https://www.youtube.com/feed/subscriptions");
      check(`подписки${tag}: всё видно`, await waitState(subs, [], ALL));
      await subs.waitForTimeout(900);
      check(`подписки${tag}: 0 запросов, шлюз снят`, (await calls()) === 0 && (await gate(subs)) === null, `calls=${await calls()}`);
      await subs.screenshot({ path: join(shots, `subscriptions-bypass-${width}.png`), fullPage: true });

      // 5) переключение чекбокса на открытой вкладке подписок
      await popup.locator("#skip-subs").uncheck();
      check(`подписки${tag}: чекбокс выключен — фильтр работает на открытой вкладке`, await waitState(subs, DENIED, ALLOWED), JSON.stringify(await stateOf(subs)));
      check(`подписки${tag}: запросы пошли`, (await calls()) > 0);
      await popup.locator("#skip-subs").check();
      check(`подписки${tag}: чекбокс включён — снова всё видно`, (await waitState(subs, [], ALL)) && (await gate(subs)) === null);
      await subs.close();

      // 6) SPA: главная → подписки → главная
      const spa = await context.newPage();
      await spa.setViewportSize({ width, height: 900 });
      await spa.goto("https://www.youtube.com/");
      check(`SPA${tag}: главная фильтруется`, await waitState(spa, DENIED, ALLOWED));
      await setStub(0, undefined);
      await spa.click("#go-subs");
      check(`SPA${tag}: переход на подписки мгновенно показывает всё`, (await waitState(spa, [], ALL)) && (await gate(spa)) === null);
      await spa.waitForTimeout(700);
      check(`SPA${tag}: на подписках запросов нет`, (await calls()) === 0, `calls=${await calls()}`);
      await spa.click("#go-home");
      check(`SPA${tag}: возврат на главную включает фильтр`, await waitState(spa, DENIED, ALLOWED));
      await spa.screenshot({ path: join(shots, `spa-home-${width}.png`), fullPage: true });
      // 6b) SPA: главная → поиск → главная (filterSearch выключен по умолчанию)
      await setStub(0, undefined);
      await spa.click("#go-search");
      check(`SPA${tag}: переход на поиск мгновенно показывает всё`, (await waitState(spa, [], ALL)) && (await gate(spa)) === null);
      await spa.waitForTimeout(700);
      check(`SPA${tag}: на поиске запросов нет`, (await calls()) === 0, `calls=${await calls()}`);
      await spa.click("#go-home");
      check(`SPA${tag}: возврат с поиска на главную включает фильтр`, await waitState(spa, DENIED, ALLOWED));
      await spa.close();

      // 7) поиск по умолчанию: жёсткая загрузка /results, чекбокс, включение на лету
      check(`поиск${tag}: чекбокс «Фильтровать результаты поиска» выключен по умолчанию`, !(await popup.isChecked("#filter-search")));
      const lh = await popup.evaluate(() => document.getElementById("filter-search").closest("label").getBoundingClientRect().height);
      check(`поиск${tag}: label чекбокса ≥ 36px`, lh >= 36, `h=${lh}`);
      await setStub(0, undefined);
      const srch = await context.newPage();
      await srch.setViewportSize({ width, height: 900 });
      await srch.goto("https://www.youtube.com/results?search_query=x", { waitUntil: "domcontentloaded" });
      check(`поиск${tag}: карточки видны, шлюза нет`, (await waitState(srch, [], ALL)) && (await gate(srch)) === null);
      await srch.waitForTimeout(900);
      check(`поиск${tag}: 0 запросов к background`, (await calls()) === 0, `calls=${await calls()}`);
      check(`поиск${tag}: индикатора нет`, await srch.evaluate(() => { const s = document.getElementById("slop-feed-status"); return !s || s.hidden; }));
      await popup.locator("#filter-search").check();
      check(`поиск${tag}: чекбокс включён — фильтр работает на открытой вкладке`, await waitState(srch, DENIED, ALLOWED), JSON.stringify(await stateOf(srch)));
      check(`поиск${tag}: запросы пошли`, (await calls()) > 0);
      await popup.locator("#filter-search").uncheck();
      check(`поиск${tag}: чекбокс выключен — снова всё видно`, (await waitState(srch, [], ALL)) && (await gate(srch)) === null);
      await srch.close();

      // 8) окно SPA-перехода: pushState без yt-navigate-finish, задержанные ответы, переиспользованные узлы, смена href
      {
        const hiddenCount = (page) => page.evaluate((ids) => ids.filter((i) => getComputedStyle(document.getElementById(i)).display === "none").length, ALL);
        const win = async (name, finishImmediately) => {
          await setStub(1500, undefined);
          const w = await context.newPage();
          await w.setViewportSize({ width, height: 900 });
          await w.goto("https://www.youtube.com/");
          await w.waitForFunction(() => document.documentElement.getAttribute("data-slop-gate") === "allowlist");
          for (let i = 0; i < 100 && (await calls()) < 3; i++) await w.waitForTimeout(20);
          const before = await calls();
          await w.evaluate((imm) => {
            document.dispatchEvent(new Event("yt-navigate-start"));
            history.pushState({}, "", "/results?search_query=x");
            document.querySelectorAll("a[href^='/watch?v=']").forEach((a, i) => a.setAttribute("href", `/watch?v=find${String(i).padStart(7, "0")}`));
            if (imm) document.dispatchEvent(new Event("yt-navigate-finish"));
          }, finishImmediately);
          const samples = [];
          for (let i = 0; i < 6; i++) { // окно ~2.4 с: ответы (1.5 с) приходят внутри окна, finish не отправлен
            samples.push({ gate: await gate(w), hidden: await hiddenCount(w), calls: await calls() });
            await w.waitForTimeout(400);
          }
          const bad = samples.filter((x) => x.gate !== null || x.hidden !== 0 || x.calls !== before);
          check(`${name}${tag}: в окне перехода шлюза нет, скрытых 0, новых запросов 0 (замеров ${samples.length})`, bad.length === 0, JSON.stringify(samples));
          if (!finishImmediately) {
            await w.evaluate(() => document.dispatchEvent(new Event("yt-navigate-finish")));
            await w.waitForTimeout(500);
            check(`${name}${tag}: после finish по-прежнему ничего не скрыто, запросов нет`, (await hiddenCount(w)) === 0 && (await gate(w)) === null && (await calls()) === before, `calls=${await calls()}`);
          }
          await w.close();
        };
        await win("окно SPA (finish задержан)", false);
        await win("контроль (finish сразу)", true);

        // обратный переход results → home в окне до finish: фильтр включается без finish и карточки не теряются
        await setStub(0, undefined);
        const back = await context.newPage();
        await back.setViewportSize({ width, height: 900 });
        await back.goto("https://www.youtube.com/results?search_query=x");
        check(`окно SPA${tag}: на поиске всё видно`, await waitState(back, [], ALL));
        await back.evaluate(() => {
          document.dispatchEvent(new Event("yt-navigate-start"));
          history.pushState({}, "", "/");
        });
        check(`окно SPA${tag}: results → home до finish — фильтр включился`, await waitState(back, DENIED, ALLOWED), JSON.stringify(await stateOf(back)));
        await back.evaluate(() => document.dispatchEvent(new Event("yt-navigate-finish")));
        await back.waitForTimeout(400);
        check(`окно SPA${tag}: после finish состояние то же, карточки не потеряны`, await waitState(back, DENIED, ALLOWED));
        await back.close();
      }
      await popup.close();
    }
    // --- feed-autofill: лента с continuation (эмуляция IntersectionObserver YouTube) ---
    {
      const feedHtml = readFileSync(join(root, "e2e", "fixtures", "feed.html"), "utf8");
      await context.unroute("https://www.youtube.com/**");
      await context.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: feedHtml }));
      const FILL_MARGIN = 0;
      const MAX_EMPTY = 5;
      const MAX_TOTAL = 15;
      const TEXT_SEARCH = "searching"; // data-state индикатора (тексты проверяются отдельно, блок R)
      const TEXT_EXHAUSTED = "exhausted";
      const TEXT_UNSAFE = "unsafe";
      const feedCalls = () => sw.evaluate(() => (globalThis.__calls ?? []).length);
      const resetStub = (delay, force) => sw.evaluate(([d, f]) => { globalThis.__calls = []; globalThis.__delay = d; globalThis.__forceError = f; }, [delay, force]);
      const feedState = (page) =>
        page.evaluate(() => {
          const vis = [...document.querySelectorAll("ytd-rich-item-renderer")].filter((e) => getComputedStyle(e).display !== "none");
          const last = vis.at(-1);
          const st = document.getElementById("slop-feed-status");
          return {
            visible: vis.length,
            total: document.querySelectorAll("ytd-rich-item-renderer").length,
            lastBottom: last ? last.getBoundingClientRect().bottom : 0,
            h: innerHeight,
            portions: window.__portions,
            reenters: window.__reenters,
            scrollY: Math.round(scrollY),
            scrollApi: window.__scrollApi,
            status: st && !st.hidden ? st.dataset.state : null,
            statusRole: st?.getAttribute("role") ?? null,
            statusWidth: st ? st.getBoundingClientRect().width : 0,
            gridWidth: document.getElementById("contents").getBoundingClientRect().width,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            hasCont: document.getElementById("cont") !== null,
            contDisplay: document.getElementById("cont") ? getComputedStyle(document.getElementById("cont")).display : null,
          };
        });
      const stable = async (page, ms = 2500) => {
        let prev = JSON.stringify(await feedState(page));
        for (;;) {
          await page.waitForTimeout(ms);
          const cur = JSON.stringify(await feedState(page));
          if (cur === prev) return JSON.parse(cur);
          prev = cur;
        }
      };
      const setup = await context.newPage();
      await setup.goto(`chrome-extension://${extId}/popup.html`);
      const setSettings = (opts) =>
        setup.evaluate(async (o) => {
          await chrome.storage.sync.clear();
          await chrome.storage.sync.set({
            "slop.settings": { enabled: true, order: ["f1"], mode: o.mode ?? "allowlist", skipSubscriptions: o.skip ?? true, compatUbol: o.compat ?? false, feedTarget: o.target },
            "slop.tag.f1": { text: "похудение", enabled: true },
          });
        }, opts);

      for (const width of widths) {
        const tag = `@${width}`;
        const open = async (path, extraErr = "") => {
          const p = await context.newPage();
          p.on("console", (m) => m.type() === "error" && errors.push(`feed${tag}${extraErr} console: ${m.text()}`));
          p.on("pageerror", (e) => errors.push(`feed${tag}${extraErr} pageerror: ${e.message}`));
          await p.setViewportSize({ width, height: 800 });
          await p.goto(`https://www.youtube.com${path}`);
          return p;
        };

        // A) подходящих хватает: догрузка до ≥ цели и заполнения без прокрутки; индикатор «ищу» виден по дороге
        await setSettings({ target: 12 });
        await resetStub(700, undefined);
        const a = await open("/?good=5");
        const sawSearch = await a.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); return !!s && !s.hidden && s.dataset.state === t; }, TEXT_SEARCH, { timeout: 15000 }).then(() => true, () => false);
        check(`autofill${tag}: индикатор «${TEXT_SEARCH}» виден во время поиска`, sawSearch);
        const sa = await stable(a, 2500);
        check(`autofill${tag}: видимых ≥ цели (12)`, sa.visible >= 12, `visible=${sa.visible} total=${sa.total} portions=${sa.portions}`);
        check(`autofill${tag}: страница заполнена до низа окна + запас`, sa.lastBottom >= sa.h + FILL_MARGIN, `lastBottom=${sa.lastBottom} h=${sa.h}`);
        check(`autofill${tag}: подгрузка шла без вмешательства пользователя`, sa.portions >= 1, `portions=${sa.portions}`);
        check(`autofill${tag}: позиция прокрутки не изменилась (0), scroll API не вызывался`, sa.scrollY === 0 && sa.scrollApi === 0, `scrollY=${sa.scrollY} api=${sa.scrollApi}`);
        check(`autofill${tag}: continuation возвращён на место (не скрыт)`, sa.contDisplay !== "none", String(sa.contDisplay));
        check(`autofill${tag}: цель достигнута — индикатор «готово», число подгрузок ≤ M`, sa.status === "done" && sa.reenters <= MAX_TOTAL, `status=${sa.status} reenters=${sa.reenters}`);
        check(`autofill${tag}: запросов к решению не больше, чем карточек`, (await feedCalls()) <= sa.total, `calls=${await feedCalls()} total=${sa.total}`);
        check(`autofill${tag}: нет горизонтальной прокрутки`, sa.overflow <= 0, `overflow=${sa.overflow}`);
        await a.evaluate(() => window.scrollTo(0, 0));
        await a.screenshot({ path: join(shots, `autofill-filled-${width}.png`) });
        await a.close();

        // B) подходящих мало: остановка по лимиту пустых подряд, сообщение, дальше не грузит
        await setSettings({ target: 12 });
        await resetStub(0, undefined);
        const b = await open("/?good=0&first=2");
        await b.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); return !!s && !s.hidden && s.dataset.state === t; }, TEXT_EXHAUSTED, { timeout: 30000 }).catch(() => {});
        const sb = await stable(b, 2500);
        check(`autofill${tag}: мало подходящих — сообщение об остановке`, sb.status === TEXT_EXHAUSTED && sb.statusRole === "status", String(sb.status));
        check(`autofill${tag}: остановка по лимиту пустых (подгрузок расширения == N=${MAX_EMPTY}), не бесконечно`, sb.reenters === MAX_EMPTY && sb.hasCont, `reenters=${sb.reenters} portions=${sb.portions}`);
        check(`autofill${tag}: видимых осталось 2 (подходящих нет)`, sb.visible === 2, `visible=${sb.visible}`);
        check(`autofill${tag}: индикатор на всю ширину сетки, без горизонтальной прокрутки`, sb.statusWidth >= sb.gridWidth * 0.95 && sb.overflow <= 0, `status=${sb.statusWidth} grid=${sb.gridWidth} overflow=${sb.overflow}`);
        const callsB = await feedCalls();
        await b.waitForTimeout(3000);
        const sb2 = await feedState(b);
        check(`autofill${tag}: после остановки новых порций и запросов нет`, sb2.portions === sb.portions && (await feedCalls()) === callsB, `portions ${sb.portions}→${sb2.portions}`);
        await b.screenshot({ path: join(shots, `autofill-exhausted-${width}.png`) });
        // ручная прокрутка работает как обычно: изменение настроек сбрасывает остановку и догрузка возобновляется
        await setSettings({ target: 13 });
        await b.waitForFunction((p) => window.__portions > p, sb.portions, { timeout: 15000 }).catch(() => {});
        check(`autofill${tag}: смена настроек сбрасывает остановку (догрузка возобновилась)`, (await feedState(b)).portions > sb.portions);
        await b.close();

        // C) общий лимит M: каждая порция даёт по одной подходящей, цель недостижима
        await setSettings({ target: 30 });
        await resetStub(0, undefined);
        const c = await open("/?good=1&first=2");
        await c.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); return !!s && !s.hidden && s.dataset.state === t; }, TEXT_EXHAUSTED, { timeout: 60000 }).catch(() => {});
        const sc = await stable(c, 3000);
        check(`autofill${tag}: общий лимит M=${MAX_TOTAL} — стоп и сообщение; фактических порций ≤ M`, sc.status === TEXT_EXHAUSTED && sc.portions <= MAX_TOTAL && sc.portions >= MAX_TOTAL - 1, `reenters=${sc.reenters} portions=${sc.portions} status=${sc.status}`);
        await c.close();

        // D) конец ленты: continuation исчезает — после паузы индикатор «Больше видео нет»
        await setSettings({ target: 30 });
        await resetStub(0, undefined);
        const d = await open("/?good=1&first=2&parts=2");
        const sd = await stable(d, 3000);
        check(`autofill${tag}: конец ленты — индикатор «end», continuation нет`, sd.status === "end" && !sd.hasCont && sd.portions === 2, `status=${sd.status} portions=${sd.portions}`);
        await d.close();

        // F) F1: пустое совпадение + медленные решения + YouTube грузит порции цепочкой (renew=1): лимит пустых действует,
        //    страница не догружается до конца ленты, индикатор остановки виден
        await setSettings({ target: 6 });
        await resetStub(700, undefined);
        const f = await open("/?good=0&first=0&renew=1&per=30&parts=100&lat=600");
        await f.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); return !!s && !s.hidden && s.dataset.state === t; }, TEXT_EXHAUSTED, { timeout: 60000 }).catch(() => {});
        const sf = await stable(f, 3000);
        check(`autofill${tag}: F1 пустое совпадение — индикатор остановки виден`, sf.status === TEXT_EXHAUSTED, String(sf.status));
        check(`autofill${tag}: F1 фактических порций ≤ N=${MAX_EMPTY} (включая начатую YouTube; цепочки нет)`, sf.portions >= 3 && sf.portions <= MAX_EMPTY && sf.total === 6 + 30 * sf.portions, `portions=${sf.portions} total=${sf.total} reenters=${sf.reenters} t=${(await f.evaluate(() => window.__log)).map((x) => x.t + (x.hold ? "H" : "")).join(",")}`);
        check(`autofill${tag}: F1 платных решений не больше загруженных карточек`, (await feedCalls()) <= sf.total, `calls=${await feedCalls()} total=${sf.total}`);
        // жест пользователя после остановки даёт новый ограниченный бюджет (не бесконечный)
        await f.waitForTimeout(10500);
        await f.mouse.move(200, 300);
        await f.mouse.wheel(0, 400);
        await f.waitForFunction((p) => window.__portions >= p + 3, sf.portions, { timeout: 60000 }).catch(() => {});
        const sf2 = await stable(f, 3000);
        check(`autofill${tag}: F1 жест после остановки возобновил догрузку, но с лимитом`, sf2.portions > sf.portions && sf2.portions <= sf.portions + MAX_EMPTY, `portions ${sf.portions}→${sf2.portions}`);
        await f.close();

        // F') те же лимиты при быстрых ответах и lat=150 (нативные порции приходят сразу после старта content script)
        await setSettings({ target: 6 });
        await resetStub(0, undefined);
        const f2 = await open("/?good=0&first=0&renew=1&per=30&parts=100&lat=150");
        await f2.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); return !!s && !s.hidden && s.dataset.state === t; }, TEXT_EXHAUSTED, { timeout: 60000 }).catch(() => {});
        const sf3 = await stable(f2, 2000);
        const lg = await f2.evaluate(() => window.__log);
        check(`autofill${tag}: N lat=150, быстрые ответы — фактических порций ≤ ${MAX_EMPTY}`, sf3.portions <= MAX_EMPTY && sf3.portions >= MAX_EMPTY - 1, `portions=${sf3.portions} reenters=${sf3.reenters} t=${lg.map((x) => x.t).join(",")}`);
        await f2.close();
        // то же для общего бюджета: подходящие есть в каждой порции, окно не заполнено, ответы мгновенные, lat=150
        await setSettings({ target: 30 });
        await resetStub(0, undefined);
        const f3 = await open("/?good=1&first=2&renew=1&per=10&parts=100&lat=150&ch=10");
        await f3.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); return !!s && !s.hidden && s.dataset.state === t; }, TEXT_EXHAUSTED, { timeout: 60000 }).catch(() => {});
        const sf4 = await stable(f3, 2000);
        const lg3 = await f3.evaluate(() => window.__log);
        check(`autofill${tag}: M lat=150, быстрые ответы — фактических порций ≤ ${MAX_TOTAL}`, sf4.portions <= MAX_TOTAL, `portions=${sf4.portions} reenters=${sf4.reenters} t=${lg3.map((x) => x.t).join(",")}`);
        await f3.close();

        // G) F2: цель 6 при цепочке YouTube (renew=1): догрузка останавливается на цели и заполнении, лишних порций нет
        await setSettings({ target: 6 });
        await resetStub(300, undefined);
        const g = await open("/?good=5&first=6&renew=1&per=10&parts=100&lat=600");
        const sg = await stable(g, 3000);
        check(`autofill${tag}: F2 цель 6 достигнута`, sg.visible >= 6 && sg.lastBottom >= sg.h, `visible=${sg.visible} lastBottom=${sg.lastBottom} h=${sg.h}`);
        check(`autofill${tag}: F2 порций немного, не до конца ленты`, sg.portions <= 3, `portions=${sg.portions} total=${sg.total}`);
        check(`autofill${tag}: F2 платных не больше загруженных карточек`, (await feedCalls()) <= sg.total, `calls=${await feedCalls()} total=${sg.total}`);
        await g.close();

        // H) первый проход контроллера идёт, когда continuation ещё нет (как на живом YouTube): автодогрузка всё равно работает
        await setSettings({ target: 12 });
        await resetStub(300, undefined);
        const h = await open("/?good=5&first=2&late=1500");
        const sh = await stable(h, 3000);
        check(`autofill${tag}: H continuation появился позже первого прохода — догрузка работает до цели`, sh.portions >= 1 && sh.visible >= 12, `portions=${sh.portions} visible=${sh.visible}`);
        await h.close();

        // I) ревью P2-1: страничное переполнение от другого continuation + прокрутка у низа; удержание не сдвигает позицию
        await setSettings({ target: 30 });
        await resetStub(1800, undefined);
        const gh = await open("/?first=1&good=0&ghost=700&parts=0&ch=100");
        await gh.waitForTimeout(5000);
        const sgh = await gh.evaluate(() => ({ y: Math.round(scrollY), hold: document.documentElement.hasAttribute("data-slop-hold"), h: document.scrollingElement.scrollHeight }));
        check(`autofill${tag}: I прокрутка не сдвинута удержанием (700), документ ${sgh.h}`, sgh.y === 700 && sgh.h >= 1500, JSON.stringify(sgh));
        await gh.close();

        // J) scroll-stuck: документ короче окна (скрытые карточки места не занимают) — прокрутить нечего, а у тач-жеста
        //    нет touchmove. После остановки по лимиту ленту ВСЕГДА можно догрузить: жест (touchstart/колесо) и кнопка «загрузить ещё».
        {
          const touch = width < 800;
          await setSettings({ target: 12 });
          await resetStub(0, undefined);
          const j = await context.newPage();
          j.on("console", (m) => m.type() === "error" && errors.push(`feed${tag} J console: ${m.text()}`));
          j.on("pageerror", (e) => errors.push(`feed${tag} J pageerror: ${e.message}`));
          const cdp = await context.newCDPSession(j);
          if (touch) {
            await cdp.send("Emulation.setDeviceMetricsOverride", { width: 393, height: 852, deviceScaleFactor: 3, mobile: true });
            await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
          } else await j.setViewportSize({ width, height: 800 });
          await j.goto("https://www.youtube.com/?good=0&first=5&renew=1&per=10&parts=100&lat=150&ch=60");
          const jState = () =>
            j.evaluate(() => {
              const m = document.getElementById("slop-feed-more");
              const s = document.getElementById("slop-feed-status");
              return { portions: window.__portions, short: document.scrollingElement.scrollHeight <= innerHeight, more: !!m && !m.hidden, status: s && !s.hidden ? s.dataset.state : null, hold: document.documentElement.hasAttribute("data-slop-hold"), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
            });
          const waitStop = () => j.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); return !!s && !s.hidden && s.dataset.state === t; }, TEXT_EXHAUSTED, { timeout: 40000 }).catch(() => {});
          await waitStop();
          await j.waitForTimeout(800);
          const j0 = await jState();
          check(`autofill${tag}: J короткая страница остановлена по лимиту, виден индикатор и кнопка «Загрузить ещё»`, j0.short && j0.status === TEXT_EXHAUSTED && j0.more && j0.hold && j0.overflow <= 0, JSON.stringify(j0));
          const jb = await j.evaluate(() => { const r = document.getElementById("slop-feed-more").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, h: r.height, w: r.width, vw: window.innerWidth }; });
          check(`autofill${tag}: J кнопка в окне, цель ≥44 px`, jb.h >= 44 && jb.x > 0 && jb.x < jb.vw, JSON.stringify(jb));
          // жест: на короткой странице тач-свайп не даёт touchmove, но даёт touchstart; колесо — как раньше
          if (touch) await cdp.send("Input.synthesizeScrollGesture", { x: 200, y: 600, yDistance: -300, gestureSourceType: "touch", speed: 800 });
          else {
            await j.mouse.move(200, 300);
            await j.mouse.wheel(0, 300);
          }
          await j.waitForFunction((p) => window.__portions > p, j0.portions, { timeout: 15000 }).catch(() => {});
          await waitStop();
          const j1 = await jState();
          check(`autofill${tag}: J ${touch ? "тач-свайп" : "колесо"} на короткой странице возобновил догрузку, с лимитом`, j1.portions > j0.portions && j1.portions <= j0.portions + MAX_EMPTY + 1, `portions ${j0.portions}→${j1.portions}`);
          // кнопка работает сразу, без интервала ожидания жеста
          await j.waitForTimeout(500);
          const jb1 = await j.evaluate(() => { const r = document.getElementById("slop-feed-more").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
          if (touch) {
            const tp = [{ x: jb1.x, y: jb1.y }];
            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp });
            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          } else await j.mouse.click(jb1.x, jb1.y);
          await j.waitForFunction((p) => window.__portions > p, j1.portions, { timeout: 15000 }).catch(() => {});
          await waitStop();
          const j2 = await jState();
          check(`autofill${tag}: J кнопка возобновила догрузку сразу, снова с лимитом и остановкой`, j2.portions > j1.portions && j2.portions <= j1.portions + MAX_EMPTY + 1 && j2.status === TEXT_EXHAUSTED && j2.more, `portions ${j1.portions}→${j2.portions} ${JSON.stringify(j2)}`);
          await j.waitForTimeout(1500); // решения по уже загруженной последней порции
          const callsJ = await feedCalls();
          await j.waitForTimeout(3000);
          check(`autofill${tag}: J после повторной остановки новых порций нет`, (await jState()).portions === j2.portions && (await feedCalls()) === callsJ, `portions ${j2.portions}→${(await jState()).portions} calls ${callsJ}→${await feedCalls()}`);
          // ревью r1 P2-2: подходящая карточка пришла после остановки (YouTube вставляет перед continuation) — индикатор и кнопка остаются ПОСЛЕ неё
          await j.evaluate(() => window.addCards(1, 1));
          await j.waitForFunction(() => { const c = document.getElementById("cont"); return c?.previousElementSibling?.id === "slop-feed-status" && getComputedStyle(c.previousElementSibling.previousElementSibling).display !== "none"; }, null, { timeout: 8000 }).catch(() => {});
          const jo = await j.evaluate(() => {
            const c = document.getElementById("cont");
            const st = c.previousElementSibling;
            const m = st?.querySelector("#slop-feed-more");
            const lastCard = st?.previousElementSibling;
            return { m: m?.id, st: st?.id, lastCard: lastCard?.tagName, shown: lastCard ? getComputedStyle(lastCard).display !== "none" : false };
          });
          check(`autofill${tag}: J новая подходящая карточка после остановки — индикатор (с кнопкой внутри) после неё, перед continuation`, jo.m === "slop-feed-more" && jo.st === "slop-feed-status" && jo.lastCard === "YTD-RICH-ITEM-RENDERER" && jo.shown, JSON.stringify(jo));
          // сценарий скриншота пользователя: «ищу» не висит вечно, если решения не приходят
          await j.screenshot({ path: join(shots, `autofill-more-${width}.png`) });
          await j.close();
        }

        // K) feed-hang: «ищу» не висит вечно. Порция не приходит (continuation молчит / заменён ненаблюдаемым элементом)
        //    и решения не приходят — везде остановка с кнопкой, кнопка запускает загрузку, отладочный атрибут отражает причину.
        for (const [name, path, delay] of [
          ["K continuation молчит", "/?first=2&good=5&parts=0&ch=60", 0],
          ["L continuation заменён", "/?first=2&good=5&swap=1&ch=60", 0],
          ["M решения не приходят", "/?first=6&good=5&parts=0&ch=60", 120000],
          // ревью r1 P2: страница клонирует те же видимые карточки каждые 5 с, одно решение всегда висит — рост «видимых» ложный
          ["N клон-перерисовка", "/?first=6&good=0&parts=0&rerender=5000&slow=1&ch=60", 0],
        ]) {
          await setSettings({ target: 12 });
          await resetStub(delay, undefined);
          const k = await open(path);
          const dbg = () => k.evaluate(() => ({ s: document.documentElement.getAttribute("data-slop-autofill"), i: document.documentElement.getAttribute("data-slop-autofill-info"), re: window.__reenters, hold: document.documentElement.hasAttribute("data-slop-hold") }));
          const stopped = await k.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); const m = document.getElementById("slop-feed-more"); return !!s && !s.hidden && s.dataset.state === t && !!m && !m.hidden; }, TEXT_EXHAUSTED, { timeout: 70000 }).then(() => true, () => false);
          const k0 = await dbg();
          check(`autofill${tag}: ${name} — остановка с кнопкой «Загрузить ещё», не вечное «ищу»`, stopped && /^exhausted\//.test(k0.s ?? ""), JSON.stringify(k0));
          check(`autofill${tag}: ${name} — отладочный атрибут без секретов`, /^cards=\d+ visible=\d+ pending=\d+ total=\d+ empty=\d+ hold=\d cont=\d$/.test(k0.i ?? ""), String(k0.i));
          {
            const m = /visible=(\d+)/.exec(k0.i ?? "");
            const real = await k.evaluate(() => [...document.querySelectorAll("ytd-rich-item-renderer")].filter((e) => getComputedStyle(e).display !== "none" && !e.id.startsWith("slow")).length);
            check(`autofill${tag}: ${name} — visible в отладке = реальным видимым карточкам (по видео, не по узлам)`, !!m && Number(m[1]) <= real + 1 && Number(m[1]) <= 12, `info=${k0.i} real=${real}`);
          }
          if (stopped) {
            await k.click("#slop-feed-more");
            const resumed = await k.waitForFunction((r) => window.__reenters > r, k0.re, { timeout: 8000 }).then(() => true, () => false);
            check(`autofill${tag}: ${name} — кнопка запускает загрузку (триггер continuation)`, resumed, JSON.stringify(await dbg()));
            const again = await k.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); return !!s && !s.hidden && s.dataset.state === t; }, TEXT_EXHAUSTED, { timeout: 70000 }).then(() => true, () => false);
            check(`autofill${tag}: ${name} — после кнопки снова конечная остановка, не вечное «ищу»`, again, JSON.stringify(await dbg()));
          }
          await k.close();
        }
        await resetStub(0, undefined);

        // Q) portion-wait: (1) YouTube не отзывается на первый вход continuation и DOM не меняется — повтор триггера
        //    приводит порцию раньше таймаута (4 с), а не «пустой» порцией и вечным ожиданием;
        //    (2) показанные нами карточки, скрытые чужим CSS, не засчитываются в цель: visible = реально отображаемым.
        {
          await setSettings({ target: 12 });
          await resetStub(0, undefined);
          const q = await open("/?first=2&good=5&mute=2&per=10&ch=60");
          const got = await q.waitForFunction(() => (window.__portions ?? 0) >= 1, null, { timeout: 15000 }).then(() => true, () => false);
          const q0 = await q.evaluate(() => ({ t: window.__log?.[0]?.t ?? -1, re: window.__reenters, muted: window.__muted, info: document.documentElement.getAttribute("data-slop-autofill-info") }));
          check(`autofill${tag}: Q1 порция не пришла на первый триггер — повтор триггера даёт её раньше таймаута`, got && q0.muted === 2 && q0.re >= 2 && q0.t > 0 && q0.t < 3800, JSON.stringify(q0));
          await q.close();

          await setSettings({ target: 3 });
          await resetStub(0, undefined);
          const css = encodeURIComponent("ytd-rich-item-renderer[data-slop-show]:nth-child(n+3){display:none !important}");
          const h = await open(`/?first=6&good=0&parts=0&ch=60&css=${css}`);
          const stoppedH = await h.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); const m = document.getElementById("slop-feed-more"); return !!s && !s.hidden && s.dataset.state === t && !!m && !m.hidden; }, TEXT_EXHAUSTED, { timeout: 70000 }).then(() => true, () => false);
          const h0 = await h.evaluate(() => ({ s: document.documentElement.getAttribute("data-slop-autofill"), i: document.documentElement.getAttribute("data-slop-autofill-info"), real: [...document.querySelectorAll("ytd-rich-item-renderer")].filter((e) => e.getBoundingClientRect().height > 0).length }));
          const vis = /visible=(\d+)/.exec(h0.i ?? "");
          check(`autofill${tag}: Q2 карточки, скрытые чужим CSS, не засчитаны: visible=${vis?.[1]}, реально ${h0.real}, цель не «достигнута»`, stoppedH && !!vis && Number(vis[1]) === h0.real && h0.real === 2 && /^exhausted\//.test(h0.s ?? ""), JSON.stringify(h0));
          await h.close();
        }
        await resetStub(0, undefined);

        // P) ревью r3: видео меняется внутри ПОДКЛЮЧЁННОГО узла (href + Text.data, без childList) — оценка заново
        for (const mode of ["blocklist", "allowlist"]) {
          await setSettings({ target: 3, mode });
          await resetStub(0, undefined);
          const p = await open("/?first=1&good=0&parts=0&ch=60");
          await p.waitForFunction(() => { const n = document.getElementById("vid00000001"); return n && (n.hasAttribute("data-slop-hidden") || n.hasAttribute("data-slop-show")); }, null, { timeout: 8000 }).catch(() => {});
          const callsBefore = await feedCalls();
          await p.evaluate(() => {
            const n = document.getElementById("vid00000001");
            n.querySelector("a").setAttribute("href", "/watch?v=inplace00001");
            n.querySelector("#video-title").firstChild.data = "Борщ рецепт на месте";
          });
          await p.waitForTimeout(1800);
          const rp = await p.evaluate(() => { const n = document.getElementById("vid00000001"); return { d: getComputedStyle(n).display, a: [...n.attributes].map((x) => x.name).filter((x) => x.startsWith("data-slop")) }; });
          const wantHidden = mode === "allowlist"; // blocklist: B не подходит под тег → виден; allowlist: не подходит → скрыт
          check(`autofill${tag}: P ${mode} — смена видео в подключённом узле: эффект старого снят, новое оценено`, (rp.d === "none") === wantHidden && !rp.a.includes(wantHidden ? "data-slop-show" : "data-slop-hidden") && (await feedCalls()) === callsBefore + 1, JSON.stringify({ rp, callsBefore, calls: await feedCalls() }));
          await p.close();
        }

        // O) ревью r2: YouTube убирает узел и вставляет его снова с ДРУГИМ видео — наши отметки старого видео не должны остаться
        for (const mode of ["blocklist", "allowlist"]) {
          await setSettings({ target: 3, mode });
          await resetStub(0, undefined);
          const o = await open("/?first=1&good=0&parts=0&ch=60");
          const fx = () => o.evaluate(() => {
            const n = document.getElementById("recycled");
            return { display: getComputedStyle(n).display, attrs: [...n.attributes].map((a) => a.name).filter((a) => a.startsWith("data-slop") || a === "class") };
          });
          await o.waitForFunction(() => { const n = document.getElementById("vid00000001"); return n && (n.hasAttribute("data-slop-hidden") || n.hasAttribute("data-slop-show")); }, null, { timeout: 8000 }).catch(() => {});
          // узел с матчем (vid1): blocklist — скрыт, allowlist — показан; страница убирает его и возвращает как не подходящее видео
          await o.evaluate(() => { const n = document.getElementById("vid00000001"); n.id = "recycled"; window.__rec = n; n.remove(); });
          await o.waitForTimeout(900);
          await o.evaluate(() => {
            const n = window.__rec;
            n.querySelector("a").setAttribute("href", "/watch?v=recyc000001");
            n.querySelector("#video-title").textContent = "Борщ рецепт переиспользованный";
            document.getElementById("cont").before(n);
          });
          await o.waitForTimeout(1800);
          const r1 = await fx();
          // blocklist: новое видео не подходит под тег → не скрыто; allowlist: не подходит → скрыто шлюзом и без отметки показа
          const wantHidden = mode === "allowlist";
          check(`autofill${tag}: O ${mode} — переиспользованный узел с новым видео оценён заново`, (r1.display === "none") === wantHidden && !r1.attrs.includes(wantHidden ? "data-slop-show" : "data-slop-hidden"), JSON.stringify(r1));
          // выключение фильтра снимает эффекты со всех узлов
          await setup.evaluate(async () => {
            const s = (await chrome.storage.sync.get("slop.settings"))["slop.settings"];
            await chrome.storage.sync.set({ "slop.settings": { ...s, enabled: false } });
          });
          await o.waitForTimeout(1200);
          const r2 = await o.evaluate(() => [...document.querySelectorAll("ytd-rich-item-renderer")].map((n) => ({ d: getComputedStyle(n).display, a: [...n.attributes].map((a) => a.name).filter((a) => a.startsWith("data-slop")) })));
          check(`autofill${tag}: O ${mode} — после выключения фильтра все карточки видны, отметок нет`, r2.every((x) => x.d !== "none" && x.a.length === 0), JSON.stringify(r2));
          await o.close();
        }
        await setSettings({ target: 12 });

        // S) рекламные слоты в ленте (разные рендереры): в allowlist скрыты и не засчитываются в цель, платных запросов по ним нет;
        //    в blocklist не тронуты и тоже не оцениваются
        {
          const adState = (page) =>
            page.evaluate(() => {
              const cards = [...document.querySelectorAll("ytd-rich-item-renderer")];
              const ads = cards.filter((e) => e.dataset.ad !== undefined);
              const real = cards.filter((e) => e.dataset.ad === undefined);
              const shown = (e) => getComputedStyle(e).display !== "none";
              return {
                ads: ads.length,
                adsShown: ads.filter(shown).length,
                adsRevealed: ads.filter((e) => e.hasAttribute("data-slop-show")).length,
                adsHidden: ads.filter((e) => e.hasAttribute("data-slop-hidden")).length,
                realShown: real.filter(shown).length,
                realRevealed: real.filter((e) => e.hasAttribute("data-slop-show")).length,
                status: (() => { const st = document.getElementById("slop-feed-status"); return st && !st.hidden ? st.dataset.state : null; })(),
              };
            });
          const adCalls = () => sw.evaluate(() => (globalThis.__calls ?? []).filter((id) => /^ad[vw]/.test(id)));
          await setSettings({ target: 12 });
          await resetStub(0, undefined);
          const s1 = await open("/?good=5&first=2&ads=3");
          await s1.waitForFunction(() => document.getElementById("slop-feed-status")?.dataset.state === "done", null, { timeout: 30000 }).catch(() => {});
          await stable(s1, 2500);
          const as = await adState(s1);
          check(`реклама${tag}: allowlist — цель 12 достигнута только настоящими (индикатор «done»), показано ≥ 12 неРекламных`, as.status === "done" && as.realRevealed >= 12 && as.realShown >= 12, JSON.stringify(as));
          check(`реклама${tag}: allowlist — все рекламные слоты (4 вида) скрыты, не проявлены (${as.ads} шт.)`, as.ads >= 6 && as.adsShown === 0 && as.adsRevealed === 0, JSON.stringify(as));
          check(`реклама${tag}: allowlist — платных запросов по рекламе нет`, (await adCalls()).length === 0, JSON.stringify(await adCalls()));
          await s1.screenshot({ path: join(shots, `ads-allowlist-${width}.png`) });
          await s1.close();
          await setSettings({ target: 12, mode: "blocklist" });
          await resetStub(0, undefined);
          const s2 = await open("/?good=5&first=2&ads=3");
          await s2.waitForTimeout(3000);
          const bs = await adState(s2);
          check(`реклама${tag}: blocklist — реклама не тронута (видна, без наших атрибутов)`, bs.ads >= 3 && bs.adsShown === bs.ads && bs.adsHidden === 0 && bs.adsRevealed === 0, JSON.stringify(bs));
          check(`реклама${tag}: blocklist — платных запросов по рекламе нет`, (await adCalls()).length === 0, JSON.stringify(await adCalls()));
          await s2.close();
        }

        // T) feed-dedup: порции повторяют уже показанные видео (dup=N) и повторный вход continuation при порции в полёте
        //    ставит порцию-повтор (dupretry=1): на странице не более одной видимой карточки на videoId, по повторам платных вызовов нет
        {
          const dupState = (page) =>
            page.evaluate(() => {
              const cards = [...document.querySelectorAll("ytd-rich-item-renderer")];
              const vis = cards.filter((e) => getComputedStyle(e).display !== "none");
              const byId = {};
              for (const e of vis) { const id = new URL(e.querySelector("a").href).searchParams.get("v"); byId[id] = (byId[id] ?? 0) + 1; }
              const st = document.getElementById("slop-feed-status");
              return {
                total: cards.length,
                dupNodes: cards.filter((e) => e.dataset.dup).length,
                visible: vis.length,
                maxPerId: Math.max(0, ...Object.values(byId)),
                status: st && !st.hidden ? st.dataset.state : null,
                dupRetry: window.__dupRetry,
                reenters: window.__reenters,
              };
            });
          const dupCases = [
            ["allowlist, повторы в порциях", "/?good=5&first=2&dup=3", { target: 12 }],
            ["allowlist, повтор триггера в полёте", "/?good=5&first=2&lat=2500&dupretry=1", { target: 12 }],
            ["blocklist, повторы в порциях", "/?good=5&first=2&dup=3&parts=3", { target: 12, mode: "blocklist" }],
          ];
          for (const [name, path, opts] of dupCases) {
            await setSettings(opts);
            await resetStub(0, undefined);
            const d = await open(path);
            await d.waitForTimeout(opts.mode === "blocklist" ? 3000 : 1000);
            if (opts.mode !== "blocklist") await d.waitForFunction(() => document.getElementById("slop-feed-status")?.dataset.state === "done", null, { timeout: 30000 }).catch(() => {});
            await stable(d, 2500);
            const ds = await dupState(d);
            const calls = await sw.evaluate(() => globalThis.__calls ?? []);
            check(`дубли${tag} ${name}: на странице ≤ 1 видимой карточки на videoId (узлов-повторов ${ds.dupNodes})`, ds.maxPerId <= 1 && (name.includes("в полёте") || ds.dupNodes > 0), JSON.stringify(ds));
            check(`дубли${tag} ${name}: платных вызовов не больше, чем уникальных видео (нет повторов вызова)`, new Set(calls).size === calls.length, `calls=${calls.length} unique=${new Set(calls).size}`);
            if (opts.mode !== "blocklist") check(`дубли${tag} ${name}: цель достигнута уникальными видео (индикатор «done»)`, ds.status === "done" && ds.visible >= 12, JSON.stringify(ds));
            console.log(`# дубли${tag} ${name}: dupRetry=${ds.dupRetry} reenters=${ds.reenters} dupNodes=${ds.dupNodes}`);
            await d.close();
          }
        }

        // E) неактивные состояния: blocklist, подписки с bypass, no_key, выключенный фильтр → только штатная порция YouTube
        const idle = [
          ["blocklist", "/?good=0", { target: 12, mode: "blocklist" }, undefined],
          ["подписки (bypass)", "/feed/subscriptions?good=0", { target: 12 }, undefined],
          ["поиск (по умолчанию)", "/results?search_query=x&good=0", { target: 12 }, undefined],
          ["no_key", "/?good=0", { target: 12 }, "no_key"],
        ];
        for (const [name, path, opts, force] of idle) {
          await setSettings(opts);
          await resetStub(0, force);
          const e = await open(path);
          await e.waitForTimeout(2500);
          const se = await feedState(e);
          check(`autofill${tag}: ${name} — автодогрузки нет`, se.reenters === 0 && (se.status === null || (force === "no_key" && se.status === "error")), `reenters=${se.reenters} status=${se.status}`);
          await e.close();
        }
        await setSettings({ target: 12 });
        await resetStub(0, undefined);

        // U) ubol-compat: карточки, спрятанные uBlock Origin Lite (его CSS-правила для YouTube подставлены в фикстуру как данные)
        {
          const infoOf = (p) => p.evaluate(() => Object.fromEntries((document.documentElement.getAttribute("data-slop-autofill-info") ?? "").split(" ").map((kv) => kv.split("="))));
          const calledIds = () => sw.evaluate(() => [...(globalThis.__calls ?? [])]);
          const checkedText = (p) => p.evaluate(() => document.querySelector("#slop-feed-status .slop-fs-detail")?.textContent ?? "");
          for (const compat of [false, true]) {
            await setSettings({ target: 12, compat });
            await resetStub(0, undefined);
            const u = await open("/?good=5&ubol=ads");
            const su = await stable(u, 2500);
            const realCards = await u.evaluate(() => document.querySelectorAll("ytd-rich-item-renderer:not([data-ad])").length);
            const adCards = await u.evaluate(() => document.querySelectorAll("ytd-rich-item-renderer[data-ad]").length);
            const iu = await infoOf(u);
            const adsHidden = await u.evaluate(() => [...document.querySelectorAll("ytd-rich-item-renderer[data-ad]")].every((e) => getComputedStyle(e).display === "none"));
            check(`ubol${tag} compat=${compat}: рекламные слоты спрятаны uBOL-правилом, автодогрузка доходит до цели`, adCards > 0 && adsHidden && su.visible >= 12, `ads=${adCards} visible=${su.visible} status=${su.status}`);
            check(`ubol${tag} compat=${compat}: счётчик карточек без рекламных слотов (ads-slots: реклама не считается независимо от compat)`, Number(iu.cards) === realCards, `cards=${iu.cards} real=${realCards} ads=${adCards}`);
            await u.close();
          }
          for (const compat of [false, true]) {
            await setSettings({ target: 12, mode: "blocklist", compat });
            await resetStub(0, undefined);
            const z = await open("/?good=5&ubol=zap&first=0");
            await z.waitForTimeout(2000);
            const ids = await calledIds();
            const zapped = await z.evaluate(() => [...document.querySelectorAll("ytd-rich-item-renderer[data-zap]")].map((e) => e.id));
            const evaluatedZapped = zapped.filter((id) => ids.includes(id));
            const totalCards = await z.evaluate(() => document.querySelectorAll("ytd-rich-item-renderer").length);
            check(`ubol${tag} blocklist compat=${compat}: спрятанные чужим CSS карточки ${compat ? "не оцениваются" : "оцениваются (прежнее поведение)"}`, zapped.length > 0 && (compat ? evaluatedZapped.length === 0 && ids.length === totalCards - zapped.length : evaluatedZapped.length === zapped.length), `zapped=${zapped.length} calls=${ids.length} evaluatedZapped=${evaluatedZapped.length}`);
            await z.close();
          }
          void checkedText;
          await setSettings({ target: 12 });
          await resetStub(0, undefined);
        }

        // R) индикатор: однозначное состояние «грузится / не грузится / почему / что сделать»; скриншоты каждого состояния
        //    (светлая и тёмная тема YouTube) в /tmp/slop-block/feed-status/
        {
          const shotDir = "/tmp/slop-block/feed-status";
          mkdirSync(shotDir, { recursive: true });
          const fmt = (key, ...vals) => {
            const m = catalog[key];
            const names = Object.entries(m.placeholders ?? {}).sort((x, y) => Number(x[1].content.slice(1)) - Number(y[1].content.slice(1))).map(([n]) => n);
            let out = m.message;
            names.forEach((n, i) => (out = out.replace(new RegExp(`\\$${n}\\$`, "i"), String(vals[i]))));
            return out;
          };
          const statusInfo = (pg) =>
            pg.evaluate(() => {
              const st = document.getElementById("slop-feed-status");
              if (!st || st.hidden) return null;
              const r = st.getBoundingClientRect();
              const cs = (sel) => { const e = st.querySelector(sel); return e ? getComputedStyle(e) : null; };
              const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== "none";
              const more = document.getElementById("slop-feed-more");
              const settings = document.getElementById("slop-feed-settings");
              const bar = st.querySelector(".slop-fs-bar");
              return {
                state: st.dataset.state, role: st.getAttribute("role"), live: st.getAttribute("aria-live"),
                title: st.querySelector(".slop-fs-title").textContent, detail: st.querySelector(".slop-fs-detail").textContent,
                h: r.height, w: r.width, vw: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                spin: cs(".slop-fs-icon").animationName, slide: bar ? getComputedStyle(bar, "::after").animationName : "none", barShown: vis(bar),
                more: vis(more), moreText: more?.textContent, moreH: more ? more.getBoundingClientRect().height : 0,
                settings: vis(settings), settingsText: settings?.textContent, detailHidden: st.querySelector(".slop-fs-detail").getAttribute("aria-hidden"),
                bg: getComputedStyle(st.querySelector(".slop-fs-card")).backgroundColor,
                cardsShown: [...document.querySelectorAll("ytd-rich-item-renderer")].every((c) => getComputedStyle(c).display !== "none"),
              };
            });
          const waitState = (pg, state, timeout = 40000) =>
            pg.waitForFunction((t) => { const s = document.getElementById("slop-feed-status"); return !!s && !s.hidden && s.dataset.state === t; }, state, { timeout }).then(() => true, () => false);
          const snap = async (pg, name) => {
            await pg.evaluate(() => { document.documentElement.removeAttribute("dark"); document.getElementById("slop-feed-status").scrollIntoView({ block: "end" }); });
            await pg.waitForTimeout(150);
            await pg.screenshot({ path: join(shotDir, `${name}-${width}-light.png`) });
            await pg.evaluate(() => { document.documentElement.setAttribute("dark", ""); document.body.style.background = "#0f0f0f"; document.body.style.color = "#f1f1f1"; });
            await pg.waitForTimeout(150);
            const dark = await statusInfo(pg);
            await pg.screenshot({ path: join(shotDir, `${name}-${width}-dark.png`) });
            await pg.evaluate(() => { document.documentElement.removeAttribute("dark"); document.body.style.background = ""; document.body.style.color = ""; });
            return dark;
          };
          const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

          // R1 поиск: порция не приходит (lat 60 с), решения быстрые — прогресс «найдено 3 из 12 · проверено 6», спиннер крутится
          await setSettings({ target: 12 });
          await resetStub(0, undefined);
          const r1 = await open("/?first=3&good=0&lat=60000");
          const r1ok = await r1.waitForFunction(() => document.getElementById("slop-feed-status")?.dataset.state === "searching" && /3/.test(document.querySelector("#slop-feed-status .slop-fs-detail")?.textContent ?? ""), null, { timeout: 15000 }).then(() => true, () => false);
          const heights = []; // высоты блока во всех состояниях: раскладка не прыгает
          const i1 = await statusInfo(r1);
          heights.push(["searching", i1?.h]);
          check(`индикатор${tag}: R1 счётчики прогресса не объявляются скринридером (aria-hidden), смена состояния — объявляется`, i1?.detailHidden === "true" && i1.role === "status");
          check(`индикатор${tag}: R1 поиск — прогресс «${i1?.detail}»`, r1ok && i1.detail === fmt("autofill_progress", 3, 12, 6) && i1.title === msg("autofill_searching"), JSON.stringify(i1));
          check(`индикатор${tag}: R1 спиннер и бегущая полоска анимированы, role=status, aria-live=polite`, i1?.spin === "slop-fs-spin" && i1.slide === "slop-fs-slide" && i1.barShown && i1.role === "status" && i1.live === "polite", JSON.stringify(i1));
          check(`индикатор${tag}: R1 кнопок нет, ширина сетки, без горизонтальной прокрутки`, !i1.more && !i1.settings && i1.overflow <= 0 && i1.w >= i1.vw * 0.8 - 40, JSON.stringify(i1));
          await r1.emulateMedia({ reducedMotion: "reduce" });
          const i1r = await statusInfo(r1);
          check(`индикатор${tag}: R1 prefers-reduced-motion — анимаций нет`, i1r?.spin === "none" && i1r.slide === "none", JSON.stringify(i1r));
          await r1.emulateMedia({ reducedMotion: "no-preference" });
          const d1 = await snap(r1, "1-searching");
          check(`индикатор${tag}: R1 тёмная тема — фон блока тёмный`, !!d1 && lum(d1.bg) < 80 && lum(i1.bg) > 200, `${d1?.bg} / ${i1?.bg}`);
          await r1.close();

          // R2 цель достигнута
          await resetStub(0, undefined);
          const r2 = await open("/?good=5");
          const r2ok = await waitState(r2, "done", 30000);
          const i2 = await statusInfo(r2);
          check(`индикатор${tag}: R2 готово — «${i2?.title}» + подсказка, без анимации и кнопок`, r2ok && i2.title === fmt("autofill_done", i2.title.match(/\d+/)?.[0]) && Number(i2.title.match(/\d+/)?.[0]) >= 12 && i2.detail === msg("autofill_done_hint") && i2.spin === "none" && !i2.barShown && !i2.more && !i2.settings, JSON.stringify(i2));
          heights.push(["done", i2?.h]);
          check(`индикатор${tag}: R2 пояснение объявляется (нет aria-hidden)`, i2?.detailHidden === null, JSON.stringify(i2));
          await snap(r2, "2-done");
          await r2.close();

          // R3 остановка: подходящих мало — причина с числом проверенных после последней находки и кнопка «Искать дальше»
          await resetStub(0, undefined);
          const r3 = await open("/?good=0&first=2");
          const r3ok = await waitState(r3, "exhausted", 40000);
          await r3.waitForTimeout(500);
          const i3 = await statusInfo(r3);
          const m3 = i3?.title.match(/\d+/)?.[0];
          check(`индикатор${tag}: R3 остановка по пустой серии — «${i3?.title}»`, r3ok && !!m3 && i3.title === fmt("autofill_stop_empty", m3) && Number(m3) > 0 && i3.detail === msg("autofill_stop_hint"), JSON.stringify(i3));
          check(`индикатор${tag}: R3 статично (без анимации), заметная кнопка «${i3?.moreText}», высота ≥ 40`, i3.spin === "none" && !i3.barShown && i3.more && i3.moreText === msg("autofill_more") && i3.moreH >= 40 && !i3.settings && i3.overflow <= 0, JSON.stringify(i3));
          await r3.focus("#slop-feed-more");
          check(`индикатор${tag}: R3 кнопка получает фокус с клавиатуры`, (await r3.evaluate(() => document.activeElement?.id)) === "slop-feed-more");
          heights.push(["exhausted-empty", i3?.h]);
          await snap(r3, "3-exhausted-empty");
          await r3.close();

          // R3b YouTube не отдаёт новые порции (порций нет вовсе)
          await resetStub(0, undefined);
          const r3b = await open("/?good=0&first=2&parts=0");
          const r3bok = await waitState(r3b, "exhausted", 40000);
          const i3b = await statusInfo(r3b);
          check(`индикатор${tag}: R3b порции не приходят — «${i3b?.title}»`, r3bok && i3b.title === msg("autofill_stop_nofeed") && i3b.more, JSON.stringify(i3b));
          heights.push(["exhausted-nofeed", i3b?.h]);
          await snap(r3b, "4-exhausted-nofeed");
          await r3b.close();

          // R3c общий лимит порций: каждая порция даёт по одной подходящей, цель недостижима
          await setSettings({ target: 30 });
          await resetStub(0, undefined);
          const r3c = await open("/?good=1&first=2");
          const r3cok = await waitState(r3c, "exhausted", 60000);
          const i3c = await statusInfo(r3c);
          check(`индикатор${tag}: R3c лимит порций — причина с числами «${i3c?.title}»`, r3cok && /\d+/.test(i3c.title) && i3c.more && i3c.spin === "none", JSON.stringify(i3c));
          heights.push(["exhausted-total", i3c?.h]);
          await snap(r3c, "5-exhausted-total");
          await r3c.close();
          await setSettings({ target: 12 });

          // R4 конец ленты
          await setSettings({ target: 30 });
          await resetStub(0, undefined);
          const r4 = await open("/?good=1&first=2&parts=2");
          const r4ok = await waitState(r4, "end", 30000);
          const i4 = await statusInfo(r4);
          check(`индикатор${tag}: R4 конец ленты — «${i4?.title}»`, r4ok && i4.title === msg("autofill_end") && !i4.more && !i4.settings && i4.spin === "none", JSON.stringify(i4));
          heights.push(["end", i4?.h]);
          await snap(r4, "6-end");
          await r4.close();
          await setSettings({ target: 12 });

          // R5 нет ключа: «фильтр не работает» + «Настройки»; лента не скрыта (fail-open); клик доходит до background
          await resetStub(0, "no_key");
          await sw.evaluate(() => { globalThis.__openOptions = 0; });
          const r5 = await open("/?good=0");
          const r5ok = await waitState(r5, "error", 20000);
          const i5 = await statusInfo(r5);
          check(`индикатор${tag}: R5 нет ключа — «${i5?.title}»`, r5ok && i5.title === fmt("autofill_error", msg("autofill_error_no_key")) && i5.detail === msg("autofill_error_hint") && i5.settings && i5.settingsText === msg("autofill_settings") && !i5.more && i5.spin === "none", JSON.stringify(i5));
          check(`индикатор${tag}: R5 fail-open — все карточки видны`, i5?.cardsShown === true, JSON.stringify(i5));
          heights.push(["error-no-key", i5?.h]);
          await snap(r5, "7-error-no-key");
          await r5.click("#slop-feed-settings");
          const opened = await sw.evaluate(() => globalThis.__openOptions);
          check(`индикатор${tag}: R5 «Настройки» открывает страницу настроек (сообщение дошло до background)`, opened === 1, String(opened));
          await r5.close();

          // R5b сбой провайдера: network без единого решения
          await resetStub(0, "network");
          const r5b = await open("/?good=0");
          const r5bok = await waitState(r5b, "error", 30000);
          const i5b = await statusInfo(r5b);
          check(`индикатор${tag}: R5b сбой сети — «${i5b?.title}»`, r5bok && i5b.title === fmt("autofill_error", msg("autofill_error_network")) && i5b.detail === msg("autofill_error_hint_retry") && i5b.settings, JSON.stringify(i5b));
          // честность: до повторов карточки при сбое провайдера скрыты шлюзом — текст про «без фильтрации» тут не обещается
          check(`индикатор${tag}: R5b при сбое провайдера текст не обещает ленту без фильтрации`, !/без фильтрации|unfiltered/i.test(i5b?.detail ?? ""), String(i5b?.detail));
          heights.push(["error-network", i5b?.h]);
          await snap(r5b, "8-error-network");
          await r5b.close();
          // R5c: 402/403 — понятные причины, лента показана без фильтрации (fail-open), кнопка «Настройки»
          for (const [force, key] of [["no_credits", "autofill_error_no_credits"], ["access_denied", "autofill_error_access_denied"]]) {
            await resetStub(0, force);
            const r5c = await open("/?good=0");
            const r5cok = await waitState(r5c, "error", 30000);
            const i5c = await statusInfo(r5c);
            check(`индикатор${tag}: R5c ${force} — «${i5c?.title}»`, r5cok && i5c.title === fmt("autofill_error", msg(key)) && i5c.detail === msg("autofill_error_hint") && i5c.settings, JSON.stringify(i5c));
            await r5c.close();
          }
          await resetStub(0, undefined);
          const hv = heights.map(([, h]) => h);
          check(`индикатор${tag}: R6 высота блока одинакова во всех состояниях (без layout-shift): ${heights.map(([n, h]) => `${n}=${h}`).join(" ")}`, hv.length === 8 && Math.max(...hv) - Math.min(...hv) <= 1);

          // R7 высота не зависит от ширины и языка: ряд ширин (включая границы container query 479/480, 859/860 и 520/521 окна)
          //    × en/ru × все состояния. Реальный блок и gate.css; тексты и флаги состояний подставляются из словарей обоих языков.
          if (width === 1280) {
            const cats = Object.fromEntries(["en", "ru"].map((l) => [l, JSON.parse(readFileSync(join(root, "static", "_locales", l, "messages.json"), "utf8"))]));
            const fmtC = (cat, key, ...vals) => {
              const m = cat[key];
              const names = Object.entries(m.placeholders ?? {}).sort((x, y) => Number(x[1].content.slice(1)) - Number(y[1].content.slice(1))).map(([n]) => n);
              let out = m.message;
              names.forEach((n, k) => (out = out.replace(new RegExp(`\\$${n}\\$`, "i"), String(vals[k]))));
              return out;
            };
            const specs = (c) => [
              ["searching", c.autofill_searching.message, fmtC(c, "autofill_progress", 2, 12, 60), false, false],
              ["done", fmtC(c, "autofill_done", 12), c.autofill_done_hint.message, false, false],
              ["exhausted", fmtC(c, "autofill_stop_empty", 60), c.autofill_stop_hint.message, true, false],
              ["exhausted", c.autofill_stop_nofeed.message, c.autofill_stop_hint.message, true, false],
              ["exhausted", fmtC(c, "autofill_stop_total", 75, 3, 12), c.autofill_stop_hint.message, true, false],
              ["exhausted", c.autofill_stop_stall.message, c.autofill_stop_hint.message, true, false],
              ["end", c.autofill_end.message, fmtC(c, "autofill_end_detail", 2, 60), false, false],
              ["unsafe", c.autofill_unsafe.message, "", false, false],
              ["error", fmtC(c, "autofill_error", c.autofill_error_no_key.message), c.autofill_error_hint.message, false, true],
              ["error", fmtC(c, "autofill_error", c.autofill_error_bad_response.message), c.autofill_error_hint_retry.message, false, true],
              ["error", fmtC(c, "autofill_error", c.autofill_error_rate_limited.message), c.autofill_error_hint_retry.message, false, true],
            ];
            await setSettings({ target: 12 });
            await resetStub(0, undefined);
            const r7 = await open("/?good=0&first=2&parts=0");
            await waitState(r7, "exhausted", 40000);
            const sweep = [];
            for (const w of [320, 360, 390, 479, 480, 520, 521, 600, 768, 860, 1024, 1280]) {
              await r7.setViewportSize({ width: w, height: 800 });
              for (const lg of ["en", "ru"]) {
                const hs = await r7.evaluate((list) => {
                  const st = document.getElementById("slop-feed-status");
                  const out = [];
                  const more = document.getElementById("slop-feed-more");
                  const settings = document.getElementById("slop-feed-settings");
                  const bar = st.querySelector(".slop-fs-bar");
                  for (const [state, title, detail, m, sg] of list) {
                    st.dataset.state = state;
                    st.querySelector(".slop-fs-title").textContent = title;
                    st.querySelector(".slop-fs-detail").textContent = detail;
                    more.hidden = !m;
                    settings.hidden = !sg;
                    bar.hidden = state !== "searching";
                    out.push(Math.round(st.getBoundingClientRect().height * 10) / 10);
                  }
                  return { out, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
                }, specs(cats[lg]));
                sweep.push([w, lg, Math.max(...hs.out) - Math.min(...hs.out), hs.out[0], hs.overflow]);
              }
            }
            const badSweep = sweep.filter(([, , spread, , ov]) => spread > 0.5 || ov > 0);
            check(`индикатор: R7 высота блока постоянна на ширинах 320…1280 (en, ru, 11 вариантов текста), без горизонтальной прокрутки`, badSweep.length === 0, JSON.stringify(badSweep.length ? badSweep : sweep.map(([w, lg, , h]) => `${w}${lg}=${h}`)));
            await r7.close();
          }
        }

        // G) ИНВАРИАНТ раскладки: покадрово (rAF на весь цикл триггера) scrollHeight и scrollTop не меняются.
        //    Фикстура без запасного padding; нижняя граница документа; overflow-anchor none/auto; continuation в окне и ниже окна.
        await setSettings({ target: 12 });
        // ответы чуть позже первого evaluate автодогрузки (250 мс): индикатор встаёт до проявления карточек, проба стартует до первого trigger
        await resetStub(400, undefined);
        const L = "list=1&ch=148&first=6&good=0&parts=0"; // нижняя граница: 6×148 + 60 > окна 800
        const css = (t) => `&css=${encodeURIComponent(t)}`;
        // expect: "unsafe" — триггер обязан быть отклонён (измерение обнаруживает изменение геометрии);
        //         "any" — допустимо и «сработал, все кадры равны», и «отклонён, позиция цела, сообщение показано»
        const frameCases = [
          ["нижняя граница, continuation в окне, anchoring none", `/?${L}&anchor=none&probe=bottom`, "any"],
          ["нижняя граница, continuation в окне, anchoring auto", `/?${L}&probe=bottom`, "any"],
          ["continuation ниже окна (прокрутка 150), anchoring none", "/?list=1&ch=240&first=6&good=0&parts=0&anchor=none&probe=150", "any"],
          ["continuation ниже окна (прокрутка 150), anchoring auto", "/?list=1&ch=240&first=6&good=0&parts=0&probe=150", "any"],
          ["continuation в окне, документ короче окна", "/?list=1&ch=100&first=3&good=0&parts=0&probe=0", "any"],
          ["grid, нижняя граница", "/?ch=240&first=6&good=0&parts=0&probe=bottom", "any"],
          ["CSS страницы: transform вниз у continuation (translateY(60px)), anchoring none", `/?${L}&anchor=none&probe=bottom${css("#cont{transform:translateY(60px)}")}`, "unsafe"],
          ["CSS страницы: transform вниз у continuation, anchoring auto", `/?${L}&probe=bottom${css("#cont{transform:translateY(60px)}")}`, "unsafe"],
          ["CSS страницы: transform вниз, continuation ниже окна", `/?list=1&ch=240&first=6&good=0&parts=0&anchor=none&probe=150${css("#cont{transform:translateY(60px)}")}`, "unsafe"],
          ["откат при scroll-behavior:smooth на html (страничный transform вниз → unsafe)", `/?${L}&anchor=none&probe=bottom${css("html{scroll-behavior:smooth}#cont{transform:translateY(60px)}")}`, "unsafe"],
          ["откат при scroll-behavior:smooth на body (страничный transform вниз → unsafe)", `/?${L}&anchor=none&probe=bottom${css("body{scroll-behavior:smooth}#cont{transform:translateY(60px)}")}`, "unsafe"],
          ["откат при scroll-behavior:smooth на html и body, anchoring auto", `/?${L}&probe=bottom${css("html,body{scroll-behavior:smooth}#cont{transform:translateY(60px)}")}`, "unsafe"],
          ["CSS страницы: transform вверх у continuation", `/?${L}&anchor=none&probe=bottom${css("#cont{transform:translateY(-30px)}")}`, "any"],
          ["CSS страницы: scale(2) у continuation (нижний overflow)", `/?${L}&anchor=none&probe=bottom${css("#cont{transform:scale(2)}")}`, "unsafe"],
          ["CSS страницы: scale(.5) у continuation", `/?${L}&anchor=none&probe=bottom${css("#cont{transform:scale(.5)}")}`, "any"],
          ["CSS страницы: margin и position relative у continuation", `/?${L}&anchor=none&probe=bottom${css("#cont{margin-top:-20px;position:relative;top:40px}")}`, "any"],
          ["CSS страницы: transform у предка (#contents)", `/?${L}&anchor=none&probe=bottom${css("#contents{transform:translateY(40px)}")}`, "any"],
          ["CSS страницы: overflow:hidden у предка", `/?${L}&anchor=none&probe=bottom${css("#contents{overflow:hidden}")}`, "any"],
        ];
        for (const [name, path, expectMode] of frameCases) {
          const g = await open(path);
          await g.waitForFunction(
            (t) => window.__reenters >= 1 || document.getElementById("slop-feed-status")?.dataset.state === t,
            TEXT_UNSAFE,
            { timeout: 15000 },
          ).catch(() => {});
          await g.waitForTimeout(900); // хвост цикла триггера (до 6 кадров и страховка 500 мс)
          const res = await g.evaluate(() => {
            window.__stopProbe = true;
            const st = document.getElementById("slop-feed-status");
            return { pre: window.__probePre, ind: window.__probeInd, rec: window.__rec, start: window.__probeStart, reenters: window.__reenters, api: window.__scrollApi, status: st && !st.hidden ? st.dataset.state : null, tr: document.getElementById("cont")?.style.transform ?? null };
          });
          const rec = res.rec ?? [];
          const bad = rec.filter(([h, y]) => h !== rec[0][0] || y !== rec[0][1]);
          const unsafeShown = res.status === TEXT_UNSAFE;
          const worked = res.reenters >= 1 && !unsafeShown;
          const outcomeOk = expectMode === "unsafe" ? unsafeShown && res.reenters === 0 : worked || unsafeShown;
          check(
            `инвариант${tag}: ${name} — ${unsafeShown ? "триггер отклонён, сообщение показано" : "триггер сработал"}, кадров ${rec.length}, scrollHeight/scrollTop неизменны`,
            outcomeOk && res.pre === 0 && res.ind === true && rec.length >= 20 && bad.length === 0 && res.api === 0 && res.tr === "",
            `pre=${res.pre} ind=${res.ind} reenters=${res.reenters} status=${res.status} frames=${rec.length} first=${JSON.stringify(rec[0])} bad=${JSON.stringify(bad.slice(0, 3))} transform=${JSON.stringify(res.tr)}`,
          );
          await g.close();
        }
        await resetStub(0, undefined);

        // F) поле цели в popup: 6–30, сохраняется, без горизонтальной прокрутки
        const pp = await context.newPage();
        await pp.setViewportSize({ width, height: 800 });
        await pp.goto(`chrome-extension://${extId}/popup.html`);
        check(`popup${tag}: поле цели по умолчанию 12`, (await pp.inputValue("#feed-target")) === "12");
        await pp.fill("#feed-target", "99");
        await pp.dispatchEvent("#feed-target", "change");
        await pp.waitForFunction(() => document.getElementById("feed-target").value === "30");
        const stored = await pp.evaluate(async () => (await chrome.storage.sync.get("slop.settings"))["slop.settings"].feedTarget);
        check(`popup${tag}: 99 → 30 сохранено в storage`, stored === 30, String(stored));
        const ov = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(`popup${tag}: поле цели без горизонтальной прокрутки`, ov <= 0, `overflow=${ov}`);
        // тумблер совместимости с uBOL: по умолчанию выключен, сохраняется в sync, подпись и описание из словаря
        check(`popup${tag}: тумблер uBOL выключен по умолчанию, подпись из словаря`, !(await pp.isChecked("#compat-ubol")) && (await pp.textContent("#compat-row span")) === msg("popup_compat_ubol") && (await pp.textContent("#compat-hint")) === msg("popup_compat_ubol_hint"));
        // click, а не check(): уход фокуса с поля цели порождает штатный change и перерисовку, пока тумблер ещё не сохранён
        await pp.click("#compat-ubol");
        const saved = await pp.waitForFunction(async () => (await chrome.storage.sync.get("slop.settings"))["slop.settings"].compatUbol === true, null, { timeout: 8000 }).then(() => true, () => false);
        check(`popup${tag}: тумблер uBOL сохранён в storage.sync и остался включённым`, saved && (await pp.isChecked("#compat-ubol")));
        await pp.click("#compat-ubol");
        const cleared = await pp.waitForFunction(async () => (await chrome.storage.sync.get("slop.settings"))["slop.settings"].compatUbol === false, null, { timeout: 8000 }).then(() => true, () => false);
        check(`popup${tag}: тумблер uBOL выключается обратно`, cleared && !(await pp.isChecked("#compat-ubol")));
        await pp.screenshot({ path: join(shots, `popup-target-${width}.png`), fullPage: true });
        await pp.close();
      }
      await setup.close();
      await context.unroute("https://www.youtube.com/**");
    }
    await setStub(0, undefined);
    await context.unroute("https://www.youtube.com/**");
  }

  }
  for (const page of ["options", "popup"]) {
    for (const width of widths) {
      const p = await context.newPage();
      p.on("console", (m) => m.type() === "error" && errors.push(`${page}@${width} console: ${m.text()}`));
      p.on("pageerror", (e) => errors.push(`${page}@${width} pageerror: ${e.message}`));
      await p.setViewportSize({ width, height: 800 });
      const external = [];
      p.on("request", (r) => !/^(chrome-extension|data|blob):/.test(r.url()) && external.push(r.url()));
      await p.goto(`chrome-extension://${extId}/${page}.html`);
      await p.waitForLoadState("load");
      const fontInfo = await p.evaluate(async () => {
        await document.fonts.load(`13px "JetBrains Mono"`, "Aa");
        await document.fonts.load(`13px "JetBrains Mono"`, "Яя");
        await document.fonts.ready;
        return { family: getComputedStyle(document.body).fontFamily, ok: document.fonts.check('13px "JetBrains Mono"', "Aa"), cyr: document.fonts.check('13px "JetBrains Mono"', "Яя") };
      });
      check(`${page}@${width}: шрифт JetBrains Mono загружен локально (latin+cyrillic)`, fontInfo.family.startsWith('"JetBrains Mono"') && fontInfo.ok && fontInfo.cyr, JSON.stringify(fontInfo));
      check(`${page}@${width}: нет внешних запросов`, external.length === 0, external.join(","));
      const overflow =await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${page}@${width}: нет горизонтальной прокрутки`, overflow <= 0, `overflow=${overflow}`);
      const file = join(shots, `${page}-${width}.png`);
      await p.screenshot({ path: file, fullPage: true });
      check(`${page}@${width}: скриншот`, existsSync(file), file);
      await p.close();
    }
  }
  if (suite === "openrouter") {
  // --- openrouter-client: ключ, маска, решение через background (fetch в SW подменён моком) ---
  const SECRET = "sk-or-v1-E2ESECRETVALUE0000WXYZ";
  await sw.evaluate(usageMock);
  for (const width of widths) {
    const p = await context.newPage();
    p.on("console", (m) => m.type() === "error" && errors.push(`options-flow@${width} console: ${m.text()}`));
    p.on("pageerror", (e) => errors.push(`options-flow@${width} pageerror: ${e.message}`));
    await p.setViewportSize({ width, height: 900 });
    await p.goto(`chrome-extension://${extId}/options.html`);
    await p.waitForFunction(() => document.getElementById("key-status").textContent.includes("не задан"));
    check(`options@${width}: поле ключа type=password`, (await p.getAttribute("#key", "type")) === "password");
    check(`options@${width}: дефолты модель/порог`, (await p.inputValue("#model")) === "typesafe/jev-1.13" && (await p.inputValue("#threshold")) === "0.7");
    await p.fill("#key", SECRET);
    await p.click("#save-key");
    await p.waitForFunction(() => document.getElementById("key-status").textContent.includes("сохранён"));
    const text = await p.evaluate(() => document.body.innerText + "|" + document.getElementById("key").value);
    check(`options@${width}: ключ не показан целиком, поле очищено`, !text.includes("E2ESECRET") && !text.includes(SECRET), text.replace(/\s+/g, " ").slice(0, 120));
    const resp = await p.evaluate((i) => chrome.runtime.sendMessage({ type: "slop/decide", video: { videoId: "e2e" + i, title: "t", channel: "c" }, tags: [{ id: "a", text: "x" }, { id: "b", text: "y" }] }), width);
    check(`decide@${width}: ответ по контракту`, resp.ok === true && resp.hide === true && resp.matchedTagIds.join() === "a", JSON.stringify(resp));
    check(`decide@${width}: ключ не в ответе`, !JSON.stringify(resp).includes("E2ESECRET"));
    await p.fill("#threshold", "1.5");
    await p.click("#save-settings");
    check(`options@${width}: невалидный порог отклонён`, (await p.textContent("#settings-msg")).includes("0 до 1"));
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`options-flow@${width}: нет горизонтальной прокрутки`, overflow <= 0, `overflow=${overflow}`);
    await p.screenshot({ path: join(shots, `options-flow-${width}.png`), fullPage: true });
    await p.click("#remove-key");
    await p.waitForFunction(() => document.getElementById("key-status").textContent.includes("не задан"));
    const noKey = await p.evaluate(() => chrome.runtime.sendMessage({ type: "slop/decide", video: { videoId: "nk", title: "t", channel: "c" }, tags: [{ id: "a", text: "x" }] }));
    check(`decide@${width}: после удаления ключа -> no_key`, noKey.ok === false && noKey.error === "no_key", JSON.stringify(noKey));
    await p.close();
  }
  const calls = await sw.evaluate(() => globalThis.__calls);
  check("мок API вызван ровно по одному разу на видео (кэш/без ключа без вызовов)", calls.length === 2 && calls.every((c) => c.url === "https://openrouter.ai/api/v1/systemone" && c.auth === `Bearer ${SECRET}`), `calls=${calls.length}`);

  // --- decision-cache: фикстура YouTube + перезагрузка страницы → 0 новых вызовов к OpenRouter ---
  await sw.evaluate(async (secret) => {
    globalThis.__calls2 = [];
    globalThis.fetch = async (url, init) => {
      const q = JSON.parse(init.body).questions;
      globalThis.__calls2.push({ url: String(url), questions: Object.keys(q).length, title: JSON.parse(init.body).state.title });
      globalThis.__msgs2 ??= null;
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul", noul: 0.9 }])) }), { status: 200 });
    };
    await chrome.storage.local.set({ openrouterKey: secret });
    if (!globalThis.__msgCounter) {
      globalThis.__msgCounter = { peek: 0, decide: 0 };
      chrome.runtime.onMessage.addListener((m) => {
        if (m && m.type === "slop/peek") globalThis.__msgCounter.peek++;
        if (m && m.type === "slop/decide") globalThis.__msgCounter.decide++;
        return undefined;
      });
    }
    await chrome.storage.sync.clear();
    await chrome.storage.sync.set({ "slop.settings": { enabled: true, order: ["c1"], mode: "blocklist" }, "slop.tag.c1": { text: "кэш-тест", enabled: true } });
  }, SECRET);
  await context.route("https://www.youtube.com/**", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
  const cacheCalls = () => sw.evaluate(() => globalThis.__calls2.length);
  const settle = async () => {
    let prev = -1;
    for (let i = 0; i < 40; i++) {
      const n = await cacheCalls();
      if (n === prev && n > 0) return n;
      prev = n;
      await new Promise((r) => setTimeout(r, 300));
    }
    return prev;
  };
  const ytp = await context.newPage();
  ytp.on("console", (m) => m.type() === "error" && errors.push(`cache-yt console: ${m.text()}`));
  await ytp.goto("https://www.youtube.com/");
  const first = await settle();
  const hiddenFirst = await ytp.evaluate(() => getComputedStyle(document.getElementById("h1")).display === "none");
  check("decision-cache: первая загрузка фикстуры — вызовы к OpenRouter, видео скрыто", first > 0 && hiddenFirst, `calls=${first}`);
  const domTitles = await ytp.evaluate(() => [...new Map([...document.querySelectorAll("ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytd-reel-item-renderer")].map((c) => [(() => { const h = c.querySelector("a[href*='/watch?v='], a[href*='/shorts/']")?.getAttribute("href"); if (!h) return null; const u = new URL(h, "https://www.youtube.com"); return u.searchParams.get("v") ?? u.pathname; })(), (c.querySelector("#video-title, a#video-title-link, .yt-lockup-metadata-view-model__title, h3")?.textContent ?? c.querySelector("a")?.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim()]).filter(([h, t]) => h && t)).values()]);
  const paidTitles = await sw.evaluate(() => globalThis.__calls2.map((c) => c.title));
  check("filter-perf: платные вызовы первой загрузки идут в порядке карточек на странице, по одному на видео", JSON.stringify(paidTitles) === JSON.stringify(domTitles), `paid=${paidTitles.length} dom=${domTitles.length}`);
  await sw.evaluate(() => { globalThis.__msgCounter.peek = 0; globalThis.__msgCounter.decide = 0; });
  await ytp.reload();
  await ytp.waitForFunction(() => getComputedStyle(document.getElementById("h1")).display === "none", null, { timeout: 8000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const afterReload = await cacheCalls();
  const hiddenAfter = await ytp.evaluate(() => getComputedStyle(document.getElementById("h1")).display === "none");
  check("decision-cache: после перезагрузки 0 новых вызовов к OpenRouter, скрытие из кэша", afterReload === first && hiddenAfter, `before=${first} after=${afterReload}`);
  const msgCounts = await sw.evaluate(() => globalThis.__msgCounter);
  check("filter-perf: повторный визит — проверка кэша пакетом (peek ≥ 1, меньше числа карточек), 0 decide", msgCounts.decide === 0 && msgCounts.peek >= 1 && msgCounts.peek < domTitles.length, JSON.stringify(msgCounts) + ` cards=${domTitles.length}`);
  const pairsStored = await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("dc3:")).length);
  check("decision-cache: кэш лежит в шардах dc3:*", pairsStored > 0, `shards=${pairsStored}`);
  await ytp.close();
  }
  // --- usage-display: блок «Траты» в настоящем popup, background с моком fetch ---
  if (suite === "openrouter") {
    const KEYS = ["sk-or-v1-USAGEKEYAAAAAAAA0001", "sk-or-v1-USAGEKEYBBBBBBBB0002", "sk-or-v1-USAGEKEYCCCCCCCC0003", "sk-or-v1-USAGEKEYDDDDDDDD0004"];
    await sw.evaluate(usageMock); // блок decision-cache выше подменил fetch — возвращаем мок с /key
    const reqToday = 2 + (await sw.evaluate(() => globalThis.__calls2.length)); // 2 из options-flow + платные вызовы decision-cache (токены — только у первых двух: 952)
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${extId}/options.html`);
    const setKey = (k) => setup.evaluate(async (key) => (key ? chrome.storage.local.set({ openrouterKey: key }) : chrome.storage.local.remove("openrouterKey")), k);
    const keyCalls = () => sw.evaluate(() => globalThis.__keyCalls.length);
    const openPopup = async (width, tag) => {
      const p = await context.newPage();
      p.on("console", (m) => m.type() === "error" && errors.push(`usage-${tag}@${width} console: ${m.text()}`));
      p.on("pageerror", (e) => errors.push(`usage-${tag}@${width} pageerror: ${e.message}`));
      await p.setViewportSize({ width, height: 800 });
      await p.goto(`chrome-extension://${extId}/popup.html`);
      await p.waitForFunction(() => document.getElementById("usage").dataset.state !== "loading", null, { timeout: 15000 });
      return p;
    };
    const rowsOf = (p) => p.locator("#usage-rows dt, #usage-rows dd").allTextContents().then((a) => a.join("|"));
    const noOverflow = async (p, name) => {
      const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(name, o <= 0, `overflow=${o}`);
    };
    const secretAbsent = async (p, name, secret) => {
      const t = await p.evaluate(() => document.documentElement.outerHTML);
      check(name, !t.includes("USAGEKEY") && !t.includes(secret) && !t.includes("SERVERTEXT"));
    };

    // A: лимит есть; второй popup (другая ширина) в пределах 60 с — из кэша
    await setup.evaluate(() => chrome.storage.sync.clear()); // режим по умолчанию (allowlist) — проверяем блок трат именно в нём
    await sw.evaluate(() => { globalThis.__keyMode = "limit"; });
    await setKey(KEYS[0]);
    const before = await keyCalls();
    for (const width of widths) {
      const p = await openPopup(width, "limit");
      check(`траты@${width}: сегодня/всего/остаток лимита/локальные счётчики`, ws(await rowsOf(p)) === ws(`Сегодня|0,0004 $|Всего|0,0123 $|Остаток лимита|74,50 $|Запросов сегодня|${reqToday}|Токенов сегодня / всего|952 / 952|≈ по цене Jev (всего)|<0,0001 $`), await rowsOf(p));
      check(`траты@${width}: режим по умолчанию allowlist, переключатели на месте`, (await p.inputValue("#mode")) === "allowlist" && (await p.locator("#skip-subs").count()) === 1);
      await noOverflow(p, `траты@${width}: нет горизонтальной прокрутки`);
      await secretAbsent(p, `траты@${width}: ключ и текст сервера не в DOM`, KEYS[0]);
      check(`траты@${width}: теги и форма на месте`, (await p.locator("#add button").count()) === 1 && (await p.locator("#enabled").count()) === 1);
      await p.screenshot({ path: join(shots, `popup-usage-${width}.png`), fullPage: true });
      await p.close();
    }
    const kc = await sw.evaluate(() => globalThis.__keyCalls);
    check("траты: два открытия popup за 60 с → один запрос к /key (кэш), GET с Bearer, без тела", kc.length - before === 1 && kc[before].method === "GET" && kc[before].auth === `Bearer ${KEYS[0]}` && kc[before].body === undefined && kc[before].ct === undefined, `calls=${kc.length - before}`);

    // B: лимита нет → строки «Остаток лимита» нет; смена ключа сбрасывает кэш
    await sw.evaluate(() => { globalThis.__keyMode = "nolimit"; });
    await setKey(KEYS[1]);
    for (const width of widths) {
      const p = await openPopup(width, "nolimit");
      const r = await rowsOf(p);
      check(`траты@${width}: без лимита нет строки остатка, новый ключ → новые данные`, ws(r).startsWith(ws(`Сегодня|0,0004 $|Всего|0,0123 $|Запросов сегодня|${reqToday}|Токенов сегодня / всего|952 / 952`)) && !r.includes("Остаток"), r);
      if (width === widths[0]) await p.screenshot({ path: join(shots, `popup-usage-nolimit-${width}.png`), fullPage: true });
      await p.close();
    }
    check("траты: смена ключа → ровно один новый запрос", (await keyCalls()) - before === 2);

    // C: 401 → нет ключа + кнопка настроек
    await sw.evaluate(() => { globalThis.__keyMode = "401"; });
    await setKey(KEYS[2]);
    for (const width of widths) {
      const p = await openPopup(width, "401");
      check(`траты@${width}: 401 → «OpenRouter отклонил ключ» и кнопка настроек`, (await p.textContent("#usage-text")) === "OpenRouter отклонил ключ" && (await p.locator("#usage-settings").isVisible()), await p.textContent("#usage-text"));
      await secretAbsent(p, `траты@${width}: текст сервера не показан`, KEYS[2]);
      await noOverflow(p, `траты@${width}: (нет ключа) нет горизонтальной прокрутки`);
      await p.screenshot({ path: join(shots, `popup-usage-nokey-${width}.png`), fullPage: true });
      if (width === widths[0]) {
        // страница настроек уже открыта (setup) — Chrome её просто фокусирует, поэтому считаем вызовы openOptionsPage
        await p.evaluate(() => { globalThis.__opened = 0; chrome.runtime.openOptionsPage = () => { globalThis.__opened++; return Promise.resolve(); }; });
        await p.click("#usage-settings");
        check("траты: кнопка вызывает chrome.runtime.openOptionsPage", (await p.evaluate(() => globalThis.__opened)) === 1);
      }
      await p.close();
    }

    // D: сеть → фиксированный текст, локальные счётчики остаются
    await sw.evaluate(() => { globalThis.__keyMode = "net"; });
    await setKey(KEYS[3]);
    for (const width of widths) {
      const p = await openPopup(width, "net");
      check(`траты@${width}: сбой сети → фиксированный текст + локальные счётчики`, (await p.textContent("#usage-text")) === "Не удалось получить траты (сеть)" && (await rowsOf(p)) === `Запросов сегодня|${reqToday}|Токенов сегодня / всего|952 / 952`, await rowsOf(p));
      await noOverflow(p, `траты@${width}: (ошибка) нет горизонтальной прокрутки`);
      await secretAbsent(p, `траты@${width}: (ошибка) ключ не в DOM`, KEYS[3]);
      if (width === widths[1]) await p.screenshot({ path: join(shots, `popup-usage-error-${width}.png`), fullPage: true });
      await p.close();
    }

    // E: ключа нет вообще — без запроса к OpenRouter
    await setKey(null);
    const beforeNoKey = await keyCalls();
    const pn = await openPopup(390, "nokey");
    check("траты: ключ не задан → no_key без запроса к /key", (await pn.textContent("#usage-text")) === "Ключ OpenRouter не задан" && (await keyCalls()) === beforeNoKey);
    await pn.close();

    // content script не может запросить траты (sender.id чужой) — проверяется юнит-тестом listener; здесь страница YouTube-заглушка
    await setup.close();
  }
  if (suite === "i18n") {
    // --- локаль браузера (ru/en) и поле тега: popup и options при 390 и 1280, скриншоты, overflow=0 ---
    const L = {
      ru: { add: "Добавить", placeholder: "Что показывать: продуктивность, IT, нейросети", usage: "Траты", optionsTitle: "slop-block — настройки", mode: "Показывать только подходящие", docLang: "ru" },
      en: { add: "Add", placeholder: "What to show: productivity, IT, neural networks", usage: "Spending", optionsTitle: "slop-block — settings", mode: "Show only matching", docLang: "en" },
    }[lang];
    const LONG = "видео про разработку, нейросети и продуктивность без кликбейта, длинных рекламных вставок и пустой болтовни ".repeat(2).slice(0, 190).trim();
    const noOverflowOf = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    // высота плейсхолдера в зеркальном блоке не больше высоты поля → виден целиком
    const placeholderFits = (p) =>
      p.evaluate(() => {
        const ta = document.getElementById("text");
        const cs = getComputedStyle(ta);
        const m = document.createElement("div");
        m.textContent = ta.placeholder;
        Object.assign(m.style, { position: "absolute", visibility: "hidden", boxSizing: "border-box", width: `${ta.offsetWidth}px`, font: cs.font, lineHeight: cs.lineHeight, padding: cs.padding, border: cs.border, whiteSpace: "pre-wrap", overflowWrap: "anywhere" });
        document.body.append(m);
        const fits = m.offsetHeight <= ta.offsetHeight + 1;
        m.remove();
        return { fits, mirror: m.offsetHeight, field: ta.offsetHeight };
      });
    for (const width of widths) {
      const tag = `@${width} [${lang}]`;
      const popup = await context.newPage();
      popup.on("console", (m) => m.type() === "error" && errors.push(`i18n popup${tag} console: ${m.text()}`));
      popup.on("pageerror", (e) => errors.push(`i18n popup${tag} pageerror: ${e.message}`));
      await popup.setViewportSize({ width, height: 900 });
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await popup.evaluate(() => chrome.storage.sync.clear());
      await popup.reload();
      await popup.waitForSelector("#counter:not(:empty)");
      const probe = await popup.evaluate(() => [chrome.i18n.getUILanguage(), chrome.i18n.getMessage("popup_add"), document.documentElement.lang]);
      check(`язык${tag}: браузер действительно в нужной локали`, probe[0].startsWith(lang) && probe[1] === L.add && probe[2] === L.docLang, JSON.stringify(probe));
      check(`popup${tag}: кнопка, заголовок трат, режим, плейсхолдер — на языке браузера`,
        (await popup.textContent("#add button")) === L.add && (await popup.textContent("#usage h2")) === L.usage &&
        (await popup.textContent("#mode option[value=allowlist]")) === L.mode && (await popup.getAttribute("#text", "placeholder")) === L.placeholder &&
        (await popup.title()) === "slop-block");
      check(`popup${tag}: нет ни одного переключателя языка`, (await popup.locator("[aria-pressed]").count()) === 0);
      check(`popup${tag}: фокус в поле тега при открытии`, (await popup.evaluate(() => document.activeElement?.id)) === "text");
      const ph = await placeholderFits(popup);
      check(`popup${tag}: плейсхолдер виден целиком`, ph.fits, JSON.stringify(ph));
      check(`popup${tag}: поле — textarea, кнопка под полем справа`, await popup.evaluate(() => {
        const ta = document.getElementById("text").getBoundingClientRect();
        const b = document.querySelector("#add button").getBoundingClientRect();
        return document.getElementById("text").tagName === "TEXTAREA" && b.top >= ta.bottom - 1 && b.right <= ta.right + 1 && b.left > ta.left + ta.width / 2;
      }));
      check(`popup${tag}: счётчик 0/200`, (await popup.textContent("#counter")) === "0/200", await popup.textContent("#counter"));
      check(`popup${tag}: ширина popup в разумных пределах`, await popup.evaluate(() => document.querySelector("main").getBoundingClientRect().width <= 400));
      await popup.screenshot({ path: join(shots, `i18n-${lang}-popup-empty-${width}.png`), fullPage: true });

      // Shift+Enter — перенос, не добавляет; Enter — добавляет; перенос схлопывается
      await popup.click("#text");
      await popup.keyboard.type("первая");
      await popup.keyboard.press("Shift+Enter");
      await popup.keyboard.type("вторая");
      check(`popup${tag}: Shift+Enter вставил перенос и не добавил тег`, (await popup.inputValue("#text")) === "первая\nвторая" && (await popup.locator("#tags li").count()) === 0);
      await popup.keyboard.press("Enter");
      await popup.waitForFunction(() => document.querySelectorAll("#tags li").length === 1);
      check(`popup${tag}: Enter добавил тег, перенос → пробел, поле очищено`, (await popup.locator("#tags li .label").textContent()) === "первая вторая" && (await popup.inputValue("#text")) === "");
      check(`popup${tag}: счётчик после очистки 0/200`, (await popup.textContent("#counter")) === "0/200");

      // длинный текст: растёт до ~5 строк, счётчик, лимит
      await popup.fill("#text", LONG);
      const h2 = await popup.evaluate(() => document.getElementById("text").offsetHeight);
      await popup.fill("#text", `${LONG}\n${LONG}`.slice(0, 200).replace(/ /g, "\n"));
      const h5 = await popup.evaluate(() => document.getElementById("text").offsetHeight);
      const lh = await popup.evaluate(() => parseFloat(getComputedStyle(document.getElementById("text")).lineHeight));
      check(`popup${tag}: поле растёт, но не выше ~5 строк`, h5 >= h2 && h5 <= lh * 5 + 40, `h(190)=${h2} h(много строк)=${h5} lh=${lh}`);
      await popup.fill("#text", "x".repeat(200));
      check(`popup${tag}: лимит — 200/200 и подсветка`, (await popup.textContent("#counter")) === "200/200" && (await popup.locator("#counter.at-limit").count()) === 1);
      await popup.evaluate(() => { const t = document.getElementById("text"); t.focus(); });
      await popup.keyboard.type("yyy");
      check(`popup${tag}: ввод сверх лимита обрезан`, (await popup.inputValue("#text")).length === 200);
      await popup.fill("#text", LONG);
      check(`popup${tag}: счётчик по длинному тегу`, (await popup.textContent("#counter")) === `${LONG.length}/200`, await popup.textContent("#counter"));
      await popup.screenshot({ path: join(shots, `i18n-${lang}-popup-long-${width}.png`), fullPage: true });
      await popup.keyboard.press("Enter");
      await popup.waitForFunction(() => document.querySelectorAll("#tags li").length === 2);
      check(`popup${tag}: длинный тег добавлен целиком`, (await popup.locator("#tags li .label").nth(1).textContent()) === LONG);
      const ov = await noOverflowOf(popup);
      check(`popup${tag}: overflow=0`, ov <= 0, `overflow=${ov}`);
      await popup.screenshot({ path: join(shots, `i18n-${lang}-popup-with-tags-${width}.png`), fullPage: true });
      await popup.evaluate(() => chrome.storage.sync.clear());
      await popup.close();

      const opt = await context.newPage();
      opt.on("console", (m) => m.type() === "error" && errors.push(`i18n options${tag} console: ${m.text()}`));
      await opt.setViewportSize({ width, height: 900 });
      await opt.goto(`chrome-extension://${extId}/options.html`);
      await opt.waitForFunction(() => document.getElementById("key-status").textContent.length > 0 && document.getElementById("model").value !== "");
      check(`options${tag}: заголовок, title и lang на языке браузера`, (await opt.textContent("h1")) === L.optionsTitle && (await opt.title()) === L.optionsTitle && (await opt.evaluate(() => document.documentElement.lang)) === L.docLang);
      const ovo = await noOverflowOf(opt);
      check(`options${tag}: overflow=0`, ovo <= 0, `overflow=${ovo}`);
      await opt.screenshot({ path: join(shots, `i18n-${lang}-options-${width}.png`), fullPage: true });
      await opt.close();
    }
  }
  if (suite === "i18n") {
    // регрессия ревью r1: тег прежней версии с сериями пробелов и новый ввод с переносом — дубликат (в storage прежний текст не переписан)
    const lp = await context.newPage();
    lp.on("pageerror", (e) => errors.push(`legacy-dup pageerror: ${e.message}`));
    await lp.setViewportSize({ width: 390, height: 900 });
    await lp.goto(`chrome-extension://${extId}/popup.html`);
    await lp.evaluate(() => chrome.storage.sync.set({ "slop.settings": { enabled: true, order: ["legacy1"], mode: "allowlist", skipSubscriptions: true }, "slop.tag.legacy1": { text: "IT   videos", enabled: true } }));
    await lp.reload();
    await lp.waitForSelector("#tags li");
    await lp.click("#text");
    await lp.keyboard.type("IT");
    await lp.keyboard.press("Shift+Enter");
    await lp.keyboard.type("videos");
    await lp.keyboard.press("Enter");
    await lp.waitForFunction(() => document.getElementById("msg").textContent.length > 0);
    const stored = await lp.evaluate(async () => Object.keys(await chrome.storage.sync.get(null)).filter((k) => k.startsWith("slop.tag.")));
    check(`legacy-dup [${lang}]: старый «IT   videos» + новый «IT\\nvideos» → дубликат отклонён, второго тега нет`, (await lp.locator("#tags li").count()) === 1 && stored.length === 1, `li=${await lp.locator("#tags li").count()} stored=${stored.length}`);
    check(`legacy-dup [${lang}]: текст пользователя в storage не переписан`, (await lp.evaluate(async () => (await chrome.storage.sync.get("slop.tag.legacy1"))["slop.tag.legacy1"].text)) === "IT   videos");
    await lp.evaluate(() => chrome.storage.sync.clear());
    await lp.close();
  }
  if (suite === "typesafe") {
    // --- typesafe-provider: переключение провайдера в options, решения через мок api.typesafe.ai ---
    const TS_SECRET = "ts-e2e-TYPESAFESECRETVALUE9999";
    const OR_SECRET = "sk-or-v1-E2EORSECRETVALUE0000WXYZ";
    const TS_URL = "https://api.typesafe.ai/v1/systemone";
    const OR_URL = "https://openrouter.ai/api/v1/systemone";
    await sw.evaluate(() => {
      globalThis.__tsCalls = [];
      globalThis.fetch = async (url, init) => {
        globalThis.__tsCalls.push({ url: String(url), auth: init.headers.Authorization, model: JSON.parse(init.body).model });
        return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { t0: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 200, output_tokens: 4 } }), { status: 200 });
      };
    });
    const decideMsg = (p, id) => p.evaluate((v) => chrome.runtime.sendMessage({ type: "slop/decide", video: { videoId: v, title: "t", channel: "c" }, tags: [{ id: "a", text: "x" }] }), id);
    for (const width of widths) {
      await sw.evaluate(() => chrome.storage.local.remove(["typesafeKey", "openrouterKey", "settings"])); // чистое состояние на каждую ширину
      const p = await context.newPage();
      p.on("console", (m) => m.type() === "error" && errors.push(`ts-options@${width} console: ${m.text()}`));
      p.on("pageerror", (e) => errors.push(`ts-options@${width} pageerror: ${e.message}`));
      await p.setViewportSize({ width, height: 1000 });
      await p.goto(`chrome-extension://${extId}/options.html`);
      await p.waitForFunction(() => document.getElementById("ts-key-status").textContent.includes("не задан") || document.getElementById("ts-key-status").textContent.includes("not set"));
      check(`ts-options@${width}: по умолчанию провайдер OpenRouter, модель TypeSafe jev-1.13.0`, (await p.inputValue("#provider")) === "openrouter" && (await p.inputValue("#model-typesafe")) === "jev-1.13.0" && (await p.inputValue("#model")) === "typesafe/jev-1.13");
      check(`ts-options@${width}: поле ключа TypeSafe type=password`, (await p.getAttribute("#ts-key", "type")) === "password");
      await p.fill("#ts-key", TS_SECRET);
      await p.click("#ts-save-key");
      await p.waitForFunction(() => /…/.test(document.getElementById("ts-key-status").textContent));
      const text = await p.evaluate(() => document.body.innerText + "|" + document.getElementById("ts-key").value);
      check(`ts-options@${width}: ключ TypeSafe не показан целиком, поле очищено`, !text.includes(TS_SECRET) && !text.includes("TYPESAFESECRET"));
      check(`ts-options@${width}: ключ OpenRouter остался не заданным`, (await p.textContent("#key-status")).length > 0 && (await sw.evaluate(() => chrome.storage.local.get("openrouterKey"))).openrouterKey === undefined);
      // провайдер OpenRouter активен, ключа OpenRouter нет -> no_key, сети нет
      const before = await sw.evaluate(() => globalThis.__tsCalls.length);
      const nk = await decideMsg(p, `nk${width}`);
      check(`ts-decide@${width}: активен OpenRouter без его ключа -> no_key, 0 вызовов`, nk.ok === false && nk.error === "no_key" && (await sw.evaluate(() => globalThis.__tsCalls.length)) === before, JSON.stringify(nk));
      await p.selectOption("#provider", "typesafe");
      await p.click("#save-settings");
      await p.waitForFunction(() => document.getElementById("settings-msg").dataset.ok === "true");
      check(`ts-options@${width}: провайдер TypeSafe сохранён`, (await p.inputValue("#provider")) === "typesafe");
      const r = await decideMsg(p, `ts${width}`);
      check(`ts-decide@${width}: решение через TypeSafe по контракту`, r.ok === true && r.hide === true && r.matchedTagIds.join() === "a" && !JSON.stringify(r).includes("TYPESAFESECRET"), JSON.stringify(r));
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`ts-options@${width}: нет горизонтальной прокрутки`, overflow <= 0, `overflow=${overflow}`);
      await p.screenshot({ path: join(shots, `typesafe-options-${width}.png`), fullPage: true });
      await p.close();
    }
    let calls = await sw.evaluate(() => globalThis.__tsCalls);
    check("typesafe: все вызовы ушли на api.typesafe.ai с ключом TypeSafe, моделью jev-1.13.0, 0 к OpenRouter", calls.length === 2 && calls.every((c) => c.url === TS_URL && c.auth === `Bearer ${TS_SECRET}` && c.model === "jev-1.13.0"), JSON.stringify(calls));

    // popup: блок трат без серверного баланса (локальные цифры + оценка)
    const pop = await context.newPage();
    pop.on("console", (m) => m.type() === "error" && errors.push(`ts-popup console: ${m.text()}`));
    pop.on("pageerror", (e) => errors.push(`ts-popup pageerror: ${e.message}`));
    await pop.setViewportSize({ width: 390, height: 800 });
    await pop.goto(`chrome-extension://${extId}/popup.html`);
    await pop.waitForFunction(() => document.getElementById("usage").dataset.state !== "loading", null, { timeout: 15000 });
    const usageText = await pop.textContent("#usage");
    check("typesafe popup: блок трат — оценка и пояснение, без серверных сумм", (await pop.getAttribute("#usage", "data-state")) === "ok" && ws(usageText).includes(ws(msg("usage_typesafe_note"))) && usageText.includes(msg("usage_estimate")) && !usageText.includes(msg("usage_limit_remaining")), usageText.replace(/\s+/g, " ").slice(0, 160));
    check("typesafe popup: запрос трат не делал fetch", (await sw.evaluate(() => globalThis.__tsCalls.length)) === 2);
    await pop.screenshot({ path: join(shots, "typesafe-popup-390.png"), fullPage: true });
    await pop.close();

    // обратно на OpenRouter: ключ OpenRouter, вызовы только на openrouter.ai, кэш той же модели общий
    const back = await context.newPage();
    await back.goto(`chrome-extension://${extId}/options.html`);
    await back.fill("#key", OR_SECRET);
    await back.click("#save-key");
    await back.waitForFunction(() => /…/.test(document.getElementById("key-status").textContent));
    await back.selectOption("#provider", "openrouter");
    await back.click("#save-settings");
    await back.waitForFunction(() => document.getElementById("settings-msg").dataset.ok === "true");
    const same = await decideMsg(back, `ts${widths[0]}`); // уже решено через TypeSafe той же моделью -> без платного вызова
    const fresh = await decideMsg(back, "or-fresh");
    calls = await sw.evaluate(() => globalThis.__tsCalls);
    check("typesafe: после возврата на OpenRouter та же пара берётся из общего кэша, новая — на openrouter.ai", same.ok === true && fresh.ok === true && calls.length === 3 && calls[2].url === OR_URL && calls[2].auth === `Bearer ${OR_SECRET}` && calls.slice(0, 2).every((c) => c.url === TS_URL), JSON.stringify(calls.map((c) => c.url)));
    await back.close();
  }
  check("нет ошибок консоли/исключений", errors.length === 0, errors.join(" | "));
} finally {
  await context.close();
  rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\nИтого: ${results.length - failed}/${results.length} проверок`);
process.exit(failed ? 1 : 0);
