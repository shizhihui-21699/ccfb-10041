import { defineConfig, type Plugin } from 'vite';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Copies pdf.js runtime assets (worker, CMaps for CJK encodings, standard
 * fonts) into public/pdfjs so the browser can load them at runtime. Run once
 * per dev-server start / build; skipped when already present.
 */
function pdfjsAssets(): Plugin {
  const target = join(root, 'public', 'pdfjs');
  return {
    name: 'copy-pdfjs-assets',
    buildStart() {
      if (existsSync(join(target, 'pdf.worker.min.mjs'))) return;
      mkdirSync(target, { recursive: true });
      const src = join(root, 'node_modules', 'pdfjs-dist');
      cpSync(join(src, 'build', 'pdf.worker.min.mjs'), join(target, 'pdf.worker.min.mjs'));
      cpSync(join(src, 'cmaps'), join(target, 'cmaps'), { recursive: true });
      cpSync(join(src, 'standard_fonts'), join(target, 'standard_fonts'), { recursive: true });
      this.info('copied pdf.js runtime assets to public/pdfjs');
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssets()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2200,
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
});
