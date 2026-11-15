// Автодогрузка ленты в allowlist. Чистая логика без DOM; все побочные эффекты — через deps.
// Главное свойство: число подгрузок за заход конечно (MAX_TOTAL), пустых подряд — MAX_EMPTY,
// а следующая подгрузка не начинается, пока по текущей порции не пришли все решения.

/**
 * Что показывает индикатор: off — скрыт; searching — ищем; done — цель достигнута; exhausted — остановка (кнопка «искать дальше»);
 * end — лента кончилась (нет continuation); unsafe — триггер небезопасен; error — фильтр не работает (fail-open).
 */
export type Indicator = "off" | "searching" | "done" | "exhausted" | "end" | "unsafe" | "error";
/** Причина, по которой фильтр не работает на странице (только для отображения). */
export type Failure = "no_key" | "rate_limited" | "network" | "bad_response" | "no_credits" | "access_denied";
export type StopReason = "empty" | "total" | "stall" | "ceiling";

/** Данные для текста индикатора (только числа и коды; тексты YouTube сюда не попадают). */
export interface IndicatorInfo {
  /** Подходящих видео сейчас. */
  found: number;
  target: number;
  /** Проверено решений (найдено карточек минус ожидающие). */
  checked: number;
  /** Причина текущей остановки (для exhausted). */
  reason: StopReason | null;
  /** Карточек, пришедших после последнего роста подходящих; 0 — порции не приходят. */
  sinceGrowth: number;
  failure: Failure | null;
}

export interface Snapshot {
  /** Фильтр активен и режим allowlist. */
  eligible: boolean;
  target: number;
  /** Видимые (разрешённые) карточки. */
  visible: number;
  /** Все найденные карточки (для обнаружения новой порции). */
  cards: number;
  /** Карточки в очереди или в полёте (решения не пришли). */
  pending: number;
  /** Низ последней видимой карточки ≥ innerHeight + запас. */
  filled: boolean;
  hasContinuation: boolean;
  /** Фильтр не работает (нет ключа / сбои провайдера): индикатор показывает ошибку, логика автодогрузки не меняется. */
  failure?: Failure | null;
}

export interface AutofillDeps {
  snapshot(): Snapshot;
  /** Инициировать подгрузку. "unsafe": триггер не смог сохранить геометрию страницы и откатился (до навигации не повторяется). */
  trigger(): "ok" | "unsafe";
  indicator(state: Indicator, info: IndicatorInfo): void;
  now(): number;
  /** Запросить повторный evaluate() через ms (только пробуждение, решения не принимает). */
  wake(ms: number): void;
  /**
   * Удержание continuation вне окна: пока включено, YouTube не может подгружать порции цепочкой сам
   * (скрытые шлюзом карточки места не занимают, и новый continuation сразу оказывается в окне).
   */
  hold?(on: boolean): void;
  /** Число карточек в DOM прямо сейчас (без дебаунса сканирования): для синхронного возврата удержания. */
  liveCards?(): number;
  /** Отладочное состояние ("<индикатор>/<причина>") и счётчики для атрибута на корневом элементе; без ключей и заголовков. */
  debug?(state: string, info: string): void;
}

/** Жест пользователя возобновляет остановку по лимиту не чаще этого интервала. */
export const INTENT_COOLDOWN_MS = 10_000;

/** Не более MAX_EMPTY подгрузок подряд без роста видимых карточек. */
export const MAX_EMPTY = 5;
/** Не более MAX_TOTAL подгрузок за один заход на страницу. */
export const MAX_TOTAL = 15;
/** Порция, не появившаяся за это время, считается пустой. */
export const LOAD_TIMEOUT_MS = 4000;
/** Решения по порции не пришли за это время — остановка с возможностью «загрузить ещё». */
export const STALL_MS = 30_000;
/** Общий потолок непрерывного «ищу» без роста видимых карточек: что бы ни ждали — остановка с кнопкой «загрузить ещё». */
export const SEARCH_CEILING_MS = 60_000;
/** Нет continuation дольше этого — «конец ленты» (YouTube убирает continuation между порциями, это не конец). Только отображение. */
export const END_GRACE_MS = 2000;

