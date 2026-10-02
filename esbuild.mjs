import * as fs from "node:fs";
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
    // Integrations (integrations/*) import their styles as text and add them to the page.
    loader: { ".css": "text" },
  },
  {
    // pi-side bridge loaded via `pi -e` (adds tree navigation to RPC mode)
    entryPoints: ["src/bridge/piBridge.ts"],
    bundle: true,
    outfile: "dist/pi-bridge.mjs",
    platform: "node",
    format: "esm",
    target: "node18",
  },
];

// Pi sides of integrations: integrations/<name>/pi.ts → dist/integrations/<name>.mjs, loaded via `pi -e`.
for (const name of fs.readdirSync("integrations")) {
  if (!fs.existsSync(`integrations/${name}/pi.ts`)) continue;
  configs.push({
    entryPoints: [`integrations/${name}/pi.ts`],
    bundle: true,
    outfile: `dist/integrations/${name}.mjs`,
    platform: "node",
    format: "esm",
    target: "node18",
  });
}

if (watch) {
  for (const c of configs) (await esbuild.context(c)).watch();
  console.log("watching…");
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log("built");
}
