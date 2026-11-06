import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : [];
  });
}

const CYR = /[А-Яа-яЁё]/;
const TEXT_PROPS = new Set(["textContent", "innerText", "placeholder", "title", "ariaLabel", "label", "alt"]);
const TEXT_ATTRS = new Set(["aria-label", "title", "placeholder", "alt", "aria-description"]);
const isLit = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n);
const litText = (n: ts.Node): string =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => s.literal.text).join("") : "";

/** Нарушения в одном исходнике: кириллица в литералах и литералы, присваиваемые как видимый текст. */
export function violations(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const at = (n: ts.Node, why: string): void => {
    out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${why}`);
  };
  const visit = (n: ts.Node): void => {
    if (isLit(n) && CYR.test(litText(n))) at(n, "кириллица в литерале");
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) {
      if (TEXT_PROPS.has(n.left.name.text) && isLit(n.right) && /\p{L}/u.test(litText(n.right))) at(n, `литерал в .${n.left.name.text}`);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "setAttribute") {
      const [a, b] = n.arguments;
      if (a && b && ts.isStringLiteral(a) && TEXT_ATTRS.has(a.text) && isLit(b) && /\p{L}/u.test(litText(b))) at(n, `литерал в атрибуте ${a.text}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const SRC = files("src", ".ts").filter((f) => f !== join("src", "background", "jev.ts"));

describe("сканер литералов UI в src", () => {
  it("в исходниках (кроме промпта Jev) нет кириллических литералов и литералов-текстов", () => {
    expect(SRC.flatMap((f) => violations(f, readFileSync(f, "utf8")))).toEqual([]);
  });
  it("сканер ловит нарушения (самопроверка)", () => {
    expect(violations("x.ts", 'el.textContent = "Привет";')).toHaveLength(2);
    expect(violations("x.ts", 'el.textContent = "Hello";')).toHaveLength(1);
    expect(violations("x.ts", 'el.setAttribute("aria-label", "Close");')).toHaveLength(1);
    expect(violations("x.ts", "el.textContent = t(key);")).toEqual([]);
    expect(violations("x.ts", 'el.textContent = "";')).toEqual([]);
  });
  it("jev.ts не использует i18n (промпт не переводится)", () => {
    const j = readFileSync("src/background/jev.ts", "utf8");
    expect(j).not.toMatch(/i18n|getMessage/);
    expect(j).toContain("Подходит ли это видео под описание: «${tag.text.slice(0, MAX_TAG_TEXT)}»?");
    expect(j).toContain('criteria: { true: "Видео соответствует описанию", false: "Видео не соответствует описанию" }');
  });
});

describe("сканер HTML", () => {
  const html = files("static", ".html");
  it("есть что проверять", () => expect(html.length).toBeGreaterThanOrEqual(2));
  it.each(html)("%s: нет видимого текста и литеральных title/placeholder/aria-label", (f) => {
    const src = readFileSync(f, "utf8");
    const body = src.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
    const text = body.replace(/<[^>]*>/g, " ").replace(/&\w+;/g, " ");
    expect(text.match(/\p{L}+/gu) ?? []).toEqual([]);
    expect(body.match(/\s(title|placeholder|aria-label|alt)="[^"]+"/g) ?? []).toEqual([]);
    expect(CYR.test(src)).toBe(false);
  });
});
