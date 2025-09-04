import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // Default for source code (browser + TypeScript)
  {
    files: ["src/**/*.{ts,js}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Node-based config files (like jest.config.js, eslint.config.mjs, etc.)
  {
    files: ["*.config.js", "*.config.cjs", "*.config.mjs", "jest.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Jest test files
  {
    files: ["src/__tests__/**/*.{ts,js}"],
    languageOptions: {
      globals: globals.jest,
    },
  },

  tseslint.configs.recommended,
]);
