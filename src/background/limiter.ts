export class LimiterFullError extends Error {
  constructor() {
    super("queue full");
  }
}

export interface LimiterOptions {
  maxConcurrent: number;
  perMinute: number;
  maxQueue: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

interface Job { fn: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }

export function createLimiter(o: LimiterOptions) {
  const queue: Job[] = [];
  const stamps: number[] = [];
  let active = 0;
  let waiting = false;

  function pump(): void {
    while (queue.length && active < o.maxConcurrent) {
      const t = o.now();
      while (stamps.length && t - stamps[0]! > 60_000) stamps.shift();
      if (stamps.length >= o.perMinute) {
        if (!waiting) {
          waiting = true;
          void o.sleep(60_001 - (t - stamps[0]!)).then(() => {
            waiting = false;
            pump();
          });
        }
        return;
      }
      const job = queue.shift()!;
      stamps.push(t);
      active++;
      job.fn().then(job.resolve, job.reject).finally(() => {
        active--;
        pump();
      });
    }
  }

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      if (queue.length >= o.maxQueue) return Promise.reject(new LimiterFullError());
      return new Promise<T>((resolve, reject) => {
        queue.push({ fn, resolve: resolve as (v: unknown) => void, reject });
        pump();
      });
    },
  };
}
