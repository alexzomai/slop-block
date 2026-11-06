import type { DecideRequest, DecideResponse, SmartTag, VideoMeta } from "../shared/decision";
import { effectiveState, type Mode, type Settings } from "../shared/settings";

export interface FilterDeps<C> {
  findCards(): C[];
  extract(card: C): VideoMeta | null;
  /** blocklist: обратимо скрыть / вернуть карточку. */
  hide(card: C): void;
  show(card: C): void;
  /** allowlist: разрешить (проявить) / снова запретить карточку; по умолчанию скрытие делает CSS-шлюз. */
  allow?(card: C): void;
  disallow?(card: C): void;
  /** Взвести/снять CSS-шлюз (единый предохранитель allowlist). */
  setGate?(on: boolean): void;
  send(req: DecideRequest): Promise<DecideResponse>;
  /** После каждого прохода scan() (для автодогрузки ленты). Исключения глушатся. */
  onSettled?(): void;
}

export interface Context { onSubscriptions: boolean }

export const DEBOUNCE_MS = 300;
export const MAX_PARALLEL = 3;
/** Дедлайн одной попытки: просрочка = временный сбой (как исключение sendMessage). */
export const ATTEMPT_TIMEOUT_MS = 20_000;
/** Задержки повторов после временного сбоя (network / rate_limited / исключение sendMessage / дедлайн): N = 2. */
export const RETRY_DELAYS_MS = [30_000, 120_000] as const;

interface Decision { hide: boolean; matched: boolean }

/** Логика фильтра без привязки к DOM: дедупликация, очередь, fail-open, обратимое скрытие/проявление. */
export class FeedFilter<C> {
  private tags: SmartTag[] = [];
  private mode: Mode = "allowlist";
  private active = false;
  private keyMissing = false;
  private lastSettings = "";
  private ctx: Context = { onSubscriptions: false };
  private decisions = new Map<string, Decision>(); // videoId → решение
  private queued = new Set<string>(); // в очереди или в полёте
  private queue: VideoMeta[] = [];
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
    this.configure(settings, ctx);
  }

  /** Запланировать проход с дебаунсом. */
  schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scan();
    }, DEBOUNCE_MS);
  }

  updateSettings(settings: Settings): void {
    this.reconfigure(settings, this.ctx);
  }

  /** Единая точка входа для смены настроек / страницы. Состояние применяется сразу, без таймеров и запросов. */
  reconfigure(settings: Settings, ctx: Context): void {
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
      this.queue = [];
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

  private place(card: C, visible: boolean): void {
    if (this.mode === "blocklist") {
      if (!visible && !this.hidden.has(card)) {
        this.deps.hide(card);
        this.hidden.add(card);
      } else if (visible && this.hidden.has(card)) {
        this.deps.show(card);
        this.hidden.delete(card);
      }
    } else if (visible && !this.shown.has(card)) {
      this.deps.allow?.(card);
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
    for (const card of found) {
      const meta = this.deps.extract(card);
      if (!meta) {
        this.place(card, true); // карточка без id (реклама, плейсхолдер) не оценивается и не должна пропадать
        continue;
      }
      this.place(card, this.visible(meta.videoId));
      if (!this.decisions.has(meta.videoId) && !this.terminal.has(meta.videoId)) {
        const f0 = this.fails.get(meta.videoId);
        if (!(f0 && (f0.count > RETRY_DELAYS_MS.length || f0.retryAt > now))) undecided.add(meta.videoId);
      }
      if (!enqueue || this.decisions.has(meta.videoId)) continue;
      if (this.terminal.has(meta.videoId) || this.queued.has(meta.videoId)) continue;
      const f = this.fails.get(meta.videoId);
      if (f && (f.count > RETRY_DELAYS_MS.length || f.retryAt > now)) continue;
      this.queued.add(meta.videoId);
      this.queue.push(meta);
    }
    this.waiting = undecided.size;
    this.pump();
  }

  private pump(): void {
    while (this.active && this.running < MAX_PARALLEL && this.queue.length > 0) {
      const meta = this.queue.shift()!;
      this.running++;
      void this.run(meta, this.generation);
    }
  }

  /** Отправка с дедлайном; результат: ответ, либо "threw" (исключение / просрочка). */
  private async attempt(meta: VideoMeta): Promise<DecideResponse | "threw"> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"threw">((resolve) => {
      t = setTimeout(() => resolve("threw"), ATTEMPT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        this.deps.send({ type: "slop/decide", video: meta, tags: this.tags }).catch((): "threw" => "threw"),
        deadline,
      ]);
    } catch {
      return "threw";
    } finally {
      clearTimeout(t);
    }
  }

  private async run(meta: VideoMeta, gen: number): Promise<void> {
    const res = await this.attempt(meta);
    this.running--;
    if (gen === this.generation) {
      this.queued.delete(meta.videoId);
      if (res === "threw") {
        this.retryLater(meta.videoId, gen);
      } else if (isRecord(res) && res.ok === true && typeof res.hide === "boolean" && Array.isArray(res.matchedTagIds)) {
        this.decisions.set(meta.videoId, { hide: res.hide, matched: res.matchedTagIds.length > 0 });
      } else if (isRecord(res) && res.ok === false && res.error === "no_key") {
        this.keyMissing = true; // режим неактивен для всей страницы до смены настроек
        this.active = false;
        this.queue = [];
        this.queued.clear();
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
