/**
 * Convert pi's `get_tree` result into a slim node list for the webview tree
 * navigator: one node per entry with a kind, a one-line preview, its label
 * and child ids. Full message bodies (tool outputs, images) never leave the host.
 */
export interface SlimNode {
  id: string;
  parentId: string | null;
  kind: string;
  text: string;
  meta?: string;
  label?: string;
  time?: string;
  hidden: boolean;
  children: string[];
}

export function slimTree(tree: any[]): { nodes: SlimNode[]; texts: Map<string, string> } {
  /** Full text of prompt-like entries, to put back into the composer after navigation. */
  const texts = new Map<string, string>();
  const textOf = (c: any): string =>
    typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ") : "";
  const oneLine = (t: string, n = 240) => t.replace(/\s+/g, " ").trim().slice(0, n);
  const nodes: SlimNode[] = [];
  const visit = (n: any) => {
    const e = n.entry;
    let kind = "other";
    let text = "";
    let hidden = true;
    let meta: string | undefined;
    if (e.type === "message") {
      const m = e.message ?? {};
      switch (m.role) {
        case "user":
          kind = "user";
          text = textOf(m.content);
          texts.set(e.id, text);
          hidden = false;
          break;
        case "assistant": {
          kind = "assistant";
          const blocks = Array.isArray(m.content) ? m.content : [];
          const t = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
          const tools = blocks.filter((b: any) => b.type === "toolCall").map((b: any) => b.name);
          text = t || (tools.length ? `→ ${[...new Set(tools)].join(", ")}` : m.stopReason === "error" ? `error: ${m.errorMessage ?? ""}` : "(no text)");
          if (tools.length && t) meta = `${tools.length} tool call${tools.length === 1 ? "" : "s"}`;
          hidden = false;
          break;
        }
        case "bashExecution":
          kind = "bash";
          text = `$ ${m.command}`;
          hidden = false;
          break;
        case "toolResult":
          kind = "tool";
          text = `${m.toolName}: ${textOf(m.content)}`;
          break;
        case "custom":
          kind = "custom";
          text = textOf(m.content);
          hidden = !m.display;
          break;
        default:
          kind = m.role ?? "other";
      }
    } else if (e.type === "branch_summary") {
      kind = "summary";
      text = e.summary ?? "";
      hidden = false;
    } else if (e.type === "compaction") {
      kind = "compaction";
      text = e.summary ?? "Context compacted";
      hidden = false;
    } else if (e.type === "custom_message") {
      kind = "custom";
      text = textOf(e.content);
      texts.set(e.id, text);
      hidden = !e.display;
    } else if (e.type === "model_change") {
      kind = "model";
      text = `model → ${e.modelId ?? e.model ?? ""}`;
    } else if (e.type === "thinking_level_change") {
      kind = "thinking";
      text = `thinking → ${e.thinkingLevel ?? ""}`;
    } else {
      kind = e.type;
      text = e.type === "session_info" ? `name → ${e.name ?? ""}` : e.type === "label" ? `label ${e.label ?? ""}` : e.customType ?? e.type;
    }
    nodes.push({
      id: e.id,
      parentId: e.parentId,
      kind,
      text: oneLine(text),
      meta,
      label: n.label,
      time: e.timestamp,
      hidden,
      children: (n.children ?? []).map((c: any) => c.entry.id),
    });
  };
  // Iterative pre-order walk: long sessions are deep chains.
  const stack = [...tree].reverse();
  while (stack.length) {
    const n = stack.pop();
    visit(n);
    for (let i = (n.children ?? []).length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  return { nodes, texts };
}