/**
 * Повтор триггера, пока порция не пришла (в пределах одной порции, до LOAD_TIMEOUT_MS): через RETRIGGER_MS после начала и
 * ещё раз столько же спустя. Платных запросов повтор не создаёт (нет новых карточек); число порций ограничено MAX_TOTAL,
 * поэтому повторов за заход не больше MAX_RETRIGGER × MAX_TOTAL.
 */
export const RETRIGGER_MS = 1300;
export const MAX_RETRIGGER = 2;

interface Loading { cardsAtTrigger: number; visibleAtTrigger: number; startedAt: number; arrived: boolean; retries: number }

export class Autofill {
  private total = 0;
  private emptyStreak = 0;
  private loading: Loading | null = null;
  private stopped: "limit" | "error" | "unsafe" | null = null;
  private key: string | undefined;
  private last: Snapshot | undefined;
  private lastIntent = -Infinity;
  /** Карточки/видимые на предыдущем проходе: рост без нашего триггера — порция, начатая YouTube до удержания. */
  private seenCards: number | undefined;
  /** Когда начали ждать решения по загруженным карточкам (индикатор «ищу» без продвижения не должен висеть вечно). */
  private waitSince: number | undefined;
  /** Текущая остановка — по зависанию решений, а не по лимиту порций. */
  private stallStop = false;
  /** Причина текущей остановки (для отладки и кулдауна жеста): empty/total — лимиты стоимости, stall/ceiling — зависание. */
  private stopReason: StopReason | null = null;
  /** Только для индикатора: число карточек в момент последнего роста видимых и начало периода без continuation. */
  private cardsAtProgress = 0;
  private noContSince: number | undefined;
  /** Последнее логическое состояние, переданное в show(): на паузе «нет continuation» поиск не должен пропадать. */
  private lastLogical: Indicator = "off";
  private endWakeAt: number | undefined;
  /** Начало непрерывного «ищу» (сдвигается ростом видимых) и момент, на который уже запрошено пробуждение к потолку. */
  private searchSince: number | undefined;
  private ceilWakeAt: number | undefined;
  /** Момент ближайшего запрошенного пробуждения по порции (не дублировать wake на каждый проход). */
  private portionWakeAt: number | undefined;
  private progressVisible = 0;
  /** Явная просьба пользователя: один триггер даже при неполученных решениях. */
  private force = false;

  constructor(private deps: AutofillDeps) {}

  /** Сброс бюджета только при реальной смене ключа (настройки + путь), а не на каждый reconfigure. */
  resetIfChanged(key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.total = 0;
    this.emptyStreak = 0;
    this.loading = null;
    this.stopped = null;
    this.waitSince = undefined;
    this.searchSince = undefined;
    this.ceilWakeAt = undefined;
    this.portionWakeAt = undefined;
    this.progressVisible = 0;
    this.cardsAtProgress = 0;
    this.noContSince = undefined;
    this.endWakeAt = undefined;
    this.stopReason = null;
    this.force = false;
    this.seenCards = this.deps.liveCards?.() || undefined;
    this.last = undefined; // удержание пересчитает ближайший evaluate() (reconfigure → scan → onSettled)
    this.show("off", "reset");
  }

  /** Триггер обнаружил нарушение геометрии уже после применения (при снятии): остановка до навигации/смены настроек. */
  markUnsafe(): void {
    this.stopped = "unsafe";
    this.loading = null;
    this.evaluate();
  }

  /** Жест пользователя (колесо, касание, клавиши): после остановки по лимиту выдаёт новый бюджет, не чаще INTENT_COOLDOWN_MS. */
  userIntent(): void {
    if (this.stopped !== "limit") return;
    // кулдаун только у лимитов стоимости; после зависания (stall/ceiling) жест возобновляет сразу
    const cost = this.stopReason === "empty" || this.stopReason === "total";
    if (cost && this.deps.now() - this.lastIntent < INTENT_COOLDOWN_MS) return;
    this.resume();
  }

