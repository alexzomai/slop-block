import type { DecideRequest, DecideResponse, PeekRequest, PeekResponse, SmartTag, VideoMeta } from "../shared/decision";
import { effectiveState, type Mode, type Settings } from "../shared/settings";

export interface FilterDeps<C> {
  findCards(): C[];
  extract(card: C): VideoMeta | null;
  /** blocklist: обратимо скрыть / вернуть карточку. */
  hide(card: C): void;
  show(card: C): void;
  /** allowlist: разрешить (проявить) / снова запретить карточку; по умолчанию скрытие делает CSS-шлюз. */
  allow?(card: C, instant?: boolean): void;
  disallow?(card: C): void;
  /** Взвести/снять CSS-шлюз (единый предохранитель allowlist). */
  setGate?(on: boolean): void;
  send(req: DecideRequest): Promise<DecideResponse>;
  /** Пакетная проверка кэша решений (без платных вызовов). Нет метода — все карточки идут в send. */
  peek?(req: PeekRequest): Promise<PeekResponse>;
  /** После каждого прохода scan() (для автодогрузки ленты). Исключения глушатся. */
  onSettled?(): void;
  /** Актуальный контекст страницы (по location). Если задан, проверяется перед каждой отправкой и применением ответа. */
  context?(): Context;
}

export interface Context { onSubscriptions: boolean; onSearch?: boolean }

export const DEBOUNCE_MS = 300;
/** Платных запросов в полёте; строго меньше maxConcurrent лимитера background (6) — слот остаётся запросам ключа/трат. */
export const MAX_PARALLEL = 5;
/** Дедлайн пакетной проверки кэша; просрочка = сбой peek (все карточки идут в send). */
export const PEEK_TIMEOUT_MS = 5_000;
/** Видео в одном сообщении peek (предел background — 100). */
export const PEEK_CHUNK = 100;
/** Дедлайн одной попытки: просрочка = временный сбой (как исключение sendMessage). */
export const ATTEMPT_TIMEOUT_MS = 20_000;
/** Задержки повторов после временного сбоя (network / rate_limited / исключение sendMessage / дедлайн): N = 2. */
export const RETRY_DELAYS_MS = [30_000, 120_000] as const;

interface Decision { hide: boolean; matched: boolean }
/** Запись упорядоченного буфера: порядок обнаружения карточек; промах выпускается в платную очередь только когда все более ранние записи решены. */
interface Pending { meta: VideoMeta; state: "peeking" | "miss" | "done" }

