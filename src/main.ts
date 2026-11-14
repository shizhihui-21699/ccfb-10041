/**
 * Browser entry: wires pdf.js to its worker and asset URLs, then boots the
 * console. Keeping this here (rather than in the parser) lets the same parser
 * module run in Node for tests and sample evaluation.
 */
import workerSrc from '/pdfjs/pdf.worker.min.mjs?url';
import { setPdfRuntime } from './parsers/pdf';

setPdfRuntime({
  workerSrc,
  cMapUrl: 'pdfjs/cmaps/',
  standardFontDataUrl: 'pdfjs/standard_fonts/',
});

await import('./ui/tokens.css');
await import('./ui/leak-console');

const root = document.getElementById('app');
if (root) {
  root.innerHTML = '<leak-console></leak-console>';
}
