import { App, Component, MarkdownRenderer, TFile, normalizePath } from "obsidian";
import {
  Box,
  Bounds,
  Side,
  arrowHead,
  edgeGeometry,
  emptyBounds,
  extend,
  extendBox,
} from "./geometry";

export interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}
export interface TextNode extends NodeBase {
  type: "text";
  text: string;
}
export interface FileNode extends NodeBase {
  type: "file";
  file: string;
  subpath?: string;
}
export interface LinkNode extends NodeBase {
  type: "link";
  url: string;
}
export interface GroupNode extends NodeBase {
  type: "group";
  label?: string;
}
export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: Side;
  fromEnd?: "none" | "arrow";
  toNode: string;
  toSide?: Side;
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
}

export interface CanvasData {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
}

export interface RenderResult {
  root: HTMLElement;
  width: number;
  height: number;
  cleanup: () => void;
}

const PRESET: Record<string, string> = {
  "1": "233,49,71", // red
  "2": "236,117,0", // orange
  "3": "224,172,0", // yellow
  "4": "8,185,78", // green
  "5": "0,191,188", // cyan
  "6": "120,82,238", // purple
};

const DEFAULT_EDGE = "#8a8a8a";
const LABEL_SPACE = 28; // room above nodes/groups for their label
export const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
};

export function resolveColor(c?: string): { solid: string; tint: string } | null {
  if (!c) return null;
  let rgb: string | undefined = PRESET[c];
  if (!rgb) {
    let hex = c.trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split("").map((ch) => ch + ch).join("");
    if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
    rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");
  }
  return { solid: `rgb(${rgb})`, tint: `rgba(${rgb},0.1)` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Replace every non-data image source with an inline data URI so the PDF window needs no app:// access. */
export async function inlineImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src");
      if (!src || src.startsWith("data:")) return;
      try {
        // Re-load with CORS so the canvas stays untainted and can be read back.
        const copy = new Image();
        copy.crossOrigin = "anonymous";
        copy.src = src;
        await copy.decode();
        const w = copy.naturalWidth;
        const h = copy.naturalHeight;
        if (!w || !h) return;
        const canvas = createEl("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(copy, 0, 0);
        const jpeg = /\.jpe?g(\?|$)/i.test(src);
        img.setAttribute("src", canvas.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.92));
        img.removeAttribute("srcset");
        img.removeAttribute("loading");
      } catch {
        // Cross-origin or undecodable images are left as they are.
      }
    })
  );
}

export async function getFileMarkdown(app: App, file: TFile, subpath?: string): Promise<string> {
  const raw = await app.vault.cachedRead(file);
  const cache = app.metadataCache.getFileCache(file);
  let start = 0;
  let end = raw.length;

  const fmEnd = cache?.frontmatterPosition?.end.offset;
  if (fmEnd !== undefined) start = fmEnd;

  if (subpath && subpath.startsWith("#") && !subpath.startsWith("#^") && cache?.headings) {
    const name = subpath.split("#").filter(Boolean).pop()?.trim().toLowerCase();
    const headings = cache.headings;
    const idx = headings.findIndex((h) => h.heading.trim().toLowerCase() === name);
    if (idx >= 0) {
      const h = headings[idx];
      start = h.position.start.offset;
      const next = headings.slice(idx + 1).find((n) => n.level <= h.level);
      if (next) end = next.position.start.offset;
    }
  }
  return raw.slice(start, end);
}

