import { createCompetitorRegistry, normalizeCompetitor, slugify } from '../competition/model.js'
import { normalizeCompetitorObservation } from '../competition/observations.js'
import { mutateRegistry, readRegistry } from '../competition/registry-file.js'
import { parseListTable } from './table.js'

// The time series of each competitor: dated observations kept in the
// registry beside the competitor they are about. An observation is recorded
// once under its id; recording the same reading again changes nothing, so a
// list imported twice or a measurement repeated within its day adds nothing.

/** `input` as the registry stores it: normalized, with the competitor named by id. */
function stored(input, registry, index, recordedAt) {
  const id = typeof input.competitor === 'string' ? slugify(input.competitor) : null
  if (!id || !index.get(id)) {
    const held = registry.competitors.map((competitor) => competitor.id)
    throw new Error(`an observation names competitor ${JSON.stringify(input.competitor)}, which the registry does not hold; it holds ${held.length ? held.join(', ') : 'no competitor'}`)
  }
  const observation = normalizeCompetitorObservation({ ...input, competitor: id }, { registry: index })
  return { ...observation, competitor: id, recordedAt }
}

/** Add each observation the registry does not hold yet; answer which were recorded and which were known. */
function record(registry, inputs) {
  const recordedAt = new Date().toISOString()
  const index = createCompetitorRegistry(registry.competitors)
  const held = new Set(registry.observations.map((observation) => observation.observationId))
  const recorded = []
  const known = []
  for (const input of inputs) {
    const observation = stored(input, registry, index, recordedAt)
    if (held.has(observation.observationId)) {
      known.push(observation.observationId)
      continue
    }
    held.add(observation.observationId)
    registry.observations.push(observation)
    recorded.push(observation)
  }
  return { recorded, known }
}

/** Store observations taken outside the lock (a measurement), in one locked write. */
export async function recordObservations(path, inputs) {
  return mutateRegistry(path, (registry) => record(registry, inputs))
}

/**
 * Import a published list: every company it names that the registry does not
 * hold is added, and every figure becomes an observation, in one locked
 * write or not at all. A company the registry already holds keeps its record.
 */
export async function importList(path, text, origin) {
  const parsed = parseListTable(text, origin)
  return mutateRegistry(path, (registry) => {
    const held = new Set(registry.competitors.map((competitor) => competitor.id))
    const added = []
    for (const input of parsed.competitors) {
      if (held.has(input.id)) continue
      const competitor = normalizeCompetitor({ ...input, tags: ['tracked'] })
      registry.competitors.push(competitor)
      added.push(competitor.id)
    }
    const { recorded, known } = record(registry, parsed.observations)
    return {
      companies: parsed.competitors.length,
      added,
      alreadyHeld: parsed.competitors.map((input) => input.id).filter((id) => !added.includes(id)),
      recorded: recorded.length,
      known: known.length,
    }
  })
}

export async function addObservation(path, input) {
  return mutateRegistry(path, (registry) => {
    const { recorded, known } = record(registry, [input])
    if (known.length) throw new Error(`observation ${known[0]} is already in ${path}; remove it first with competitors observation remove ${known[0]}`)
    return recorded[0]
  })
}

function observationIndex(registry, id, path) {
  const index = registry.observations.findIndex((observation) => observation.observationId === id)
  if (index < 0) {
    throw new Error(`observation ${id} is not in ${path}; competitors observation list names the ${registry.observations.length} it holds`)
  }
  return index
}

export async function removeObservation(path, id) {
  return mutateRegistry(path, (registry) => {
    const index = observationIndex(registry, id, path)
    const [removed] = registry.observations.splice(index, 1)
    return removed
  })
}

export async function showObservation(path, id) {
  const registry = await readRegistry(path)
  return registry.observations[observationIndex(registry, id, path)]
}

/** The observations of one competitor and one metric when named, oldest first. */
export function selectObservations(observations, { competitor = null, metric = null } = {}) {
  return observations
    .filter((observation) => competitor === null || observation.competitor === slugify(competitor))
    .filter((observation) => metric === null || observation.metric?.key === metric)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.recordedAt.localeCompare(right.recordedAt))
}
