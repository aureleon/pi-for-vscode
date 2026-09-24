import { execFile } from "node:child_process";
import * as os from "node:os";

let cached: Promise<NodeJS.ProcessEnv> | undefined;

/**
 * GUI-launched VS Code often lacks the user's shell PATH (mise, nvm, homebrew…).
 * Resolve the login-shell environment once so `pi` and `node` can be found and
 * API keys exported in shell rc files reach the agent.
 */
export function getShellEnv(enabled: boolean): Promise<NodeJS.ProcessEnv> {
  if (!enabled || process.platform === "win32") return Promise.resolve({ ...process.env });
  cached ??= new Promise((resolve) => {
    const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    const start = "__PI_VSCODE_ENV_START__";
    const end = "__PI_VSCODE_ENV_END__";
    execFile(
      shell,
      ["-l", "-i", "-c", `echo ${start}; env; echo ${end}`],
      { timeout: 8000, maxBuffer: 10 * 1024 * 1024, cwd: os.homedir(), env: process.env },
      (_err, stdout) => {
        const env: NodeJS.ProcessEnv = { ...process.env };
        const s = stdout?.indexOf(start) ?? -1;
        const e = stdout?.indexOf(end) ?? -1;
        if (s >= 0 && e > s) {
          for (const line of stdout.slice(s + start.length, e).split("\n")) {
            const i = line.indexOf("=");
            if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
          }
        }
        // Never leak VS Code's electron-as-node flag into the child.
        delete env.ELECTRON_RUN_AS_NODE;
        resolve(env);
      },
    );
  });
  return cached;
}
