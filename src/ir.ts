/**
 * A small document model, built from Obsidian's rendered markdown (HTML DOM).
 * Both the Word and the PDF writer consume this, so formatting stays identical.
 * Only DOM APIs are used here (no Obsidian imports) so it can be tested in a browser.
 */

export type Inline =
  | {
      kind: "text";
      text: string;
      bold?: boolean;
      italic?: boolean;
      strike?: boolean;
      code?: boolean;
      highlight?: boolean;
      link?: string;
    }
  | { kind: "break" };

export interface ListItem {
  blocks: Block[];
  /** undefined = ordinary item, otherwise a task-list checkbox */
  checked?: boolean;
}

export type Block =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; title?: Inline[]; blocks: Block[] }
  | { kind: "table"; header: boolean; rows: Inline[][][] }
  | { kind: "hr" }
  | { kind: "image"; dataUrl: string; width: number; height: number; alt?: string };

interface Style {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  highlight?: boolean;
  link?: string;
}

const SKIP_TAGS = new Set(["STYLE", "SCRIPT", "BUTTON", "SVG", "INPUT", "NOSCRIPT", "IFRAME", "CANVAS"]);
const SKIP_CLASSES = [
  "frontmatter",
  "metadata-container",
  "markdown-embed-link",
  "markdown-embed-title",
  "copy-code-button",
  "heading-collapse-indicator",
  "collapse-indicator",
  "list-collapse-indicator",
  "callout-icon",
  "callout-fold",
  "edit-block-button",
];
const BLOCK_TAGS = new Set([
  "H1", "H2", "H3", "H4", "H5", "H6", "P", "UL", "OL", "PRE", "BLOCKQUOTE", "TABLE", "HR",
  "DIV", "SECTION", "ARTICLE", "DETAILS", "FIGURE", "LI", "DL", "HEADER", "FOOTER",
]);

function shouldSkip(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  return SKIP_CLASSES.some((c) => el.classList.contains(c));
}

// ---- inlines -----------------------------------------------------------

function hasBlockChild(el: Element): boolean {
  return Array.from(el.children).some((c) => BLOCK_TAGS.has(c.tagName.toUpperCase()) && !shouldSkip(c));
}

function normalizeInlines(inlines: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const raw of inlines) {
    if (raw.kind === "break") {
      const last = out[out.length - 1];
      if (last?.kind === "text") last.text = last.text.replace(/ +$/, "");
      if (out.length > 0) out.push(raw);
      continue;
    }
    let text = raw.text.replace(/[ \t\r\n\f\u00a0]+/g, " ");
    const prev = out[out.length - 1];
    if (!prev || prev.kind === "break" || (prev.kind === "text" && prev.text.endsWith(" "))) {
      text = text.replace(/^ +/, "");
    }
    if (text) out.push({ ...raw, text });
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.kind === "break") out.pop();
    else {
      last.text = last.text.replace(/ +$/, "");
      if (!last.text) out.pop();
      else break;
    }
  }
  return out;
}

function linkOf(a: Element): string | undefined {
  if (a.classList.contains("internal-link") || a.classList.contains("tag")) return undefined;
  const href = a.getAttribute("href") ?? "";
  return /^(https?:|mailto:)/i.test(href) ? href : undefined;
}

/** Collects inline content; images are returned as separate blocks so they can sit between paragraphs. */
class InlineCollector {
  blocks: Block[] = [];
  private cur: Inline[] = [];

  flush() {
    const inlines = normalizeInlines(this.cur);
    this.cur = [];
    if (inlines.length > 0) this.blocks.push({ kind: "paragraph", inlines });
  }

  add(node: Node, style: Style) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? "";
      if (text) this.cur.push({ kind: "text", text, ...style });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (shouldSkip(el)) return;
    const tag = el.tagName.toUpperCase();

    if (tag === "BR") {
      this.cur.push({ kind: "break" });
      return;
    }
    if (tag === "IMG") {
      const image = imageBlock(el as HTMLImageElement);
      if (image) {
        this.flush();
        this.blocks.push(image);
      }
      return;
    }

    const next: Style = { ...style };
    if (tag === "STRONG" || tag === "B") next.bold = true;
    if (tag === "EM" || tag === "I") next.italic = true;
    if (tag === "DEL" || tag === "S" || tag === "STRIKE") next.strike = true;
    if (tag === "CODE" || tag === "KBD") next.code = true;
    if (tag === "MARK") next.highlight = true;
    if (tag === "A") {
      const link = linkOf(el);
      if (link) next.link = link;
    }
    for (const child of Array.from(el.childNodes)) this.add(child, next);
  }
}

function inlinesOf(el: Element): Inline[] {
  const c = new InlineCollector();
  for (const child of Array.from(el.childNodes)) c.add(child, {});
  // images inside e.g. a heading or a table cell are dropped; only text is kept
  const out: Inline[] = [];
  c.flush();
  for (const b of c.blocks) if (b.kind === "paragraph") out.push(...b.inlines, { kind: "break" });
  return normalizeInlines(out);
}

// ---- images ------------------------------------------------------------

