/**
 * Markdown for a selection in the transcript. The chat shows rendered markdown, so a plain copy
 * loses bold, code spans, lists and links. This walks the live DOM inside the selected range and
 * writes it back as markdown. It walks the live DOM (not `range.cloneContents()`) so that hidden
 * parts (a closed Thinking block) stay out, as they do in `Selection.toString()`.
 */

/** Inline elements. Any other element (div, section, body, custom tags) starts a block. */
const INLINE = new Set(["STRONG", "B", "EM", "I", "DEL", "S", "CODE", "A", "SPAN", "BR", "IMG", "INPUT", "SUB", "SUP", "KBD", "MARK", "U", "SMALL", "LABEL"]);
const isBlock = (e: Element) => !INLINE.has(e.tagName);
/** UI chrome that is not part of the message text. */
const SKIP = "button, svg, summary, .code-head, .copy-btn, input:not([type=checkbox]), textarea, script, style";

/**
 * The selection as markdown, or undefined when plain text is the right copy: the selection is in
 * one text node, inside code, or touches no rendered markdown.
 */
export function selectionMarkdown(sel: Selection): string | undefined {
  if (sel.rangeCount === 0 || sel.isCollapsed) return undefined;
  const parts: string[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const md = rangeMarkdown(sel.getRangeAt(i));
    if (md === undefined) return undefined;
    parts.push(md);
  }
  const out = parts.join("\n\n").trim();
  return out || undefined;
}

function rangeMarkdown(r: Range): string | undefined {
  const ca = r.commonAncestorContainer;
  if (!(ca instanceof Element)) return undefined;
  if (ca.closest("pre, code")) return undefined;
  const mdRoot = ca.closest(".md");
  const touchesMd = mdRoot ? true : [...ca.querySelectorAll(".md")].some((m) => r.intersectsNode(m));
  if (!touchesMd) return undefined;
  // A selection over some rows or items starts at the table or list, so the rows and markers stay.
  const start = ca.matches("tr, thead, tbody") ? ca.closest("table") ?? ca : ca;
  return new Writer(r).flow([start]).join("\n\n");
}

class Writer {
  constructor(private r: Range) {}

  private in(n: Node): boolean {
    return this.r.intersectsNode(n);
  }

  private skip(e: Element): boolean {
    if (e.matches(SKIP)) return true;
    const cv = (e as any).checkVisibility;
    return typeof cv === "function" && !cv.call(e);
  }

  /** The selected part of a text node. */
  private clip(t: Text): string {
    let s = 0;
    let e = t.data.length;
    if (t === this.r.startContainer) s = this.r.startOffset;
    if (t === this.r.endContainer) e = this.r.endOffset;
    return t.data.slice(s, e);
  }

  /** Selected text below `el`, with whitespace kept (code). */
  private raw(el: Element): string {
    let out = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (this.in(n)) out += this.clip(n as Text);
    return out;
  }

  /** Blocks for a run of sibling nodes. Inline nodes between blocks become one paragraph. */
  flow(nodes: Iterable<Node>): string[] {
    const out: string[] = [];
    let buf = "";
    const flush = () => {
      const p = buf.replace(/[ \t]*\n[ \t]*/g, "\n").trim();
      if (p) out.push(p);
      buf = "";
    };
    for (const n of nodes) {
      if (!this.in(n)) continue;
      if (n instanceof Text) buf += this.clip(n).replace(/\s+/g, " ");
      else if (n instanceof Element && !this.skip(n)) {
        if (isBlock(n)) {
          flush();
          out.push(...this.block(n));
        } else buf += this.inline(n);
      }
    }
    flush();
    return out;
  }

