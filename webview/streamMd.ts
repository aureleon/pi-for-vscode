import { marked, type Token, type TokensList } from "marked";

/**
 * Incremental markdown renderer for streaming text.
 *
 * Re-rendering the whole message on every token replaced every paragraph,
 * list and code block each frame, so the layout jittered and everything below
 * it (the spinner, later blocks) flickered. This keeps one DOM chunk per
 * top-level markdown token and, on each update, re-renders only from the
 * first token whose source changed. While streaming that is almost always
 * just the last block.
 */
export class StreamingMarkdown {
  private chunks: { raw: string; nodes: ChildNode[] }[] = [];
  private text = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly decorate: (container: HTMLElement) => void,
  ) {}

  update(text: string) {
    if (text === this.text) return;
    let tokens: TokensList;
    try {
      tokens = marked.lexer(text, { gfm: true });
    } catch {
      this.reset();
      this.root.textContent = text;
      this.text = text;
      return;
    }
    // Reference-style link definitions affect every token; re-render fully if they change.
    const links = JSON.stringify(tokens.links ?? {});
    if (links !== this.links) {
      this.links = links;
      this.reset();
    }
    this.text = text;

    let i = 0;
    while (i < this.chunks.length && i < tokens.length && this.chunks[i].raw === tokens[i].raw) i++;
    // Drop changed/removed chunks from i onward.
    for (const c of this.chunks.splice(i)) for (const n of c.nodes) n.remove();
    // Render the remaining tokens one by one so each keeps its own DOM.
    for (let j = i; j < tokens.length; j++) {
      const tok: Token = tokens[j];
      const list = Object.assign([tok], { links: tokens.links }) as unknown as TokensList;
      const tmp = document.createElement("div");
      tmp.innerHTML = marked.parser(list);
      this.decorate(tmp);
      const nodes = [...tmp.childNodes];
      this.root.append(...nodes);
      this.chunks.push({ raw: tok.raw, nodes });
    }
  }

  private links = "{}";

  reset() {
    this.chunks = [];
    this.root.textContent = "";
    this.text = "";
  }
}
