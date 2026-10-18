import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const directory = join(root, '.build', 'registry-concurrency', randomUUID())
const workspace = join(directory, 'workspace')
await mkdir(workspace, { recursive: true })
const registry = join(workspace, 'competitors.json')
const cli = join(root, 'src', 'cli.js')
const report = { status: 'failed', commands: [], started_at: new Date().toISOString() }
const save = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, '\t'))
const required = (name) => {
  const value = process.env[name]
  assert.ok(value?.trim(), `${name} is required`)
  return value
}
async function command(binary, args) {
  const record = { binary, args, stdout: '', stderr: '' }
  report.commands.push(record)
  await save()
  const child = spawn(binary, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { record.stdout += bytes })
  child.stderr.on('data', bytes => { record.stderr += bytes })
  await new Promise((accept, refuse) => {
    child.once('error', error => { record.error = error.message; refuse(error) })
    child.once('close', (code, signal) => {
      record.exit = code
      record.signal = signal
      accept()
    })
  })
  await save()
  return record
}
const invoke = args => command(process.execPath, [cli, ...args])
let lock
try {
  const success = Number(required('COMPETITORS_TEST_SUCCESS_EXIT'))
  const refused = Number(required('COMPETITORS_TEST_FAILURE_EXIT'))
  assert.ok(Number.isSafeInteger(success) && Number.isSafeInteger(refused) && success !== refused)
  const revision = await command('git', ['rev-parse', 'HEAD'])
  assert.equal(revision.exit, success, revision.stderr)
  assert.equal(revision.stdout.trim(), required('COMPETITORS_TEST_SOURCE_REVISION'))
  const changes = await command('git', ['diff', 'HEAD', '--no-ext-diff'])
  assert.equal(changes.exit, success, changes.stderr)
  assert.equal(changes.stdout, '', 'Qualification requires the declared committed source')
  report.source_revision = revision.stdout.trim()
  report.node = process.version
  report.cli_sha256 = createHash('sha256').update(await readFile(cli)).digest('hex')
  const flock = promisify(createRequire(import.meta.url)('fs-ext').flock)
  const first = join(workspace, 'first.json')
  const second = join(workspace, 'second.json')
  await writeFile(first, JSON.stringify({ id: 'first', name: 'First', domains: ['first.example'] }))
  await writeFile(second, JSON.stringify({ id: 'second', name: 'Second', domains: ['second.example'] }))
  const added = await invoke(['registry', 'add', '--registry', registry, '--competitor', first])
  assert.equal(added.exit, success, added.stderr)
  const before = await readFile(registry)
  const alias = join(workspace, 'alias.json')
  await symlink(registry, alias)
  const oldPending = `${registry}.pending`
  const sentinel = 'A pending file this operation does not own.'
  await writeFile(oldPending, sentinel)
  lock = await open(`${registry}.lock`, 'a', constants.S_IRUSR | constants.S_IWUSR)
  await flock(lock.fd, 'exnb')
  const busy = await invoke(['registry', 'add', '--registry', alias, '--competitor', second])
  assert.equal(busy.signal, null, busy.stderr)
  assert.equal(busy.exit, refused, busy.stderr)
  assert.ok(busy.stderr.includes(`${registry}.lock`), busy.stderr)
  assert.ok(busy.stderr.includes('committed=false'), busy.stderr)
  assert.deepEqual(await readFile(registry), before, 'Refused mutation changed retained competitors')
  assert.equal(await readFile(oldPending, 'utf8'), sentinel)
  await lock.close()
  lock = undefined

  const recovered = await invoke(['registry', 'add', '--registry', alias, '--competitor', second])
  assert.equal(recovered.exit, success, recovered.stderr)
  const retained = JSON.parse(await readFile(registry, 'utf8'))
  assert.deepEqual(retained.competitors.map(item => item.id).sort(), ['first', 'second'])
  assert.equal(await readFile(oldPending, 'utf8'), sentinel,
    'Mutation overwrote a pending file owned by another operation')
  const removed = await invoke(['registry', 'remove', 'second', '--registry', registry])
  assert.equal(removed.exit, success, removed.stderr)
  assert.deepEqual(JSON.parse(await readFile(registry, 'utf8')).competitors.map(item => item.id), ['first'])
  const duplicate = await invoke(['registry', 'add', '--registry', registry, '--competitor', first])
  assert.equal(duplicate.exit, refused, duplicate.stderr)
  const final = await invoke(['registry', 'remove', 'first', '--registry', registry])
  assert.equal(final.exit, success, final.stderr)
  assert.deepEqual(JSON.parse(await readFile(registry, 'utf8')).competitors, [])
  report.final_registry = JSON.parse(await readFile(registry, 'utf8'))
  report.status = 'passed'
} catch (error) {
  report.error = error.stack
  throw error
} finally {
  try {
    if (lock) await lock.close()
    await rm(workspace, { recursive: true, force: true })
  } catch (error) {
    report.status = 'failed'
    report.cleanup_error = error.stack
    throw error
  } finally {
    report.finished_at = new Date().toISOString()
    await save()
    console.log(join(directory, 'report.json'))
  }
}