/** Логика фильтра без привязки к DOM: дедупликация, очередь, fail-open, обратимое скрытие/проявление. */
export class FeedFilter<C> {
  private tags: SmartTag[] = [];
  private mode: Mode = "allowlist";
  private active = false;
  private keyMissing = false;
  private lastSettings = "";
  private ctx: Context = { onSubscriptions: false };
  private settings: Settings | undefined;
  private decisions = new Map<string, Decision>(); // videoId → решение
  private queued = new Set<string>(); // в очереди, в полёте или в проверке кэша (peek)
  private instant = new Set<string>(); // решения из кэша: проявлять без лесенки анимации
  private lastScan = -Infinity;
  private queue: VideoMeta[] = [];
  /** Новые видео в порядке обнаружения (между пакетами и между проходами) до выпуска в очередь платных запросов. */
  private ordered: Pending[] = [];
  private fails = new Map<string, { count: number; retryAt: number }>(); // временные сбои
  /** Больше не отправляем: bad_response / неразборчивый ответ / исчерпанные повторы. В allowlist такая карточка видна (fail-open). */
  private terminal = new Set<string>();
  private hidden = new Set<C>(); // blocklist
  private shown = new Set<C>(); // allowlist
  private gate: boolean | undefined;
  private cardCount = 0;
  private waiting = 0; // карточки без решения, которые ещё будут оценены (не терминальные, не ждущие повтора)
  private running = 0;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private deps: FilterDeps<C>, settings: Settings, ctx: Context = { onSubscriptions: false }) {
    this.settings = settings;
    this.configure(settings, ctx);
  }

  /** Запланировать проход с дебаунсом. */
  schedule(): void {
    if (this.timer !== undefined) return;
    // ведущий фронт: если простоя ≥ DEBOUNCE_MS, проход сразу; иначе по остатку интервала
    const wait = Math.max(0, this.lastScan + DEBOUNCE_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scan();
    }, wait);
  }

  updateSettings(settings: Settings): void {
    this.reconfigure(settings, this.ctx);
  }

  /** Единая точка входа для смены настроек / страницы. Состояние применяется сразу, без таймеров и запросов. */
  reconfigure(settings: Settings, ctx: Context): void {
    this.settings = settings;
    this.configure(settings, ctx);
    this.resetVisuals();
    if (!this.active) {
      this.setGate(false);
      return;
    }
    this.setGate(this.mode === "allowlist");
    this.scan(false); // только известные решения, без новых запросов
    this.schedule();
  }

  /**
   * Единая точка актуализации контекста: если страница (location) уже другая, чем применённый контекст,
   * состояние пересчитывается немедленно: поколение очереди сбрасывается, шлюз и скрытие снимаются.
   * Вызывается перед каждым проходом, отправкой и применением ответа, независимо от порядка SPA-событий.
   */
  syncContext(): void {
    const live = this.deps.context?.();
    if (!live || !this.settings) return;
    if (!!live.onSubscriptions === !!this.ctx.onSubscriptions && !!live.onSearch === !!this.ctx.onSearch) return;
    this.reconfigure(this.settings, live);
  }

  private configure(settings: Settings, ctx: Context): boolean {
    this.ctx = ctx;
    const snapshot = JSON.stringify(settings);
    if (snapshot !== this.lastSettings) this.keyMissing = false; // смена настроек снимает «нет ключа»
    this.lastSettings = snapshot;
    const wanted = effectiveState(settings, { ...ctx, keyMissing: false });
    const tagsChanged = JSON.stringify(wanted.tags) !== JSON.stringify(this.tags);
    this.tags = wanted.tags;
    this.mode = wanted.mode;
    this.active = effectiveState(settings, { ...ctx, keyMissing: this.keyMissing }).active;
    if (tagsChanged) {
      this.generation++; // ответы устаревших запросов игнорируются
      this.decisions.clear();
      this.queued.clear();
      this.instant.clear();
      this.queue = [];
      this.ordered = [];
      this.fails.clear();
      this.terminal.clear();
    }
    return tagsChanged;
  }

  private setGate(on: boolean): void {
    if (this.gate === on) return;
    this.gate = on;
    this.deps.setGate?.(on);
  }

  /** Вернуть страницу к исходному виду; дальше scan() выставит нужное по известным решениям. */
  private resetVisuals(): void {
    for (const c of this.hidden) this.deps.show(c);
    this.hidden.clear();
    for (const c of this.shown) this.deps.disallow?.(c);
    this.shown.clear();
  }

  /** Видимость по режиму: blocklist — не скрыта, пока нет hide:true; allowlist — скрыта, пока нет разрешения или fail-open. */
  private visible(videoId: string): boolean {
    const d = this.decisions.get(videoId);
    if (this.mode === "blocklist") return !(d?.hide ?? false);
    return d ? d.matched : this.terminal.has(videoId);
  }

  private place(card: C, visible: boolean, instant = false): void {
    if (this.mode === "blocklist") {
      if (!visible && !this.hidden.has(card)) {
        this.deps.hide(card);
        this.hidden.add(card);
      } else if (visible && this.hidden.has(card)) {
        this.deps.show(card);
        this.hidden.delete(card);
      }
    } else if (visible && !this.shown.has(card)) {
      this.deps.allow?.(card, instant);
      this.shown.add(card);
    } else if (!visible && this.shown.has(card)) {
      this.deps.disallow?.(card);
      this.shown.delete(card);
    }
  }

  /** Сводка для автодогрузки: видимые (allowlist), найденные карточки, необработанные (очередь + полёт). */
  snapshot(): { active: boolean; mode: Mode; visible: number; cards: number; pending: number } {
    return { active: this.active, mode: this.mode, visible: this.shown.size, cards: this.cardCount, pending: Math.max(this.waiting, this.queued.size) };
  }

  scan(enqueue = true): void {
    if (enqueue) this.lastScan = Date.now(); // scan(false) из reconfigure — без запросов: интервал дебаунса не расходует
    try {
      this.doScan(enqueue);
    } finally {
      try {
        this.deps.onSettled?.();
      } catch {
        /* автодогрузка не должна ломать фильтр */
      }
    }
  }

  private doScan(enqueue: boolean): void {
    this.syncContext();
    if (!this.active) {
      this.waiting = 0;
      this.resetVisuals();
      this.setGate(false);
      return;
    }
    this.setGate(this.mode === "allowlist");
    const now = Date.now();
    const found = this.deps.findCards();
    this.cardCount = found.length;
    const undecided = new Set<string>();
    const fresh: VideoMeta[] = []; // новые в порядке страницы: сначала проверка кэша, потом очередь
    for (const card of found) {
      const meta = this.deps.extract(card);
      if (!meta) {
        this.place(card, true); // карточка без id (реклама, плейсхолдер) не оценивается и не должна пропадать
        continue;
      }
      this.place(card, this.visible(meta.videoId), this.instant.has(meta.videoId));
      if (this.shown.has(card)) this.instant.delete(meta.videoId);
      if (!this.decisions.has(meta.videoId) && !this.terminal.has(meta.videoId)) {
        const f0 = this.fails.get(meta.videoId);
        if (!(f0 && (f0.count > RETRY_DELAYS_MS.length || f0.retryAt > now))) undecided.add(meta.videoId);
      }
      if (!enqueue || this.decisions.has(meta.videoId)) continue;
      if (this.terminal.has(meta.videoId) || this.queued.has(meta.videoId)) continue;
      const f = this.fails.get(meta.videoId);
      if (f && (f.count > RETRY_DELAYS_MS.length || f.retryAt > now)) continue;
      this.queued.add(meta.videoId);
      fresh.push(meta);
    }
    this.waiting = undecided.size;
    if (fresh.length > 0) this.enqueue(fresh);
    this.pump();
  }

  /** Новые видео: через пакетную проверку кэша, если она доступна; иначе сразу в очередь платных запросов. */
  private enqueue(fresh: VideoMeta[]): void {
    if (!this.deps.peek) {
      this.queue.push(...fresh);
      return;
    }
    const entries: Pending[] = fresh.map((meta) => ({ meta, state: "peeking" }));
    this.ordered.push(...entries);
    for (let i = 0; i < entries.length; i += PEEK_CHUNK) void this.peekBatch(entries.slice(i, i + PEEK_CHUNK), this.generation);
  }

  /** Выпуск промахов в платную очередь строго в порядке обнаружения: пока более ранняя запись ждёт peek, поздние ждут её (дедлайн peek ограничивает ожидание). */
  private release(): void {
    while (this.ordered.length > 0 && this.ordered[0]!.state !== "peeking") {
      const e = this.ordered.shift()!;
      if (e.state === "miss") this.queue.push(e.meta);
    }
  }

  private async peekBatch(entries: Pending[], gen: number): Promise<void> {
    const metas = entries.map((e) => e.meta);
    const res = await this.withDeadline(() => this.deps.peek!({ type: "slop/peek", videos: metas, tags: this.tags }), PEEK_TIMEOUT_MS);
    this.syncContext(); // ответ другого контекста не применяется (поколение сброшено)
    if (gen !== this.generation) return;
    if (isRecord(res) && res.ok === false && res.error === "no_key") {
      this.noKey();
    } else if (isRecord(res) && res.ok === true && isRecord(res.decisions)) {
      const decisions = res.decisions as Record<string, unknown>;
      for (const e of entries) {
        const id = e.meta.videoId;
        const d = Object.prototype.hasOwnProperty.call(decisions, id) ? decisions[id] : undefined;
        if (this.applyDecision(id, d)) {
          this.queued.delete(id);
          this.instant.add(id); // хит применяется сразу, не дожидаясь прочих пакетов
          e.state = "done";
        } else {
          e.state = "miss"; // промах кэша или неразборчивый элемент
        }
      }
    } else {
      for (const e of entries) e.state = "miss"; // fail-open: как без peek, порядок сохраняется
    }
    this.release();
    this.scan();
    this.pump();
  }

  private applyDecision(videoId: string, res: unknown): boolean {
    if (isRecord(res) && res.ok === true && typeof res.hide === "boolean" && Array.isArray(res.matchedTagIds)) {
      this.decisions.set(videoId, { hide: res.hide, matched: res.matchedTagIds.length > 0 });
      return true;
    }
    return false;
  }

  private noKey(): void {
    this.keyMissing = true; // режим неактивен для всей страницы до смены настроек
    this.active = false;
    this.queue = [];
    this.ordered = [];
    this.queued.clear();
  }

  private pump(): void {
    this.syncContext();
    while (this.active && this.running < MAX_PARALLEL && this.queue.length > 0) {
      this.syncContext(); // прямо перед отправкой
      if (!this.active) break;
      const meta = this.queue.shift()!;
      this.running++;
      void this.run(meta, this.generation);
    }
  }

  /** Результат с дедлайном: значение либо "threw" (исключение / просрочка). */
  private async withDeadline<T>(start: () => Promise<T>, ms: number): Promise<T | "threw"> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"threw">((resolve) => {
      t = setTimeout(() => resolve("threw"), ms);
    });
    let started: Promise<T>;
    try {
      started = start(); // синхронно: порядок и момент отправки не меняются
    } catch {
      started = Promise.reject(new Error("threw"));
    }
    try {
      return await Promise.race([started.catch((): "threw" => "threw"), deadline]);
    } catch {
      return "threw";
    } finally {
      clearTimeout(t);
    }
  }

  /** Отправка с дедлайном; результат: ответ, либо "threw" (исключение / просрочка). */
  private attempt(meta: VideoMeta): Promise<DecideResponse | "threw"> {
    return this.withDeadline(() => this.deps.send({ type: "slop/decide", video: meta, tags: this.tags }), ATTEMPT_TIMEOUT_MS);
  }

  private async run(meta: VideoMeta, gen: number): Promise<void> {
    const res = await this.attempt(meta);
    this.running--;
    this.syncContext(); // ответ, полученный на другом контексте, не применяется (поколение сброшено)
    if (gen === this.generation) {
      this.queued.delete(meta.videoId);
      if (res === "threw") {
        this.retryLater(meta.videoId, gen);
      } else if (this.applyDecision(meta.videoId, res)) {
        // решение применено
      } else if (isRecord(res) && res.ok === false && res.error === "no_key") {
        this.noKey();
      } else if (isRecord(res) && res.ok === false && (res.error === "network" || res.error === "rate_limited")) {
        this.retryLater(meta.videoId, gen);
      } else {
        this.terminal.add(meta.videoId); // bad_response и неразборчивый ответ
      }
      this.scan();
    }
    this.pump();
  }

  /** Не более RETRY_DELAYS_MS.length повторов: за жизнь страницы при неизменных тегах — не более 1+N отправок. */
  private retryLater(videoId: string, gen: number): void {
    const count = (this.fails.get(videoId)?.count ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[count - 1];
    this.fails.set(videoId, { count, retryAt: delay === undefined ? Infinity : Date.now() + delay });
    if (delay === undefined) {
      this.terminal.add(videoId); // повторы исчерпаны: fail-open (в allowlist карточка показывается)
      return;
    }
    setTimeout(() => {
      if (gen === this.generation) this.scan();
    }, delay);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
