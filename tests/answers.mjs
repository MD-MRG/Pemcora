/**
 * Step C1d: every answer type in a room, readings with units, and suggested notes.
 *
 * Runs the rules in Node first, then the real screens in a browser in test mode:
 * a Custom List built with one test of each type and suggested wording, worked
 * through room by room as a technician would.
 *
 *   node tests/answers.mjs [screenshot dir]     (dev server on 5173)
 *
 * What it holds the app to:
 *   - each type records what testTypes.js says it keeps, and a reading keeps its unit
 *   - a No, or a reading outside its limits, opens the note box as FAIL does
 *   - the note box offers the list's suggestions; the one with [timeframe] asks for it
 *   - a visit can't be finished, or exported, while a note still says [timeframe]
 *   - an admin rewords the suggestions in Settings, and an AV list shows none
 */
import { chromium } from 'playwright-core'
import { testContext } from './harness.mjs'

const DIR = process.argv[2] ?? '.'
const BASE = process.env.PEMCORA_BASE ?? 'http://localhost:5173/'

const log = (k, v, extra = '') => console.log(`${v ? 'PASS' : 'FAIL'}  ${k}${extra ? ' — ' + extra : ''}`)

// ── The rules ───────────────────────────────────────────────────────────────
const { fillTimeframe, holdsTimeframe, noteIsFinished, notesAwaitingTimeframe } = await import('../src/lib/testTypes.js')

log('a note holding [timeframe] is found, whatever its case', holdsTimeframe('Fix within [Timeframe].') && !holdsTimeframe('Fix within 3 months.') && !holdsTimeframe(null))
log('and is not finished', !noteIsFinished('Fix within [timeframe].') && noteIsFinished('Fix within 3 months.'))
log('the timeframe goes in its place', fillTimeframe('Recommended within [timeframe].', ' 3 months ') === 'Recommended within 3 months.')

const LIST = {
  tests: [{ id: 'a', label: 'A' }],
  sections: [
    { id: 'off', label: 'Off', tests: [{ id: 'b', label: 'B' }] },
    { id: 'si', label: 'Each alarm', scope: 'item', assetType: 'smoke_alarm', tests: [{ id: 'k', label: 'K' }] },
  ],
}
const visit = {
  rooms: {
    r1: { template: LIST, results: { main: { a: 'FAIL' } }, sections: {}, troubleshooting: { a: 'Within [timeframe]' } },
    // A fail in a section switched off: its note can't be seen, so it can't be held against finishing.
    r2: { template: LIST, results: { main: {}, off: { b: 'FAIL' } }, sections: { off: false }, troubleshooting: { b: 'Within [timeframe]' } },
    r3: { template: LIST, results: { main: { a: 'FAIL' } }, sections: {}, troubleshooting: { a: 'Within 3 months' } },
  },
  siteResults: { template: LIST, results: { si: { alarm1: { k: 'FAIL' } } }, troubleshooting: { 'alarm1:k': '[timeframe]' } },
}
log('an open visit\'s unfinished notes are found, room by room and in the whole-site step',
  notesAwaitingTimeframe(visit).join() === 'r1,site', notesAwaitingTimeframe(visit).join())
log('none in a visit with none', notesAwaitingTimeframe({ rooms: {} }).length === 0 && notesAwaitingTimeframe(null).length === 0)

// ── The screens ─────────────────────────────────────────────────────────────
async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true })
    } catch {}
  }
  return await chromium.launch({ headless: true })
}

const SUGGESTIONS = [
  'Fail – does not comply. Repair or replacement is mandatory.',
  'Fail – still complies. Repair or replacement recommended within [timeframe].',
]
const TEMPLATE = {
  mainLabel: 'Main test list',
  failNotes: SUGGESTIONS,
  tests: [
    { id: 't1', label: 'Lamp works', order: 0 },
    { id: 't2', label: 'Cover fitted', type: 'yesno', order: 1 },
    { id: 't3', label: 'Kitchen', type: 'choice', options: ['Included', 'Not applicable', 'Not included'], order: 2 },
    { id: 't4', label: 'Insulation resistance', type: 'measure', unit: 'MΩ', min: 1, order: 3 },
    { id: 't5', label: 'Circuit protected', type: 'text', order: 4 },
    { id: 't6', label: 'Earth continuity', type: 'measure', unit: 'Ω', order: 5 },
  ],
  sections: [],
}
const SEED = [
  {
    id: 'c1',
    name: 'Typed Co',
    locations: [
      {
        id: 'l1',
        address: '1 Volt St',
        suburb: 'Ohmsville',
        city: 'Melbourne',
        state: 'VIC',
        postcode: '3000',
        floors: [{ id: 'f1', label: 'Ground', rooms: [{ id: 'r1', name: 'Kitchen', planNumber: '' }] }],
        visits: [],
      },
    ],
  },
]

