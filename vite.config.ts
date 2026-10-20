import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: './',
  // The production build generates a self-contained HTML file under preview/.
  // It is an artifact, not a second Vite entry, so keep dependency discovery on
  // the source application only.
  optimizeDeps: { entries: ['index.html'] },
  server: {
    proxy: {
      '/three-chess/socket.io': { target: 'http://127.0.0.1:3000', ws: true },
      '/three-chess/api': { target: 'http://127.0.0.1:3000' },
    },
  },
});
