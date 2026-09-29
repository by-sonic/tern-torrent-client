'use strict'

// Builds every brand image from assets/logo-source.png (the full logo with the wordmark):
//   assets/logo.png   the bird alone on transparency, for the sidebar and empty state
//   assets/icon.png   256px app icon: the bird on a deep-navy tile
//   assets/tray.png   32px tray icon
//   assets/icon.ico   16 to 256px, used by the installer and the .exe
// Run: npm run icons

const fs = require('node:fs')
const path = require('node:path')
const { PNG } = require('pngjs')

const ASSETS = path.join(__dirname, '..', 'assets')
const WORDMARK_TOP = 700 // everything below this row of the source is the "Tern" wordmark
const TILE_TOP = [0x14, 0x25, 0x52]
const TILE_BOTTOM = [0x06, 0x0c, 0x1c]
const BIRD_SHARE = 0.8 // bird width as a share of the icon
const SS = 4

/** Smallest rectangle holding every visible pixel above the wordmark. */
function birdBounds (png) {
  let x0 = png.width; let x1 = 0; let y0 = png.height; let y1 = 0
  for (let y = 0; y < Math.min(WORDMARK_TOP, png.height); y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.data[(y * png.width + x) * 4 + 3] > 12) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

function crop (png, { x, y, w, h }) {
  const out = new PNG({ width: w, height: h })
  PNG.bitblt(png, out, x, y, w, h, 0, 0)
  return out
}

/** Area-average downscale on premultiplied alpha (no dark fringes at the edges). */
function resize (src, width, height) {
  const out = new PNG({ width, height })
  const sx = src.width / width
  const sy = src.height / height
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fx0 = x * sx; const fx1 = (x + 1) * sx; const fy0 = y * sy; const fy1 = (y + 1) * sy
      let r = 0; let g = 0; let b = 0; let a = 0; let weight = 0
      for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
        for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
          const w = (Math.min(fx1, xx + 1) - Math.max(fx0, xx)) * (Math.min(fy1, yy + 1) - Math.max(fy0, yy))
          const i = (Math.min(src.height - 1, yy) * src.width + Math.min(src.width - 1, xx)) * 4
          const alpha = src.data[i + 3] / 255
          r += src.data[i] * alpha * w; g += src.data[i + 1] * alpha * w; b += src.data[i + 2] * alpha * w
          a += alpha * w; weight += w
        }
      }
      const o = (y * width + x) * 4
      if (a > 0) { out.data[o] = r / a; out.data[o + 1] = g / a; out.data[o + 2] = b / a }
      out.data[o + 3] = Math.round((a / weight) * 255)
    }
  }
  return out
}

function tileCoverage (x, y) {
  const r = 0.24
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  return Math.hypot(x - cx, y - cy) <= r ? 1 : 0
}

/** The bird centred on the rounded navy tile, `size` px square. */
function icon (bird, size) {
  const birdW = Math.round(size * BIRD_SHARE)
  const birdH = Math.round((birdW * bird.height) / bird.width)
  const scaled = resize(bird, birdW, birdH)
  const left = Math.round((size - birdW) / 2)
  const top = Math.round((size - birdH) / 2)
  const out = new PNG({ width: size, height: size })

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) cover += tileCoverage((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)
      cover /= SS * SS
      if (!cover) continue
      const t = y / size
      const base = TILE_TOP.map((c, i) => c + (TILE_BOTTOM[i] - c) * t)
      let [r, g, b] = base
      const bx = x - left
      const by = y - top
      if (bx >= 0 && by >= 0 && bx < birdW && by < birdH) {
        const i = (by * birdW + bx) * 4
        const a = scaled.data[i + 3] / 255
        r = scaled.data[i] * a + r * (1 - a)
        g = scaled.data[i + 1] * a + g * (1 - a)
        b = scaled.data[i + 2] * a + b * (1 - a)
      }
      const o = (y * size + x) * 4
      out.data[o] = Math.round(r); out.data[o + 1] = Math.round(g); out.data[o + 2] = Math.round(b)
      out.data[o + 3] = Math.round(cover * 255)
    }
  }
  return out
}

function ico (images) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = 6 + images.length * 16
  const dir = images.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size; e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([head, ...dir, ...images.map((i) => i.data)])
}

const source = PNG.sync.read(fs.readFileSync(path.join(ASSETS, 'logo-source.png')))
const bounds = birdBounds(source)
const pad = Math.round(bounds.w * 0.02)
const birdOnly = crop(source, {
  x: Math.max(0, bounds.x - pad), y: Math.max(0, bounds.y - pad),
  w: Math.min(source.width - Math.max(0, bounds.x - pad), bounds.w + pad * 2),
  h: Math.min(source.height - Math.max(0, bounds.y - pad), bounds.h + pad * 2)
})

const logoWidth = 512
const logo = resize(birdOnly, logoWidth, Math.round((logoWidth * birdOnly.height) / birdOnly.width))
fs.writeFileSync(path.join(ASSETS, 'logo.png'), PNG.sync.write(logo))
fs.writeFileSync(path.join(ASSETS, 'icon.png'), PNG.sync.write(icon(birdOnly, 256)))
fs.writeFileSync(path.join(ASSETS, 'tray.png'), PNG.sync.write(icon(birdOnly, 32)))
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico([256, 64, 48, 32, 16].map((size) => ({ size, data: PNG.sync.write(icon(birdOnly, size)) }))))
console.log('bird', bounds, '→ logo', logo.width, 'x', logo.height)
