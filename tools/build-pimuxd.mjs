import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const targets = { "darwin-arm64": "aarch64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu" };
const platform = process.argv[2] ?? `${process.platform}-${process.arch}`;
const target = targets[platform];
if (!target) throw new Error(`Unsupported pimuxd target: ${platform}`);
const output = resolve(process.env.CARGO_TARGET_DIR || "pimuxd/target");
const result = spawnSync("cargo", ["build", "--locked", "--release", "--manifest-path", "pimuxd/Cargo.toml",
  "--target-dir", output, "--target", target], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync("dist", { recursive: true });
copyFileSync(resolve(output, target, "release", "pimuxd"), "dist/pimuxd");
chmodSync("dist/pimuxd", 0o755);
