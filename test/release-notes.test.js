'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sectionFor } = require('../scripts/release-notes')

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.1.0] - 2026-10-10

### Added
- Second thing.

## [1.0.0] - 2026-09-29

### Added
- First thing.
`

test('returns only the section of the requested version', () => {
  const notes = sectionFor(CHANGELOG, 'v1.1.0')
  assert.match(notes, /Second thing/)
  assert.doesNotMatch(notes, /First thing/)
})

test('works for the last section and accepts a tag without the v', () => {
  assert.match(sectionFor(CHANGELOG, '1.0.0'), /First thing/)
})

test('falls back to a short line for an unknown version', () => {
  assert.match(sectionFor(CHANGELOG, 'v9.9.9'), /Release v9\.9\.9/)
})

test('the real changelog has a section for the current package version', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { version } = require('../package.json')
  const real = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8')
  assert.doesNotMatch(sectionFor(real, `v${version}`), /See CHANGELOG\.md/, `CHANGELOG.md needs a "## [${version}]" section`)
})