const browser = await launch()
const pageErrors = []
try {
  const ctx = await testContext(browser, { viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('pageerror', e => pageErrors.push(e.message))

  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.evaluate(([seed, template]) => {
    localStorage.setItem('fc.clients', JSON.stringify(seed))
    localStorage.setItem('fc.templates', JSON.stringify({ custom: template }))
  }, [SEED, TEMPLATE])
  await page.goto(BASE + '#/custom-list', { waitUntil: 'networkidle' })
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('tbody tr').filter({ hasText: 'Typed Co' }).click()
  await page.locator('tbody tr').filter({ hasText: '1 Volt St' }).click()
  await page.getByRole('button', { name: 'Start custom list' }).click()
  await page.getByRole('button', { name: /^Kitchen/ }).click()

  const entry = () =>
    page.evaluate(() => {
      const visit = JSON.parse(localStorage.getItem('fc.clients'))[0].locations[0].visits[0]
      return visit.rooms.r1 ?? {}
    })
  const press = (test, label) => page.getByRole('button', { name: `${test}: ${label}`, exact: true }).click()
  const noteBox = test => page.getByRole('textbox', { name: test, exact: true })

  log('a PASS / FAIL / N/A test is as it always was', (await page.getByRole('button', { name: 'Lamp works: PASS', exact: true }).count()) === 1)

  await press('Cover fitted', 'No')
  let e = await entry()
  log('a yes/no test records NO', e.results?.main?.t2 === 'NO', JSON.stringify(e.results))
  log('and a No opens the note box', (await noteBox('Cover fitted').count()) === 1)
  const offered = page.getByRole('group', { name: 'Suggested notes for Cover fitted' }).getByRole('button')
  log('which offers the list\'s suggestions', (await offered.count()) === 2)
  await offered.first().click()
  log('choosing one fills the note', (await noteBox('Cover fitted').inputValue()) === SUGGESTIONS[0])
  await noteBox('Cover fitted').fill(SUGGESTIONS[0] + ' Cover cracked.')
  log('which stays editable', (await entry()).troubleshooting?.t2 === SUGGESTIONS[0] + ' Cover cracked.')

  await press('Kitchen', 'Not included')
  log('a choice records the option\'s text', (await entry()).results?.main?.t3 === 'Not included')
  log('and is never a fail', (await noteBox('Kitchen').count()) === 0)

  await page.getByLabel('Circuit protected', { exact: true }).fill('Kitchen GPOs')
  log('a text answer records what was typed', (await entry()).results?.main?.t5 === 'Kitchen GPOs')

  await page.getByLabel('Earth continuity reading').fill('0.3')
  e = await entry()
  log('a reading is kept with its unit', e.readings?.main?.t6?.value === '0.3' && e.readings.main.t6.unit === 'Ω', JSON.stringify(e.readings))
  log('with no limits it gives no verdict', !e.results?.main?.t6)

  await page.getByLabel('Insulation resistance reading').fill('0.5')
  e = await entry()
  log('a reading under its minimum is a FAIL', e.results?.main?.t4 === 'FAIL' && e.readings?.main?.t4?.unit === 'MΩ', JSON.stringify(e.results))
  log('and opens the note box', (await noteBox('Insulation resistance').count()) === 1)
  const second = page.getByRole('group', { name: 'Suggested notes for Insulation resistance' }).getByRole('button').nth(1)
  await second.click()
  log('the suggestion with [timeframe] asks for it first', (await page.getByLabel('Timeframe').count()) === 1 && (await noteBox('Insulation resistance').inputValue()) === '')
  await page.getByLabel('Timeframe').fill('3 months')
  await page.getByRole('button', { name: 'Use', exact: true }).click()
  log('and puts it in', (await noteBox('Insulation resistance').inputValue()) === 'Fail – still complies. Repair or replacement recommended within 3 months.',
    await noteBox('Insulation resistance').inputValue())
  const insulationSuggestions = page.getByRole('group', { name: 'Suggested notes for Insulation resistance' }).getByRole('button')
  log('once there is a note, the suggestions step aside', (await insulationSuggestions.count()) === 0)
  await page.getByRole('button', { name: 'Suggested wording', exact: true }).last().click()
  log('and come back when asked for', (await insulationSuggestions.count()) === 2)
  await page.evaluate(() => document.querySelector('main .overflow-auto')?.scrollTo(0, 0))
  await page.screenshot({ path: `${DIR}/answers-room.png` })

  // Left saying [timeframe], the visit can't be finished.
  await noteBox('Insulation resistance').fill('Recommended within [timeframe].')
  log('a note still saying [timeframe] says so', /can.t be finished while a note still says \[timeframe\]/.test(await page.textContent('main')))
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await page.getByRole('button', { name: 'Finish visit' }).click()
  log('finishing is refused, naming the room', /A note still says \[timeframe\]/.test(await page.textContent('main')) && (await page.getByRole('dialog').count()) === 0)
  log('and so is exporting, which would finish it', await (async () => {
    await page.getByRole('button', { name: 'Export report' }).click()
    await page.waitForTimeout(300)
    const v = await page.evaluate(() => JSON.parse(localStorage.getItem('fc.clients'))[0].locations[0].visits[0])
    return !v.completedAt && (v.exports ?? []).length === 0
  })())
  await page.screenshot({ path: `${DIR}/answers-refused.png` })

  await page.getByRole('button', { name: /^Kitchen/ }).click()
  await noteBox('Insulation resistance').fill('Recommended within 6 months.')
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await page.getByRole('button', { name: 'Finish visit' }).click()
  log('filled in, it can be finished', (await page.getByRole('dialog').count()) === 1)
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()

  // N/A on a failed reading: the note goes, after asking, and so does the reading.
  await page.getByRole('button', { name: /^Kitchen/ }).click()
  await press('Insulation resistance', 'N/A')
  log('leaving a fail that has a note asks first', (await page.getByRole('dialog').count()) === 1)
  await page.getByRole('dialog').getByRole('button', { name: 'Discard notes' }).click()
  e = await entry()
  log('N/A clears the reading and the note',
    e.results?.main?.t4 === 'NA' && !e.readings?.main?.t4 && !('t4' in (e.troubleshooting ?? {})), JSON.stringify({ r: e.results, rd: e.readings }))
  await page.getByLabel('Earth continuity reading').fill('')
  log('clearing a reading removes it', !(await entry()).readings?.main?.t6)

  // Settings: the suggestions are the list's to reword.
  await page.goto(BASE + '#/settings', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Custom List', exact: true }).last().click()
  log('a list with suggestions shows them in Settings', (await page.getByRole('textbox', { name: 'Suggested note 1' }).count()) === 1)
  log('beside each typed test, what it asks for',
    /Yes \/ No/.test(await page.textContent('main')) && /Reading \(MΩ\)/.test(await page.textContent('main')))
  await page.getByRole('textbox', { name: 'Suggested note 1' }).fill('Does not comply. Must be repaired.')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fc.templates')).custom.failNotes)
  log('an admin can reword them', saved?.[0] === 'Does not comply. Must be repaired.', JSON.stringify(saved))
  await page.getByRole('button', { name: 'Preventative Maintenance', exact: true }).last().click()
  log('an AV list has none', (await page.getByRole('textbox', { name: 'Suggested note 1' }).count()) === 0 && !/Suggested notes for a failed test/.test(await page.textContent('main')))
  await page.screenshot({ path: `${DIR}/answers-settings.png`, fullPage: true })

  // A team with an electrical pack rewords the suggestions on its own list.
  const tab = page.getByRole('button', { name: 'QLD electrical safety', exact: true })
  log('a list from a pack the team doesn\'t use has no tab', (await tab.count()) === 0)
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(e => e.name).filter(u => u.includes('/src/lib/entitlements.js')).pop()
    const entitlements = await import(url ?? '/src/lib/entitlements.js')
    await entitlements.openEntitlements('team', 'user', {
      getEntitlements: async () => ({
        enforced: false, accountType: 'provider', plan: 'pro', isPro: true, seatLimit: 1, seatsUsed: 1,
        visitLimit: null, visitsUsed: 0, packs: ['core', 'av', 'qld_electrical'], pastDueUntil: null,
        cancelAt: null, importUsed: false, openVisits: 0, starterPack: 'av', starterInUse: true,
      }),
    })
  })
  await tab.click()
  const first = page.getByRole('textbox', { name: 'Suggested note 1' })
  log('a team holding the pack has its list, seeded with the electrician\'s wording',
    (await first.count()) === 1 && (await first.inputValue()).startsWith('Fail – does not comply'))
  log('with each reading\'s unit beside it', /Reading \(Ω\)/.test(await page.textContent('main')) && /Reading \(ms\)/.test(await page.textContent('main')))
} catch (e) {
  log('suite threw before finishing', false, e.message)
} finally {
  log('no page errors along the way', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  await browser.close()
}
