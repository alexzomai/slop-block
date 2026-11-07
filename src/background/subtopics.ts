import { normalizeTagText, tagIdentity } from "../shared/settings";

/** Максимум символов под-темы (как лимит тега). */
export const MAX_SUBTOPIC = 200;

/** Разделители: , ， ; ； перевод строки, « / » (слэш с пробелами), слова «или» и «or». «и»/«and», `AI/ML`, дефис — не разделители. */
const SEPARATORS = /[,，;；\n\r]+|\s\/\s|\s(?:или|or)\s/iu;

/**
 * Раскладывает текст тега на под-темы: обрезка, схлопывание пробелов, срез до 200 символов,
 * дедупликация по `tagIdentity` (порядок первого вхождения). Нет под-тем — весь текст как одна.
 * Тег без разделителей даёт ровно одну под-тему с прежним текстом.
 */
export function subtopics(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(SEPARATORS)) {
    const s = normalizeTagText(part).slice(0, MAX_SUBTOPIC).trim();
    if (!s) continue;
    const id = tagIdentity(s);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(s);
  }
  if (out.length === 0) {
    const whole = normalizeTagText(text).slice(0, MAX_SUBTOPIC).trim();
    if (whole) out.push(whole);
  }
  return out;
}

/**
 * Отбирает до `max` различных под-тем (по `tagIdentity`) round-robin: сначала первая под-тема каждого тега,
 * затем вторая и т. д. Зависит только от входа (не от кэша). Не больше `max` тегов ⇒ у каждого тега есть вопрос.
 */
export function selectQuestions(lists: string[][], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let round = 0; lists.some((l) => l.length > round); round++) {
    for (const l of lists) {
      const s = l[round];
      if (s === undefined) continue;
      const id = tagIdentity(s);
      if (seen.has(id) || out.length >= max) continue;
      seen.add(id);
      out.push(s);
    }
  }
  return out;
}