function imageBlock(img: HTMLImageElement): Block | null {
  const src = img.getAttribute("src") ?? "";
  if (!src.startsWith("data:image/")) return null;
  const width = img.naturalWidth || Number(img.getAttribute("width")) || 0;
  const height = img.naturalHeight || Number(img.getAttribute("height")) || 0;
  if (!width || !height) return null;
  return { kind: "image", dataUrl: src, width, height, alt: img.getAttribute("alt") ?? undefined };
}

/** Make every image a PNG/JPEG/GIF data URI (Word can't take SVG/WebP) and wait until it has dimensions. */
export async function normalizeImages(root: Element, maxWidth = 1600): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    imgs.map(async (img) => {
      try {
        await img.decode();
      } catch {
        return;
      }
      const src = img.getAttribute("src") ?? "";
      const mime = /^data:(image\/[a-z+.-]+)/i.exec(src)?.[1]?.toLowerCase();
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!mime || !w || !h) return;
      const okType = mime === "image/png" || mime === "image/jpeg" || mime === "image/gif";
      if (okType && w <= maxWidth) return;
      const scale = Math.min(1, maxWidth / w);
      const canvas = createEl("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.setAttribute("src", canvas.toDataURL("image/png"));
      try {
        await img.decode();
      } catch {
        /* ignore */
      }
    })
  );
}

// ---- blocks ------------------------------------------------------------

function codeBlock(pre: Element): Block {
  const code = pre.querySelector("code") ?? pre;
  const clone = code.cloneNode(true) as Element;
  clone.querySelectorAll(".copy-code-button").forEach((n) => n.remove());
  return { kind: "code", text: (clone.textContent ?? "").replace(/\n$/, "") };
}

function tableBlock(table: Element): Block {
  const rows: Inline[][][] = [];
  for (const tr of Array.from(table.querySelectorAll("tr"))) {
    rows.push(Array.from(tr.children).filter((c) => /^(TD|TH)$/i.test(c.tagName)).map((c) => inlinesOf(c)));
  }
  return { kind: "table", header: table.querySelector("thead") !== null, rows };
}

function listBlock(list: Element): Block {
  const ordered = list.tagName.toUpperCase() === "OL";
  const items: ListItem[] = [];
  for (const li of Array.from(list.children)) {
    if (li.tagName.toUpperCase() !== "LI") continue;
    const box = li.querySelector<HTMLInputElement>(":scope > input[type=checkbox], :scope > p > input[type=checkbox]");
    const task = li.classList.contains("task-list-item") || box !== null;
    const checked = task
      ? (box?.checked ?? false) || (li.getAttribute("data-task") ?? " ") !== " " && li.hasAttribute("data-task")
      : undefined;
    items.push({ blocks: blocksFrom(li), checked });
  }
  return { kind: "list", ordered, start: Number(list.getAttribute("start")) || 1, items };
}

function calloutBlock(el: Element): Block {
  const title = el.querySelector(":scope > .callout-title .callout-title-inner");
  const content = el.querySelector(":scope > .callout-content");
  return {
    kind: "quote",
    title: title ? inlinesOf(title).map((i) => (i.kind === "text" ? { ...i, bold: true } : i)) : undefined,
    blocks: content ? blocksFrom(content) : [],
  };
}

export function blocksFrom(root: Element): Block[] {
  const blocks: Block[] = [];
  let collector = new InlineCollector();
  const flushInline = () => {
    collector.flush();
    blocks.push(...collector.blocks);
    collector = new InlineCollector();
  };

  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      collector.add(node, {});
      continue;
    }
    const el = node as Element;
    if (shouldSkip(el)) continue;
    const tag = el.tagName.toUpperCase();

    if (/^H[1-6]$/.test(tag)) {
      flushInline();
      const inlines = inlinesOf(el);
      if (inlines.length > 0) blocks.push({ kind: "heading", level: Number(tag[1]), inlines });
    } else if (tag === "P") {
      flushInline();
      const c = new InlineCollector();
      for (const child of Array.from(el.childNodes)) c.add(child, {});
      c.flush();
      blocks.push(...c.blocks);
    } else if (tag === "UL" || tag === "OL") {
      flushInline();
      blocks.push(listBlock(el));
    } else if (tag === "PRE") {
      flushInline();
      blocks.push(codeBlock(el));
    } else if (tag === "BLOCKQUOTE") {
      flushInline();
      blocks.push({ kind: "quote", blocks: blocksFrom(el) });
    } else if (tag === "TABLE") {
      flushInline();
      blocks.push(tableBlock(el));
    } else if (tag === "HR") {
      flushInline();
      blocks.push({ kind: "hr" });
    } else if (el.classList.contains("callout")) {
      flushInline();
      blocks.push(calloutBlock(el));
    } else if (BLOCK_TAGS.has(tag) && (hasBlockChild(el) || tag !== "DIV")) {
      flushInline();
      blocks.push(...blocksFrom(el));
    } else if (tag === "DIV" || tag === "SECTION") {
      // block wrapper with only inline content (Obsidian's el-p etc.)
      flushInline();
      blocks.push(...blocksFrom(el));
    } else {
      collector.add(el, {});
    }
  }
  flushInline();
  return blocks;
}

export function blocksFromHtmlElement(el: Element): Block[] {
  return blocksFrom(el);
}

/** Plain-text inline helper for writers/tests. */
export function inlineText(inlines: Inline[]): string {
  return inlines.map((i) => (i.kind === "break" ? "\n" : i.text)).join("");
}
