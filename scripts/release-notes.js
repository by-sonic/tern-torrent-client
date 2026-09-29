'use strict'

// Prints the CHANGELOG.md section for a tag, for the GitHub release notes.
// Usage: node scripts/release-notes.js v1.2.3 [output-file]
// With an output file it is written as UTF-8 (safe for non-ASCII text); otherwise it goes to stdout.

const fs = require('node:fs')
const path = require('node:path')

/**
 * @param {string} changelog  the whole CHANGELOG.md
 * @param {string} tag        e.g. "v1.2.3"
 * @returns {string} the section body, or a short fallback
 */
function sectionFor (changelog, tag) {
  const version = tag.replace(/^v/, '')
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`))
  if (start === -1) return `Release ${tag}. See CHANGELOG.md for details.`
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## ['))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

if (require.main === module) {
  const tag = process.argv[2]
  if (!tag) { console.error('usage: node scripts/release-notes.js <tag>'); process.exit(1) }
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
  const notes = `${sectionFor(changelog, tag)}\n`
  if (process.argv[3]) fs.writeFileSync(process.argv[3], notes, 'utf8')
  else process.stdout.write(notes)
}

module.exports = { sectionFor }
