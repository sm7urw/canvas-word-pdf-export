export type Side = "top" | "right" | "bottom" | "left";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeGeometry {
  p0: Pt;
  p1: Pt;
  p2: Pt;
  p3: Pt;
  mid: Pt;
  fromSide: Side;
  toSide: Side;
}

const DIR: Record<Side, Pt> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export function anchor(b: Box, side: Side): Pt {
  switch (side) {
    case "top":
      return { x: b.x + b.width / 2, y: b.y };
    case "bottom":
      return { x: b.x + b.width / 2, y: b.y + b.height };
    case "left":
      return { x: b.x, y: b.y + b.height / 2 };
    case "right":
      return { x: b.x + b.width, y: b.y + b.height / 2 };
  }
}

function center(b: Box): Pt {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Pick sides that face each other when the canvas edge does not specify any. */
export function autoSides(from: Box, to: Box): [Side, Side] {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ["right", "left"] : ["left", "right"];
  }
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export function edgeGeometry(
  from: Box,
  fromSide: Side | undefined,
  to: Box,
  toSide: Side | undefined
): EdgeGeometry {
  const [autoFrom, autoTo] = autoSides(from, to);
  const fs = fromSide ?? autoFrom;
  const ts = toSide ?? autoTo;

  const p0 = anchor(from, fs);
  const p3 = anchor(to, ts);
  const dist = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const k = Math.min(Math.max(dist * 0.5, 40), 250);

  const p1 = { x: p0.x + DIR[fs].x * k, y: p0.y + DIR[fs].y * k };
  const p2 = { x: p3.x + DIR[ts].x * k, y: p3.y + DIR[ts].y * k };

  // Point on a cubic bezier at t = 0.5
  const mid = {
    x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
    y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
  };

  return { p0, p1, p2, p3, mid, fromSide: fs, toSide: ts };
}

/** Triangle arrowhead with its tip at `tip`, pointing along `dir` (does not need to be normalised). */
export function arrowHead(tip: Pt, dir: Pt, size = 14): [Pt, Pt, Pt] {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const d = { x: dir.x / len, y: dir.y / len };
  const n = { x: -d.y, y: d.x };
  const base = { x: tip.x - d.x * size, y: tip.y - d.y * size };
  return [
    tip,
    { x: base.x + n.x * size * 0.5, y: base.y + n.y * size * 0.5 },
    { x: base.x - n.x * size * 0.5, y: base.y - n.y * size * 0.5 },
  ];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function extend(b: Bounds, p: Pt): void {
  b.minX = Math.min(b.minX, p.x);
  b.minY = Math.min(b.minY, p.y);
  b.maxX = Math.max(b.maxX, p.x);
  b.maxY = Math.max(b.maxY, p.y);
}

export function extendBox(b: Bounds, box: Box): void {
  extend(b, { x: box.x, y: box.y });
  extend(b, { x: box.x + box.width, y: box.y + box.height });
}

export interface PageLayout {
  /** CSS @page size value */
  pageSize: string;
  pageWidth: number;
  pageHeight: number;
  scale: number;
  scaledWidth: number;
  scaledHeight: number;
  centered: boolean;
}

export type PageMode = "fit" | "a4-landscape" | "a4-portrait";

// A4 in CSS px at 96 dpi (floored so content never spills onto a second page)
const A4_LONG = 1122;
const A4_SHORT = 793;
const A4_MARGIN = 24;
const MAX_FIT_DIMENSION = 14000;

export function pageLayout(mode: PageMode, w: number, h: number): PageLayout {
  if (mode === "fit") {
    const scale = Math.min(1, MAX_FIT_DIMENSION / Math.max(w, h));
    const sw = Math.ceil(w * scale);
    const sh = Math.ceil(h * scale);
    return {
      pageSize: `${sw + 1}px ${sh + 1}px`,
      pageWidth: sw + 1,
      pageHeight: sh + 1,
      scale,
      scaledWidth: sw,
      scaledHeight: sh,
      centered: false,
    };
  }

  const landscape = mode === "a4-landscape";
  const pw = landscape ? A4_LONG : A4_SHORT;
  const ph = landscape ? A4_SHORT : A4_LONG;
  const scale = Math.min((pw - 2 * A4_MARGIN) / w, (ph - 2 * A4_MARGIN) / h, 2);
  return {
    pageSize: landscape ? "A4 landscape" : "A4 portrait",
    pageWidth: pw,
    pageHeight: ph,
    scale,
    scaledWidth: Math.floor(w * scale),
    scaledHeight: Math.floor(h * scale),
    centered: true,
  };
}
