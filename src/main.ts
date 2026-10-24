import {
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  TFile,
  normalizePath,
} from "obsidian";
import { PageMode } from "./geometry";
import { CanvasData, renderCanvas } from "./render";
import { canvasToRasterPdf } from "./raster";
import { buildDocumentBlocks } from "./document-export";
import {
  BLANK_PDF_LIMIT,
  askSavePath,
  buildHtml,
  WINDOW_VARIANTS,
  htmlToPdf,
  writeExternalFile,
} from "./pdf";

interface Settings {
  pageMode: PageMode;
  forceLight: boolean;
  saveTo: "vault" | "ask";
  outputFolder: string;
  debugHtml: boolean;
  exportMethod: "auto" | "image";
  docTitle: boolean;
  docEdgeLabels: boolean;
  docGroupHeadings: boolean;
  docPageNumbers: boolean;
}

const DEFAULTS: Settings = {
  pageMode: "fit",
  forceLight: true,
  saveTo: "vault",
  outputFolder: "",
  debugHtml: false,
  exportMethod: "auto",
  docTitle: true,
  docEdgeLabels: true,
  docGroupHeadings: true,
  docPageNumbers: true,
};

export default class CanvasPdfExportPlugin extends Plugin {
  settings: Settings = { ...DEFAULTS };

  async onload() {
    try {
      await this.start();
    } catch (err) {
      console.error("[canvas-word-pdf-export] failed to start", err);
      new Notice(`Canvas Word + PDF Export could not start: ${err instanceof Error ? err.message : String(err)}`, 20000);
      throw err;
    }
  }

