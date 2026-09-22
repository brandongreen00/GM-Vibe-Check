import { defineConfig } from 'vitest/config';

// GitHub Pages serves this project from https://<user>.github.io/GM-Vibe-Check/
// The base path must match the repository name, and it is also what the
// onboarding screen computes as the redirect URI the user registers with Spotify.
export default defineConfig(({ command, isPreview }) => ({
  // The dev server alone runs at the origin root, so the documented local redirect URI
  // (http://127.0.0.1:5173/) matches byte-for-byte, which Spotify requires. `vite preview`
  // serves the real build, so it keeps the Pages sub-path.
  base: command === 'serve' && !isPreview ? '/' : '/GM-Vibe-Check/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
