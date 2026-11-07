import { addTag, removeTag, setEnabled, setFeedTarget, setMode, setFilterSearch, setSkipSubscriptions, toggleTag, type AddError, type Mode, type Settings } from "../shared/settings";

/** Код сообщения (пусто — нет сообщения); текст подбирает UI по языку браузера. */
export type PopupMessage = AddError | "save" | "bad_target" | "";

export interface ControllerDeps {
  save(s: Settings): Promise<void>;
  render(s: Settings, message: PopupMessage): void;
}

/**
 * Состояние popup. Контракт: `current` и рендер меняются только после успешной записи;
 * при отказе записи UI откатывается к `current` (= тому, что в storage) и показывает сообщение.
 * Операции выполняются строго по очереди.
 */
export class PopupController {
  private queue: Promise<void> = Promise.resolve();
  constructor(private deps: ControllerDeps, private current: Settings) {}

  get state(): Settings {
    return this.current;
  }

  init(): void {
    this.deps.render(this.current, "");
  }

  private commit(compute: (s: Settings) => { settings: Settings; error?: AddError | "bad_target" }): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const r = compute(this.current);
      if (r.error) {
        this.deps.render(this.current, r.error);
        return false;
      }
      try {
        await this.deps.save(r.settings);
      } catch {
        this.deps.render(this.current, "save");
        return false;
      }
      this.current = r.settings;
      this.deps.render(this.current, "");
      return true;
    };
    const p = this.queue.then(run);
    this.queue = p.then(() => undefined, () => undefined);
    return p;
  }

  add(text: string): Promise<boolean> {
    return this.commit((s) => addTag(s, text));
  }
  remove(id: string): Promise<boolean> {
    return this.commit((s) => ({ settings: removeTag(s, id) }));
  }
  toggle(id: string): Promise<boolean> {
    return this.commit((s) => ({ settings: toggleTag(s, id) }));
  }
  setEnabled(enabled: boolean): Promise<boolean> {
    return this.commit((s) => ({ settings: setEnabled(s, enabled) }));
  }
  setMode(mode: Mode): Promise<boolean> {
    return this.commit((s) => ({ settings: setMode(s, mode) }));
  }
  setSkipSubscriptions(skip: boolean): Promise<boolean> {
    return this.commit((s) => ({ settings: setSkipSubscriptions(s, skip) }));
  }
  setFilterSearch(on: boolean): Promise<boolean> {
    return this.commit((s) => ({ settings: setFilterSearch(s, on) }));
  }
  setFeedTarget(value: number): Promise<boolean> {
    return this.commit((s) => (Number.isFinite(value) ? { settings: setFeedTarget(s, value) } : { settings: s, error: "bad_target" }));
  }
}
