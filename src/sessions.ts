import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SessionSummary {
  file: string;
  name?: string;
  firstMessage?: string;
  mtime: number;
  messageCount: number;
}

export function defaultSessionDir(cwd: string): string {
  const base = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(os.homedir(), ".pi", "agent", "sessions");
  const enc = "--" + cwd.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-") + "--";
  return path.join(base, enc);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join(" ");
  }
  return "";
}

export async function listSessions(dir: string, limit = 60): Promise<SessionSummary[]> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const stats = await Promise.all(
    names.map(async (n) => {
      const file = path.join(dir, n);
      try {
        return { file, mtime: (await fs.promises.stat(file)).mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  const recent = stats
    .filter((s): s is { file: string; mtime: number } => !!s)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);

  return Promise.all(
    recent.map(async ({ file, mtime }) => {
      const summary: SessionSummary = { file, mtime, messageCount: 0 };
      try {
        const data = await fs.promises.readFile(file, "utf8");
        for (const line of data.split("\n")) {
          if (!line) continue;
          const isInfo = line.includes('"session_info"');
          const isMsg = line.startsWith('{"type":"message"');
          if (!isInfo && !isMsg) continue;
          try {
            const e = JSON.parse(line);
            if (e.type === "session_info") summary.name = e.name || undefined;
            else if (e.type === "message") {
              const role = e.message?.role;
              if (role === "user" || role === "assistant") summary.messageCount++;
              if (role === "user" && !summary.firstMessage) summary.firstMessage = textOf(e.message.content).trim();
            }
          } catch {}
        }
      } catch {}
      return summary;
    }),
  );
}

export function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
