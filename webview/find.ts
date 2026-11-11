/**
 * Find in the chat: a small bar at the top of the transcript, as VS Code's find widget.
 *
 * The matches are marked with the CSS Custom Highlight API (`::highlight(pi-find)` in styles.css),
 * which paints ranges and does not change the DOM. So a message that streams, the markdown
 * renderer and the copy of a selection do not see the marks.
 */

/** No more matches than this are marked and counted. */
const MAX_MATCHES = 2000;

/** The highlights are one per page; each chat (a tile) puts its own ranges in them. */
function highlight(name: string, priority = 0): Set<Range> | undefined {
  const registry = (CSS as any).highlights as Map<string, Set<Range>> | undefined;
  const Highlight = (window as any).Highlight;
  if (!registry || !Highlight) return undefined;
  let h = registry.get(name);
  if (!h) {
    h = new Highlight();
    (h as any).priority = priority;
    registry.set(name, h!);
  }
  return h;
}

export interface FindOptions {
  /** The scrolling element; the bar stays at its top. */
  scroll: HTMLElement;
  /** The transcript. Each child is one item (a message, a tool call). */
  messages: HTMLElement;
  icons: { close: string; chevron: string };
}

export interface Find {
  readonly open: boolean;
  /** Show the bar and put the cursor in it. `text`: search for this (the selection). */
  show(text?: string): void;
  hide(): void;
  /** Go to the next (1) or the previous (-1) match. */
  step(dir: 1 | -1): void;
}

