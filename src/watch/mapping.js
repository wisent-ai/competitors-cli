import { readFile } from 'node:fs/promises'
import { slugify } from '../competition/model.js'
import { mutateRegistry, readRegistry } from '../competition/registry-file.js'

// A mapping says how one tracked competitor meets our own products: which of
// ours competes with it, what ours lacks against it, what we would do better
// and why, and, when nothing of ours meets the need, what we would build.
// Our products are read from the product catalog file a caller names
// (`stado product catalog --json`), so a mapping can only name a product the
// catalog holds.

export const RELATIONS = ['competes', 'adjacent', 'none']
// Where we can be better than a competitor: our own implementation instead of
// a rented provider, the user's data staying the user's, a lower price, the
// fleet we already run, and what our other products give it.
export const ADVANTAGES = ['own-solution', 'privacy', 'cost', 'fleet', 'ecosystem']
export const PURPOSES = ['commercial', 'public-good', 'both']
export const SURFACES = ['cli', 'desktop', 'web', 'service', 'ios', 'android']
// GitHub's limit for a repository description, which a product created from a
// proposal gives every repository it provisions.
const OFFER_BYTES = 350

/** Our products from a `stado product catalog --json` file, by id. */
export async function readCatalog(path) {
  if (!path) throw new Error('--catalog <products.json> is required: the file `stado product catalog --json` writes, naming our products')
  let document
  try {
    document = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`product catalog ${path} cannot be read as JSON: ${error.message}`)
  }
  const products = Array.isArray(document) ? document : document?.products
  if (!Array.isArray(products) || !products.every((product) => typeof product?.id === 'string')) {
    throw new Error(`product catalog ${path} must hold {"products": [{"id", "name", "description"}, ...]} as stado product catalog --json writes it`)
  }
  return new Map(products.map((product) => [product.id, { id: product.id, name: product.name || product.id, description: product.description || '' }]))
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function texts(value, field, where) {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => text(item))) throw new Error(`${where}: ${field} must be a list of non-empty sentences`)
  return value.map(text)
}

function products(value, field, catalog, where) {
  const ids = texts(value, field, where)
  const unknown = ids.filter((id) => !catalog.has(id))
  if (unknown.length) throw new Error(`${where}: ${field} names ${unknown.join(', ')}, which the product catalog does not hold; it holds ${catalog.size} products (stado product catalog)`)
  return ids
}

function oneOf(value, field, allowed, where) {
  if (!allowed.includes(value)) throw new Error(`${where}: ${field} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`)
  return value
}

/**
 * `input` as a mapping of `competitor`, every field checked before anything
 * is written. A gap (no product of ours competes) also states the offer,
 * the first slice and the surfaces a proposal is written from.
 */
