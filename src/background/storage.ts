/** Минимальный интерфейс, совместимый с chrome.storage.local (подменяется в тестах). */
export interface KV {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}
