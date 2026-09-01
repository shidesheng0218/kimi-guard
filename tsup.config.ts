import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  minify: false,
  external: [/^node:/],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
