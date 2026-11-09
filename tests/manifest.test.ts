import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8")) as Record<string, any>;

describe("manifest (extension-shell)", () => {
  it("is MV3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("requests exactly storage", () => {
    expect(manifest.permissions).toEqual(["storage"]);
  });

  it("limits host_permissions to youtube, openrouter and typesafe", () => {
    expect(manifest.host_permissions).toEqual([
      "https://www.youtube.com/*",
      "https://openrouter.ai/*",
      "https://api.typesafe.ai/*",
    ]);
  });

  it.each([
    "optional_permissions",
    "optional_host_permissions",
    "externally_connectable",
    "web_accessible_resources",
  ])("has no %s", (key) => {
    expect(manifest).not.toHaveProperty(key);
  });

  it("has no forbidden permissions anywhere", () => {
    const text = JSON.stringify(manifest);
    for (const bad of ["<all_urls>", "\"tabs\"", "\"cookies\"", "\"webRequest\"", "\"scripting\"", "\"activeTab\"", "*://*/*"]) {
      expect(text).not.toContain(bad);
    }
  });

  it("has strict extension_pages CSP", () => {
    const csp: string = manifest.content_security_policy?.extension_pages;
    expect(csp).toBe("script-src 'self'; object-src 'self'");
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline|https?:|\*/);
  });

  it("runs content script only on youtube", () => {
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].matches).toEqual(["https://www.youtube.com/*"]);
    expect(manifest.content_scripts[0].js).toEqual(["content.js"]);
  });
});
