import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let cached: Promise<NodeJS.ProcessEnv> | undefined;
let log: ((line: string) => void) | undefined;

/** Where the shell-env problems go (the Pi output channel). */
export function setShellEnvLog(fn: (line: string) => void) {
  log = fn;
}

/**
 * GUI-launched VS Code often lacks the user's shell PATH (mise, nvm, homebrew…).
 * Resolve the login-shell environment once so `pi` and `node` can be found and
 * API keys exported in shell rc files reach the agent.
 *
 * A failed resolution (for example a slow shell just after login) is not cached:
 * the next start (the Restart button) tries again. Callers get a copy, so that
 * they can change it.
 */
export async function getShellEnv(enabled: boolean): Promise<NodeJS.ProcessEnv> {
  if (!enabled || process.platform === "win32") return withFallbackPath({ ...process.env });
  const p = (cached ??= resolve().then((env) => {
    if (!env) cached = undefined;
    return env ?? withFallbackPath({ ...process.env });
  }));
  return { ...(await p) };
}

function resolve(): Promise<NodeJS.ProcessEnv | undefined> {
  return new Promise((done) => {
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const start = "__PI_VSCODE_ENV_START__";
    const end = "__PI_VSCODE_ENV_END__";
    const t0 = Date.now();
    execFile(
      shell,
      ["-l", "-i", "-c", `echo ${start}; env; echo ${end}`],
      { timeout: 20_000, maxBuffer: 10 * 1024 * 1024, cwd: os.homedir(), env: process.env },
      (err, stdout) => {
        const s = stdout?.indexOf(start) ?? -1;
        const e = stdout?.indexOf(end) ?? -1;
        if (!(s >= 0 && e > s)) {
          const why = err?.killed ? `timed out after ${Date.now() - t0} ms` : err?.message ?? "no output";
          log?.(`[pi] could not read the login shell environment (${shell}: ${why}); pi starts with VS Code's PATH and the usual pi folders`);
          return done(undefined);
        }
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const line of stdout.slice(s + start.length, e).split("\n")) {
          const i = line.indexOf("=");
          if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
        }
        // Never leak VS Code's electron-as-node flag into the child.
        delete env.ELECTRON_RUN_AS_NODE;
        done(env);
      },
    );
  });
}

/** Without the shell's PATH, add the folders where pi installers put `pi`, so that it can still start. */
function withFallbackPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === "win32") return env;
  const home = os.homedir();
  const dirs = [
    path.join(home, ".pi", "agent", "bin"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const have = (env.PATH ?? "").split(":").filter(Boolean);
  const add = dirs.filter((d) => !have.includes(d) && fs.existsSync(d));
  env.PATH = [...have, ...add].join(":");
  return env;
}
