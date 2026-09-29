// Number and text formatting, Russian units.

const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']

export function bytesParts (n) {
  let value = Math.max(0, n || 0)
  let i = 0
  while (value >= 1024 && i < BYTE_UNITS.length - 1) { value /= 1024; i += 1 }
  const digits = i === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
  return { num: value.toFixed(digits), unit: BYTE_UNITS[i] }
}

export function fmtBytes (n) {
  const { num, unit } = bytesParts(n)
  return `${num} ${unit}`
}

export function rateParts (bytesPerSec) {
  const { num, unit } = bytesParts(bytesPerSec)
  return { num: unit === 'Б' ? '0' : num, unit: `${unit}/с` }
}

export function fmtRate (bytesPerSec) {
  const { num, unit } = rateParts(bytesPerSec)
  return `${num} ${unit}`
}

export function fmtEta (seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return ''
  if (seconds < 60) return 'меньше минуты'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} ч ${minutes % 60} мин`
  return `${Math.round(hours / 24)} дн`
}

/** Russian plural: plural(1, ['пир', 'пира', 'пиров']) → 'пир' */
export function plural (n, forms) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return forms[2]
  if (b > 1 && b < 5) return forms[1]
  if (b === 1) return forms[0]
  return forms[2]
}

export function splitPath (p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i === -1 ? { dir: '', base: p } : { dir: p.slice(0, i + 1), base: p.slice(i + 1) }
}
