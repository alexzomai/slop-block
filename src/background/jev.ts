import type { SmartTag, VideoMeta } from "../shared/decision";

/** Адаптер формата Jev (System One) через OpenRouter: POST /api/v1/systemone. См. design.md, D1. */
export const ENDPOINT = "https://openrouter.ai/api/v1/systemone";
export const MAX_TAGS = 20;
export const MAX_TAG_TEXT = 200;
export const MAX_DESCRIPTION = 500;
const MAX_TITLE = 300;

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}
export interface SystemOneBody {
  model: string;
  state: { title: string; channel: string; description?: string };
  questions: Record<string, NoulQuestion>;
}

export function buildRequest(model: string, video: VideoMeta, tags: SmartTag[]): SystemOneBody {
  const state: SystemOneBody["state"] = {
    title: video.title.slice(0, MAX_TITLE),
    channel: video.channel.slice(0, MAX_TITLE),
  };
  if (video.description) state.description = video.description.slice(0, MAX_DESCRIPTION);
  const questions: Record<string, NoulQuestion> = {};
  tags.slice(0, MAX_TAGS).forEach((tag, i) => {
    questions[`t${i}`] = {
      type: "noul",
      instructions: `Подходит ли это видео под описание: «${tag.text.slice(0, MAX_TAG_TEXT)}»?`,
      criteria: { true: "Видео соответствует описанию", false: "Видео не соответствует описанию" },
    };
  });
  return { model, state, questions };
}

/** Возвращает вероятности по id тегов или null, если ответ неполон/некорректен. */
export function parseResponse(json: unknown, tags: SmartTag[]): Record<string, number> | null {
  if (typeof json !== "object" || json === null) return null;
  const answers = (json as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return null;
  const out: Record<string, number> = {};
  const used = tags.slice(0, MAX_TAGS);
  for (let i = 0; i < used.length; i++) {
    const a = (answers as Record<string, unknown>)[`t${i}`];
    if (typeof a !== "object" || a === null) return null;
    const { type, noul } = a as { type?: unknown; noul?: unknown };
    if (type !== "noul" || typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) return null;
    out[used[i]!.id] = noul;
  }
  return out;
}