  /**
   * Явная просьба «загрузить ещё» (кнопка в индикаторе): тот же новый ограниченный бюджет без интервала ожидания.
   * Нужна там, где жест прокрутки невозможен (документ короче окна: нет прокрутки, а на тач-экране нет и touchmove).
   */
  loadMore(): void {
    if (this.stopped === "limit") this.resume();
  }

  private resume(): void {
    this.lastIntent = this.deps.now();
    this.stopped = null;
    this.total = 0;
    this.emptyStreak = 0;
    this.loading = null;
    this.waitSince = undefined;
    this.stallStop = false;
    this.stopReason = null;
    this.searchSince = undefined;
    this.ceilWakeAt = undefined;
    this.portionWakeAt = undefined;
    this.progressVisible = this.last?.visible ?? 0;
    this.cardsAtProgress = this.last?.cards ?? 0;
    this.force = true; // решения могут висеть (причина остановки) — явная просьба всё равно запускает загрузку
    this.evaluate();
  }

  /** Исходное число карточек в момент подключения наблюдателя (до окна дебаунса): всё, что придёт сверх, — порции в бюджет. */
  observe(): void {
    const n = this.deps.liveCards?.() ?? 0;
    if (n > 0 && this.seenCards === undefined) this.seenCards = n;
  }

  /**
   * Изменение DOM (синхронно, до первого кадра). Каждый рост числа карточек — фактическая порция в оба бюджета, кто бы её
   * ни запустил: наш триггер (закрывает открытую загрузку) или YouTube (нативная: total++, пустая серия не короче 1,
   * пока решения не покажут рост видимых). Затем удержание возвращается по актуальному состоянию.
   */
  onDomChange(): void {
    try {
      const live = this.deps.liveCards?.();
      if (live !== undefined) {
        if (this.seenCards === undefined) {
          if (live > 0) this.seenCards = live;
        } else if (live > this.seenCards) {
          const prev = this.seenCards;
          this.seenCards = live;
          const l = this.loading;
          if (l && !l.arrived) {
            if (live > l.cardsAtTrigger) l.arrived = true;
          } else if (this.stopped === null) {
            this.total++;
            if (l) this.emptyStreak++; // ещё одна порция, пока решения по прежней не пришли: считаем пустой, рост видимых обнулит серию
            else this.loading = { cardsAtTrigger: prev, visibleAtTrigger: this.last?.visible ?? 0, startedAt: this.deps.now(), arrived: true, retries: 0 };
          }
        }
      }
      if (!this.last) {
        // до первого evaluate(): шлюз allowlist уже взведён, скрытые карточки места не занимают, YouTube начал бы цепочку.
        // Не allowlist — CSS без шлюза не действует, evaluate() всё уточнит.
        this.deps.hold?.(true);
        return;
      }
      this.applyHold();
    } catch {
      this.deps.hold?.(false);
    }
  }

  evaluate(): void {
    try {
      this.step();
      this.applyHold();
    } catch {
      this.stopped = "error"; // сбой DOM-адаптера: страница работает как без автодогрузки
      this.loading = null;
      this.deps.hold?.(false);
      this.show("off", "error");
    }
  }

  /** Индикатор + отладочное состояние + учёт непрерывного «ищу». */
  private show(state: Indicator, reason: string): void {
    const d = this.deps;
    this.lastLogical = state;
    const s0 = this.last;
    // сбой фильтра перекрывает показ (но не логику): лента при этом открыта, а пользователю надо знать почему
    // (остановка по зависанию решений остаётся остановкой: у неё есть кнопка «искать дальше», а причина — «проверка не отвечает»)
    const keep = state === "unsafe" || (state === "exhausted" && this.stopReason === "stall");
    const shown: Indicator = s0?.failure && !keep ? "error" : state;
    d.indicator(shown, {
      found: s0?.visible ?? 0,
      target: s0?.target ?? 0,
      checked: s0 ? Math.max(0, s0.cards - s0.pending) : 0,
      reason: state === "exhausted" ? this.stopReason : null,
      sinceGrowth: s0 ? Math.max(0, s0.cards - this.cardsAtProgress) : 0,
      failure: s0?.failure ?? null,
    });
    if (state === "searching") this.searchSince ??= d.now();
    else {
      this.searchSince = undefined;
      this.ceilWakeAt = undefined;
    }
    const s = this.last;
    d.debug?.(`${state}/${reason}`, s ? `cards=${s.cards} visible=${s.visible} pending=${s.pending} total=${this.total} empty=${this.emptyStreak} hold=${this.holdOn ? 1 : 0} cont=${s.hasContinuation ? 1 : 0}` : "");
  }
  private holdOn = false;

