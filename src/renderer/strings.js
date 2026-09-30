// Every user-facing string that is not in index.html lives here.

export const STATE_LABEL = {
  metadata: 'Получаю данные',
  choosing: 'Выбор файлов',
  checking: 'Проверка файлов',
  connecting: 'Ищу пиров',
  downloading: 'Скачивается',
  seeding: 'Раздаётся',
  done: 'Готово',
  paused: 'Пауза',
  queued: 'В очереди',
  error: 'Ошибка'
}

export const TOASTS = {
  failed: 'Не получилось. Попробуй ещё раз.',
  engineUnavailable: 'Движок загрузки остановился. Перезапусти Tern, чтобы продолжить.',
  duplicate: 'Этот торрент уже в списке',
  badTorrent: 'Не удалось прочитать торрент. Проверь файл или ссылку.',
  notTorrent: 'Это не .torrent-файл и не magnet-ссылка',
  handlerOpened: 'Windows открыла «Приложения по умолчанию». Выбери там Tern.',
  handlerFailed: 'Не удалось зарегистрировать Tern в Windows'
}

export const ERRORS = {
  'engine-process-exited': 'Движок загрузки остановился. Перезапусти Tern, чтобы продолжить.',
  'no-source': 'Нет данных торрента. Удали его и добавь заново.',
  'not-a-torrent': 'Это не похоже на magnet-ссылку или хеш торрента.',
  'too-many-files': 'В торренте слишком много файлов (больше 10 000).'
}

export const ADD_TEXT_ERROR = 'Вставь magnet-ссылку (magnet:?xt=urn:btih:…) или 40-символьный хеш.'

export const REMOVE_TEXT = {
  confirm: 'Удалить',
  busy: 'Удаление…',
  removing: 'Удаляю торрент из списка…',
  trashing: 'Останавливаю торрент и перемещаю файлы в корзину…',
  failed: 'Не удалось удалить торрент. Попробуй ещё раз.'
}

export function removalWarning (result) {
  if (!result?.removed) return ''
  const messages = []
  if (result.failed) messages.push(`Не удалось удалить файлов: ${result.failed}.`)
  if (result.skipped) messages.push(`Оставлено файлов, которые нельзя безопасно удалить: ${result.skipped}.`)
  if (result.sourceUnavailable) messages.push('Исходный .torrent не удалён: его путь не сохранён.')
  return messages.length ? `Торрент удалён из списка. ${messages.join(' ')}` : ''
}
