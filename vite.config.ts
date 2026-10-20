import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: './',
  // The production build generates a self-contained HTML file under preview/.
  // It is an artifact, not a second Vite entry, so keep dependency discovery on
  // the source application only.
  optimizeDeps: { entries: ['index.html'] },
});
