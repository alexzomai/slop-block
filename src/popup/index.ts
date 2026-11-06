import { KEY_STORAGE } from "../background/settings";
import { activeTags, type Mode, type Settings } from "../shared/settings";
import { loadSettings, saveSettings } from "../shared/storage";
import type { UsageResponse } from "../shared/usage";
import { applyI18n, domRoot, t } from "../shared/i18n";
import { MAX_TAGS, MAX_TEXT, MAX_TARGET, MIN_TARGET } from "../shared/settings";
import { PopupController, type PopupMessage } from "./controller";
import { clampHeight, counterView, isSubmitKey } from "./input";
import { modeTexts } from "./texts";
import { usageView } from "./usage";

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

let keyPresent = true; // пока не знаем — подсказку не показываем

/** Факт наличия ключа; само значение никуда не попадает. */
async function readKeyPresent(): Promise<boolean> {
  try {
    const v = (await chrome.storage.local.get(KEY_STORAGE))[KEY_STORAGE];
    return typeof v === "string" && v.length > 0;
  } catch {
    return true; // не смогли прочитать — подсказку не показываем
  }
}

function messageText(m: PopupMessage): string {
  switch (m) {
    case "": return "";
    case "empty": return t("err_empty");
    case "too_long": return t("err_too_long", MAX_TEXT);
    case "limit": return t("err_limit", MAX_TAGS);
    case "duplicate": return t("err_duplicate");
    case "save": return t("err_save");
    case "bad_target": return t("err_bad_target", MIN_TARGET, MAX_TARGET);
  }
}

const MAX_ROWS = 5;

/** Авто-рост поля тега: по содержимому до ~5 строк, дальше — прокрутка внутри поля. */
function grow(el: HTMLTextAreaElement): void {
  const cs = getComputedStyle(el);
  const border = el.offsetHeight - el.clientHeight;
  const max = (parseFloat(cs.lineHeight) || 18) * MAX_ROWS + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + border;
  el.style.height = "auto";
  el.style.height = `${clampHeight(el.scrollHeight + border, max)}px`;
}

function updateCounter(): void {
  const el = $("text") as HTMLTextAreaElement;
  const v = counterView(el.value, MAX_TEXT);
  $("counter").textContent = t("popup_counter", v.n, MAX_TEXT);
  $("counter").classList.toggle("at-limit", v.atLimit);
  grow(el);
}

function render(c: PopupController, s: Settings, message: PopupMessage): void {
  ($("enabled") as HTMLInputElement).checked = s.enabled;
  ($("mode") as HTMLSelectElement).value = s.mode;
  ($("skip-subs") as HTMLInputElement).checked = s.skipSubscriptions;
  ($("feed-target") as HTMLInputElement).value = String(s.feedTarget);
  const mt = modeTexts(s.mode);
  ($("text") as HTMLTextAreaElement).placeholder = mt.placeholder;
  $("text").setAttribute("aria-label", mt.label);
  $("mode-title").textContent = mt.title;
  $("key-hint").hidden = keyPresent || !s.enabled || activeTags(s).length === 0;
  $("msg").textContent = messageText(message);
  const list = $("tags");
  list.replaceChildren();
  for (const tag of s.tags) {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = tag.enabled;
    cb.setAttribute("aria-label", t("popup_tag_enabled"));
    cb.addEventListener("change", () => void c.toggle(tag.id));
    const label = document.createElement("span");
    label.className = tag.enabled ? "label" : "label off";
    label.textContent = tag.text; // только textContent
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = t("popup_delete");
    del.addEventListener("click", () => void c.remove(tag.id));
    li.append(cb, label, del);
    list.append(li);
  }
}

function renderUsage(r: UsageResponse | null | undefined): void {
  const v = usageView(r);
  $("usage").dataset.state = v.state;
  $("usage-text").textContent = v.text ?? ""; // только textContent
  $("usage-text").hidden = v.state === "ok";
  $("usage-settings").hidden = v.state !== "no_key";
  const dl = $("usage-rows");
  dl.replaceChildren();
  for (const [k, val] of v.rows ?? []) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = val;
    dl.append(dt, dd);
  }
}

/** Траты запрашиваются у background (ключ в popup не попадает) и не блокируют отрисовку тегов. */
function loadUsage(): void {
  renderUsage(null);
  $("usage-settings").addEventListener("click", () => void chrome.runtime.openOptionsPage());
  chrome.runtime.sendMessage({ type: "slop/usage" }).then(renderUsage, () => renderUsage(undefined));
}

async function main(): Promise<void> {
  applyI18n(domRoot(document), "ext_name");
  const [initial, present] = await Promise.all([loadSettings(chrome.storage.sync), readKeyPresent()]);
  keyPresent = present;
  const controller: PopupController = new PopupController(
    { save: (s) => saveSettings(chrome.storage.sync, s), render: (s, m) => render(controller, s, m) },
    initial,
  );
  $("enabled").addEventListener("change", (e) => void controller.setEnabled((e.target as HTMLInputElement).checked));
  $("mode").addEventListener("change", (e) => void controller.setMode((e.target as HTMLSelectElement).value as Mode));
  $("skip-subs").addEventListener("change", (e) => void controller.setSkipSubscriptions((e.target as HTMLInputElement).checked));
  $("feed-target").addEventListener("change", (e) => void controller.setFeedTarget((e.target as HTMLInputElement).valueAsNumber));
  const input = $("text") as HTMLTextAreaElement;
  const submit = (): void => {
    void controller.add(input.value).then((ok) => {
      if (ok) input.value = "";
      updateCounter();
    });
  };
  $("add").addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  input.addEventListener("keydown", (e) => {
    if (isSubmitKey(e)) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener("input", updateCounter);
  controller.init();
  updateCounter();
  input.focus();
  loadUsage();
}

void main();