  private block(el: Element): string[] {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return [`${"#".repeat(Number(tag[1]))} ${this.inlineKids(el).trim()}`];
    if (tag === "HR") return ["---"];
    if (tag === "PRE") {
      const lang = el.querySelector("code")?.className.match(/language-([\w+#.-]+)/)?.[1] ?? "";
      const text = this.raw(el).replace(/\n$/, "");
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      return [`${fence}${lang}\n${text}\n${fence}`];
    }
    if (tag === "UL" || tag === "OL") return [this.list(el)];
    if (tag === "BLOCKQUOTE") {
      const body = this.flow(el.childNodes).join("\n\n");
      return body ? [body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")] : [];
    }
    if (tag === "TABLE") return [this.table(el)].filter(Boolean);
    return this.flow(el.childNodes);
  }

  private list(el: Element): string {
    const ordered = el.tagName === "OL";
    let n = ordered ? Number(el.getAttribute("start") ?? 1) : 0;
    const items: string[] = [];
    let loose = false;
    for (const li of el.children) {
      if (li.tagName !== "LI") continue;
      const num = n++;
      if (!this.in(li) || this.skip(li)) continue;
      const marker = ordered ? `${num}. ` : "- ";
      const looseItem = [...li.children].some((c) => c.tagName === "P");
      loose ||= looseItem;
      const body = this.flow(li.childNodes).join(looseItem ? "\n\n" : "\n");
      const pad = " ".repeat(marker.length);
      items.push(marker + body.split("\n").map((l, i) => (i && l ? pad + l : l)).join("\n"));
    }
    return items.join(loose ? "\n\n" : "\n");
  }

  private table(el: Element): string {
    const rows = [...el.querySelectorAll("tr")].filter((tr) => tr.closest("table") === el && this.in(tr));
    if (!rows.length) return "";
    const cells = rows.map((tr) =>
      [...tr.children].map((c) => (this.in(c) ? this.inlineKids(c).trim().replace(/\|/g, "\\|").replace(/\n/g, " ") : "")),
    );
    const width = Math.max(...cells.map((c) => c.length));
    const head = [...rows[0].children];
    const sep = Array.from({ length: width }, (_, i) => {
      const a = head[i]?.getAttribute("align") ?? (head[i] as HTMLElement | undefined)?.style.textAlign;
      return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
    });
    const line = (c: string[]) => `| ${Array.from({ length: width }, (_, i) => c[i] ?? "").join(" | ")} |`;
    return [line(cells[0]), line(sep), ...cells.slice(1).map(line)].join("\n");
  }

  private inlineKids(el: Element): string {
    let out = "";
    for (const n of el.childNodes) {
      if (!this.in(n)) continue;
      if (n instanceof Text) out += this.clip(n).replace(/\s+/g, " ");
      else if (n instanceof Element && !this.skip(n)) out += isBlock(n) ? ` ${this.flow(n.childNodes).join(" ")} ` : this.inline(n);
    }
    return out;
  }

  /** Put a marker around the content, with outer spaces kept outside (`**x** `, not `**x **`). */
  private wrap(el: Element, m: string): string {
    const s = this.inlineKids(el);
    const t = s.trim();
    if (!t) return s;
    return `${s.match(/^\s*/)![0]}${m}${t}${m}${s.match(/\s*$/)![0]}`;
  }

  private inline(el: Element): string {
    switch (el.tagName) {
      case "STRONG":
      case "B":
        return this.wrap(el, "**");
      case "EM":
      case "I":
        return this.wrap(el, "*");
      case "DEL":
      case "S":
        return this.wrap(el, "~~");
      case "CODE": {
        const t = this.raw(el);
        if (!t) return "";
        const ticks = "`".repeat(Math.max(1, ...[...t.matchAll(/`+/g)].map((m) => m[0].length + 1)));
        const pad = ticks.length > 1 || /^`|`$/.test(t) ? " " : "";
        return `${ticks}${pad}${t}${pad}${ticks}`;
      }
      case "A": {
        const t = this.inlineKids(el);
        const href = el.getAttribute("href");
        return !href || t.trim() === href ? t : `[${t.trim()}](${href})`;
      }
      case "BR":
        return "\n";
      case "IMG": {
        const src = el.getAttribute("src") ?? "";
        const alt = el.getAttribute("alt") ?? "";
        return src && !src.startsWith("data:") ? `![${alt}](${src})` : alt;
      }
      case "INPUT":
        return (el as HTMLInputElement).checked ? "[x]" : "[ ]";
      default:
        return this.inlineKids(el);
    }
  }
}
