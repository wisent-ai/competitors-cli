import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { normalizeCompetitor, slugify } from './model.js'

const require = createRequire(import.meta.url)
const registryMode = constants.S_IRUSR | constants.S_IWUSR

function combined(previous, error) {
  return previous
    ? new AggregateError([previous, error], `${previous.message}; ${error.message}`)
    : error
}

async function canonicalRegistry(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    // A broken symlink is not an absent registry: do not replace the link.
    try {
      await lstat(path)
    } catch (inspection) {
      if (inspection.code !== 'ENOENT') throw inspection
      return join(await realpath(dirname(resolve(path))), basename(path))
    }
    throw error
  }
}

async function mutateRegistry(path, change) {
  let flock
  try {
    flock = require('fs-ext').flock
  } catch (error) {
    throw new Error(`competitor registry ${path} requires the fs-ext native locking dependency: ${error.message}`, { cause: error })
  }
  let target
  let handle
  try {
    target = await canonicalRegistry(path)
    handle = await open(`${target}.lock`, 'a', registryMode)
  } catch (error) {
    throw new Error(`competitor registry ${path}: opening mutation lock: ${error.message}`, { cause: error })
  }
  let result
  let failure
  let committed = false
  try {
    await new Promise((accept, refuse) => {
      flock(handle.fd, 'exnb', (error) => error ? refuse(error) : accept())
    })
    const registry = await readRegistry(target)
    result = change(registry)
    await writeRegistry(target, registry)
    committed = true
  } catch (error) {
    failure = error
  }
  try {
    // Keep the carrier inode: unlinking it could split concurrent owners.
    // Closing the descriptor releases the OS lock, including on process exit.
    await handle.close()
  } catch (error) {
    failure = combined(failure, new Error(`closing mutation lock: ${error.message}`, { cause: error }))
  }
  if (failure) {
    throw new Error(`competitor registry ${path}, lock ${target}.lock, committed=${committed}: ${failure.message}`, { cause: failure })
  }
  return result
}

// The competitors a comparison or a discovery run is measured against live in
// one JSON file the CLI owns, {"competitors": [...]}, named by --registry or
// COMPETITORS_REGISTRY. Nothing is compiled in: a registry starts empty and
// changes only through add, edit and remove, so the list a run used is the
// file it read.

export function registryPath(explicit, env = process.env) {
  const path = explicit || env.COMPETITORS_REGISTRY
  if (!path) {
    throw new Error('no competitor registry is named: pass --registry <file> or set COMPETITORS_REGISTRY')
  }
  return path
}

export async function readRegistry(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { competitors: [] }
    throw new Error(`competitor registry ${path} cannot be read: ${error.message}`)
  }
  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw new Error(`competitor registry ${path} is not JSON: ${error.message}`)
  }
  if (!document || !Array.isArray(document.competitors)) {
    throw new Error(`competitor registry ${path} must hold {"competitors": [...]}`)
  }
  return { competitors: document.competitors.map(normalizeCompetitor) }
}

async function writeRegistry(path, registry) {
  const pending = `${path}.pending-${randomUUID()}`
  const handle = await open(pending, 'wx', registryMode)
  let failure
  try {
    await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`)
    await handle.sync()
  } catch (error) {
    failure = error
  }
  try {
    await handle.close()
  } catch (error) {
    failure = combined(failure, error)
  }
  if (!failure) {
    try {
      await rename(pending, path)
      return
    } catch (error) {
      failure = error
    }
  }
  try {
    await unlink(pending)
  } catch (error) {
    failure = combined(failure, error)
  }
  throw new Error(`writing competitor registry ${path} through ${pending}: ${failure.message}`, { cause: failure })
}

function find(registry, id, path) {
  const key = slugify(id)
  const index = registry.competitors.findIndex((competitor) => competitor.id === key)
  if (index < 0) {
    const known = registry.competitors.map((competitor) => competitor.id)
    throw new Error(`competitor ${key} is not in ${path}; it holds ${known.length ? known.join(', ') : 'no competitor'}`)
  }
  return index
}

export async function showCompetitor(path, id) {
  const registry = await readRegistry(path)
  return registry.competitors[find(registry, id, path)]
}

export async function addCompetitor(path, input) {
  return mutateRegistry(path, (registry) => {
    const competitor = normalizeCompetitor(input)
    if (registry.competitors.some((existing) => existing.id === competitor.id)) {
      throw new Error(`competitor ${competitor.id} is already in ${path}; change it with competitors registry edit ${competitor.id}`)
    }
    registry.competitors.push(competitor)
    return competitor
  })
}

// Many competitors in one locked write. Every record is normalized and checked
// before anything changes, so a file naming one id twice, or an id the registry
// already holds, is refused with every such id and the registry stays as it was.
export async function importCompetitors(path, inputs) {
  return mutateRegistry(path, (registry) => {
    const incoming = inputs.map(normalizeCompetitor)
    const held = new Set(registry.competitors.map((competitor) => competitor.id))
    const seen = new Set()
    const clashes = new Set()
    for (const competitor of incoming) {
      if (held.has(competitor.id) || seen.has(competitor.id)) clashes.add(competitor.id)
      seen.add(competitor.id)
    }
    if (clashes.size) {
      throw new Error(`import refused, nothing was added: ${[...clashes].join(', ')} already in ${path} or named twice in the file; change held ones with competitors registry edit`)
    }
    registry.competitors.push(...incoming)
    return incoming
  })
}

export async function editCompetitor(path, id, changes) {
  return mutateRegistry(path, (registry) => {
    const index = find(registry, id, path)
    const changed = normalizeCompetitor({ ...registry.competitors[index], ...changes, id: registry.competitors[index].id })
    registry.competitors[index] = changed
    return changed
  })
}

export async function removeCompetitor(path, id) {
  return mutateRegistry(path, (registry) => {
    const index = find(registry, id, path)
    const removed = registry.competitors[index]
    registry.competitors = registry.competitors.filter((_, at) => at !== index)
    return removed
  })
}
