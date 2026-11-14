declare module 'pdfjs-dist/build/pdf.mjs' {
  export interface PdfTextItemLike {
    str: string;
    transform: number[];
    width: number;
    height: number;
    hasEOL?: boolean;
  }
  export interface PdfPageProxy {
    getTextContent(): Promise<{ items: PdfTextItemLike[] }>;
  }
  export interface PdfDocumentProxy {
    numPages: number;
    getPage(n: number): Promise<PdfPageProxy>;
  }
  export interface DocumentInitParameters {
    data?: Uint8Array;
    useWorkerFetch?: boolean;
    isEvalSupported?: boolean;
    disableFontFace?: boolean;
    cMapUrl?: string;
    cMapPacked?: boolean;
    standardFontDataUrl?: string;
  }
  export interface PDFDocumentLoadingTask {
    promise: Promise<PdfDocumentProxy>;
  }
  export function getDocument(src: DocumentInitParameters): PDFDocumentLoadingTask;
  export const GlobalWorkerOptions: { workerSrc: string; workerPort?: Worker | null };
  export const version: string;
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const src: string;
  export default src;
}