export function createFind(o: FindOptions): Find {
  const bar = document.createElement("div");
  bar.className = "find-bar hidden";
  bar.innerHTML =
    `<div class="find-box" role="search">` +
    `<input class="find-input" placeholder="Find in chat" spellcheck="false" aria-label="Find in chat">` +
    `<span class="find-count" aria-live="polite"></span>` +
    `<button class="find-btn" data-dir="-1" title="Previous Match (Shift+Enter)" aria-label="Previous match">${o.icons.chevron}</button>` +
    `<button class="find-btn find-next" data-dir="1" title="Next Match (Enter)" aria-label="Next match">${o.icons.chevron}</button>` +
    `<button class="find-btn find-close" title="Close (Esc)" aria-label="Close">${o.icons.close}</button>` +
    `</div>`;
  o.scroll.prepend(bar);
  const input = bar.querySelector<HTMLInputElement>(".find-input")!;
  const count = bar.querySelector<HTMLElement>(".find-count")!;

  /** The matches, in the order of the transcript, each with its item. */
  let matches: { range: Range; item: HTMLElement }[] = [];
  /** More matches than `MAX_MATCHES`. */
  let more = false;
  let current = -1;
  let returnFocus: HTMLElement | undefined;

  function unmark() {
    const all = highlight("pi-find");
    const cur = highlight("pi-find-current", 1);
    for (const m of matches) {
      all?.delete(m.range);
      cur?.delete(m.range);
    }
  }

  /** Text that is not on screen and cannot come on screen with a click: hidden elements, and the text of buttons. */
  function skipped(parent: Element, cache: Map<Element, boolean>): boolean {
    let skip = cache.get(parent);
    if (skip === undefined) {
      // Text in a closed <details> (thinking, summaries) counts: a match opens it.
      skip = !!parent.closest("button, .hidden") || (!parent.closest("details:not([open])") && !(parent as any).checkVisibility?.());
      cache.set(parent, skip);
    }
    return skip;
  }

  /** Find the matches of the text in the bar. An item's text is searched as one string, so a match can go across elements (code tokens, bold). */
  function search() {
    unmark();
    matches = [];
    more = false;
    const q = input.value.toLowerCase();
    if (!q) return;
    const cache = new Map<Element, boolean>();
    for (const item of Array.from(o.messages.children) as HTMLElement[]) {
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      const starts: number[] = [];
      let text = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text;
        if (!t.data || !t.parentElement || skipped(t.parentElement, cache)) continue;
        nodes.push(t);
        starts.push(text.length);
        text += t.data;
      }
      // A few characters change their length in lower case; then the positions would not fit.
      const low = text.toLowerCase();
      const hay = low.length === text.length ? low : text;
      /** The text node and the offset in it of position `at`. `end`: the position is the end of a match. */
      const locate = (at: number, end: boolean): [Text, number] => {
        let lo = 0;
        let hi = nodes.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid] < at || (!end && starts[mid] === at)) lo = mid;
          else hi = mid - 1;
        }
        return [nodes[lo], at - starts[lo]];
      };
      for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) {
        if (matches.length >= MAX_MATCHES) {
          more = true;
          return;
        }
        const range = document.createRange();
        range.setStart(...locate(i, false));
        range.setEnd(...locate(i + q.length, true));
        matches.push({ range, item });
      }
    }
  }

  function mark() {
    const all = highlight("pi-find");
    const cur = highlight("pi-find-current", 1);
    matches.forEach((m, i) => {
      if (i === current) {
        all?.delete(m.range);
        cur?.add(m.range);
      } else {
        cur?.delete(m.range);
        all?.add(m.range);
      }
    });
    const n = matches.length;
    count.textContent = !input.value ? "" : !n ? "No results" : `${current + 1} of ${n}${more ? "+" : ""}`;
    bar.classList.toggle("none", !!input.value && !n);
  }

  /** Bring the current match on screen. Open what hides it: a closed <details>, a collapsed prompt, a tool output that is cut off. */
  function reveal() {
    const m = matches[current];
    const parent = m?.range.startContainer.parentElement;
    if (!parent) return;
    for (let d = parent.closest<HTMLDetailsElement>("details:not([open])"); d; d = d.parentElement?.closest<HTMLDetailsElement>("details:not([open])") ?? null) d.open = true;
    parent.closest(".user-msg.collapsed")?.querySelector<HTMLElement>(".user-toggle")?.click();
    if (parent.closest(".tool-content")) parent.closest(".tool-row")?.classList.add("expanded");
    parent.scrollIntoView({ block: "center" });
    // A long paragraph: its centre can be far from the match. The layout of an item off screen is known only now.
    requestAnimationFrame(() => {
      const r = m.range.getBoundingClientRect();
      const s = o.scroll.getBoundingClientRect();
      if (!r.height) return;
      if (r.top < s.top + 44 || r.bottom > s.bottom - 16) o.scroll.scrollTop += r.top - s.top - s.height / 2;
    });
  }

  /** Search again after the text in the bar changed. The current match is the first one at or below the top of the view. */
  function fresh() {
    search();
    const top = o.scroll.getBoundingClientRect().top;
    current = matches.findIndex((m) => m.item.getBoundingClientRect().bottom > top);
    if (current < 0) current = matches.length - 1;
    mark();
    reveal();
  }

  /** Search again after the transcript changed (a message streams, another session). The view does not move. */
  function again() {
    const at = current;
    search();
    current = matches.length ? Math.min(Math.max(at, 0), matches.length - 1) : -1;
    mark();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
  // Not while a search of new text waits: that one searches the new transcript too.
  const observer = new MutationObserver(() => !pendingInput && later(again, 300));

  function step(dir: 1 | -1) {
    if (!matches.length) return;
    current = (current + dir + matches.length) % matches.length;
    mark();
    reveal();
  }

  function show(text?: string) {
    if (bar.classList.contains("hidden")) {
      const a = document.activeElement;
      returnFocus = a instanceof HTMLElement && a !== document.body ? a : undefined;
      bar.classList.remove("hidden");
      observer.observe(o.messages, { childList: true, subtree: true, characterData: true });
    }
    if (text) input.value = text;
    input.focus();
    input.select();
    if (input.value) fresh();
  }

  function hide() {
    if (bar.classList.contains("hidden")) return;
    clearTimeout(timer);
    observer.disconnect();
    unmark();
    matches = [];
    current = -1;
    bar.classList.add("hidden");
    if (returnFocus?.isConnected) returnFocus.focus();
    returnFocus = undefined;
  }

  /** The text in the bar changed and its search waits. */
  let pendingInput = false;
  input.addEventListener("input", () => {
    pendingInput = true;
    later(() => {
      pendingInput = false;
      fresh();
    }, 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // The search of the last keys may still wait.
      if (pendingInput) {
        clearTimeout(timer);
        timer = undefined;
        pendingInput = false;
        fresh();
      } else step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide();
    }
  });
  bar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".find-btn");
    if (!b) return;
    if (b.classList.contains("find-close")) hide();
    else step(b.dataset.dir === "1" ? 1 : -1);
  });
  // A click on a button must not take the cursor out of the field.
  bar.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest(".find-btn")) e.preventDefault();
  });

  return {
    get open() {
      return !bar.classList.contains("hidden");
    },
    show,
    hide,
    step,
  };
}
