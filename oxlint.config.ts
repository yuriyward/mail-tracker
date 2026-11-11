import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core, antiSlop],
  // Design-system copies stay byte-identical to their source (.ward/design-system-copies.tsv).
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "web/dist/**",
    "web/src/components/ui/**",
    "web/src/components/patterns/**",
  ],
  jsPlugins: ["oxlint-plugin-complexity"],
  rules: {
    "complexity/complexity": ["error", { cognitive: 15 }],
  },
});
