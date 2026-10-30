// A competitor read from several sources on a day (each of its GitHub
// repositories) has one figure per day: the sum of that day's readings. The
// board and the opportunity reasons read the change of that figure between
// days that sum the same sources, never one repository's stars against
// another's, and never a repository added later as growth. Each case runs the
// real CLI against a registry of its own under .build/watch; nothing is read
// from the network, every reading is recorded with `observation add`.
//
// Run: COMPETITORS_TEST_SUCCESS_EXIT=<status> node --test tests/watch/signals.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')
const cli = join(root, 'src', 'cli.js')
const scratchRoot = join(root, '.build', 'watch')

const declared = process.env.COMPETITORS_TEST_SUCCESS_EXIT
assert.ok(declared?.trim(), 'COMPETITORS_TEST_SUCCESS_EXIT is required: the exit status the CLI contract names for success')
const successExit = Number(declared)
assert.ok(Number.isInteger(successExit), `COMPETITORS_TEST_SUCCESS_EXIT is not an integer exit status: ${declared}`)

function registry(t) {
  mkdirSync(scratchRoot, { recursive: true })
  const directory = mkdtempSync(join(scratchRoot, 'case-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'registry.json')
  const competitor = join(directory, 'competitor.json')
  writeFileSync(competitor, JSON.stringify({ name: 'Twofold', repositories: ['twofold/client', 'twofold/voice'] }))
  ok(['registry', 'add', '--competitor', competitor, '--registry', path])
  return { directory, path }
}

function ok(args) {
  const ran = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, COMPETITORS_REGISTRY: '' } })
  assert.equal(ran.status, successExit, `${args.join(' ')}: ${ran.stderr}`)
  return JSON.parse(ran.stdout)
}

function stars({ directory, path }, repository, day, value) {
  const file = join(directory, `${repository.replace('/', '-')}-${day}.json`)
  writeFileSync(file, JSON.stringify({
    observationId: `github:${repository}:${day}`,
    competitor: 'twofold',
    signalType: 'social',
    sourceType: 'github',
    observedAt: `${day}T06:00:00.000Z`,
    metric: { key: 'github_stars', value, unit: 'stars' },
    attributes: { repository },
  }))
  ok(['observation', 'add', '--observation', file, '--registry', path])
}

function row({ path }) {
  return ok(['board', 'show', '--format', 'json', '--registry', path]).companies.find((company) => company.id === 'twofold')
}

function reasons({ path }) {
  return ok(['opportunity', 'list', '--registry', path]).opportunities.find((item) => item.competitor === 'twofold').reasons
}

test('one day of several repositories is one figure, not a movement between them', (t) => {
  const held = registry(t)
  stars(held, 'twofold/client', '2026-10-01', 17)
  stars(held, 'twofold/voice', '2026-10-01', 32)
  assert.deepEqual(row(held).githubStars, { value: 49, at: '2026-10-01', previous: null, readings: 1, sources: ['twofold/client', 'twofold/voice'] })
  assert.ok(!reasons(held).some((reason) => reason.startsWith('GitHub stars')), 'one day of readings states no change')
})

test('the change is read between days that sum the same repositories', (t) => {
  const held = registry(t)
  stars(held, 'twofold/client', '2026-10-01', 17)
  stars(held, 'twofold/voice', '2026-10-01', 32)
  stars(held, 'twofold/client', '2026-10-02', 20)
  stars(held, 'twofold/voice', '2026-10-02', 40)
  assert.deepEqual(row(held).githubStars, { value: 60, at: '2026-10-02', previous: 49, readings: 2, sources: ['twofold/client', 'twofold/voice'] })
  assert.ok(reasons(held).includes('GitHub stars 49 → 60 (2026-10-01 → 2026-10-02)'), reasons(held).join('\n'))
})

test('a repository read only later is not growth', (t) => {
  const held = registry(t)
  stars(held, 'twofold/client', '2026-10-01', 17)
  stars(held, 'twofold/client', '2026-10-02', 18)
  stars(held, 'twofold/voice', '2026-10-02', 32)
  assert.deepEqual(row(held).githubStars, { value: 50, at: '2026-10-02', previous: null, readings: 1, sources: ['twofold/client', 'twofold/voice'] })
  assert.ok(!reasons(held).some((reason) => reason.startsWith('GitHub stars')), reasons(held).join('\n'))
})
