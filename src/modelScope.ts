/**
 * Resolve Pi's `enabledModels` scope the same way the pi CLI does
 * (see pi-coding-agent/dist/core/model-resolver.js `resolveModelScopeFromModels`).
 *
 * Sources, highest precedence first:
 *   1. `--models <patterns>` in the `pi.args` setting
 *   2. `<cwd>/.pi/settings.json` → enabledModels   (project overrides global; arrays replace)
 *   3. `$PI_CODING_AGENT_DIR/settings.json` or `~/.pi/agent/settings.json` → enabledModels
 * An empty/missing list means "all available models".
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { minimatch } from "minimatch";

export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}

export interface ScopeResult<M extends ModelLike> {
  /** Scoped models in pattern order, or undefined when no scope is configured. */
  models?: M[];
  /** Where the patterns came from, for display. */
  source?: string;
  patterns: string[];
  unmatched: string[];
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.PI_CODING_AGENT_DIR;
  if (d) return d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : d;
  return path.join(os.homedir(), ".pi", "agent");
}

function readEnabled(file: string): string[] | undefined {
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(json?.enabledModels) ? json.enabledModels.filter((x: unknown) => typeof x === "string") : undefined;
  } catch {
    return undefined;
  }
}

export function enabledModelPatterns(cwd: string, args: string[], env?: NodeJS.ProcessEnv): { patterns: string[]; source?: string } {
  const i = args.findIndex((a) => a === "--models");
  if (i >= 0 && args[i + 1]) return { patterns: args[i + 1].split(",").map((s) => s.trim()).filter(Boolean), source: "--models" };
  const eq = args.find((a) => a.startsWith("--models="));
  if (eq) return { patterns: eq.slice(9).split(",").map((s) => s.trim()).filter(Boolean), source: "--models" };

  const projectFile = path.join(cwd, ".pi", "settings.json");
  const project = readEnabled(projectFile);
  if (project !== undefined) return { patterns: project, source: projectFile };
  const globalFile = path.join(agentDir(env), "settings.json");
  return { patterns: readEnabled(globalFile) ?? [], source: globalFile };
}

const same = (a: ModelLike, b: ModelLike) => a.provider === b.provider && a.id === b.id;

function exactRef<M extends ModelLike>(ref: string, models: M[]): M | undefined {
  const r = ref.trim();
  if (!r) return undefined;
  const lower = r.toLowerCase();
  const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === lower);
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined;
  const slash = r.indexOf("/");
  if (slash !== -1) {
    const provider = r.slice(0, slash).trim().toLowerCase();
    const id = r.slice(slash + 1).trim().toLowerCase();
    if (provider && id) {
      const pm = models.filter((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id);
      if (pm.length === 1) return pm[0];
      if (pm.length > 1) return undefined;
    }
  }
  const ids = models.filter((m) => m.id.toLowerCase() === lower);
  return ids.length === 1 ? ids[0] : undefined;
}

const isAlias = (id: string) => id.endsWith("-latest") || !/-\d{8}$/.test(id);

function tryMatch<M extends ModelLike>(pattern: string, models: M[]): M | undefined {
  const exact = exactRef(pattern, models);
  if (exact) return exact;
  const p = pattern.toLowerCase();
  const matches = models.filter((m) => m.id.toLowerCase().includes(p) || m.name?.toLowerCase().includes(p));
  if (!matches.length) return undefined;
  const aliases = matches.filter((m) => isAlias(m.id));
  const pool = aliases.length ? aliases : matches;
  return [...pool].sort((a, b) => b.id.localeCompare(a.id))[0];
}

function parsePattern<M extends ModelLike>(pattern: string, models: M[]): M | undefined {
  const m = tryMatch(pattern, models);
  if (m) return m;
  const colon = pattern.lastIndexOf(":");
  if (colon === -1) return undefined;
  // Strip a `:thinking` (or invalid) suffix and retry, like pi's scope mode.
  return parsePattern(pattern.slice(0, colon), models);
}

export function resolveScope<M extends ModelLike>(patterns: string[], models: M[]): { models: M[]; unmatched: string[] } {
  const out: M[] = [];
  const unmatched: string[] = [];
  const add = (m: M) => {
    if (!out.some((x) => same(x, m))) out.push(m);
  };
  for (const pattern of patterns) {
    if (/[*?[]/.test(pattern)) {
      let glob = pattern;
      const colon = pattern.lastIndexOf(":");
      if (colon !== -1 && LEVELS.includes(pattern.slice(colon + 1))) glob = pattern.slice(0, colon);
      const exact = exactRef(glob, models);
      if (exact) {
        add(exact);
        continue;
      }
      const hits = models.filter(
        (m) => minimatch(`${m.provider}/${m.id}`, glob, { nocase: true }) || minimatch(m.id, glob, { nocase: true }),
      );
      if (!hits.length) unmatched.push(pattern);
      hits.forEach(add);
      continue;
    }
    const m = parsePattern(pattern, models);
    if (m) add(m);
    else unmatched.push(pattern);
  }
  return { models: out, unmatched };
}

export function scopeModels<M extends ModelLike>(cwd: string, args: string[], models: M[], env?: NodeJS.ProcessEnv): ScopeResult<M> {
  const { patterns, source } = enabledModelPatterns(cwd, args, env);
  if (!patterns.length) return { patterns, source, unmatched: [] };
  const r = resolveScope(patterns, models);
  return { models: r.models, source, patterns, unmatched: r.unmatched };
}
