// Minimal typings for the pdfmake browser build (it ships without declarations for these paths).
declare module "pdfmake/build/pdfmake" {
  interface PdfDocument {
    getBuffer(callback: (buffer: Uint8Array) => void): void;
  }
  interface PdfMake {
    vfs: Record<string, string>;
    createPdf(definition: object): PdfDocument;
  }
  const pdfMake: PdfMake;
  export default pdfMake;
}

declare module "pdfmake/build/vfs_fonts" {
  const fonts: Record<string, unknown>;
  export default fonts;
}
