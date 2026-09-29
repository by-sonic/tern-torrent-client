import { $, run, toast, openDialog, closeDialog } from './dom.js'
import { renderFiles } from './files-list.js'
import { fmtBytes } from './format.js'
import { ADD_TEXT_ERROR } from './strings.js'

// ------------------------------------------------------------------ add

export function initAddDialog () {
  const dialog = $('dlg-add')
  const text = $('add-text')
  const error = $('add-error')

  const openMagnet = () => {
    text.value = ''
    error.hidden = true
    openDialog(dialog)
    text.focus()
  }
  $('add-magnet').addEventListener('click', openMagnet)
  $('add-file').addEventListener('click', () => run(window.tern.pickTorrent(), 'badTorrent'))
  $('add-cancel').addEventListener('click', () => closeDialog(dialog))
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('add-form').requestSubmit() }
  })
  $('add-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      await window.tern.addText(text.value)
      closeDialog(dialog)
    } catch {
      error.textContent = ADD_TEXT_ERROR
      error.hidden = false
    }
  })
}

// ------------------------------------------------------------------ file picker

/** Shows the first torrent that is waiting for a file choice. */
export function createPicker () {
  const dialog = $('dlg-pick')
  let current = null // { id, selected: boolean[], dir, files }

  const selectedBytes = () => current.files.reduce((sum, f, i) => sum + (current.selected[i] ? f.length : 0), 0)

  function refresh () {
    const count = current.selected.filter(Boolean).length
    const total = current.files.length
    $('pick-summary').textContent = `${count} из ${total} файлов`
    $('pick-go').disabled = count === 0
    $('pick-go').textContent = count ? `Скачать · ${fmtBytes(selectedBytes())}` : 'Скачать'
    renderFiles($('pick-files'), current.files.map((f, i) => ({ ...f, selected: current.selected[i] })), {
      onToggle: (index, checked) => { current.selected[index] = checked; refresh() }
    })
  }

  function setAll (value) {
    current.selected = current.selected.map(() => value)
    refresh()
  }

  // Ids already answered: a snapshot sent before the answer was processed must not reopen the dialog.
  const answered = new Set()

  async function cancel () {
    const { id } = current
    answered.add(id)
    current = null
    closeDialog(dialog)
    await run(window.tern.remove(id, false))
  }

  $('pick-all').addEventListener('click', () => setAll(true))
  $('pick-none').addEventListener('click', () => setAll(false))
  $('pick-cancel').addEventListener('click', cancel)
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (current) cancel() })
  $('pick-dir-change').addEventListener('click', async () => {
    const shown = current
    const dir = await run(window.tern.pickFolder(shown.dir))
    if (dir && current === shown) { shown.dir = dir; $('pick-dir').textContent = dir }
  })
  $('pick-go').addEventListener('click', async () => {
    const { id, selected, dir } = current
    answered.add(id)
    current = null
    closeDialog(dialog)
    try {
      await window.tern.confirm(id, { selected, dir })
    } catch (err) {
      console.error(err)
      answered.delete(id) // let the picker come back so nothing is lost
      toast('failed', 'error')
    }
  })

  return {
    /** Bring the dialog back for a torrent that is still waiting for a choice. */
    reopen (state, id) {
      answered.delete(id)
      this.update(state)
    },
    update (state) {
      const choosing = new Set(state.torrents.filter((t) => t.state === 'choosing').map((t) => t.id))
      for (const id of answered) if (!choosing.has(id)) answered.delete(id)
      if (current && !choosing.has(current.id)) {
        current = null
        closeDialog(dialog)
      }
      if (current) return
      const next = state.torrents.find((t) => t.state === 'choosing' && t.files && !answered.has(t.id))
      if (!next) return
      current = { id: next.id, files: next.files, selected: next.files.map(() => true), dir: next.dir }
      $('pick-name').textContent = next.name
      $('pick-dir').textContent = next.dir
      $('pick-files').dataset.sig = ''
      refresh()
      openDialog(dialog)
    }
  }
}

// ------------------------------------------------------------------ settings

export function initSettings (getSettings) {
  const dialog = $('dlg-settings')
  const fields = {
    down: $('set-down'), up: $('set-up'), verify: $('set-verify'), active: $('set-active'),
    seed: $('set-seed'), tray: $('set-tray'), login: $('set-login'), update: $('set-update')
  }
  const save = (patch) => run(window.tern.setSettings(patch))
  const num = (input) => Math.max(0, Math.floor(Number(input.value)) || 0)

  const fill = () => {
    const s = getSettings()
    fields.down.value = s.downLimitKB
    fields.up.value = s.upLimitKB
    fields.verify.value = s.verifyLimitMB ?? 256
    fields.active.value = s.maxActive
    fields.seed.checked = s.seedAfterDone
    fields.tray.checked = s.closeToTray
    fields.login.checked = s.launchAtLogin
    fields.update.checked = s.autoUpdate
    $('set-dir').textContent = s.downloadDir
    $('set-dir').title = s.downloadDir
  }

  $('open-settings').addEventListener('click', () => { fill(); openDialog(dialog) })
  $('set-close').addEventListener('click', () => closeDialog(dialog))
  fields.down.addEventListener('change', () => save({ downLimitKB: num(fields.down) }))
  fields.up.addEventListener('change', () => save({ upLimitKB: num(fields.up) }))
  fields.verify.addEventListener('change', () => save({ verifyLimitMB: Math.min(4096, num(fields.verify)) }))
  fields.active.addEventListener('change', () => save({ maxActive: Math.max(1, num(fields.active)) }))
  fields.seed.addEventListener('change', () => save({ seedAfterDone: fields.seed.checked }))
  fields.tray.addEventListener('change', () => save({ closeToTray: fields.tray.checked }))
  fields.login.addEventListener('change', () => save({ launchAtLogin: fields.login.checked }))
  fields.update.addEventListener('change', () => save({ autoUpdate: fields.update.checked }))
  $('set-dir-change').addEventListener('click', async () => {
    const dir = await run(window.tern.pickFolder(getSettings().downloadDir))
    if (dir) { await save({ downloadDir: dir }); fill() }
  })
  $('set-handler').addEventListener('click', () => registerHandler())
}

export async function registerHandler () {
  try {
    await window.tern.registerHandler()
    toast('handlerOpened')
  } catch (err) {
    console.error(err)
    toast('handlerFailed', 'error')
  }
}
