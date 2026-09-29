import { el } from './dom.js'
import { fmtBytes, splitPath } from './format.js'

const views = new WeakMap()

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
  const signature = JSON.stringify(files.map((f) => [f.path, f.length]))
  let view = views.get(list)
  if (!view || list.dataset.sig !== signature || view.showProgress !== showProgress || list.children.length !== files.length) {
    list.dataset.sig = signature
    view = { showProgress, rows: files.map((file, index) => buildRow(file, index, onToggle, showProgress)) }
    views.set(list, view)
    list.replaceChildren(...view.rows.map((row) => row.node))
  }
  files.forEach((file, index) => {
    const { node, box, bar } = view.rows[index]
    if (!box.dataset.busy && box.checked !== file.selected) box.checked = file.selected
    const off = String(!box.checked)
    if (node.dataset.off !== off) node.dataset.off = off
    if (bar) {
      const progress = String(file.progress || 0)
      if (view.rows[index].progress !== progress) {
        view.rows[index].progress = progress
        bar.style.setProperty('--p', progress)
      }
    }
  })
}

function buildRow (file, index, onToggle, showProgress) {
  const { dir, base } = splitPath(file.path)
  const row = el('li', 'file')
  const box = el('input')
  box.type = 'checkbox'
  box.setAttribute('aria-label', file.path)
  // While a toggle is in flight the box keeps what the person clicked; afterwards it follows the engine.
  let pending = 0
  box.addEventListener('change', () => {
    const checked = box.checked
    pending += 1
    box.dataset.busy = '1'
    Promise.resolve().then(() => onToggle(index, checked)).then((selected) => {
      // The detail panel returns the accepted value (e.g. when unchecking the last
      // file was refused). Picker callbacks can keep returning undefined.
      if (pending === 1 && typeof selected === 'boolean') box.checked = selected
    }).catch((err) => console.error(err)).finally(() => {
      pending -= 1
      if (!pending) {
        delete box.dataset.busy
        const off = String(!box.checked)
        if (row.dataset.off !== off) row.dataset.off = off
      }
    })
  })

  const name = el('span', 'file-name')
  if (dir) name.append(el('span', 'file-dir', dir))
  name.append(base)
  name.title = file.path

  row.append(box, name, el('span', 'file-size', fmtBytes(file.length)))
  let fill = null
  if (showProgress) {
    const bar = el('div', 'file-bar')
    fill = el('i')
    bar.append(fill)
    row.append(bar)
  }
  return { node: row, box, bar: fill, progress: null }
}
