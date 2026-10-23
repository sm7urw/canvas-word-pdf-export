import { App, Component, MarkdownRenderer, TFile, normalizePath } from "obsidian";
import { orderByArrows } from "./flow";
import { Block, blocksFrom, normalizeImages } from "./ir";
import {
  CanvasData,
  CanvasNode,
  IMAGE_MIME,
  bufferToBase64,
  getFileMarkdown,
  inlineImages,
} from "./render";

export interface DocOptions {
  includeTitle: boolean;
  edgeLabels: boolean;
  groupHeadings: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function fillNode(
  app: App,
  component: Component,
  el: HTMLElement,
  node: CanvasNode,
  canvasFile: TFile
): Promise<void> {
  if (node.type === "text") {
    await MarkdownRenderer.render(app, node.text, el, canvasFile.path, component);
  } else if (node.type === "link") {
    el.createEl("p").createEl("a", { text: node.url, href: node.url, cls: "external-link" });
  } else if (node.type === "file") {
    const tfile = app.vault.getAbstractFileByPath(normalizePath(node.file));
    if (!(tfile instanceof TFile)) {
      el.createEl("p", { text: `Missing file: ${node.file}` });
      return;
    }
    const ext = tfile.extension.toLowerCase();
    if (ext === "md") {
      const md = await getFileMarkdown(app, tfile, node.subpath);
      await MarkdownRenderer.render(app, md, el, tfile.path, component);
    } else if (IMAGE_MIME[ext]) {
      const buf = await app.vault.readBinary(tfile);
      el.createEl("img", { attr: { src: `data:${IMAGE_MIME[ext]};base64,${bufferToBase64(buf)}`, alt: tfile.name } });
    } else {
      el.createEl("p", { text: tfile.name });
    }
  }
}

/** Reads the canvas in arrow order and returns the document as format-independent blocks. */
export async function buildDocumentBlocks(
  app: App,
  component: Component,
  file: TFile,
  data: CanvasData,
  opts: DocOptions
): Promise<Block[]> {
  const nodes = data.nodes ?? [];
  if (nodes.length === 0) throw new Error("The canvas is empty.");
  const items = orderByArrows(nodes, data.edges ?? []);
  if (items.length === 0) throw new Error("The canvas has no content nodes (only groups).");

  const host = document.body.createDiv({ cls: "cpe-doc-host" });
  host.setCssStyles({ position: "fixed", left: "-300000px", top: "0", width: "720px", pointerEvents: "none" });
  try {
    const sections = items.map((item) => ({ item, el: host.createDiv({ cls: "markdown-rendered" }) }));
    await Promise.all(sections.map((s) => fillNode(app, component, s.el, s.item.node, file)));
    await sleep(500); // let async post-processors (embeds, code, mermaid) finish
    await inlineImages(host);
    await normalizeImages(host);

    const blocks: Block[] = [];
    if (opts.includeTitle) {
      blocks.push({ kind: "heading", level: 0, inlines: [{ kind: "text", text: file.basename }] });
    }
    for (const { item, el } of sections) {
      if (opts.groupHeadings && item.groupHeading) {
        blocks.push({ kind: "heading", level: 1, inlines: [{ kind: "text", text: item.groupHeading }] });
      }
      if (opts.edgeLabels && item.edgeLabel) {
        blocks.push({ kind: "paragraph", inlines: [{ kind: "text", text: `» ${item.edgeLabel}`, italic: true }] });
      }
      blocks.push(...blocksFrom(el));
    }
    return blocks;
  } finally {
    host.remove();
  }
}
