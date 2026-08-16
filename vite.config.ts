import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The party engine is vendored (see vendor/party/README.md); existing
      // imports keep the upstream package name.
      '@cazala/party': fileURLToPath(new URL('./vendor/party/src/index.ts', import.meta.url)),
    },
  },
})
