// @ts-check
import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "**/*.tsbuildinfo",
      // Git submodule with its own repo.
      "packages/argent-private/",
      "packages/argent/bin/",
      "packages/argent/dylibs/",
      "packages/argent/assets/",
      "packages/argent/skills/",
      "packages/argent/agents/",
      "packages/argent/rules/",
      "packages/native-devtools-ios/bin/",
      "packages/native-devtools-ios/dylibs/",
      // Fetched by scripts/download-trace-processor.sh.
      "packages/native-devtools-android/assets/trace-processor/",
      "packages/docs/build/",
      "packages/docs/.docusaurus/",
      "packages/docs/static/",
      "coverage/",
    ],
  },

  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Explicit list rather than `projectService`, which would not pick up
        // the per-package tsconfig.test.json. The glob also matches
        // packages/docs, which is outside the npm workspaces, so `npm ci` there
        // has to run before this lint (see .github/workflows/lint.yml). The
        // bench scripts under packages/*/scripts are deliberately NOT covered
        // here — they get a type-info-free block below (see the note there).
        project: ["packages/*/tsconfig.json", "packages/*/tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // checksVoidReturn flags legitimate async callbacks (event handlers,
      // array iteration).
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Pre-existing debt, off to keep the gate green; ratchet each back to
      // "error".
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  {
    files: ["packages/docs/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Mocks and partial fixtures trip these.
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/test/**", "**/tests/**"],
    rules: {
      "@typescript-eslint/no-base-to-string": "off",
      "no-empty": "off",
    },
  },

  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [eslint.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // The bench scripts under packages/*/scripts are dev-only tooling that import
  // the whole tool-server src type graph; adding them to `parserOptions.project`
  // (above) makes the type-aware parser build a second full TS program for two
  // ~115 KB files, which OOMs CI's ESLint at its 4 GB heap. Lint them WITHOUT
  // type information — the same treatment as the .js dev/build scripts. This is
  // not a rule opt-out to dodge a finding: the type-info-free set still runs
  // no-unused-vars, no-useless-assignment and prefer-const here (the errors this
  // paydown fixed); only the type-aware rules (e.g. no-base-to-string), which
  // this repo already turns off for test files, do not apply to the scripts.
  // Without this block they would hit `**/*.ts` above and fail to parse
  // ("file not found in any project").
  {
    files: ["packages/*/scripts/**/*.ts"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
    },
  }
);
