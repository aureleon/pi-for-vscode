import { spawnSync } from "node:child_process";

const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
// Build on the release host to use its toolchain and Linux libc baseline.
if (target !== `${process.platform}-${process.arch}`) throw new Error(`Build the ${target} package on its target host.`);
for (const [command, args] of [
  [process.execPath, ["tools/build-pimuxd.mjs", target]],
  ["tar", ["-czf", `dist/pimuxd-${target}.tar.gz`, "-C", "dist", "pimuxd"]],
  ["vsce", ["package", "--no-dependencies", "--target", target]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
