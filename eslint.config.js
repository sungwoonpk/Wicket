import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-throw-literal": "error",
      // Request and response bodies are untrusted JSON, so `any` is used at those edges and checked by hand.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The server code logs through an injected logger, never straight to the console.
    files: ["src/**/*.ts"],
    ignores: ["src/gateway/main.ts", "src/mock/main.ts"],
    rules: { "no-console": "error" },
  },
  {
    // The dashboard runs in the browser as a plain script.
    files: ["src/gateway/dashboard/app.js"],
    languageOptions: { globals: globals.browser, sourceType: "script" },
  },
);
