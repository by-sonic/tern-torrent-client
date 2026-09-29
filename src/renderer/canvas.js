// Canvas drawing: the piece strip and piece mosaic (the signature) and the speed sparkline.
// Live pieces use the logo's cyan-to-azure gradient; finished or idle ones go quiet.

let colors = null
export function refreshColors () {
  const css = getComputedStyle(document.documentElement)
  const get = (name) => css.getPropertyValue(name).trim()
  colors = {
    cyan: get('--cyan'), azure: get('--azure'), ice: get('--ice'),
    muted: get('--muted'), track: get('--track'), line: get('--line')
  }
}

function fit (canvas) {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return null
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return { ctx, w, h }
}

function liveGradient (ctx, x0, y0, x1, y1) {
  const gradient = ctx.createLinearGradient(x0, y0, x1, y1)
  gradient.addColorStop(0, colors.cyan)
  gradient.addColorStop(1, colors.azure)
  return gradient
}

/** Average completeness (0..1) of slice `i` of `count`, from a string of '0'..'9'. */
function sliceValue (pieces, i, count) {
  const m = pieces.length
  if (!m) return 0
  const from = Math.floor((i * m) / count)
  const to = Math.max(from + 1, Math.floor(((i + 1) * m) / count))
  let sum = 0
  for (let k = from; k < to; k++) sum += pieces.charCodeAt(k) - 48
  return sum / ((to - from) * 9)
}

/**
 * One tick per slice of the torrent. Filled ticks are pieces we have,
 * so the strip is the real shape of the download.
 * @param {HTMLCanvasElement} canvas
 * @param {string} pieces  characters '0'..'9', completeness of each slice
 * @param {'live' | 'quiet'} mode  live = logo gradient, quiet = finished or idle
 * @param {{tick?: number, gap?: number}} [shape]
 */
export function drawPieceMap (canvas, pieces, mode, { tick = 3, gap = 2 } = {}) {
  if (!colors) refreshColors()
  const size = fit(canvas)
  if (!size) return
  const { ctx, w, h } = size
  const step = tick + gap
  const ticks = Math.max(1, Math.floor((w + gap) / step))
  const left = (w - (ticks * step - gap)) / 2
  const fill = mode === 'live' ? liveGradient(ctx, left, 0, w - left, 0) : colors.ice

  for (let i = 0; i < ticks; i++) {
    const t = sliceValue(pieces, i, ticks)
    if (t < 0.04) {
      ctx.globalAlpha = 1
      ctx.fillStyle = colors.track
    } else {
      ctx.globalAlpha = (mode === 'live' ? 0.35 : 0.28) + (mode === 'live' ? 0.65 : 0.5) * t
      ctx.fillStyle = fill
    }
    ctx.fillRect(left + i * step, 0, tick, h)
  }
  ctx.globalAlpha = 1
}

/** The torrent as a square of tiles that light up as pieces arrive. */
export function drawMosaic (canvas, pieces, mode) {
  if (!colors) refreshColors()
  const size = fit(canvas)
  if (!size) return
  const { ctx, w, h } = size
  const count = Math.max(1, pieces.length)
  const cols = Math.ceil(Math.sqrt((count * w) / h))
  const rows = Math.ceil(count / cols)
  const gap = 2
  const cell = Math.min((w - gap * (cols - 1)) / cols, (h - gap * (rows - 1)) / rows)
  const left = (w - (cols * cell + gap * (cols - 1))) / 2
  const top = (h - (rows * cell + gap * (rows - 1))) / 2
  const fill = mode === 'live' ? liveGradient(ctx, 0, 0, w, h) : colors.ice

  for (let i = 0; i < count; i++) {
    const t = pieces.length ? (pieces.charCodeAt(i) - 48) / 9 : 0
    const x = left + (i % cols) * (cell + gap)
    const y = top + Math.floor(i / cols) * (cell + gap)
    ctx.globalAlpha = t < 0.04 ? 1 : (mode === 'live' ? 0.3 : 0.25) + (mode === 'live' ? 0.7 : 0.55) * t
    ctx.fillStyle = t < 0.04 ? colors.track : fill
    ctx.beginPath()
    ctx.roundRect(x, y, cell, cell, Math.min(2, cell / 3))
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/** Download speed over the last minute. */
export function drawSpark (canvas, samples) {
  if (!colors) refreshColors()
  const size = fit(canvas)
  if (!size) return
  const { ctx, w, h } = size
  ctx.fillStyle = colors.line
  ctx.fillRect(0, h - 1, w, 1)
  if (samples.length < 2) return

  const max = Math.max(256 * 1024, ...samples) * 1.1
  const x = (i) => (i / (samples.length - 1)) * w
  const y = (v) => h - 2 - (v / max) * (h - 6)

  ctx.beginPath()
  ctx.moveTo(x(0), y(samples[0]))
  for (let i = 1; i < samples.length; i++) {
    const mx = (x(i - 1) + x(i)) / 2
    ctx.bezierCurveTo(mx, y(samples[i - 1]), mx, y(samples[i]), x(i), y(samples[i]))
  }
  ctx.strokeStyle = liveGradient(ctx, 0, 0, w, 0)
  ctx.lineWidth = 1.6
  ctx.lineJoin = 'round'
  ctx.stroke()

  ctx.lineTo(w, h)
  ctx.lineTo(0, h)
  ctx.closePath()
  const fade = ctx.createLinearGradient(0, 0, 0, h)
  fade.addColorStop(0, colors.azure)
  fade.addColorStop(1, 'transparent')
  ctx.globalAlpha = 0.2
  ctx.fillStyle = fade
  ctx.fill()
  ctx.globalAlpha = 1
}
