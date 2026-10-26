import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    host: true // exposes to local network for testing on real iOS & Android phones!
  },
  base: './' // Allows deployment to GitHub Pages on any subdirectory
});
