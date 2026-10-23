import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  IRunOptions,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { Block, Inline, ListItem } from "./ir";

type Child = Paragraph | Table;
type RunLike = TextRun | ExternalHyperlink;

interface Ctx {
  /** left indent in twips applied to every paragraph (list nesting, quotes) */
  indent: number;
  quote: boolean;
  nextInstance: { n: number };
}

const HEADINGS = [
  HeadingLevel.TITLE,
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const HEADING_SIZES = [44, 34, 28, 25, 23, 22, 22]; // half-points: title, h1..h6
const MAX_IMAGE_WIDTH_PX = 600;

function dataUrlToBytes(dataUrl: string): { type: "png" | "jpg" | "gif"; data: Uint8Array } | null {
  const m = /^data:image\/(png|jpeg|jpg|gif);base64,(.*)$/is.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2]);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return { type: m[1].toLowerCase() === "png" ? "png" : m[1].toLowerCase() === "gif" ? "gif" : "jpg", data };
}

function runs(inlines: Inline[], extra: { bold?: boolean; italics?: boolean; color?: string } = {}): RunLike[] {
  const out: RunLike[] = [];
  for (const i of inlines) {
    if (i.kind === "break") {
      out.push(new TextRun({ break: 1 }));
      continue;
    }
    const run = (underline: boolean) => {
      const options: IRunOptions = {
        text: i.text,
        bold: i.bold || extra.bold,
        italics: i.italic || extra.italics,
        strike: i.strike,
        font: i.code ? "Consolas" : undefined,
        size: i.code ? 20 : undefined,
        shading: i.code ? { type: ShadingType.CLEAR, fill: "EEEEEE", color: "auto" } : undefined,
        highlight: i.highlight ? "yellow" : undefined,
        color: i.link ? "0563C1" : extra.color,
        underline: underline ? {} : undefined,
      };
      return new TextRun(options);
    };
    out.push(i.link ? new ExternalHyperlink({ link: i.link, children: [run(true)] }) : run(false));
  }
  return out;
}

function paragraphProps(ctx: Ctx) {
  return {
    indent: ctx.indent > 0 ? { left: ctx.indent } : undefined,
    border: ctx.quote
      ? { left: { style: BorderStyle.SINGLE, size: 12, color: "AAAAAA", space: 8 } }
      : undefined,
    spacing: { after: 120 },
  };
}

function listItemBlocks(item: ListItem, ordered: boolean, level: number, instance: number, ctx: Ctx): Child[] {
  const out: Child[] = [];
  let first = true;
  for (const b of item.blocks) {
    if (first && b.kind === "paragraph") {
      const prefix =
        item.checked === undefined ? [] : [new TextRun({ text: item.checked ? "☑ " : "☐ " })];
      out.push(
        new Paragraph({
          children: [...prefix, ...runs(b.inlines)],
          numbering: { reference: ordered ? "numbers" : "bullets", level: Math.min(level, 5), instance },
          spacing: { after: 60 },
        })
      );
      first = false;
      continue;
    }
    first = false;
    if (b.kind === "list") {
      out.push(...listBlocks(b, level + 1, ctx));
    } else {
      out.push(...blockToDocx(b, { ...ctx, indent: ctx.indent + 360 * (level + 1) }));
    }
  }
  return out;
}

function listBlocks(b: Extract<Block, { kind: "list" }>, level: number, ctx: Ctx): Child[] {
  const instance = ++ctx.nextInstance.n;
  return b.items.flatMap((item) => listItemBlocks(item, b.ordered, level, instance, ctx));
}

