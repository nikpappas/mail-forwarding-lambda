

import { defineConfig } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";

export default defineConfig([
	{ files: ["**/*.mjs"], languageOptions: { globals: { ...globals.browser, process: 'readonly' } } },
	{ files: ["**/*.mjs"], plugins: { js }, extends: ["js/recommended"], rules: { "no-prototype-builtins": "warn" } },
]);
