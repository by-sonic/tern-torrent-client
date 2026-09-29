import { el } from './dom.js'
import { fmtBytes, splitPath } from './format.js'

/**
 * Renders a checkbox list of torrent files into `list`.
 * Rebuilds only when the set of files changes; otherwise updates in place,
 * so a checkbox the person is holding does not flicker every second.
 *
 * @param {HTMLElement} list
 * @param {{path: string, length: number, selected: boolean, progress?: number}[]} files
 * @param {{ onToggle: (index: number, checked: boolean) => void | Promise<void>, showProgress?: boolean }} options
 */
export function renderFiles (list, files, { onToggle, showProgress = false }) {
  const signature = files.map((f) => `${f.path}:${f.length}`).join('|')
  if (list.dataset.sig !== signature) {
    list.dataset.sig = signature
    list.replaceChildren(...files.map((file, index) => buildRow(file, index, onToggle, showProgress)))
  }
  files.forEach((file, index) => {
    const row = list.children[index]
    const box = row.querySelector('input')
    if (!box.dataset.busy) box.checked = file.selected
    row.dataset.off = String(!file.selected)
    if (showProgress) row.querySelector('.file-bar > i').style.setProperty('--p', String(file.progress || 0))
  })
}

function buildRow (file, index, onToggle, showProgress) {
  const { dir, base } = splitPath(file.path)
  const row = el('li', 'file')
  const box = el('input')
  box.type = 'checkbox'
  box.setAttribute('aria-label', file.path)
  // While a toggle is in flight the box keeps what the person clicked; afterwards it follows the engine.
  box.addEventListener('change', () => {
    box.dataset.busy = '1'
    Promise.resolve(onToggle(index, box.checked)).finally(() => { delete box.dataset.busy })
  })

  const name = el('span', 'file-name')
  if (dir) name.append(el('span', 'file-dir', dir))
  name.append(base)
  name.title = file.path

  row.append(box, name, el('span', 'file-size', fmtBytes(file.length)))
  if (showProgress) {
    const bar = el('div', 'file-bar')
    bar.append(el('i'))
    row.append(bar)
  }
  return row
}
