import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'

const port = Number(process.env.PORT ?? 3117)

export default defineConfig({
  server: { port, strictPort: true },
  preview: { port, strictPort: true },
  resolve: { tsconfigPaths: true },
  plugins: [tanstackStart({ srcDirectory: 'src' }), viteReact(), nitro()],
})
