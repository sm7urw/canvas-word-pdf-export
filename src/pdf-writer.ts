// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - pdfmake ships its browser build without type declarations for these paths
import pdfMakeImport from "pdfmake/build/pdfmake";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import pdfFontsImport from "pdfmake/build/vfs_fonts";
import { Block, Inline, ListItem } from "./ir";

/* eslint-disable @typescript-eslint/no-explicit-any */
const pdfMake: any = (pdfMakeImport as any).default ?? pdfMakeImport;
const fonts: any = (pdfFontsImport as any).default ?? pdfFontsImport;
pdfMake.vfs = fonts?.pdfMake?.vfs ?? fonts?.vfs ?? fonts;

const CONTENT_WIDTH = 483; // A4 (595pt) minus 2 x 56pt margins

type Node = any;

function textNodes(inlines: Inline[], extra: Record<string, unknown> = {}): Node[] {
  return inlines.map((i): Node => {
    if (i.kind === "break") return { text: "\n" };
    const decoration: string[] = [];
    if (i.strike) decoration.push("lineThrough");
    if (i.link) decoration.push("underline");
    return {
      text: i.text,
      bold: i.bold || undefined,
      italics: i.italic || undefined,
      decoration: decoration.length ? decoration : undefined,
      background: i.code ? "#eeeeee" : i.highlight ? "#fff176" : undefined,
      link: i.link,
      color: i.link ? "#0563c1" : undefined,
      preserveLeadingSpaces: i.code ? true : undefined,
      ...extra,
    };
  });
}

function listItem(item: ListItem): Node {
  const stack: Node[] = [];
  let first = true;
  for (const b of item.blocks) {
    if (first && b.kind === "paragraph") {
      const prefix = item.checked === undefined ? [] : [{ text: item.checked ? "[x] " : "[ ] " }];
      stack.push({ text: [...prefix, ...textNodes(b.inlines)] });
    } else {
      stack.push(...blockToPdf(b));
    }
    first = false;
  }
  if (stack.length === 1 && stack[0].text !== undefined && Object.keys(stack[0]).length === 1) return stack[0];
  return { stack };
}

function blockToPdf(b: Block): Node[] {
  switch (b.kind) {
    case "heading":
      return [
        {
          text: textNodes(b.inlines),
          style: b.level === 0 ? "title" : `h${Math.min(6, b.level)}`,
          headlineLevel: b.level,
        },
      ];
    case "paragraph":
      return [{ text: textNodes(b.inlines), margin: [0, 0, 0, 6] }];
    case "list": {
      const items = b.items.map(listItem);
      return [b.ordered ? { ol: items, start: b.start, margin: [0, 0, 0, 6] } : { ul: items, margin: [0, 0, 0, 6] }];
    }
    case "code":
      return [
        {
          table: { widths: ["*"], body: [[{ text: b.text, fontSize: 9, preserveLeadingSpaces: true }]] },
          layout: { fillColor: () => "#f2f2f2", hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 8, paddingTop: () => 6, paddingBottom: () => 6 },
          margin: [0, 0, 0, 8],
        },
      ];
    case "quote": {
      const stack: Node[] = [];
      if (b.title && b.title.length) stack.push({ text: textNodes(b.title, { bold: true }), margin: [0, 0, 0, 4] });
      for (const child of b.blocks) stack.push(...blockToPdf(child));
      if (stack.length === 0) stack.push({ text: "" });
      return [
        {
          table: { widths: ["*"], body: [[{ stack }]] },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: (i: number) => (i === 0 ? 2.5 : 0),
            vLineColor: () => "#bbbbbb",
            paddingLeft: () => 10,
          },
          margin: [0, 0, 0, 6],
        },
      ];
    }
    case "hr":
      return [
        {
          canvas: [{ type: "line", x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.7, lineColor: "#bbbbbb" }],
          margin: [0, 6, 0, 8],
        },
      ];
    case "image":
      return [
        {
          image: b.dataUrl,
          fit: [Math.min(CONTENT_WIDTH, b.width * 0.75), 640],
          margin: [0, 0, 0, 8],
        },
      ];
    case "table": {
      if (b.rows.length === 0) return [];
      const cols = Math.max(...b.rows.map((r) => r.length));
      const body = b.rows.map((cells, ri) =>
        Array.from({ length: cols }, (_, ci) => ({
          text: textNodes(cells[ci] ?? [], b.header && ri === 0 ? { bold: true } : {}),
          fillColor: b.header && ri === 0 ? "#f2f2f2" : undefined,
        }))
      );
      return [
        {
          table: { headerRows: b.header ? 1 : 0, widths: Array(cols).fill("*"), body },
          layout: {
            hLineColor: () => "#bbbbbb",
            vLineColor: () => "#bbbbbb",
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
          },
          margin: [0, 0, 0, 8],
        },
      ];
    }
  }
}

export interface WriterOptions {
  pageNumbers?: boolean;
}

export async function blocksToPdf(blocks: Block[], opts: WriterOptions = {}): Promise<ArrayBuffer> {
  const content = blocks.flatMap(blockToPdf);
  if (content.length === 0) content.push({ text: "" });
  const definition = {
    pageSize: "A4",
    pageMargins: [56, 56, 56, 56],
    defaultStyle: { font: "Roboto", fontSize: 11, lineHeight: 1.2 },
    styles: {
      title: { fontSize: 24, bold: true, margin: [0, 0, 0, 10] },
      h1: { fontSize: 18, bold: true, margin: [0, 12, 0, 6] },
      h2: { fontSize: 15, bold: true, margin: [0, 10, 0, 5] },
      h3: { fontSize: 13, bold: true, margin: [0, 8, 0, 4] },
      h4: { fontSize: 12, bold: true, margin: [0, 8, 0, 4] },
      h5: { fontSize: 11, bold: true, margin: [0, 6, 0, 3] },
      h6: { fontSize: 11, bold: true, italics: true, margin: [0, 6, 0, 3] },
    },
    footer: opts.pageNumbers
      ? (currentPage: number, pageCount: number) => ({
          text: `${currentPage} / ${pageCount}`,
          alignment: "center",
          fontSize: 9,
          color: "#666666",
          margin: [0, 22, 0, 0],
        })
      : undefined,
    content,
  };
  return new Promise<ArrayBuffer>((resolve, reject) => {
    try {
      pdfMake.createPdf(definition).getBuffer((buf: Uint8Array) => {
        resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      });
    } catch (e) {
      reject(e);
    }
  });
}
