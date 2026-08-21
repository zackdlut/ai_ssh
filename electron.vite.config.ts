import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** Electron's Chromium supports woff2; drop the woff fallback from @fontsource CSS. */
function woff2Only(): Plugin {
  return {
    name: 'woff2-only',
    transform(code, id) {
      if (!id.endsWith('.css') || !code.includes("format('woff')")) return null
      return code.replace(/,\s*url\([^)]+\.woff\)\s*format\('woff'\)/g, '')
    },
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (fileName.endsWith('.woff')) delete bundle[fileName]
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer'),
        katex: resolve(__dirname, 'src/renderer/lib/katexStub.ts')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/@xterm')) return 'xterm'
            if (id.includes('node_modules/mermaid')) return 'mermaid'
            if (id.includes('node_modules/echarts')) return 'echarts'
          }
        }
      }
    },
    plugins: [react(), woff2Only()]
  }
})
