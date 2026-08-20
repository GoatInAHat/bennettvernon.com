import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Both launch.json files point a debugger at this exact port. Fail on a
  // conflict rather than drifting to 5174, which would attach them to
  // whichever other Vite project already holds it.
  server: { port: 5173, strictPort: true },
  resolve: {
    alias: {
      // The party engine is vendored (see vendor/party/README.md); existing
      // imports keep the upstream package name.
      '@cazala/party': fileURLToPath(new URL('./vendor/party/src/index.ts', import.meta.url)),
    },
  },
})
