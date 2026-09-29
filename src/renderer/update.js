import { $, run } from './dom.js'

const STATUS_TEXT = {
  disabled: 'Обновления работают только в установленной версии.',
  idle: 'Установлена последняя версия.',
  checking: 'Проверяю…',
  installing: 'Устанавливаю обновление…'
}

/** Show the update banner, the version line and the "check now" control. */
export async function initUpdates () {
  let version = ''
  let dismissed = ''

  const banner = $('update-banner')
  const status = $('update-status')

  function render (u) {
    const line = versionLine(u)
    status.textContent = line
    const busy = u.status === 'checking' || u.status === 'downloading' || u.status === 'installing'
    $('update-check').disabled = busy || u.status === 'ready' || u.status === 'disabled'

    const showBanner = (u.status === 'downloading' || u.status === 'ready') && dismissed !== `${u.status}:${u.version}`
    banner.hidden = !showBanner
    $('update-install').hidden = u.status !== 'ready'
    if (showBanner) {
      $('update-text').textContent = u.status === 'ready'
        ? `Tern ${u.version} готов. Обновление установится при перезапуске.`
        : `Загружаю Tern ${u.version}… ${u.percent}%`
    }
    banner.dataset.status = u.status
    banner.dataset.key = `${u.status}:${u.version}`
  }

  function versionLine (u) {
    const head = version ? `Версия ${version}. ` : ''
    if (u.status === 'downloading') return `${head}Загружаю ${u.version}… ${u.percent}%`
    if (u.status === 'ready') return `${head}Версия ${u.version} готова к установке.`
    if (u.status === 'error') return `${head}Не удалось проверить обновления. Проверь интернет и попробуй позже.`
    return head + STATUS_TEXT[u.status]
  }

  $('update-check').addEventListener('click', () => run(window.tern.checkForUpdates()))
  $('update-install').addEventListener('click', () => run(window.tern.installUpdate()))
  $('update-dismiss').addEventListener('click', () => { dismissed = banner.dataset.key; banner.hidden = true })

  window.tern.onUpdate(render)
  const info = await window.tern.appInfo()
  version = info.version
  render(info.update)
}
