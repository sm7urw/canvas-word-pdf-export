import { PageMode, pageLayout } from "./geometry";

export const PRINT_CSS = `
html, body {
  margin: 0 !important; padding: 0 !important;
  height: auto !important; width: auto !important;
  overflow: visible !important; position: static !important;
  background: var(--background-primary, #fff) !important;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.cpe-page { overflow: hidden; background: var(--background-primary, #fff); }
/* Belt and braces against Obsidian's print rules hiding body children */
html body > .cpe-page { display: block !important; visibility: visible !important; opacity: 1 !important; }
html body > .cpe-page.cpe-centered { display: flex !important; align-items: center; justify-content: center; }
.cpe-clip { overflow: hidden; position: relative; }
.cpe-canvas {
  position: relative; transform-origin: 0 0;
  background: var(--background-primary, #fff);
  color: var(--text-normal, #222);
  font-family: var(--font-text, system-ui, sans-serif);
}
.cpe-node {
  position: absolute; box-sizing: border-box; overflow: hidden;
  border: 2px solid var(--cpe-border, #8a8a8a); border-radius: 8px;
  background: var(--background-primary, #fff);
}
.cpe-file { overflow: visible; }
.cpe-group { overflow: visible; background: transparent; border-radius: 12px; }
.cpe-edges { position: absolute; left: 0; top: 0; overflow: visible; }
.cpe-label {
  position: absolute; left: 0; top: -24px; max-width: 100%;
  font-size: 14px; color: #777; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cpe-group-label {
  position: absolute; left: 0; top: -28px; max-width: 100%;
  font-size: 15px; padding: 1px 8px; border-radius: 6px; white-space: nowrap;
  background: var(--cpe-border, #8a8a8a); color: #fff;
}
.cpe-content {
  box-sizing: border-box; height: 100%; padding: 12px 16px; overflow: hidden;
  font-size: 16px; line-height: 1.5;
}
.cpe-content > :first-child { margin-top: 0 !important; }
.cpe-content > :last-child { margin-bottom: 0 !important; }
.cpe-image { display: block; width: 100%; height: 100%; object-fit: contain; }
.cpe-missing { color: #999; font-style: italic; }
.cpe-link-url { word-break: break-all; color: var(--text-accent, #6c31e3); text-decoration: underline; }
.cpe-edge-label {
  position: absolute; transform: translate(-50%, -50%);
  background: var(--background-primary, #fff); border: 1px solid #bbb; border-radius: 6px;
  padding: 2px 8px; font-size: 14px; white-space: nowrap;
}
`;

function isPrintOnly(mediaText: string): boolean {
  return /\bprint\b/i.test(mediaText) && !/\b(screen|all)\b/i.test(mediaText);
}

/** Serialise a rule, dropping print-only @media blocks at any nesting depth. */
function serializeRule(rule: CSSRule): string {
  if (rule instanceof CSSMediaRule && isPrintOnly(rule.media.mediaText)) return "";
  if (!(rule instanceof CSSStyleRule) && rule instanceof CSSGroupingRule) {
    const text = rule.cssText;
    const header = text.slice(0, text.indexOf("{"));
    const inner = Array.from(rule.cssRules).map(serializeRule).join("\n");
    return `${header}{${inner}}`;
  }
  return rule.cssText;
}

/**
 * Collect the app's and theme's CSS, minus print-only blocks. Obsidian ships
 * `@media print { body > :not(.print) { display: none !important } }`, which
 * would hide our page entirely and give a blank PDF.
 */
function collectCss(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.disabled) continue;
    if (sheet.media.length > 0 && isPrintOnly(sheet.media.mediaText)) continue;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) out.push(serializeRule(rule));
  }
  return out.join("\n");
}

/** Minimal self-contained styling, used when Obsidian's own CSS can't be trusted. */
export const SIMPLE_CSS = `
:root { --background-primary: #fff; --text-normal: #222; --text-accent: #6c31e3; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #222; }
.markdown-rendered h1 { font-size: 1.8em; margin: 0.6em 0 0.4em; }
.markdown-rendered h2 { font-size: 1.5em; margin: 0.6em 0 0.4em; }
.markdown-rendered h3 { font-size: 1.25em; margin: 0.6em 0 0.4em; }
.markdown-rendered h4, .markdown-rendered h5, .markdown-rendered h6 { font-size: 1.1em; margin: 0.6em 0 0.4em; }
.markdown-rendered p { margin: 0.5em 0; }
.markdown-rendered ul, .markdown-rendered ol { margin: 0.5em 0; padding-left: 1.5em; }
.markdown-rendered blockquote { margin: 0.5em 0; padding-left: 1em; border-left: 3px solid #bbb; color: #555; }
.markdown-rendered code { font-family: ui-monospace, Menlo, Consolas, monospace; background: #f1f1f1; padding: 0 0.25em; border-radius: 3px; }
.markdown-rendered pre { background: #f1f1f1; padding: 0.6em; border-radius: 6px; overflow: hidden; }
.markdown-rendered pre code { background: none; padding: 0; }
.markdown-rendered table { border-collapse: collapse; }
.markdown-rendered th, .markdown-rendered td { border: 1px solid #bbb; padding: 2px 8px; }
.markdown-rendered img { max-width: 100%; }
.markdown-rendered a { color: var(--text-accent); }
.markdown-rendered .frontmatter, .markdown-rendered .metadata-container { display: none; }
`;

