export interface VideoMeta { videoId: string; title: string; channel: string; description?: string }
export interface SmartTag { id: string; text: string }  // text — описание того, что скрывать, на естественном языке
export interface DecideRequest { type: "slop/decide"; video: VideoMeta; tags: SmartTag[] }
export type DecideResponse = { ok: true; hide: boolean; matchedTagIds: string[]; probabilities: Record<string, number> } | { ok: false; error: "no_key" | "rate_limited" | "network" | "bad_response" };
