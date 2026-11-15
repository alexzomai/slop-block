import type { ProviderId } from "./providers";

export type PauseKind = "no_credits" | "access_denied";

/** Базовая пауза и потолок, мс. Удвоение на каждый повторный отказ подряд. */
const LIMITS: Record<PauseKind, { base: number; max: number }> = {
  no_credits: { base: 60_000, max: 600_000 },
  access_denied: { base: 30_000, max: 300_000 },
};

interface State { kind: PauseKind; until: number; step: number; gen: string }

/**
 * Паузы по провайдеру (в памяти service worker): пока пауза не истекла, платные запросы не уходят.
 * Привязана к поколению ключа: сохранение/смена/удаление ключа снимает её. Не блокировка: по истечении уходит пробный запрос.
 */
export function createPauses(now: () => number) {
  const state = new Map<ProviderId, State>();
  return {
    /** Активная пауза для текущего поколения ключа (иначе null). */
    active(p: ProviderId, gen: string): { kind: PauseKind; until: number } | null {
      const s = state.get(p);
      if (!s) return null;
      if (s.gen !== gen) {
        state.delete(p);
        return null;
      }
      return now() < s.until ? { kind: s.kind, until: s.until } : null;
    },
    /** Отказ провайдера: пауза удваивается, пока отказы идут подряд с тем же видом и поколением. */
    hit(p: ProviderId, gen: string, kind: PauseKind): void {
      const prev = state.get(p);
      const step = prev && prev.gen === gen && prev.kind === kind ? prev.step + 1 : 0;
      const l = LIMITS[kind];
      state.set(p, { kind, gen, step, until: now() + Math.min(l.base * 2 ** step, l.max) });
    },
    /** Успех: пауза и шаг backoff сбрасываются, но только паузу того же поколения ключа (поздний ответ старого ключа чужую не снимает). */
    clear(p: ProviderId, gen: string): void {
      if (state.get(p)?.gen === gen) state.delete(p);
    },
    /** Для UI: состояние провайдера с учётом поколения ключа (без истёкших). */
    status(p: ProviderId, gen: string): "ok" | PauseKind {
      return this.active(p, gen)?.kind ?? "ok";
    },
  };
}
export type Pauses = ReturnType<typeof createPauses>;
