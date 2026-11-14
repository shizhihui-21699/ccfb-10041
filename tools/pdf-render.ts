/**
 * Renders text blocks to a real PDF (with a CJK font and a text layer) using
 * headless Chrome via playwright-core. Used only at sample-generation time;
 * the app itself never needs Node.
 */
import { chromium, type Browser } from 'playwright-core';

export interface PdfBlock {
  text: string;
  heading?: boolean;
}

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

export interface PdfRenderer {
  render(title: string, blocks: PdfBlock[]): Promise<Uint8Array>;
  close(): Promise<void>;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function launchPdfRenderer(): Promise<PdfRenderer> {
  const executablePath = CHROME_PATHS.find((p) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('node:fs').existsSync(p);
    } catch {
      return false;
    }
  });
  const browser: Browser = await chromium.launch(
    executablePath ? { executablePath, headless: true } : { headless: true },
  );
  const page = await browser.newPage();

  return {
    async render(title, blocks) {
      const body = blocks
        .map((b) =>
          b.heading
            ? `<h2>${esc(b.text)}</h2>`
            : `<p>${esc(b.text)}</p>`,
        )
        .join('\n');
      const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 22mm 18mm; }
  body { font-family: "Songti SC", "Hiragino Sans GB", "Arial Unicode MS", serif; font-size: 11.5pt; line-height: 1.85; color: #111; }
  h2 { font-family: "Heiti SC", "PingFang SC", sans-serif; font-size: 12.5pt; margin: 12pt 0 6pt; }
  p { margin: 0 0 8pt; text-align: justify; }
  footer { position: fixed; bottom: 8mm; font-size: 8pt; color: #666; width: 100%; }
</style></head><body>
${body}
<footer>内部资料 · 仅限授权范围使用</footer>
</body></html>`;
      await page.setContent(html, { waitUntil: 'load' });
      return page.pdf({ format: 'A4', printBackground: true });
    },
    async close() {
      await browser.close();
    },
  };
}
