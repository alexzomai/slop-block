import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { normText } from "../src/background/cache";
import { addTag, normalize, tagIdentity, type Settings } from "../src/shared/settings";

const EM = String.fromCharCode(0x2003); // em space
const NNBSP = String.fromCharCode(0x202f); // narrow no-break space
const NBSP = " ";
// пробельные и регистровые варианты нескольких «смыслов»
const BASES = ["IT videos", "нейросети", "a b c", "x"];
const variants = (b: string): string[] => {
  const w = b.split(" ");
  return [
    b, b.toUpperCase(), b.toLowerCase(),
    ` ${b} `, w.join("   "), w.join("\t"), w.join(NBSP), w.join("\n"), w.join(" \r\n\t "),
    `\n${w.join(EM)}${NNBSP}`, w.join(" ").replace(/^./, (c) => c.toUpperCase()),
  ];
};
const ALL = [...BASES.flatMap(variants), "other", "IT  video", "it videos2", "itvideos"];

/** Состояние «как из хранилища»: текст не нормализуется (тег мог быть сохранён прежней версией). */
const stored = (text: string): Settings => normalize({ enabled: true, mode: "allowlist", skipSubscriptions: true, filterSearch: false, tags: [{ id: "old", text, enabled: true }] });

describe("tagIdentity — единая идентичность тегов", () => {
  it("свойство: равны по tagIdentity ⇔ addTag при существующем a отклоняет b как дубликат", () => {
    let pairs = 0;
    for (const a of ALL) {
      const s = stored(a);
      if (s.tags.length === 0) continue; // пустой после trim не хранится
      for (const b of ALL) {
        if (tagIdentity(b) === "") continue; // пустой ввод — другая ошибка (empty)
        const r = addTag(s, b, () => "new");
        const dup = r.error === "duplicate";
        expect(dup, JSON.stringify([a, b])).toBe(tagIdentity(a) === tagIdentity(b));
        if (!dup) expect(r.error).toBeUndefined();
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(1000);
  });
  it("симметрия: порядок добавления не важен", () => {
    for (const a of ALL) for (const b of ALL) {
      if (!tagIdentity(a) || !tagIdentity(b)) continue;
      const ab = addTag(addTag({ ...stored("zz"), tags: [] }, a, () => "1").settings, b, () => "2").error === "duplicate";
      const ba = addTag(addTag({ ...stored("zz"), tags: [] }, b, () => "1").settings, a, () => "2").error === "duplicate";
      expect(ab).toBe(ba);
    }
  });
  it("регрессия: старый валидный тег «IT   videos» и новый «IT\\nvideos» — дубликат", () => {
    const s = stored("IT   videos");
    expect(s.tags[0]!.text).toBe("IT   videos"); // данные пользователя не переписываются
    const r = addTag(s, "IT\nvideos", () => "new");
    expect(r.error).toBe("duplicate");
    expect(r.settings.tags).toHaveLength(1);
  });
  it("normalize не переписывает тексты пользователя", () => {
    expect(stored("A \t B").tags[0]!.text).toBe("A \t B");
  });
  it("ключ кэша решений строится от той же идентичности", () => {
    for (const v of ALL) expect(normText(v)).toBe(tagIdentity(v));
    expect(normText).toBe(tagIdentity);
  });
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const unparen = (n: ts.Node): ts.Node => (ts.isParenthesizedExpression(n) ? unparen(n.expression) : n);
const isTextProp = (n: ts.Node): boolean => {
  const u = unparen(n);
  return ts.isPropertyAccessExpression(u) && u.name.text === "text";
};
const CMP = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const TEXT_METHODS = new Set(["toLowerCase", "toUpperCase", "trim", "replace", "localeCompare", "normalize", "includes", "startsWith", "endsWith"]);
const KEYED = new Set(["has", "add", "set", "get", "delete", "indexOf"]);

/** Сравнения текстов тегов (.text) в обход tagIdentity: равенство, строковые методы, ключи Map/Set. */
export function bypasses(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const at = (n: ts.Node, why: string): void => void out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${why}`);
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && CMP.has(n.operatorToken.kind) && (isTextProp(n.left) || isTextProp(n.right))) at(n, "сравнение .text");
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression;
      if (isTextProp(m.expression) && TEXT_METHODS.has(m.name.text)) at(n, `.text.${m.name.text}()`);
      if (KEYED.has(m.name.text) && n.arguments.some(isTextProp)) at(n, `.text как ключ ${m.name.text}()`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("сканер: нет сравнений текстов тегов в обход tagIdentity", () => {
  it("в src", () => {
    // единственное разрешённое исключение: санитайзинг сырого значения из хранилища (trim + обрезка, без сравнения и без схлопывания —
    // тексты пользователя не переписываются)
    const allowed = (v: string): boolean => v.startsWith("src/shared/settings.ts:") && v.endsWith(".text.trim()");
    expect(files("src").flatMap((f) => bypasses(f, readFileSync(f, "utf8"))).filter((v) => !allowed(v))).toEqual([]);
  });
  it("самопроверка сканера", () => {
    expect(bypasses("x.ts", "a.text.toLowerCase() === b")).toHaveLength(1);
    expect(bypasses("x.ts", "x.text === y.text")).toHaveLength(1);
    expect(bypasses("x.ts", "m.has(t.text)")).toHaveLength(1);
    expect(bypasses("x.ts", "tagIdentity(a.text) === tagIdentity(b.text)")).toEqual([]);
    expect(bypasses("x.ts", "typeof o.text !== \"string\"")).toEqual([]);
  });
});
