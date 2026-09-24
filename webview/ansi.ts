// Tiny ANSI SGR -> HTML converter for extension status/widget text.

const BASIC = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];

function basic(i: number, bright: boolean): string {
  return `var(--vscode-terminal-ansi${bright ? "Bright" : ""}${BASIC[i]})`;
}

function xterm256(n: number): string {
  if (n < 8) return basic(n, false);
  if (n < 16) return basic(n - 8, true);
  if (n < 232) {
    const v = n - 16;
    const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${c(Math.floor(v / 36))},${c(Math.floor(v / 6) % 6)},${c(v % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function stripAnsi(s: string): string {
  return (s ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
}

export function ansiToHtml(input: string): string {
  // Drop OSC sequences (hyperlinks, titles) and non-SGR CSI sequences.
  const s = (input ?? "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
  let out = "";
  let fg: string | undefined, bg: string | undefined;
  let bold = false, dim = false, italic = false, underline = false;
  let open = false;
  const re = /\x1b\[([0-9;?]*)([ -/]*[@-~])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const flush = (text: string) => {
    if (!text) return;
    const style = [
      fg && `color:${fg}`,
      bg && `background:${bg}`,
      bold && "font-weight:600",
      dim && "opacity:.65",
      italic && "font-style:italic",
      underline && "text-decoration:underline",
    ].filter(Boolean).join(";");
    out += style ? `<span style="${style}">${escapeHtml(text)}</span>` : escapeHtml(text);
  };
  while ((m = re.exec(s))) {
    flush(s.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== "m") continue;
    const codes = (m[1] || "0").split(";").map((x) => parseInt(x || "0", 10));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = bg = undefined; bold = dim = italic = underline = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if (c === 4) underline = true;
      else if (c === 22) bold = dim = false;
      else if (c === 23) italic = false;
      else if (c === 24) underline = false;
      else if (c >= 30 && c <= 37) fg = basic(c - 30, false);
      else if (c >= 90 && c <= 97) fg = basic(c - 90, true);
      else if (c >= 40 && c <= 47) bg = basic(c - 40, false);
      else if (c >= 100 && c <= 107) bg = basic(c - 100, true);
      else if (c === 39) fg = undefined;
      else if (c === 49) bg = undefined;
      else if (c === 38 || c === 48) {
        let col: string | undefined;
        if (codes[i + 1] === 2) { col = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
        else if (codes[i + 1] === 5) { col = xterm256(codes[i + 2]); i += 2; }
        if (c === 38) fg = col; else bg = col;
      }
    }
  }
  flush(s.slice(last));
  void open;
  return out;
}
