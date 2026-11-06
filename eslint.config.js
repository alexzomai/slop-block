import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "dist-test/", "artifacts/", "node_modules/", "openspec/", ".claude/", ".agents/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: { "no-console": "error" },
  },
  {
    files: ["scripts/**/*.mjs", "e2e/**/*.mjs", "*.config.*"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
  },
  {
    // колбэки page.evaluate выполняются в браузере
    files: ["e2e/**/*.mjs"],
    languageOptions: { globals: { document: "readonly", Response: "readonly", chrome: "readonly" } },
  },
  {
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
