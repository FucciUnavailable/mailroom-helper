// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", ".trigger", "dist"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md constraint 3: no `any`, no unvalidated parsing. These are
      // errors rather than warnings so CI actually blocks on them.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
