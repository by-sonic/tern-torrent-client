// Benchmark for big-torrent stalls: 6 loopback seeders share a 512 MB / 32 768-piece torrent, then a leecher
// downloads it with the 1.0.0 settings ('old') and the current ones ('new'). It reports main-thread stalls
// (event-loop delay), CPU time, peak memory and duration. Needs no internet; runs at below-normal priority.
// Run: npm run bench   (or: node scripts/bench/run.js new)
const { spawn } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const here = __dirname
const out = path.join(os.tmpdir(), 'tern-stress')

function run (script, args, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, script), ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      const complete = buf.split('\n').slice(0, -1) // the last piece may be an unfinished line
      const line = complete.find((l) => l.startsWith(marker))
      if (line) resolve({ child, data: JSON.parse(line.slice(marker.length + 1)) })
    })
    child.on('exit', (code) => reject(new Error(`${script} exited with ${code}`)))
  })
}

;(async () => {
  console.log('starting 6 local seeders (creates a 512 MB test file the first time)...')
  const seeders = await run('seeders.js', ['6'], 'READY')
  console.log(`seeders ready: ${seeders.data.pieces} pieces, ports ${seeders.data.ports.join(',')}`)
  const results = []
  for (const mode of (process.argv[2] ? [process.argv[2]] : ['old', 'new'])) {
    const r = await run('leecher.js', [mode, seeders.data.ports.join(','), path.join(out, `dl-${mode}`)], 'RESULT')
    r.child.removeAllListeners('exit')
    results.push(r.data)
    console.log(JSON.stringify(r.data))
  }
  seeders.child.removeAllListeners('exit')
  seeders.child.kill()
  fs.rmSync(path.join(out, 'dl-old'), { recursive: true, force: true })
  fs.rmSync(path.join(out, 'dl-new'), { recursive: true, force: true })
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
