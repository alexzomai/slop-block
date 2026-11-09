// Автодогрузка ленты в allowlist. Чистая логика без DOM; все побочные эффекты — через deps.
// Главное свойство: число подгрузок за заход конечно (MAX_TOTAL), пустых подряд — MAX_EMPTY,
// а следующая подгрузка не начинается, пока по текущей порции не пришли все решения.

export type Indicator = "off" | "searching" | "exhausted" | "unsafe";

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
}

export interface AutofillDeps {
  snapshot(): Snapshot;
  /** Инициировать подгрузку. "unsafe": триггер не смог сохранить геометрию страницы и откатился (до навигации не повторяется). */
  trigger(): "ok" | "unsafe";
  indicator(state: Indicator): void;
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
}

/** Жест пользователя возобновляет остановку по лимиту не чаще этого интервала. */
export const INTENT_COOLDOWN_MS = 10_000;

/** Не более MAX_EMPTY подгрузок подряд без роста видимых карточек. */
export const MAX_EMPTY = 5;
/** Не более MAX_TOTAL подгрузок за один заход на страницу. */
export const MAX_TOTAL = 15;
/** Порция, не появившаяся за это время, считается пустой. */
export const LOAD_TIMEOUT_MS = 4000;

interface Loading { cardsAtTrigger: number; visibleAtTrigger: number; startedAt: number; arrived: boolean }

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

  constructor(private deps: AutofillDeps) {}

  /** Сброс бюджета только при реальной смене ключа (настройки + путь), а не на каждый reconfigure. */
  resetIfChanged(key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.total = 0;
    this.emptyStreak = 0;
    this.loading = null;
    this.stopped = null;
    this.seenCards = this.deps.liveCards?.() || undefined;
    this.last = undefined; // удержание пересчитает ближайший evaluate() (reconfigure → scan → onSettled)
    this.deps.indicator("off");
  }

  /** Триггер обнаружил нарушение геометрии уже после применения (при снятии): остановка до навигации/смены настроек. */
  markUnsafe(): void {
    this.stopped = "unsafe";
    this.loading = null;
    this.evaluate();
  }

  /** Жест пользователя (колесо, касание, клавиши): после остановки по лимиту выдаёт новый бюджет, не чаще INTENT_COOLDOWN_MS. */
  userIntent(): void {
    if (this.stopped !== "limit" || this.deps.now() - this.lastIntent < INTENT_COOLDOWN_MS) return;
    this.lastIntent = this.deps.now();
    this.stopped = null;
    this.total = 0;
    this.emptyStreak = 0;
    this.loading = null;
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
            else this.loading = { cardsAtTrigger: prev, visibleAtTrigger: this.last?.visible ?? 0, startedAt: this.deps.now(), arrived: true };
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
      this.deps.indicator("off");
    }
  }

  /** Держим, пока автодогрузка активна, цель не достигнута, порция не ожидается и нет continuation-конца/unsafe/ошибки. */
  private applyHold(): void {
    const s = this.last;
    const open = this.loading !== null && !this.loading.arrived;
    const reached = !!s && s.visible >= s.target && s.filled;
    const on = !!s && s.eligible && s.hasContinuation && !reached && !open && (this.stopped === null || this.stopped === "limit");
    this.deps.hold?.(on);
  }

  private step(): void {
    const d = this.deps;
    if (this.stopped === "error") return;
    const s = d.snapshot();
    this.last = s;
    if (!s.eligible) {
      this.loading = null;
      d.indicator("off");
      return;
    }
    if (this.stopped === "unsafe") return d.indicator("unsafe");
    if (this.stopped === "limit") return d.indicator("exhausted");

    if (this.loading) {
      const l = this.loading;
      const arrived = l.arrived || s.cards > l.cardsAtTrigger;
      l.arrived = arrived;
      if (!arrived) {
        if (d.now() - l.startedAt < LOAD_TIMEOUT_MS) {
          d.indicator("searching");
          return;
        }
        this.emptyStreak++; // порция не пришла
      } else if (s.pending > 0) {
        d.indicator("searching"); // ждём решений по порции
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
      d.indicator("off");
      return;
    }
    if (!s.hasContinuation) {
      // Не липко: continuation ещё не отрисован при первом проходе (карточек 0) и пропадает между порциями у YouTube.
      // Пока его нет, подгрузки нет; появился — работаем в пределах прежних лимитов.
      d.indicator("off");
      return;
    }
    if (this.emptyStreak >= MAX_EMPTY || this.total >= MAX_TOTAL) {
      this.stopped = "limit";
      d.indicator("exhausted");
      return;
    }
    d.indicator("searching");
    if (s.pending > 0) return; // решения по уже загруженным карточкам ещё идут
    this.total++;
    this.loading = { cardsAtTrigger: s.cards, visibleAtTrigger: s.visible, startedAt: d.now(), arrived: false };
    d.hold?.(false); // синхронно до триггера: reenter меряет геометрию уже без удержания
    if (d.trigger() === "unsafe") {
      this.stopped = "unsafe";
      this.loading = null;
      d.indicator("unsafe");
      return;
    }
    d.wake(LOAD_TIMEOUT_MS);
  }
}
