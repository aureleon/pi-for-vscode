import * as fs from "node:fs";

/** A session file as the read-only viewer shows it: the messages on the branch of the last entry. */
export interface SessionView {
  header?: any;
  name?: string;
  /** Ids of the entries on the branch, root first. One id for each item in `messages`. */
  ids: string[];
  messages: any[];
}

/**
 * Turn one session entry into the message shape that `get_messages` returns, so the
 * webview renders it like the live chat. Entries that are not shown give undefined.
 */
function entryMessage(e: any): any {
  switch (e.type) {
    case "message":
      return e.message?.role === "system" ? undefined : e.message;
    case "custom_message":
      return { role: "custom", customType: e.customType, content: e.content, display: e.display, details: e.details };
    case "compaction":
      return { role: "compactionSummary", summary: e.summary, tokensBefore: e.tokensBefore };
    case "branch_summary":
      return { role: "branchSummary", summary: e.summary };
  }
  return undefined;
}

/**
 * Read a session file without pi. The leaf is the last entry in the file, as when pi
 * opens the session. All entries on the branch are shown, also the ones before a compaction.
 * A last line that is not complete yet (pi is writing it) is skipped.
 */
export async function readSessionView(file: string): Promise<SessionView> {
  const text = await fs.promises.readFile(file, "utf8");
  let header: any;
  let name: string | undefined;
  const byId = new Map<string, any>();
  let leaf: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session") header = e;
    else if (e.type === "session_info") name = e.name || undefined;
    if (typeof e.id === "string" && e.type !== "session") {
      byId.set(e.id, e);
      leaf = e.id;
    }
  }
  const branch: any[] = [];
  const seen = new Set<string>();
  for (let id = leaf; id && byId.has(id) && !seen.has(id); id = byId.get(id).parentId) {
    seen.add(id);
    branch.push(byId.get(id));
  }
  const ids: string[] = [];
  const messages: any[] = [];
  for (const e of branch.reverse()) {
    const m = entryMessage(e);
    if (!m) continue;
    ids.push(e.id);
    messages.push(m);
  }
  return { header, name, ids, messages };
}
