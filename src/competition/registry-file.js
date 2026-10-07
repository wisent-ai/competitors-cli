import { readFile, rename, writeFile } from 'node:fs/promises'
import { normalizeCompetitor, slugify } from './model.js'

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
  const pending = `${path}.pending`
  await writeFile(pending, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 })
  await rename(pending, path)
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
  const registry = await readRegistry(path)
  const competitor = normalizeCompetitor(input)
  if (registry.competitors.some((existing) => existing.id === competitor.id)) {
    throw new Error(`competitor ${competitor.id} is already in ${path}; change it with competitors registry edit ${competitor.id}`)
  }
  registry.competitors.push(competitor)
  await writeRegistry(path, registry)
  return competitor
}

export async function editCompetitor(path, id, changes) {
  const registry = await readRegistry(path)
  const index = find(registry, id, path)
  const changed = normalizeCompetitor({ ...registry.competitors[index], ...changes, id: registry.competitors[index].id })
  registry.competitors[index] = changed
  await writeRegistry(path, registry)
  return changed
}

export async function removeCompetitor(path, id) {
  const registry = await readRegistry(path)
  const [removed] = registry.competitors.splice(find(registry, id, path), 1)
  await writeRegistry(path, registry)
  return removed
}
