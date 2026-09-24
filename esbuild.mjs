import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const configs = [
  {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
    sourcemap: true,
  },
  {
    entryPoints: ["webview/main.ts"],
    bundle: true,
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
    target: "es2020",
    sourcemap: true,
  },
];

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
  console.log("watching…");
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log("built");
}