  private async start() {
    await this.loadSettings();

    const forCanvas = (run: (f: TFile) => void) => (checking: boolean) => {
      const f = this.app.workspace.getActiveFile();
      if (f && f.extension === "canvas") {
        if (!checking) run(f);
        return true;
      }
      return false;
    };

    // The "as drawn" layout PDF needs Electron/Node and is desktop-only.
    if (Platform.isDesktopApp) {
      this.addCommand({
        id: "export-canvas-to-pdf",
        name: "Export current canvas to PDF (as drawn)",
        checkCallback: forCanvas((f) => void this.exportCanvas(f)),
      });
    }
    this.addCommand({
      id: "export-canvas-to-docx",
      name: "Export current canvas as Word document (follow arrows)",
      checkCallback: forCanvas((f) => void this.exportDocument(f, "docx")),
    });
    this.addCommand({
      id: "export-canvas-to-document-pdf",
      name: "Export current canvas as PDF document (follow arrows)",
      checkCallback: forCanvas((f) => void this.exportDocument(f, "pdf")),
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "canvas") return;
        menu.addItem((item) =>
          item
            .setTitle("Export canvas as Word document")
            .setIcon("file-text")
            .onClick(() => void this.exportDocument(file, "docx"))
        );
        menu.addItem((item) =>
          item
            .setTitle("Export canvas as PDF document")
            .setIcon("file-text")
            .onClick(() => void this.exportDocument(file, "pdf"))
        );
        if (Platform.isDesktopApp) {
          menu.addItem((item) =>
            item
              .setTitle("Export canvas to PDF (as drawn)")
              .setIcon("file-output")
              .onClick(() => void this.exportCanvas(file))
          );
        }
      })
    );

    this.addSettingTab(new CanvasPdfExportSettingTab(this.app, this));
  }

  async exportCanvas(file: TFile) {
    const notice = new Notice("Exporting canvas to PDF…", 0);
    let cleanup: (() => void) | undefined;
    try {
      const data = JSON.parse(await this.app.vault.read(file)) as CanvasData;
      const rendered = await renderCanvas(this.app, this, file, data);
      cleanup = rendered.cleanup;

      const build = (useAppCss: boolean) =>
        buildHtml(rendered.root, rendered.width, rendered.height, {
          pageMode: this.settings.pageMode,
          forceLight: this.settings.forceLight,
          useAppCss,
        });
      const html = build(true);
      const simpleHtml = build(false);

      if (this.settings.debugHtml) {
        const base = await this.vaultOutputPath(file);
        await this.app.vault.adapter.write(base.replace(/\.pdf$/, ".debug.html"), html);
        await this.app.vault.adapter.write(base.replace(/\.pdf$/, ".debug-simple.html"), simpleHtml);
      }

      const rasterise = () =>
        canvasToRasterPdf(rendered.root, rendered.width, rendered.height, this.settings.pageMode);
      const isBlank = (b: ArrayBuffer | null) => !b || b.byteLength < BLANK_PDF_LIMIT;

      let pdf: ArrayBuffer | null = null;
      let method = "image";
      const diag: string[] = [];

      if (this.settings.exportMethod === "auto") {
        const attempts: { label: string; html: string; variant: number }[] = [
          { label: "normal", html, variant: 0 },
          { label: "simple styling", html: simpleHtml, variant: 0 },
          ...Array.from({ length: WINDOW_VARIANTS - 1 }, (_, i) => ({
            label: `simple styling, window mode ${i + 1}`,
            html: simpleHtml,
            variant: i + 1,
          })),
        ];
        for (const a of attempts) {
          try {
            const r = await htmlToPdf(a.html, a.variant);
            if (!r) {
              diag.push(`${a.label}: print unavailable`);
              break;
            }
            diag.push(`${a.label}: ${r.byteLength} bytes`);
            if (!isBlank(r)) {
              pdf = r;
              method = a.label;
              break;
            }
          } catch (e) {
            diag.push(`${a.label}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      if (!pdf) {
        pdf = await rasterise();
        method = "image";
      }

      if (this.settings.exportMethod === "auto") {
        if (method === "image") {
          new Notice(
            `Exported as an image-based PDF with a hidden text layer (text can be selected and searched, but not restyled). Normal export came out blank: ${diag.join("; ")}`,
            15000
          );
        } else if (method !== "normal") {
          new Notice(`Exported using: ${method}.`, 8000);
        }
      }

      if (this.settings.saveTo === "ask") {
        const target = await askSavePath(`${file.basename}.pdf`);
        notice.hide();
        if (!target) return;
        writeExternalFile(target, pdf);
        new Notice(`Saved ${target}`);
        return;
      }

      const outPath = await this.vaultOutputPath(file);
      await this.app.vault.adapter.writeBinary(outPath, pdf);
      notice.hide();
      new Notice(`Exported to ${outPath}`);
    } catch (err) {
      notice.hide();
      console.error("[canvas-word-pdf-export]", err);
      new Notice(`Canvas export failed: ${err instanceof Error ? err.message : String(err)}`, 8000);
    } finally {
      cleanup?.();
    }
  }

  /** Reads the canvas in arrow order and writes a running text document (Word or PDF). */
  async exportDocument(file: TFile, format: "docx" | "pdf") {
    const notice = new Notice("Creating document from canvas…", 0);
    try {
      const data = JSON.parse(await this.app.vault.read(file)) as CanvasData;
      const blocks = await buildDocumentBlocks(this.app, this, file, data, {
        includeTitle: this.settings.docTitle,
        edgeLabels: this.settings.docEdgeLabels,
        groupHeadings: this.settings.docGroupHeadings,
      });
      const bytes =
        format === "docx"
          ? await (await import("./docx-writer")).blocksToDocx(blocks, { pageNumbers: this.settings.docPageNumbers })
          : await (await import("./pdf-writer")).blocksToPdf(blocks, { pageNumbers: this.settings.docPageNumbers });
      notice.hide();
      await this.saveOutput(file, bytes, format, "-document");
    } catch (err) {
      notice.hide();
      console.error("[canvas-word-pdf-export]", err);
      new Notice(`Document export failed: ${err instanceof Error ? err.message : String(err)}`, 8000);
    }
  }

  private async saveOutput(file: TFile, data: ArrayBuffer, ext: string, suffix = ""): Promise<void> {
    if (this.settings.saveTo === "ask" && Platform.isDesktopApp) {
      const target = await askSavePath(`${file.basename}${suffix}.${ext}`, ext);
      if (!target) return;
      writeExternalFile(target, data);
      new Notice(`Saved ${target}`);
      return;
    }
    const outPath = await this.vaultOutputPath(file, ext, suffix);
    await this.app.vault.adapter.writeBinary(outPath, data);
    new Notice(`Exported to ${outPath}`);
    if (Platform.isMobile) await this.showOnMobile(outPath, ext);
  }

  /** On phones/tablets there is no file manager step: open the result straight away. */
  private async showOnMobile(path: string, ext: string): Promise<void> {
    try {
      await new Promise((r) => window.setTimeout(r, 400)); // let the vault index the new file
      const f = this.app.vault.getAbstractFileByPath(path);
      if (ext === "pdf" && f instanceof TFile) {
        await this.app.workspace.getLeaf("tab").openFile(f);
      } else {
        // Word files can't be shown inside Obsidian; hand them to the system (share/preview sheet).
        const app = this.app as unknown as { openWithDefaultApp?: (path: string) => Promise<void> };
        await app.openWithDefaultApp?.(path);
      }
    } catch (e) {
      console.warn("[canvas-word-pdf-export] could not open exported file", e);
    }
  }

  private async vaultOutputPath(file: TFile, ext = "pdf", suffix = ""): Promise<string> {
    const custom = this.settings.outputFolder.trim().replace(/^\/+|\/+$/g, "");
    const folder = custom || (file.parent && file.parent.path !== "/" ? file.parent.path : "");
    if (folder && !(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }
    const name = `${file.basename}${suffix}.${ext}`;
    return normalizePath(folder ? `${folder}/${name}` : name);
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = { ...DEFAULTS, ...saved };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class CanvasPdfExportSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: CanvasPdfExportPlugin) {
    super(app, plugin);
  }

  /** Declarative settings (Obsidian 1.13+): makes the settings searchable. Older versions use display(). */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const folderDesc = Platform.isDesktopApp
      ? "Leave empty to save next to the canvas file."
      : "Leave empty to save next to the canvas file. On mobile the file is saved in the vault and opened/shared afterwards.";
    const folder: SettingDefinitionItem = {
      name: "Vault output folder",
      desc: folderDesc,
      control: { type: "text", key: "outputFolder", placeholder: "e.g. Exports" },
    };
    const items: SettingDefinitionItem[] = [
      {
        type: "group",
        heading: "Document export (follow arrows)",
        items: [
          { name: "Canvas name as title", control: { type: "toggle", key: "docTitle" } },
          {
            name: "Arrow labels",
            desc: "Write the text on an arrow as an italic line before the node it leads to.",
            control: { type: "toggle", key: "docEdgeLabels" },
          },
          {
            name: "Page numbers",
            desc: "Add page numbers (e.g. 2 / 5) in the footer of the Word and PDF documents.",
            control: { type: "toggle", key: "docPageNumbers" },
          },
          {
            name: "Group names as headings",
            desc: "Add a heading the first time the flow enters a group.",
            control: { type: "toggle", key: "docGroupHeadings" },
          },
        ],
      },
    ];
    if (!Platform.isDesktopApp) return [...items, folder];
    return [
      ...items,
      {
        type: "group",
        heading: "Layout PDF (as drawn)",
        items: [
          {
            name: "Page format",
            desc: "“Fit to canvas” makes one page sized exactly to the canvas. A4 scales the canvas onto one A4 page.",
            control: {
              type: "dropdown",
              key: "pageMode",
              options: {
                fit: "Fit to canvas (one custom-size page)",
                "a4-landscape": "A4 landscape",
                "a4-portrait": "A4 portrait",
              },
            },
          },
          {
            name: "Always use light theme",
            desc: "Print with the light theme even if Obsidian is in dark mode.",
            control: { type: "toggle", key: "forceLight" },
          },
          {
            name: "Export method",
            desc: "Automatic makes a normal PDF with selectable text and falls back to an image-based PDF if that comes out blank. “Image” always uses the image-based PDF.",
            control: {
              type: "dropdown",
              key: "exportMethod",
              options: { auto: "Automatic", image: "Image-based PDF only" },
            },
          },
          {
            name: "Save PDF to",
            control: {
              type: "dropdown",
              key: "saveTo",
              options: { vault: "Inside the vault", ask: "Ask each time (save dialog)" },
            },
          },
          folder,
          {
            name: "Save debug HTML",
            desc: "Also save the intermediate HTML next to the PDF (for troubleshooting a blank or broken export).",
            control: { type: "toggle", key: "debugHtml" },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Document export (follow arrows)").setHeading();

    new Setting(containerEl)
      .setName("Canvas name as title")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.docTitle).onChange(async (v) => {
          this.plugin.settings.docTitle = v;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Arrow labels")
      .setDesc("Write the text on an arrow as an italic line before the node it leads to.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.docEdgeLabels).onChange(async (v) => {
          this.plugin.settings.docEdgeLabels = v;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Page numbers")
      .setDesc("Add page numbers (e.g. 2 / 5) in the footer of the Word and PDF documents.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.docPageNumbers).onChange(async (v) => {
          this.plugin.settings.docPageNumbers = v;
          await this.plugin.saveSettings();
        })
      );
    new Setting(containerEl)
      .setName("Group names as headings")
      .setDesc("Add a heading the first time the flow enters a group.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.docGroupHeadings).onChange(async (v) => {
          this.plugin.settings.docGroupHeadings = v;
          await this.plugin.saveSettings();
        })
      );

    if (Platform.isDesktopApp) this.displayDesktopSettings(containerEl);
    else {
      new Setting(containerEl)
        .setName("Vault output folder")
        .setDesc("Leave empty to save next to the canvas file. On mobile the file is saved in the vault and opened/shared afterwards.")
        .addText((t) =>
          t
            .setPlaceholder("e.g. Exports")
            .setValue(this.plugin.settings.outputFolder)
            .onChange(async (v) => {
              this.plugin.settings.outputFolder = v;
              await this.plugin.saveSettings();
            })
        );
    }
  }

  private displayDesktopSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Layout PDF (as drawn)").setHeading();

    new Setting(containerEl)
      .setName("Page format")
      .setDesc("“Fit to canvas” makes one page sized exactly to the canvas. A4 scales the canvas onto one A4 page.")
      .addDropdown((d) =>
        d
          .addOption("fit", "Fit to canvas (one custom-size page)")
          .addOption("a4-landscape", "A4 landscape")
          .addOption("a4-portrait", "A4 portrait")
          .setValue(this.plugin.settings.pageMode)
          .onChange(async (v) => {
            this.plugin.settings.pageMode = v as PageMode;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Always use light theme")
      .setDesc("Print with the light theme even if Obsidian is in dark mode.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.forceLight).onChange(async (v) => {
          this.plugin.settings.forceLight = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Export method")
      .setDesc(
        "Automatic makes a normal PDF with selectable text and falls back to an image-based PDF if that comes out blank. “Image” always uses the image-based PDF."
      )
      .addDropdown((d) =>
        d
          .addOption("auto", "Automatic")
          .addOption("image", "Image-based PDF only")
          .setValue(this.plugin.settings.exportMethod)
          .onChange(async (v) => {
            this.plugin.settings.exportMethod = v as Settings["exportMethod"];
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Save PDF to")
      .addDropdown((d) =>
        d
          .addOption("vault", "Inside the vault")
          .addOption("ask", "Ask each time (save dialog)")
          .setValue(this.plugin.settings.saveTo)
          .onChange(async (v) => {
            this.plugin.settings.saveTo = v as Settings["saveTo"];
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Vault output folder")
      .setDesc("Leave empty to save next to the canvas file.")
      .addText((t) =>
        t
          .setPlaceholder("e.g. Exports")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (v) => {
            this.plugin.settings.outputFolder = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Save debug HTML")
      .setDesc("Also save the intermediate HTML next to the PDF (for troubleshooting a blank or broken export).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debugHtml).onChange(async (v) => {
          this.plugin.settings.debugHtml = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
