import type { ProviderId } from "./providers";
import { getKeyWithGen } from "./settings";
import type { KV } from "./storage";

/** Отметка по провайдеру в отдельном ключе хранилища: параллельные операции разных провайдеров не затирают друг друга. */
export const rejectedStorage = (p: ProviderId): string => `keyRejected.${p}`;

/** Необратимый отпечаток ключа (SHA-256, hex). Сам ключ в новом месте не хранится. */
export async function fingerprint(key: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

const LEGACY_STORAGE = "keyRejected";

interface Record_ { fp: string; gen: string }

/**
 * Память об отклонённых ключах. Запись {отпечаток, поколение сохранения} действует, только пока совпадают и отпечаток
 * текущего ключа, и текущее поколение (setKey/removeKey меняют его при КАЖДОМ сохранении, даже того же значения).
 * Поэтому повторное сохранение ключа снимает отказ, а запоздалый ответ старого запроса (другой ключ или прежнее
 * поколение) ничего не помечает и не затирает.
 */
export function createRejections(kv: KV) {
  const locks = new Map<ProviderId, Promise<void>>();
  const read = async (p: ProviderId): Promise<Record_ | undefined> => {
    const v = (await kv.get(rejectedStorage(p)))[rejectedStorage(p)] as Partial<Record_> | undefined;
    return v && typeof v.fp === "string" && typeof v.gen === "string" ? { fp: v.fp, gen: v.gen } : undefined;
  };
  return {
    /** gen — из того же снимка, что и key. */
    async has(provider: ProviderId, key: string, gen: string): Promise<boolean> {
      const rec = await read(provider);
      return !!rec && rec.gen === gen && rec.fp === (await fingerprint(key));
    },
    /**
     * key и gen — согласованный снимок (одно чтение), снятый ДО запроса. Все mark провайдера идут по очереди (замок);
     * под замком ключ и поколение перечитываются одним get и запись делается только при совпадении обоих.
     * Запись, чьё поколение равно текущему, не перезаписывается. Старый mark, начатый до setKey, завершается
     * до начала более позднего mark того же провайдера, поэтому не может затереть отказ нового поколения.
     */
    mark(provider: ProviderId, key: string, gen: string): Promise<void> {
      const run = async (): Promise<void> => {
        const fp = await fingerprint(key);
        const name = rejectedStorage(provider);
        const cur = await getKeyWithGen(kv, provider);
        if (cur.gen !== gen || cur.key !== key) return;
        const rec = (await kv.get(name))[name] as Partial<Record_> | undefined;
        if (rec && rec.gen === cur.gen) return; // уже помечено в этом поколении
        await kv.set({ [name]: { fp, gen } });
      };
      const next = (locks.get(provider) ?? Promise.resolve()).then(run, run);
      locks.set(provider, next.catch(() => undefined));
      return next;
    },
    /** Удаляет устаревший общий ключ keyRejected (формат, никогда не выпускавшийся); без переноса. */
    async purgeLegacy(): Promise<void> {
      await kv.remove(LEGACY_STORAGE);
    },
  };
}
