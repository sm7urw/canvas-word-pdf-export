import { PageMode } from "./geometry";
import { PRINT_CSS, SIMPLE_CSS } from "./pdf";

/**
 * Image-based fallback: draw the canvas DOM through an SVG <foreignObject> onto a
 * <canvas>, then wrap the JPEG in a minimal PDF. Independent of Electron's printing,
 * but the text is not selectable.
 */

const MAX_DIMENSION = 16000;
const MAX_PIXELS = 90_000_000;

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not rasterise the canvas."));
    img.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not encode the canvas image."));
          return;
        }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
      },
      "image/jpeg",
      0.92
    );
  });
}

export function chooseScale(w: number, h: number): number {
  const byDim = MAX_DIMENSION / Math.max(w, h);
  const byArea = Math.sqrt(MAX_PIXELS / (w * h));
  return Math.max(0.1, Math.min(2, byDim, byArea));
}

export function pdfFromJpeg(
  jpeg: Uint8Array,
  imgW: number,
  imgH: number,
  page: { w: number; h: number },
  place: { x: number; y: number; w: number; h: number },
  textOps = ""
): ArrayBuffer {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (data: Uint8Array | string) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: string | Uint8Array[]) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    if (typeof body === "string") push(body);
    else body.forEach(push);
    push("\nendobj\n");
  };
  const f = (n: number) => n.toFixed(2);

  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(page.w)} ${f(page.h)}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>`
  );
  obj(4, [
    enc.encode(
      `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    ),
    jpeg,
    enc.encode("\nendstream"),
  ]);
  const content = `q ${f(place.w)} 0 0 ${f(place.h)} ${f(place.x)} ${f(place.y)} cm /Im0 Do Q\n${textOps}`;
  const contentBytes = Uint8Array.from(content, (c) => c.charCodeAt(0) & 0xff); // Latin-1
  obj(5, [enc.encode(`<< /Length ${contentBytes.length} >>\nstream\n`), contentBytes, enc.encode("\nendstream")]);
  obj(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  const xrefAt = length;
  let xref = `xref\n0 7\n0000000000 65535 f \n`;
  for (let i = 1; i <= 6; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out.buffer;
}

export function pageForMode(mode: PageMode, w: number, h: number) {
  const PX = 0.75; // CSS px -> PDF pt
  if (mode === "fit") {
    return { page: { w: w * PX, h: h * PX }, place: { x: 0, y: 0, w: w * PX, h: h * PX } };
  }
  const landscape = mode === "a4-landscape";
  const pw = landscape ? 841.89 : 595.28;
  const ph = landscape ? 595.28 : 841.89;
  const margin = 18;
  const s = Math.min((pw - 2 * margin) / w, (ph - 2 * margin) / h);
  const dw = w * s;
  const dh = h * s;
  return { page: { w: pw, h: ph }, place: { x: (pw - dw) / 2, y: (ph - dh) / 2, w: dw, h: dh } };
}

export interface TextRun {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Measure where each word lands, using the same CSS as the SVG rendering (in a hidden iframe). */
export async function collectTextRuns(root: HTMLElement, width: number, height: number): Promise<TextRun[]> {
  const iframe = createEl("iframe");
  iframe.style.cssText = `position:fixed;left:-300000px;top:0;border:0;width:${width}px;height:${height}px`;
  document.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
      iframe.srcdoc =
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SIMPLE_CSS}\n${PRINT_CSS}</style></head>` +
        `<body style="margin:0">${root.outerHTML}</body></html>`;
    });
    const doc = iframe.contentDocument;
    const canvasEl = doc?.querySelector(".cpe-canvas");
    if (!doc || !canvasEl) return [];
    const origin = canvasEl.getBoundingClientRect();
    const runs: TextRun[] = [];
    const walker = doc.createTreeWalker(canvasEl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = (n as Text).parentElement;
      if (!parent || parent.closest("style,script")) continue;
      const clip = parent.closest(".cpe-content")?.getBoundingClientRect();
      const text = n.nodeValue ?? "";
      for (const m of text.matchAll(/\S+/g)) {
        const r = doc.createRange();
        r.setStart(n, m.index ?? 0);
        r.setEnd(n, (m.index ?? 0) + m[0].length);
        const b = r.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) continue;
        if (clip && (b.bottom > clip.bottom + 1 || b.top < clip.top - 1 || b.right > clip.right + 1)) continue;
        runs.push({ text: m[0], x: b.left - origin.left, y: b.top - origin.top, w: b.width, h: b.height });
      }
    }
    return runs;
  } finally {
    iframe.remove();
  }
}

function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 63;
    if (c === 0x5c || c === 0x28 || c === 0x29) out += "\\" + ch;
    else if (c >= 32 && c <= 255) out += ch;
    else out += "?";
  }
  return out;
}

/** Invisible (render mode 3) text over the image so the PDF is searchable and selectable. */
export function buildTextOps(
  runs: TextRun[],
  width: number,
  height: number,
  place: { x: number; y: number; w: number; h: number }
): string {
  if (runs.length === 0) return "";
  const k = place.w / width; // pt per css px
  const ctx = createEl("canvas").getContext("2d");
  if (ctx) ctx.font = "100px Helvetica, Arial, sans-serif";
  const f = (n: number) => n.toFixed(2);
  const ops: string[] = ["BT", "3 Tr"];
  for (const r of runs) {
    const fs = Math.max(1, r.h * k * 0.8);
    const natural = ctx ? (ctx.measureText(r.text).width / 100) * fs : r.w * k;
    const tz = natural > 0 ? Math.min(400, Math.max(20, ((r.w * k) / natural) * 100)) : 100;
    const x = place.x + r.x * k;
    const y = place.y + (height - (r.y + r.h)) * k + r.h * k * 0.2;
    ops.push(`/F1 ${f(fs)} Tf ${f(tz)} Tz 1 0 0 1 ${f(x)} ${f(y)} Tm (${pdfString(r.text)}) Tj`);
  }
  ops.push("ET");
  return ops.join("\n");
}

export async function canvasToRasterPdf(
  root: HTMLElement,
  width: number,
  height: number,
  mode: PageMode
): Promise<ArrayBuffer> {
  const xhtml = new XMLSerializer().serializeToString(root.cloneNode(true));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;background:#fff">` +
    `<style><![CDATA[${SIMPLE_CSS}\n${PRINT_CSS}]]></style>${xhtml}</div></foreignObject></svg>`;

  // A data: URL (not a blob: URL) keeps the canvas untainted so it can be exported.
  const url = `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
  {
    const img = await loadImage(url);
    const scale = chooseScale(width, height);
    const cw = Math.max(1, Math.round(width * scale));
    const ch = Math.max(1, Math.round(height * scale));
    const canvas = createEl("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas context available.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const jpeg = await canvasToJpeg(canvas);
    const { page, place } = pageForMode(mode, width, height);
    let textOps = "";
    try {
      textOps = buildTextOps(await collectTextRuns(root, width, height), width, height, place);
    } catch (e) {
      console.warn("[canvas-word-pdf-export] text layer skipped", e);
    }
    return pdfFromJpeg(jpeg, cw, ch, page, place, textOps);
  }
}