export function normalizeMapping(input, competitor, catalog) {
  const where = `the mapping of ${competitor}`
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${where} must be a JSON object`)
  const known = ['ours', 'relation', 'need', 'missing', 'better', 'purpose', 'offer', 'slice', 'surfaces', 'uses', 'mappedBy']
  const extra = Object.keys(input).filter((key) => !known.includes(key))
  if (extra.length) throw new Error(`${where}: ${extra.join(', ')} is not a mapping field; the fields are ${known.join(', ')}`)
  const ours = products(input.ours, 'ours', catalog, where)
  const relation = oneOf(input.relation, 'relation', RELATIONS, where)
  if (ours.length && relation === 'none') throw new Error(`${where}: relation none says nothing of ours meets it, yet ours names ${ours.join(', ')}`)
  if (!ours.length && relation !== 'none') throw new Error(`${where}: relation ${relation} needs the products of ours it names in ours`)
  const need = text(input.need)
  if (!need) throw new Error(`${where}: need is empty; say what people pay this competitor for`)
  const better = input.better === undefined ? [] : input.better
  if (!Array.isArray(better)) throw new Error(`${where}: better must be a list of {advantage, reason}`)
  const advantages = better.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`${where}: better[${index}] must be {advantage, reason}`)
    const reason = text(item.reason)
    if (!reason) throw new Error(`${where}: better[${index}].reason is empty; say why we would be better`)
    return { advantage: oneOf(item.advantage, `better[${index}].advantage`, ADVANTAGES, where), reason }
  })
  const repeated = advantages.map((item) => item.advantage).filter((advantage, index, all) => all.indexOf(advantage) !== index)
  if (repeated.length) throw new Error(`${where}: better names ${repeated.join(', ')} twice; one reason per advantage`)
  const mappedBy = text(input.mappedBy)
  if (!mappedBy) throw new Error(`${where}: mappedBy is empty; say who judged this mapping`)
  const mapping = {
    competitor,
    ours,
    relation,
    need,
    missing: texts(input.missing, 'missing', where),
    better: advantages,
    purpose: oneOf(input.purpose, 'purpose', PURPOSES, where),
    offer: text(input.offer) || null,
    slice: texts(input.slice, 'slice', where),
    surfaces: texts(input.surfaces, 'surfaces', where).map((surface) => oneOf(surface, 'surfaces', SURFACES, where)),
    uses: products(input.uses, 'uses', catalog, where),
    mappedBy,
    mappedAt: new Date().toISOString(),
  }
  // A gap we would pursue (nothing of ours meets it, and we would do something
  // better) is what a proposal is written from, so it states the offer, the
  // first slice and the surfaces; a gap with no advantage is left alone.
  if (!ours.length && advantages.length) {
    if (!mapping.offer) throw new Error(`${where}: nothing of ours meets it, so offer must say in one sentence what we would build`)
    if (Buffer.byteLength(mapping.offer) > OFFER_BYTES) throw new Error(`${where}: offer is ${Buffer.byteLength(mapping.offer)} bytes; a product description holds at most ${OFFER_BYTES}`)
    if (!mapping.slice.length) throw new Error(`${where}: nothing of ours meets it, so slice must list what the first release does`)
    if (!mapping.surfaces.length) throw new Error(`${where}: nothing of ours meets it, so surfaces must name the surfaces it ships (${SURFACES.join(', ')})`)
  }
  return mapping
}

function competitorId(registry, id, path) {
  const key = slugify(id)
  if (!registry.competitors.some((competitor) => competitor.id === key)) {
    throw new Error(`competitor ${key} is not in ${path}; competitors registry list names the ${registry.competitors.length} it holds`)
  }
  return key
}

/** Write the mapping of one competitor, replacing the one it had. */
export async function setMapping(path, id, input, catalog) {
  return mutateRegistry(path, (registry) => {
    const competitor = competitorId(registry, id, path)
    const mapping = normalizeMapping(input, competitor, catalog)
    const replaced = registry.mappings.some((held) => held.competitor === competitor)
    registry.mappings = [...registry.mappings.filter((held) => held.competitor !== competitor), mapping]
    return { mapping, replaced }
  })
}

/**
 * Write many mappings in one locked write, or none: `inputs` is a list of
 * mappings each naming its `competitor`. Every one is checked before any is
 * written; a competitor named twice is refused, and a held mapping is replaced.
 */
export async function importMappings(path, inputs, catalog) {
  if (!Array.isArray(inputs)) throw new Error('mappings input must be a list of mappings, each naming its competitor')
  return mutateRegistry(path, (registry) => {
    const seen = new Set()
    const mappings = inputs.map((input, index) => {
      if (!input || typeof input !== 'object') throw new Error(`mappings[${index}] must be a JSON object`)
      const { competitor: named, ...fields } = input
      if (typeof named !== 'string' || !named.trim()) throw new Error(`mappings[${index}] names no competitor`)
      const competitor = competitorId(registry, named, path)
      if (seen.has(competitor)) throw new Error(`import refused, nothing was written: ${competitor} is mapped twice in the file`)
      seen.add(competitor)
      return normalizeMapping(fields, competitor, catalog)
    })
    const replaced = registry.mappings.filter((held) => seen.has(held.competitor)).map((held) => held.competitor)
    registry.mappings = [...registry.mappings.filter((held) => !seen.has(held.competitor)), ...mappings]
    return { set: mappings.length, replaced }
  })
}

function mappingIndex(registry, id, path) {
  const key = slugify(id)
  const index = registry.mappings.findIndex((held) => held.competitor === key)
  if (index < 0) {
    throw new Error(`competitor ${key} has no mapping in ${path}; ${registry.mappings.length} competitors have one (competitors mapping list); write one with competitors mapping set ${key}`)
  }
  return index
}

export async function showMapping(path, id) {
  const registry = await readRegistry(path)
  return registry.mappings[mappingIndex(registry, id, path)]
}

export async function removeMapping(path, id) {
  return mutateRegistry(path, (registry) => {
    const [removed] = registry.mappings.splice(mappingIndex(registry, id, path), 1)
    return removed
  })
}
