import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Writes sw.js into the build, with the list of files that build is made of, so the
// app can open with no signal. See src/serviceWorker.template.js. Build only: the
// dev server never has a service worker in the way.
function serviceWorker() {
  return {
    name: 'pemcora-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const files = [
        ...new Set([
          'index.html',
          ...Object.keys(bundle).filter(name => !name.endsWith('.map')),
          ...readdirSync('public'),
        ]),
      ]
      // Vite puts a hash of its content in every asset's name, so this list changes
      // whenever the build does. The time sorts builds, for keeping the last one.
      const hash = createHash('sha256').update(files.sort().join()).digest('hex').slice(0, 12)
      const build = `${Date.now()}-${hash}`
      const source = readFileSync('src/serviceWorker.template.js', 'utf8')
        .replace('__BUILD__', build)
        .replace('__FILES__', JSON.stringify(files))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

// Relative base so a later GitHub Pages deploy works at any sub-path
// without hardcoding the repo name.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), serviceWorker()],
})
