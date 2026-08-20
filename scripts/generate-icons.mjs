// Rasterises build/icon.svg into the artifacts electron-builder and the
// renderer need. The SVG is the only source of truth; never hand-edit outputs.
//
// Requires two build-only converters that are deliberately not tracked in
// package.json (sharp pulls a large native binary that CI does not need):
//   npm i --no-save sharp png-to-ico
// Then: node scripts/generate-icons.mjs

import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')
const source = join(outDir, 'icon.svg')
const smallSource = join(outDir, 'icon-small.svg')

// electron-builder derives .icns and the smaller Linux sizes from icon.png, so
// the master raster has to be 1024 to keep macOS retina slices sharp.
const MASTER_SIZE = 1024
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
// Below this the full mark's mesh links stop resolving, so ICO frames switch
// to the simplified artwork.
const SMALL_ART_MAX = 32

const render = (svg, size) =>
  sharp(svg, { density: 384 }).resize(size, size, { fit: 'contain' }).png().toBuffer()

const svg = await readFile(source)
const smallSvg = await readFile(smallSource)
await mkdir(outDir, { recursive: true })

const master = await render(svg, MASTER_SIZE)
await writeFile(join(outDir, 'icon.png'), master)

const icoFrames = await Promise.all(
  ICO_SIZES.map((size) => render(size <= SMALL_ART_MAX ? smallSvg : svg, size))
)
await writeFile(join(outDir, 'icon.ico'), await pngToIco(icoFrames))

// The renderer cannot import from outside its Vite root, so it gets a copy.
await copyFile(source, join(root, 'src', 'renderer', 'icon.svg'))

console.log(`icon.png ${MASTER_SIZE}px, icon.ico [${ICO_SIZES.join(' ')}], renderer favicon`)
