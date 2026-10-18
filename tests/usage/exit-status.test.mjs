// The competitors CLI tells a wrong invocation apart from a failed run by its
// exit status: a usage refusal exits with the usage status and prints the
// usage, and a run that fails on a correct invocation exits with the failure
// status and its own cause, without the usage. Each case runs the real CLI in
// its own scratch directory under .build/usage.
//
// The statuses are the CLI contract's, declared by the caller as
// COMPETITORS_TEST_USAGE_EXIT and COMPETITORS_TEST_FAILURE_EXIT and refused by
// name when missing, as the registry concurrency journey takes its own.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')
const cli = join(root, 'src', 'cli.js')
const scratchRoot = join(root, '.build', 'usage')

function declared(name) {
  const value = process.env[name]
  assert.ok(value?.trim(), `${name} is required: the exit status the CLI contract names for it`)
  const status = Number(value)
  assert.ok(Number.isInteger(status), `${name} is not an integer exit status: ${value}`)
  return status
}

const usageExit = declared('COMPETITORS_TEST_USAGE_EXIT')
const failureExit = declared('COMPETITORS_TEST_FAILURE_EXIT')

function run(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, COMPETITORS_REGISTRY: '' } })
}

function scratch(t) {
  mkdirSync(scratchRoot, { recursive: true })
  const directory = mkdtempSync(join(scratchRoot, 'case-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('an unknown command is a usage refusal that names it and prints the usage', (t) => {
  const ran = run(['no-such-command'], scratch(t))
  assert.equal(ran.status, usageExit, ran.stderr)
  assert.match(ran.stderr, /Unknown command: no-such-command/u)
  assert.match(ran.stderr, /Usage:/u)
  assert.equal(ran.stdout, '')
})

test('a flag the command does not take is a usage refusal that names it', (t) => {
  const ran = run(['registry', 'list', '--no-such-flag'], scratch(t))
  assert.equal(ran.status, usageExit, ran.stderr)
  assert.match(ran.stderr, /does not take --no-such-flag/u)
  assert.match(ran.stderr, /Usage:/u)
})

test('a correct invocation that fails exits with the failure status and its cause, without the usage', (t) => {
  const directory = scratch(t)
  const registry = join(directory, 'registry.json')
  writeFileSync(registry, JSON.stringify({ competitors: [] }))
  const ran = run(['registry', 'show', 'absent', '--registry', registry], directory)
  assert.equal(ran.status, failureExit, ran.stderr)
  assert.notEqual(failureExit, usageExit)
  assert.match(ran.stderr, /absent/u)
  assert.doesNotMatch(ran.stderr, /Usage:/u)
})
