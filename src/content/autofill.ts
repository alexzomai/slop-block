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
}

/** Не более MAX_EMPTY подгрузок подряд без роста видимых карточек. */
export const MAX_EMPTY = 5;
/** Не более MAX_TOTAL подгрузок за один заход на страницу. */
export const MAX_TOTAL = 15;
/** Порция, не появившаяся за это время, считается пустой. */
export const LOAD_TIMEOUT_MS = 4000;

interface Loading { cardsAtTrigger: number; visibleAtTrigger: number; startedAt: number }

export class Autofill {
  private total = 0;
  private emptyStreak = 0;
  private loading: Loading | null = null;
  private stopped: "limit" | "end" | "error" | "unsafe" | null = null;
  private key: string | undefined;

  constructor(private deps: AutofillDeps) {}

  /** Сброс бюджета только при реальной смене ключа (настройки + путь), а не на каждый reconfigure. */
  resetIfChanged(key: string): void {
    if (key === this.key) return;
    this.key = key;
    this.total = 0;
    this.emptyStreak = 0;
    this.loading = null;
    this.stopped = null;
    this.deps.indicator("off");
  }

  /** Триггер обнаружил нарушение геометрии уже после применения (при снятии): остановка до навигации/смены настроек. */
  markUnsafe(): void {
    this.stopped = "unsafe";
    this.loading = null;
    this.evaluate();
  }

  evaluate(): void {
    try {
      this.step();
    } catch {
      this.stopped = "error"; // сбой DOM-адаптера: страница работает как без автодогрузки
      this.loading = null;
      this.deps.indicator("off");
    }
  }

  private step(): void {
    const d = this.deps;
    if (this.stopped === "error") return;
    const s = d.snapshot();
    if (!s.eligible) {
      this.loading = null;
      d.indicator("off");
      return;
    }
    if (this.stopped === "unsafe") return d.indicator("unsafe");
    if (this.stopped === "limit") return d.indicator("exhausted");
    if (this.stopped === "end") return d.indicator("off");

    if (this.loading) {
      const l = this.loading;
      const arrived = s.cards > l.cardsAtTrigger;
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
      this.stopped = "end";
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
    this.loading = { cardsAtTrigger: s.cards, visibleAtTrigger: s.visible, startedAt: d.now() };
    if (d.trigger() === "unsafe") {
      this.stopped = "unsafe";
      this.loading = null;
      d.indicator("unsafe");
      return;
    }
    d.wake(LOAD_TIMEOUT_MS);
  }
}
