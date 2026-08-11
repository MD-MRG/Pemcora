// Runs the thirteen localStorage suites and summarises them.
//
//   npm test            (dev server must already be on 5173)
//
// Exists because these are only useful if something actually runs them: the
// auth gate in PR #3 broke all 220 checks and nobody noticed for two merges.
// CI calls this, and so can you.
//
// It deliberately does NOT include rls.mjs or supabase-e2e.mjs — both need
// credentials and write to the live project, which is not something a pull
// request from a fork should be able to trigger.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const SUITES = [
  'shell',
  'home',
  'new-client-form',
  'new-client-locations',
  'edit-client',
  'pm-visits',
  'pm-room-tests',
  'pm-export',
  'commissioning',
  'custom-list',
  'teams',
  'settings',
  'template-editor',
]

// Fail fast and clearly. Without this, every suite times out one after another
// and thirty minutes later you get ten identical stack traces instead of
// "the dev server is not running".
try {
  const res = await fetch(BASE, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
} catch (e) {
  console.error(`\nCannot reach the dev server at ${BASE} — ${e.message}`)
  console.error('Start it with `npm run dev` first.\n')
  console.error('It must be the DEV server, not `npm run preview`: test mode is')
  console.error('gated on import.meta.env.DEV, so a production build ignores it')
  console.error('and every suite stops at the sign-in screen.\n')
  process.exit(1)
}

const run = suite =>
  new Promise(resolve => {
    // cwd pinned to the project root rather than inherited — running from
    // anywhere else silently finds no suites and reports zero checks, which
    // reads exactly like a clean pass.
    const child = spawn(process.execPath, [join(HERE, `${suite}.mjs`), HERE], {
      cwd: join(HERE, '..'),
      env: { ...process.env, PEMCORA_BASE: BASE },
    })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('close', code => resolve({ out, code }))
  })

let totalPass = 0
let totalFail = 0
const broken = []

console.log(`\nRunning ${SUITES.length} suites against ${BASE}\n`)

for (const suite of SUITES) {
  const { out, code } = await run(suite)
  const lines = out.split('\n')
  const pass = lines.filter(l => l.startsWith('PASS')).length
  const fail = lines.filter(l => l.startsWith('FAIL')).length
  totalPass += pass
  totalFail += fail

  // A suite that exits non-zero having reported nothing has crashed, not
  // passed. Counting only PASS/FAIL lines would score that as a clean run.
  const crashed = code !== 0 && fail === 0
  if (crashed) broken.push(suite)

  const status = fail > 0 ? 'FAIL' : crashed ? 'CRASH' : 'ok'
  console.log(`${suite.padEnd(24)} ${String(pass).padStart(3)} pass  ${String(fail).padStart(3)} fail  ${status}`)

  if (fail > 0) for (const l of lines.filter(l => l.startsWith('FAIL'))) console.log(`    ${l}`)
  if (crashed) console.log(out.split('\n').slice(-12).map(l => `    ${l}`).join('\n'))
}

console.log(`\n${'-'.repeat(56)}`)
console.log(`${totalPass + totalFail} checks · ${totalPass} passed · ${totalFail} failed` +
  (broken.length ? ` · ${broken.length} suite(s) crashed` : ''))

const ok = totalFail === 0 && broken.length === 0
console.log(ok ? 'All suites green.\n' : 'Suite run FAILED.\n')
process.exit(ok ? 0 : 1)
