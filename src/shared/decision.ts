export interface VideoMeta { videoId: string; title: string; channel: string; description?: string }
export interface SmartTag { id: string; text: string }  // text — описание того, что скрывать, на естественном языке
export interface DecideRequest { type: "slop/decide"; video: VideoMeta; tags: SmartTag[] }
export type DecideResponse = { ok: true; hide: boolean; matchedTagIds: string[]; probabilities: Record<string, number> } | { ok: false; error: "no_key" | "rate_limited" | "network" | "bad_response" };

/** Пакетная проверка кэша решений: без сети и платных вызовов. Отсутствующий в `decisions` videoId — промах кэша. */
export interface PeekRequest { type: "slop/peek"; videos: VideoMeta[]; tags: SmartTag[] }
export type DecidedOk = Extract<DecideResponse, { ok: true }>;
export type PeekResponse = { ok: true; decisions: Record<string, DecidedOk> } | { ok: false; error: "no_key" | "bad_response" };
