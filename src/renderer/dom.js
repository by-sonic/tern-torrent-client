import { TOASTS } from './strings.js'

export const $ = (id) => document.getElementById(id)

export function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const ICON_PATHS = {
  pause: 'M5 3v10M11 3v10',
  play: 'M5 3.5v9l7-4.5z',
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  down: 'M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10',
  up: 'M8 13.5v-8M4.5 9L8 5.5 11.5 9M3 2.5h10',
  check: 'M3.5 8.5l3 3 6-7',
  queue: 'M8 4.5V8l2.5 1.5M8 14.2a6.2 6.2 0 1 0 0-12.4 6.2 6.2 0 0 0 0 12.4z',
  alert: 'M8 6v3M8 11.3v.1M8 2.2l6.4 11.3H1.6z',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.8 10.8l3.5 3.5',
  plus: 'M8 3v10M3 8h10',
  link: 'M6.6 9.4l2.8-2.8M7.2 4.6l.9-.9a2.7 2.7 0 0 1 3.8 3.8l-.9.9M8.8 11.4l-.9.9a2.7 2.7 0 0 1-3.8-3.8l.9-.9',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.8 4.5l.5 9h5.4l.5-9',
  hourglass: 'M4 2.5h8M4 13.5h8M5 2.5c0 3 3 3.5 3 5.5s-3 2.5-3 5.5M11 2.5c0 3-3 3.5-3 5.5s3 2.5 3 5.5',
  globe: 'M8 14.2a6.2 6.2 0 1 0 0-12.4 6.2 6.2 0 0 0 0 12.4zM1.8 8h12.4M8 1.8c2 2 2.6 4 2.6 6.2S10 12.2 8 14.2C6 12.2 5.4 10.2 5.4 8S6 3.8 8 1.8z'
}

export function icon (name) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', ICON_PATHS[name])
  svg.append(path)
  return svg
}

export function iconButton (name, label, onClick) {
  const button = el('button', 'btn btn-quiet')
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.append(icon(name))
  button.addEventListener('click', (event) => { event.stopPropagation(); onClick(event) })
  return button
}

export function toast (key, kind = 'info', text) {
  const node = el('div', 'toast', text || TOASTS[key] || key)
  node.dataset.kind = kind
  $('toasts').append(node)
  setTimeout(() => node.remove(), 3600)
}

/** Run an API call; show a toast instead of throwing into the void. */
export async function run (promise, errorKey = 'failed') {
  try {
    return await promise
  } catch (err) {
    console.error(err)
    toast(errorKey, 'error')
    return undefined
  }
}

export function openDialog (dialog) { if (!dialog.open) dialog.showModal() }
export function closeDialog (dialog) { if (dialog.open) dialog.close() }
