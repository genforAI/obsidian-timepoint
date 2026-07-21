import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "release",
    "runtime-evidence",
    "verification",
    "design-reference",
    "main.js",
    "*.map",
    "package-lock.json",
    "RUN_02_*",
    "scripts/generate-run02-*.mjs",
    "esbuild.config.mjs",
  ]),
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.mts", "scripts/*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    rules: {
      "obsidianmd/no-global-this": "off",
      "obsidianmd/rule-custom-message": "off",
    },
  },
  {
    files: ["src/settings/settings.ts"],
    rules: {
      "@typescript-eslint/no-deprecated": "off",
      "obsidianmd/settings-tab/prefer-setting-definitions": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "obsidianmd/no-tfile-tfolder-cast": "off",
    },
  },
);