function blockToDocx(b: Block, ctx: Ctx): Child[] {
  switch (b.kind) {
    case "heading":
      return [
        new Paragraph({
          heading: HEADINGS[Math.max(0, Math.min(6, b.level))],
          children: runs(b.inlines),
          ...(ctx.indent > 0 ? { indent: { left: ctx.indent } } : {}),
        }),
      ];
    case "paragraph":
      return [new Paragraph({ children: runs(b.inlines), ...paragraphProps(ctx) })];
    case "list":
      return listBlocks(b, 0, ctx);
    case "code": {
      const children: TextRun[] = [];
      b.text.split("\n").forEach((line, i) => {
        children.push(new TextRun({ text: line, break: i === 0 ? undefined : 1, font: "Consolas", size: 20 }));
      });
      return [
        new Paragraph({
          children,
          shading: { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" },
          ...paragraphProps(ctx),
        }),
      ];
    }
    case "quote": {
      const inner: Ctx = { ...ctx, indent: ctx.indent + 360, quote: true };
      const out: Child[] = [];
      if (b.title && b.title.length > 0) {
        out.push(new Paragraph({ children: runs(b.title, { bold: true }), ...paragraphProps(inner) }));
      }
      for (const child of b.blocks) out.push(...blockToDocx(child, inner));
      return out;
    }
    case "hr":
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } },
          spacing: { before: 120, after: 120 },
        }),
      ];
    case "image": {
      const img = dataUrlToBytes(b.dataUrl);
      if (!img) return [];
      const scale = Math.min(1, MAX_IMAGE_WIDTH_PX / b.width);
      return [
        new Paragraph({
          children: [
            new ImageRun({
              type: img.type,
              data: img.data,
              transformation: { width: Math.round(b.width * scale), height: Math.round(b.height * scale) },
              altText: { name: b.alt || "image", description: b.alt || "image", title: b.alt || "image" },
            }),
          ],
          ...paragraphProps(ctx),
        }),
      ];
    }
    case "table": {
      if (b.rows.length === 0) return [];
      const cols = Math.max(...b.rows.map((r) => r.length));
      const rows = b.rows.map(
        (cells, ri) =>
          new TableRow({
            tableHeader: b.header && ri === 0,
            children: Array.from({ length: cols }, (_, ci) => {
              const cell = cells[ci] ?? [];
              const head = b.header && ri === 0;
              return new TableCell({
                width: { size: 100 / cols, type: WidthType.PERCENTAGE },
                shading: head ? { type: ShadingType.CLEAR, fill: "F2F2F2", color: "auto" } : undefined,
                children: [new Paragraph({ children: runs(cell, { bold: head }) })],
              });
            }),
          })
      );
      return [
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
        new Paragraph({ children: [], spacing: { after: 120 } }),
      ];
    }
  }
}

export interface WriterOptions {
  pageNumbers?: boolean;
}

export async function blocksToDocx(blocks: Block[], opts: WriterOptions = {}): Promise<ArrayBuffer> {
  const ctx: Ctx = { indent: 0, quote: false, nextInstance: { n: 0 } };
  const children = blocks.flatMap((b) => blockToDocx(b, ctx));
  if (children.length === 0) children.push(new Paragraph({ children: [] }));

  const bulletLevels = Array.from({ length: 6 }, (_, level) => ({
    level,
    format: LevelFormat.BULLET,
    text: ["•", "◦", "▪"][level % 3],
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 540 + level * 360, hanging: 270 } } },
  }));
  const numberLevels = Array.from({ length: 6 }, (_, level) => ({
    level,
    format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3],
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 540 + level * 360, hanging: 360 } } },
  }));

  // One numbering instance per ordered list so each starts at 1.
  const doc = new Document({
    creator: "Canvas Word + PDF Export",
    title: "Canvas document",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: HEADING_SIZES.map((size, i) => ({
        id: i === 0 ? "Title" : `Heading${i}`,
        name: i === 0 ? "Title" : `heading ${i}`,
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { size, bold: true },
        paragraph: { spacing: { before: i === 0 ? 0 : 240, after: 120 }, keepNext: true },
      })),
    },
    numbering: {
      config: [
        { reference: "bullets", levels: bulletLevels },
        { reference: "numbers", levels: numberLevels },
      ],
    },
    sections: [
      {
        children,
        footers: opts.pageNumbers
          ? {
              default: new Footer({
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    children: [
                      new TextRun({
                        children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES],
                        size: 18,
                        color: "666666",
                      }),
                    ],
                  }),
                ],
              }),
            }
          : undefined,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  return blob.arrayBuffer();
}