export interface HtmlOptions {
  pageMode: PageMode;
  forceLight: boolean;
  /** false = skip Obsidian's own stylesheets and use SIMPLE_CSS instead */
  useAppCss?: boolean;
}

/** A PDF with real content is well above this; an empty page is about 1 KB. */
export const BLANK_PDF_LIMIT = 4000;

export function buildHtml(root: HTMLElement, width: number, height: number, opts: HtmlOptions): string {
  const layout = pageLayout(opts.pageMode, width, height);

  const useApp = opts.useAppCss !== false;
  let bodyClass = useApp ? document.body.className : "";
  if (useApp && opts.forceLight) bodyClass = bodyClass.replace(/\btheme-dark\b/g, "theme-light");
  const bodyStyle = useApp ? document.body.getAttribute("style") ?? "" : "";

  // Serialise the canvas without the scale transform; we apply it on a wrapper.
  const canvasHtml = root.outerHTML;

  const body = `
<div class="print cpe-page${layout.centered ? " cpe-centered" : ""}" style="width:${layout.pageWidth}px;height:${layout.pageHeight}px">
  <div class="cpe-clip" style="width:${layout.scaledWidth}px;height:${layout.scaledHeight}px">
    <div style="transform:scale(${layout.scale});transform-origin:0 0;width:${width}px;height:${height}px">${canvasHtml}</div>
  </div>
</div>`;

  return `<!DOCTYPE html>
<html class="${useApp ? document.documentElement.className : ""}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<style>${opts.useAppCss === false ? SIMPLE_CSS : collectCss()}</style>
<style>${PRINT_CSS}
@page { size: ${layout.pageSize}; margin: 0; }
</style>
</head>
<body class="${bodyClass}" style="${bodyStyle.replace(/"/g, "&quot;")}">${body}</body>
</html>`;
}

// ---- Electron helpers ----------------------------------------------------

interface ElectronWindow {
  loadFile(path: string): Promise<void>;
  webContents: {
    printToPDF(options: { printBackground: boolean; preferCSSPageSize: boolean }): Promise<Uint8Array>;
  };
  destroy(): void;
}

interface ElectronRemote {
  BrowserWindow?: new (options: Record<string, unknown>) => ElectronWindow;
  dialog?: {
    showSaveDialog(options: {
      defaultPath: string;
      filters: { name: string; extensions: string[] }[];
    }): Promise<{ canceled: boolean; filePath?: string }>;
  };
}

interface NodeFs {
  writeFileSync(path: string, data: string | Uint8Array, encoding?: string): void;
  unlinkSync(path: string): void;
}

/** Node's require() only exists in the desktop app. */
function nodeRequire<T>(name: string): T {
  const req = (window as unknown as { require?: (id: string) => unknown }).require;
  if (!req) throw new Error("Node modules are not available on this platform.");
  return req(name) as T;
}

function getRemote(): ElectronRemote | null {
  try {
    const electron = nodeRequire<{ remote?: ElectronRemote }>("electron");
    if (electron.remote) return electron.remote;
  } catch {
    // not available, try the standalone module below
  }
  try {
    return nodeRequire<ElectronRemote>("@electron/remote");
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export const WINDOW_VARIANTS = 4;

function windowOptions(variant: number): Record<string, unknown> {
  switch (variant) {
    case 1:
      return { show: false, width: 1200, height: 800 };
    case 2:
      return { show: false, width: 1200, height: 800, webPreferences: { offscreen: true } };
    case 3:
      return {
        show: true, x: -32000, y: -32000, width: 1200, height: 800, frame: false,
        skipTaskbar: true, focusable: false, webPreferences: { javascript: false },
      };
    default:
      return {
        show: false, width: 1200, height: 800,
        webPreferences: { javascript: false, sandbox: true, nodeIntegration: false },
      };
  }
}

/** Renders the HTML in a hidden window and returns PDF bytes, or null if Electron's printing is unavailable. */
export async function htmlToPdf(html: string, variant = 0): Promise<ArrayBuffer | null> {
  const BrowserWindow = getRemote()?.BrowserWindow;
  if (!BrowserWindow) return null;

  const fs = nodeRequire<NodeFs>("fs");
  const os = nodeRequire<{ tmpdir(): string }>("os");
  const path = nodeRequire<{ join(...parts: string[]): string }>("path");
  const tmp = path.join(os.tmpdir(), `canvas-word-pdf-export-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, "utf8");

  const win = new BrowserWindow(windowOptions(variant));
  try {
    await win.loadFile(tmp);
    await sleep(variant === 0 ? 600 : 900);
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
    const bytes = new Uint8Array(buf);
    if (bytes.length === 0) throw new Error("Electron returned an empty PDF.");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  } finally {
    try {
      win.destroy();
    } catch {
      // window already closed
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp file already gone
    }
  }
}

/** Ask the user where to save; returns null if cancelled or the dialog is unavailable. */
export async function askSavePath(defaultName: string, ext = "pdf"): Promise<string | null> {
  const dialog = getRemote()?.dialog;
  if (!dialog) return null;
  const res = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
}

export function writeExternalFile(filePath: string, data: ArrayBuffer): void {
  nodeRequire<NodeFs>("fs").writeFileSync(filePath, new Uint8Array(data));
}
