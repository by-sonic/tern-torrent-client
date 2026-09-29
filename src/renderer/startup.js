'use strict'

const byId = (id) => document.getElementById(id)
const TEXT = {
  checking: ['Проверяем обновления', 'Ищем последнюю версию Tern.', 'Подключаемся к серверу обновлений…'],
  downloading: ['Загружаем обновление', 'После загрузки Tern обновится и запустится автоматически.', 'Загружаем установщик…'],
  installing: ['Устанавливаем обновление', 'Tern закроется на время установки и откроется снова.', 'Запускаем установщик…'],
  starting: ['Запускаем Tern', 'Всё готово.', 'Открываем приложение…'],
  error: ['Обновление не завершено', 'Проверь подключение к интернету и повтори попытку. Можно запустить текущую версию.', 'Текущая версия остаётся доступной.']
}

function bytes (value) {
  const number = Math.max(0, Number(value) || 0)
  return `${(number / (1024 * 1024)).toFixed(1)} МБ`
}

let lastStatus = ''
function render (state) {
  const status = TEXT[state.status] ? state.status : 'checking'
  const [title, description, detail] = TEXT[status]
  document.body.dataset.status = status
  byId('startup-title').textContent = title
  byId('startup-description').textContent = state.error === 'update-install-timeout' || (status === 'error' && state.percent === 100)
    ? 'Не удалось запустить установку. Повтори попытку или открой текущую версию Tern.' : description
  byId('startup-version').textContent = state.version ? `Tern ${state.currentVersion} → ${state.version}` : `Tern ${state.currentVersion || ''}`.trim()
  const percent = Math.min(100, Math.max(0, Number(state.percent) || 0))
  const determinate = status === 'downloading' || status === 'installing' || status === 'starting'
  const progress = byId('startup-progress')
  progress.dataset.indeterminate = status === 'checking' ? 'true' : 'false'
  if (determinate) progress.setAttribute('aria-valuenow', status === 'downloading' ? percent : 100)
  else progress.removeAttribute('aria-valuenow')
  byId('startup-progress-fill').style.width = status === 'checking' ? '' : `${status === 'downloading' ? percent : 100}%`
  byId('startup-percent').hidden = status !== 'downloading'
  byId('startup-percent').textContent = `${percent}%`
  byId('startup-transfer').textContent = status === 'downloading' && state.total > 0
    ? `${bytes(state.transferred)} из ${bytes(state.total)}${state.bytesPerSecond > 0 ? ` · ${bytes(state.bytesPerSecond)}/с` : ''}` : detail
  const stage = status === 'error' ? state.failedStage || 'checking' : status
  const step = stage === 'checking' ? 0 : stage === 'downloading' ? 1 : 2
  for (const [index, id] of ['check', 'download', 'install'].entries()) {
    const item = byId(`startup-step-${id}`)
    if (index === step) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current')
    item.dataset.done = index < step ? 'true' : 'false'
  }
  byId('startup-actions').hidden = status !== 'error'
  if (status !== lastStatus) {
    byId('startup-announcement').textContent = title
    if (status === 'error') byId('startup-continue').focus()
    lastStatus = status
  }
}

byId('startup-close').addEventListener('click', () => void window.ternStartup.quit())
byId('startup-retry').addEventListener('click', () => void window.ternStartup.retry())
byId('startup-continue').addEventListener('click', () => void window.ternStartup.continue())
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); void window.ternStartup.quit() }
})
window.ternStartup.onState(render)
void window.ternStartup.getState().then(render)
