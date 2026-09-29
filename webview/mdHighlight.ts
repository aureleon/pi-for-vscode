/**
 * Markdown highlighter for the composer's backdrop layer.
 *
 * The composer is a real <textarea> with transparent text layered over a <div>
 * that renders this HTML with identical font metrics. Every character of the
 * source appears exactly once and in order (markup like ** and ` stays visible,
 * dimmed), and every style preserves glyph advance widths, so the caret stays
 * aligned:
 *   bold   → faux-bold text-shadow (no font-weight change)
 *   italic → per-word skew via inline-block transform (layout width unchanged)
 *   code   → background tint + colour (no font-family change)
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const mark = (s: string) => `<span class="md-mark">${esc(s)}</span>`;

/** Wrap each non-space run so italics can be skewed without changing line breaks. */
const slant = (s: string) => s.replace(/[^\s]+/g, (w) => `<span class="md-i">${esc(w)}</span>`);

const INLINE = new RegExp(
  [
    "(?<code>`[^`\\n]+`)",
    "(?<bold>\\*\\*(?=\\S)[^*\\n]*?\\S\\*\\*|__(?=\\S)[^_\\n]*?\\S__)",
    "(?<strike>~~(?=\\S)[^~\\n]*?\\S~~)",
    "(?<italic>(?<![*\\w])\\*(?=[^\\s*])[^*\\n]*?[^\\s*]\\*(?![*\\w])|(?<![_\\w])_(?=[^\\s_])[^_\\n]*?[^\\s_]_(?![_\\w]))",
    "(?<link>\\[[^\\]\\n]+\\]\\([^)\\s]+\\))",
    "(?<mention>(?<=^|\\s)@(?:\"[^\"\\n]+\"|[^\\s]+))",
    "(?<url>https?:\\/\\/[^\\s)]+)",
  ].join("|"),
  "g",
);

function inline(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index!;
    out += esc(text.slice(last, i));
    const s = m[0];
    const g = m.groups!;
    if (g.code) out += `<span class="md-code">${mark("`")}${esc(s.slice(1, -1))}${mark("`")}</span>`;
    else if (g.bold) out += `<span class="md-b">${mark(s.slice(0, 2))}${esc(s.slice(2, -2))}${mark(s.slice(-2))}</span>`;
    else if (g.strike) out += `<span class="md-s">${mark("~~")}${esc(s.slice(2, -2))}${mark("~~")}</span>`;
    else if (g.italic) out += `${mark(s[0])}<span class="md-em">${slant(s.slice(1, -1))}</span>${mark(s.slice(-1))}`;
    else if (g.link) {
      const close = s.indexOf("](");
      out += `${mark("[")}<span class="md-link">${esc(s.slice(1, close))}</span>${mark(s.slice(close))}`;
    } else if (g.mention) out += `<span class="md-mention">${esc(s)}</span>`;
    else if (g.url) out += `<span class="md-url">${esc(s)}</span>`;
    last = i + s.length;
  }
  return out + esc(text.slice(last));
}

export function highlightMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  lines.forEach((line, n) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      out.push(`<span class="md-fence">${esc(line)}</span>`);
      return;
    }
    if (fence) {
      out.push(`<span class="md-codeblock">${esc(line)}</span>`);
      return;
    }
    let m: RegExpMatchArray | null;
    if (n === 0 && (m = line.match(/^(\/[\w:.-]+)(.*)$/))) {
      out.push(`<span class="md-cmd">${esc(m[1])}</span>${inline(m[2])}`);
    } else if (n === 0 && (m = line.match(/^(!{1,2})(.*)$/))) {
      out.push(`<span class="md-cmd">${esc(m[1])}</span><span class="md-shell">${esc(m[2])}</span>`);
    } else if ((m = line.match(/^(\s{0,3}#{1,6})(\s+)(.*)$/))) {
      out.push(`<span class="md-h">${mark(m[1])}${m[2]}${inline(m[3])}</span>`);
    } else if ((m = line.match(/^(\s*>+)(.*)$/))) {
      out.push(`<span class="md-quote">${mark(m[1])}${inline(m[2])}</span>`);
    } else if ((m = line.match(/^(\s*)([-*+]|\d+[.)])(\s+\[[ xX]\])?(\s+)(.*)$/))) {
      out.push(`${m[1]}<span class="md-li">${esc(m[2])}${m[3] ? esc(m[3]) : ""}</span>${m[4]}${inline(m[5])}`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(mark(line));
    } else out.push(inline(line));
  });
  // A trailing newline needs a character after it or the last empty line has no height.
  return out.join("\n") + (src.endsWith("\n") ? " " : "");
}