  /** Держим, пока автодогрузка активна, цель не достигнута, порция не ожидается и нет continuation-конца/unsafe/ошибки. */
  private applyHold(): void {
    const s = this.last;
    const open = this.loading !== null && !this.loading.arrived;
    const reached = !!s && s.visible >= s.target && s.filled;
    const on = !!s && s.eligible && s.hasContinuation && !reached && !open && (this.stopped === null || this.stopped === "limit");
    this.holdOn = on;
    this.deps.hold?.(on);
  }

  private step(): void {
    const d = this.deps;
    if (this.stopped === "error") return;
    const s = d.snapshot();
    this.last = s;
    if (s.hasContinuation) {
      this.noContSince = undefined;
      this.endWakeAt = undefined;
    }
    if (s.pending === 0) {
      this.waitSince = undefined;
      // остановка по зависанию — не лимит стоимости: решения всё же пришли, работаем дальше в прежнем бюджете
      if (this.stallStop && this.stopped === "limit") this.stopped = null;
      this.stallStop = false;
    }
    if (s.visible > this.progressVisible) {
      // рост видимых — решения идут: потолки ожидания отсчитываются заново
      if (this.searchSince !== undefined) this.searchSince = d.now();
      if (this.waitSince !== undefined) this.waitSince = d.now();
      this.cardsAtProgress = s.cards;
    }
    // Высшая отметка, а не последнее значение: мерцание счёта (страница перерисовала карточки, отметки вернутся
    // на следующем проходе) не должно выглядеть «ростом» и сдвигать потолки.
    this.progressVisible = Math.max(this.progressVisible, s.visible);
    if (!s.eligible) {
      this.loading = null;
      this.show("off", "not-eligible");
      return;
    }
    if (this.stopped === "unsafe") return this.show("unsafe", "geometry");
    if (this.stopped === "limit") return this.show("exhausted", this.stopReason ?? "limit");
    if (this.searchSince !== undefined) {
      const left = SEARCH_CEILING_MS - (d.now() - this.searchSince);
      if (left <= 0) {
        // потолок: непрерывное «ищу» без роста видимых — что бы ни ждали, останавливаемся (кнопка «загрузить ещё»)
        this.stopped = "limit";
        this.stopReason = "ceiling";
        this.stallStop = false;
        this.waitSince = undefined;
        return this.show("exhausted", "ceiling");
      }
      if (this.ceilWakeAt === undefined || this.ceilWakeAt <= d.now()) {
        this.ceilWakeAt = d.now() + left;
        d.wake(left);
      }
    }

    if (this.loading) {
      const l = this.loading;
      const arrived = l.arrived || s.cards > l.cardsAtTrigger;
      l.arrived = arrived;
      if (!arrived) {
        const el = d.now() - l.startedAt;
        if (el < LOAD_TIMEOUT_MS) {
          // Порция не пришла: YouTube мог не заметить вход continuation (IntersectionObserver) — повторяем триггер,
          // прежде чем считать порцию пустой. Без изменений DOM evaluate() сам не вызовется, поэтому всегда будим себя
          // на ближайшую границу (следующий повтор или таймаут порции).
          if (l.retries < MAX_RETRIGGER && el >= (l.retries + 1) * RETRIGGER_MS) {
            l.retries++;
            if (this.fire() === "unsafe") return;
          }
          const next = l.retries < MAX_RETRIGGER ? Math.min(LOAD_TIMEOUT_MS, (l.retries + 1) * RETRIGGER_MS) : LOAD_TIMEOUT_MS;
          this.wakeOnce(next - el);
          this.show("searching", "waiting-portion");
          return;
        }
        this.emptyStreak++; // порция не пришла
      } else if (s.pending > 0) {
        if (this.stalled(s)) return;
        this.show("searching", "decisions"); // ждём решений по порции
        return;
      } else if (s.visible > l.visibleAtTrigger) {
        this.emptyStreak = 0;
      } else {
        this.emptyStreak++;
      }
      this.loading = null;
    }

    if (s.visible >= s.target && s.filled) {
      this.emptyStreak = 0;
      this.show("done", "reached");
      return;
    }
    if (!s.hasContinuation) {
      // Не липко: continuation ещё не отрисован при первом проходе (карточек 0) и пропадает между порциями у YouTube.
      // Пока его нет, подгрузки нет; появился — работаем в пределах прежних лимитов.
      // Для индикатора: «конец ленты» только если continuation нет не меньше END_GRACE_MS (иначе мерцание между порциями).
      this.noContSince ??= d.now();
      const left = END_GRACE_MS - (d.now() - this.noContSince);
      if (s.cards > 0 && left <= 0) return this.show("end", "no-continuation");
      if (s.cards > 0 && (this.endWakeAt === undefined || this.endWakeAt <= d.now())) {
        this.endWakeAt = d.now() + left;
        d.wake(left);
      }
      // на паузе индикатор сохраняется (иначе поиск мигает: searching → скрыт → searching), начальная страница без него остаётся без него
      this.show(this.lastLogical === "searching" ? "searching" : "off", "no-continuation");
      return;
    }
    if (this.emptyStreak >= MAX_EMPTY || this.total >= MAX_TOTAL) {
      this.stopped = "limit";
      this.stopReason = this.emptyStreak >= MAX_EMPTY ? "empty" : "total";
      this.show("exhausted", this.stopReason);
      return;
    }
    if (s.pending > 0 && !this.force) {
      if (this.stalled(s)) return;
      this.show("searching", "decisions");
      return; // решения по уже загруженным карточкам ещё идут
    }
    this.force = false;
    this.waitSince = undefined;
    this.show("searching", "triggered");
    this.total++;
    this.loading = { cardsAtTrigger: s.cards, visibleAtTrigger: s.visible, startedAt: d.now(), arrived: false, retries: 0 };
    if (this.fire() === "unsafe") return;
    this.wakeOnce(RETRIGGER_MS);
  }

