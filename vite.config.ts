import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 建置成單一 index.html：雙擊就能以 file:// 開啟，不需要任何 server。
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 2000,
  },
});