export async function renderCanvas(
  app: App,
  component: Component,
  file: TFile,
  data: CanvasData,
  padding = 48
): Promise<RenderResult> {
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  if (nodes.length === 0) throw new Error("The canvas is empty.");

  const byId = new Map<string, CanvasNode>(nodes.map((n) => [n.id, n]));

  // ---- bounds -------------------------------------------------------------
  const bounds: Bounds = emptyBounds();
  for (const n of nodes) {
    extendBox(bounds, n);
    if (n.type === "group" || n.type === "file") extend(bounds, { x: n.x, y: n.y - LABEL_SPACE });
  }
  const geoms = new Map<string, ReturnType<typeof edgeGeometry>>();
  for (const e of edges) {
    const a = byId.get(e.fromNode);
    const b = byId.get(e.toNode);
    if (!a || !b) continue;
    const g = edgeGeometry(a, e.fromSide, b, e.toSide);
    geoms.set(e.id, g);
    for (const p of [g.p0, g.p3, g.mid]) extend(bounds, p);
  }

  const minX = bounds.minX - padding;
  const minY = bounds.minY - padding;
  const width = Math.ceil(bounds.maxX - bounds.minX + padding * 2);
  const height = Math.ceil(bounds.maxY - bounds.minY + padding * 2);

  // ---- DOM ----------------------------------------------------------------
  const host = document.body.createDiv({ cls: "cpe-host" });
  host.setCssStyles({ position: "fixed", left: "-300000px", top: "0", pointerEvents: "none" });
  const root = host.createDiv({ cls: "cpe-canvas" });
  root.setCssStyles({ width: `${width}px`, height: `${height}px` });

  const place = (el: HTMLElement, b: Box) =>
    el.setCssStyles({
      left: `${b.x - minX}px`,
      top: `${b.y - minY}px`,
      width: `${b.width}px`,
      height: `${b.height}px`,
    });

  const applyColor = (el: HTMLElement, color?: string, isGroup = false) => {
    const c = resolveColor(color);
    if (c) {
      el.style.setProperty("--cpe-border", c.solid);
      el.style.setProperty(
        "background",
        isGroup ? c.tint : `linear-gradient(${c.tint},${c.tint}), var(--background-primary, #fff)`
      );
    }
  };

  // Groups first (behind everything)
  for (const n of nodes) {
    if (n.type !== "group") continue;
    const el = root.createDiv({ cls: "cpe-node cpe-group" });
    place(el, n);
    applyColor(el, n.color, true);
    if (n.label) el.createDiv({ cls: "cpe-group-label", text: n.label });
  }

  // Edges
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "cpe-edges");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  root.appendChild(svg);

  const off = (p: { x: number; y: number }) => ({ x: p.x - minX, y: p.y - minY });
  const labels: { text: string; at: { x: number; y: number } }[] = [];

  for (const e of edges) {
    const g = geoms.get(e.id);
    if (!g) continue;
    const color = resolveColor(e.color)?.solid ?? DEFAULT_EDGE;
    const p0 = off(g.p0);
    const p1 = off(g.p1);
    const p2 = off(g.p2);
    const p3 = off(g.p3);

    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("d", `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", "2");
    svg.appendChild(path);

    const addArrow = (tip: { x: number; y: number }, dir: { x: number; y: number }) => {
      const pts = arrowHead(tip, dir);
      const poly = document.createElementNS(svgNs, "polygon");
      poly.setAttribute("points", pts.map((p) => `${p.x},${p.y}`).join(" "));
      poly.setAttribute("fill", color);
      svg.appendChild(poly);
    };
    if ((e.toEnd ?? "arrow") === "arrow") addArrow(p3, { x: p3.x - p2.x, y: p3.y - p2.y });
    if (e.fromEnd === "arrow") addArrow(p0, { x: p0.x - p1.x, y: p0.y - p1.y });

    if (e.label) labels.push({ text: e.label, at: off(g.mid) });
  }

  // Content nodes
  const renders: Promise<unknown>[] = [];
  for (const n of nodes) {
    if (n.type === "group") continue;
    const el = root.createDiv({ cls: `cpe-node cpe-${n.type}` });
    place(el, n);
    applyColor(el, n.color);

    if (n.type === "text") {
      const body = el.createDiv({ cls: "cpe-content markdown-rendered" });
      renders.push(MarkdownRenderer.render(app, n.text, body, file.path, component));
    } else if (n.type === "file") {
      renders.push(renderFileNode(app, component, el, n));
    } else if (n.type === "link") {
      const body = el.createDiv({ cls: "cpe-content cpe-link-body" });
      body.createDiv({ cls: "cpe-link-url", text: n.url });
    }
  }

  // Edge labels on top
  for (const l of labels) {
    const el = root.createDiv({ cls: "cpe-edge-label", text: l.text });
    el.setCssStyles({ left: `${l.at.x}px`, top: `${l.at.y}px` });
  }

  await Promise.all(renders);
  await sleep(500); // let async post-processors (embeds, code, mermaid) finish
  await inlineImages(root);

  return { root, width, height, cleanup: () => host.remove() };
}

async function renderFileNode(
  app: App,
  component: Component,
  el: HTMLElement,
  n: FileNode
): Promise<void> {
  const tfile = app.vault.getAbstractFileByPath(normalizePath(n.file));
  const title = n.file.split("/").pop() ?? n.file;
  el.createDiv({ cls: "cpe-label", text: n.subpath ? `${title}${n.subpath}` : title });

  if (!(tfile instanceof TFile)) {
    el.createDiv({ cls: "cpe-content cpe-missing", text: `Missing file: ${n.file}` });
    return;
  }

  const ext = tfile.extension.toLowerCase();
  if (ext === "md") {
    const md = await getFileMarkdown(app, tfile, n.subpath);
    const body = el.createDiv({ cls: "cpe-content markdown-rendered" });
    await MarkdownRenderer.render(app, md, body, tfile.path, component);
  } else if (IMAGE_MIME[ext]) {
    const buf = await app.vault.readBinary(tfile);
    const img = el.createEl("img", { cls: "cpe-image" });
    img.src = `data:${IMAGE_MIME[ext]};base64,${bufferToBase64(buf)}`;
  } else {
    el.createDiv({ cls: "cpe-content cpe-missing", text: `${title} (${ext.toUpperCase()})` });
  }
}