  /** Один вход continuation в зону видимости. "unsafe" — остановка до навигации (индикатор уже показан). */
  private fire(): "ok" | "unsafe" {
    const d = this.deps;
    d.hold?.(false); // синхронно до триггера: reenter меряет геометрию уже без удержания
    if (d.trigger() === "unsafe") {
      this.stopped = "unsafe";
      this.loading = null;
      this.show("unsafe", "geometry");
      return "unsafe";
    }
    return "ok";
  }

  /** Пробуждение через ms; уже запрошенное, не позднее нужного, не дублируется. */
  private wakeOnce(ms: number): void {
    const d = this.deps;
    const at = d.now() + ms;
    if (this.portionWakeAt !== undefined && this.portionWakeAt > d.now() && this.portionWakeAt <= at) return;
    this.portionWakeAt = at;
    d.wake(ms);
  }

  /**
   * Решения по загруженным карточкам не приходят дольше STALL_MS: остановка как по лимиту (индикатор с кнопкой
   * «загрузить ещё»), а не вечное «ищу». Таймер пробуждения ставится при начале ожидания.
   */
  private stalled(s: Snapshot): boolean {
    const d = this.deps;
    if (this.waitSince === undefined) {
      this.waitSince = d.now();
      d.wake(STALL_MS);
      return false;
    }
    if (d.now() - this.waitSince < STALL_MS) return false;
    this.waitSince = undefined;
    this.stopped = "limit";
    this.stallStop = true;
    this.stopReason = "stall";
    // this.loading сохраняется: поздние решения завершат учёт порции (пустая — ровно один раз) в прежнем бюджете
    this.last = s;
    this.show("exhausted", "stall");
    return true;
  }
}
