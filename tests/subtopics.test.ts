import { describe, expect, it } from "vitest";
import { selectQuestions, subtopics } from "../src/background/subtopics";

describe("subtopics", () => {
  it("запятые", () => expect(subtopics("продуктивность, IT, нейросети")).toEqual(["продуктивность", "IT", "нейросети"]));
  it("прочие разделители", () =>
    expect(subtopics("кино; музыка / игры или книги\nspace OR time")).toEqual(["кино", "музыка", "игры", "книги", "space", "time"]));
  it("не разделители: и/and, слэш без пробелов, дефис, слова с 'or'", () => {
    expect(subtopics("AI/ML и этика")).toEqual(["AI/ML и этика"]);
    expect(subtopics("rock and roll")).toEqual(["rock and roll"]);
    expect(subtopics("history of Florida")).toEqual(["history of Florida"]);
    expect(subtopics("лего-конструкторы")).toEqual(["лего-конструкторы"]);
  });
  it("мусор и повторы", () => expect(subtopics("IT,, it ;  , IT")).toEqual(["IT"]));
  it("тег без перечисления — прежний текст", () => expect(subtopics("кликбейт про похудение")).toEqual(["кликбейт про похудение"]));
  it("срез до 200 символов", () => expect(subtopics("x".repeat(300) + ", y")).toEqual(["x".repeat(200), "y"]));
  it("только разделители → весь текст одной под-темой", () => expect(subtopics(" , ; ")).toEqual([", ;"]));
  it("пустая строка → пусто", () => expect(subtopics("  ")).toEqual([]));
});

describe("selectQuestions", () => {
  it("round-robin и предел", () => {
    const mk = (p: string) => Array.from({ length: 10 }, (_, i) => `${p}${i}`);
    const out = selectQuestions([mk("a"), mk("b"), mk("c")], 20);
    expect(out).toHaveLength(20);
    expect(out.slice(0, 3)).toEqual(["a0", "b0", "c0"]);
    expect(out.filter((s) => s.startsWith("a"))).toHaveLength(7);
    expect(out.filter((s) => s.startsWith("b"))).toHaveLength(7);
    expect(out.filter((s) => s.startsWith("c"))).toHaveLength(6);
  });
  it("у каждого из 20 тегов есть вопрос", () => {
    const lists = Array.from({ length: 20 }, (_, i) => (i === 0 ? Array.from({ length: 15 }, (_, j) => `x${j}`) : [`t${i}`]));
    const out = selectQuestions(lists, 20);
    for (let i = 1; i < 20; i++) expect(out).toContain(`t${i}`);
    expect(out).toContain("x0");
    expect(out).toHaveLength(20);
  });
  it("дедуп между тегами", () => expect(selectQuestions([["IT", "AI"], ["it", "ML"]], 20)).toEqual(["IT", "AI", "ML"]));
  it("детерминированно", () => expect(selectQuestions([["a", "b"], ["c"]], 2)).toEqual(selectQuestions([["a", "b"], ["c"]], 2)));
});
