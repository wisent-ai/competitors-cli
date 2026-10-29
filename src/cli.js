#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { compareProducts, comparisonMarkdown } from './comparison.js'
import { discoverCompetitorCandidates, summarizeDiscoveryCandidates } from './discovery/index.js'
import {
  addCompetitor,
  editCompetitor,
  editCompetitors,
  importCompetitors,
  readRegistry,
  registryPath,
  removeCompetitor,
  showCompetitor,
} from './competition/registry-file.js'
import { criteriaFromValues, describeCriteria, filterCompetitors } from './competition/filter.js'
import { boardHtml, boardMarkdown, boardRows } from './watch/board.js'
import { importMappings, readCatalog, removeMapping, setMapping, showMapping } from './watch/mapping.js'
import { addObservation, importList, removeObservation, selectObservations, showObservation } from './watch/observations.js'
import { rankOpportunities } from './watch/opportunity.js'
import { writeProposals } from './watch/proposal.js'
import { serveBoard } from './watch/serve.js'
import { measureCompetitors } from './watch/signals.js'

// The invocation itself is wrong: exit 2 with the usage; any other failure
// exits 1 with its own message (cli.md rule 10).
const EXIT_FAILURE = 1 // https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html
const EXIT_USAGE = 2 // https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html

class UsageError extends Error {}

function usage() {
  return `competitors-cli

Usage:
  competitors registry list [--tag <tag>]... [--region <region>]... [--category <category>] [--active | --inactive] [--registry <file>] [--text]
  competitors registry show <id> [--registry <file>] [--text]
  competitors registry add --competitor <competitor.json> [--registry <file>] [--text]
  competitors registry import --competitors <competitors.json> [--registry <file>] [--text]
  competitors registry edit <id> --competitor <changes.json> [--registry <file>] [--text]
  competitors registry edit --competitors <changes.json> [--registry <file>] [--text]
  competitors registry remove <id> [--registry <file>] [--text]
  competitors observation list [--competitor-id <id>] [--metric <key>] [--registry <file>] [--text]
  competitors observation show <observation-id> [--registry <file>] [--text]
  competitors observation add --observation <observation.json> [--registry <file>] [--text]
  competitors observation import --table <list.tsv> [--registry <file>] [--text]
  competitors observation remove <observation-id> [--registry <file>] [--text]
  competitors observation measure [--competitor-id <id>]... [--registry <file>] [--text]
  competitors mapping list [--registry <file>] [--text]
  competitors mapping show <id> [--registry <file>] [--text]
  competitors mapping import --mappings <mappings.json> --catalog <products.json> [--registry <file>] [--text]
  competitors mapping set <id> --mapping <mapping.json> --catalog <products.json> [--registry <file>] [--text]
  competitors mapping remove <id> [--registry <file>] [--text]
  competitors opportunity list [--limit <n>] [--registry <file>] [--text]
  competitors proposal write --out <dir> --limit <n> --owner <org> --family wisent|standalone --evidence <ref>... --catalog <products.json> [--oko-root <defect> --oko-product <product>] [--registry <file>] [--text]
  competitors board show [--format json|text|markdown|html] [--registry <file>]
  competitors board serve --catalog <products.json> [--port <n>] [--registry <file>]
  competitors discover --records <records.json> [--registry <file>] [--own-domain <domain>]... [--text]
  competitors compare --product <product.json> (--competitors <competitors.json> | --registry <file> [--tag <tag>]... [--region <region>]... [--category <category>] [--active | --inactive]) [--format json|markdown]

The registry is one JSON file the CLI owns, {"competitors": [...], "observations": [...],
"mappings": [...]}, named by --registry or COMPETITORS_REGISTRY; it starts empty. A competitor
record carries id or name, and optionally company, productCategory, description, location,
founded, domains, repositories (GitHub OWNER/NAME), mentionQuery, appStoreIds,
playStorePackages, regions, tags and active. Removing a competitor removes its observations and
its mapping.
observation import reads a tab-separated list whose header names its columns (Company,
Snapshot Time and Source required); each company it does not hold is added and each figure is
recorded as a dated observation, once. observation measure reads each competitor's home pages,
Hacker News stories for its mentionQuery and GitHub stars of its repositories, and records the
readings. A mapping names which of our products (from the stado product catalog --json file)
meets a competitor; opportunity list ranks them; proposal write writes a product plan and a
creation request for each of the strongest gaps nothing of ours meets, and with --oko-root
records each in Oko. board show prints every tracked company beside our products; board serve
serves the same board with every operation on 127.0.0.1 (--port 0, the default, lets the
system choose the port, which it prints).
All commands write their result to stdout: as JSON, or with --text as one path: value line per
field.`
}

function refuseUsage(message) {
  throw new UsageError(`${message}\n\n${usage()}`)
}

// Every flag the CLI knows. Repeatable flags may be given many times; every
// other flag is refused when given twice, so a second value never silently
// replaces the first (rule 12).
const REPEATABLE = new Set('own-domain tag region competitor-id evidence'.split(' '))
const STRINGS = 'records product competitors registry competitor category observation table metric mapping mappings catalog limit out owner family oko-root oko-product port'
const OPTIONS = Object.fromEntries([
  ...STRINGS.split(' ').map((name) => [name, { type: 'string' }]),
  ['format', { type: 'string' }],
  ...[...REPEATABLE].map((name) => [name, { type: 'string', multiple: true, default: [] }]),
  ...'text active inactive'.split(' ').map((name) => [name, { type: 'boolean', default: false }]),
])

// The flags each command reads; anything else is refused before the command
// runs, so a misspelt flag never silently falls back to a default (rule 12).
const FILTERS = 'tag region category active inactive'
const FLAGS = {
  'registry list': `registry text ${FILTERS}`.split(' '),
  'registry show': 'registry text'.split(' '),
  'registry add': 'competitor registry text'.split(' '),
  'registry import': 'competitors registry text'.split(' '),
  'registry edit': 'competitor competitors registry text'.split(' '),
  'registry remove': 'registry text'.split(' '),
  'observation list': 'competitor-id metric registry text'.split(' '),
  'observation show': 'registry text'.split(' '),
  'observation add': 'observation registry text'.split(' '),
  'observation import': 'table registry text'.split(' '),
  'observation remove': 'registry text'.split(' '),
  'observation measure': 'competitor-id registry text'.split(' '),
  'mapping import': 'mappings catalog registry text'.split(' '),
  'mapping list': 'registry text'.split(' '),
  'mapping show': 'registry text'.split(' '),
  'mapping set': 'mapping catalog registry text'.split(' '),
  'mapping remove': 'registry text'.split(' '),
  'opportunity list': 'limit registry text'.split(' '),
  'proposal write': 'out limit owner family evidence catalog oko-root oko-product registry text'.split(' '),
  'board show': 'format registry'.split(' '),
  'board serve': 'catalog port registry'.split(' '),
  discover: 'records registry own-domain text'.split(' '),
  compare: `product competitors registry format ${FILTERS}`.split(' '),
}
const GROUPS = ['registry', 'observation', 'mapping', 'opportunity', 'proposal', 'board']
// Verbs whose first word after the verb is the object's id.
const TAKES_ID = new Set(['registry show', 'registry edit', 'registry remove', 'observation show', 'observation remove', 'mapping show', 'mapping set', 'mapping remove'])

function parse(argv) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true, tokens: true })
  } catch (error) {
    // A flag no command knows is refused by the parser before the command is
    // read; the refusal still names the command and the flags it takes.
    const unknown = /^Unknown option '([^']+)'/u.exec(error.message)
    const [command, verb] = argv
    const name = GROUPS.includes(command) ? `${command} ${verb}` : command
    if (unknown && FLAGS[name]) {
      refuseUsage(`competitors ${name} does not take ${unknown[1]}; it takes ${FLAGS[name].map((flag) => `--${flag}`).join(', ')}`)
    }
    return refuseUsage(error.message)
  }
}

function refuseUnknown(command, tokens) {
  const known = FLAGS[command]
  const seen = new Set()
  for (const token of tokens) {
    if (token.kind !== 'option') continue
    if (!known.includes(token.name)) {
      refuseUsage(`competitors ${command} does not take ${token.rawName}; it takes ${known.map((name) => `--${name}`).join(', ')}`)
    }
    if (seen.has(token.name) && !REPEATABLE.has(token.name)) refuseUsage(`--${token.name} may be supplied only once`)
    seen.add(token.name)
  }
}

function refuseSurplus(command, surplus) {
  if (surplus.length) refuseUsage(`competitors ${command} does not take ${surplus.join(' ')}`)
}

// The same result for people: one `path: value` line per field (cli.md rule 13).
function render(result, text) {
  if (!text) return JSON.stringify(result, null, '  ')
  const lines = []
  const walk = (node, path) => {
    if (Array.isArray(node) && node.length) node.forEach((item, index) => walk(item, `${path}[${index}]`))
    else if (node && typeof node === 'object' && Object.keys(node).length) for (const [key, item] of Object.entries(node)) walk(item, path ? `${path}.${key}` : key)
    else lines.push(path ? `${path}: ${node === null || typeof node === 'object' ? '-' : node}` : String(node))
  }
  walk(result, '')
  return lines.join('\n')
}

async function jsonFile(path, label) {
  if (!path) refuseUsage(`${label} is required`)
  return JSON.parse(await readFile(path, 'utf8'))
}

function competitorList(input, label) {
  const competitors = Array.isArray(input) ? input : input.competitors
  if (!Array.isArray(competitors)) throw new Error(`${label} input must be an array or {"competitors": []}`)
  return competitors
}

function wholeNumber(value, flag, least) {
  if (value === undefined) return undefined
  if (!/^\d+$/u.test(value) || Number(value) < least) refuseUsage(`${flag} must be a whole number of at least ${least}; got ${value}`)
  return Number(value)
}

function oneOf(value, flag, allowed) {
  if (value !== undefined && !allowed.includes(value)) refuseUsage(`${flag} must be ${allowed.join(', ')}; got ${value}`)
  return value
}

async function registry(verb, id, values) {
  const path = registryPath(values.registry)
  if (verb === 'list') {
    const held = await readRegistry(path)
    const criteria = criteriaFromValues(values, refuseUsage)
    const filter = describeCriteria(criteria)
    if (!filter) return { registry: path, competitors: held.competitors }
    return { registry: path, filter, held: held.competitors.length, competitors: filterCompetitors(held.competitors, criteria) }
  }
  if (verb === 'import') {
    const input = await jsonFile(values.competitors, '--competitors <competitors.json>')
    return { registry: path, added: await importCompetitors(path, competitorList(input, 'Competitors')) }
  }
  if (verb === 'show') return { registry: path, competitor: await showCompetitor(path, id) }
  if (verb === 'remove') {
    const { competitor, observations, mapping } = await removeCompetitor(path, id)
    return { registry: path, removed: competitor, observationsRemoved: observations, mappingRemoved: mapping }
  }
  if (verb === 'edit' && id === undefined) {
    if (values.competitor) refuseUsage('competitors registry edit --competitor changes the competitor whose id follows edit; name the id, or pass every change as --competitors <changes.json>')
    const input = await jsonFile(values.competitors, 'competitors registry edit needs the competitor id, or --competitors <changes.json>')
    return { registry: path, changed: await editCompetitors(path, competitorList(input, 'Changes')) }
  }
  if (verb === 'edit' && values.competitors) refuseUsage('competitors registry edit <id> takes --competitor <changes.json>; --competitors changes many and names no id')
  const input = await jsonFile(values.competitor, '--competitor <competitor.json>')
  if (verb === 'add') return { registry: path, added: await addCompetitor(path, input) }
  return { registry: path, changed: await editCompetitor(path, id, input) }
}

async function observation(verb, id, values) {
  const path = registryPath(values.registry)
  if (verb === 'list') {
    const held = await readRegistry(path)
    const [competitor = null] = values['competitor-id']
    if (values['competitor-id'].length > 1) refuseUsage('observation list takes one --competitor-id')
    return { registry: path, observations: selectObservations(held.observations, { competitor, metric: values.metric ?? null }) }
  }
  if (verb === 'show') return { registry: path, observation: await showObservation(path, id) }
  if (verb === 'remove') return { registry: path, removed: await removeObservation(path, id) }
  if (verb === 'add') return { registry: path, added: await addObservation(path, await jsonFile(values.observation, '--observation <observation.json>')) }
  if (verb === 'import') {
    if (!values.table) refuseUsage('--table <list.tsv> is required')
    return { registry: path, ...(await importList(path, await readFile(values.table, 'utf8'), values.table)) }
  }
  const measured = await measureCompetitors(path, { competitors: values['competitor-id'] })
  if (measured.failures.length) process.exitCode = EXIT_FAILURE
  return measured
}

async function mapping(verb, id, values) {
  const path = registryPath(values.registry)
  if (verb === 'list') return { registry: path, mappings: (await readRegistry(path)).mappings }
  if (verb === 'show') return { registry: path, mapping: await showMapping(path, id) }
  if (verb === 'remove') return { registry: path, removed: await removeMapping(path, id) }
  if (!values.catalog) refuseUsage('--catalog <products.json> is required: the file stado product catalog --json writes')
  if (verb === 'import') {
    const inputs = await jsonFile(values.mappings, '--mappings <mappings.json>')
    return { registry: path, ...(await importMappings(path, inputs, await readCatalog(values.catalog))) }
  }
  const input = await jsonFile(values.mapping, '--mapping <mapping.json>')
  return { registry: path, ...(await setMapping(path, id, input, await readCatalog(values.catalog))) }
}

async function opportunity(values) {
  const path = registryPath(values.registry)
  const limit = wholeNumber(values.limit, '--limit', 1)
  const ranked = rankOpportunities(await readRegistry(path))
  return { registry: path, opportunities: limit === undefined ? ranked : ranked.slice(0, limit) }
}

async function proposal(values) {
  const path = registryPath(values.registry)
  if (!values.catalog) refuseUsage('--catalog <products.json> is required: the file stado product catalog --json writes')
  if (values.limit === undefined) refuseUsage('--limit <n> is required: how many of the strongest gaps get a proposal')
  oneOf(values.family, '--family', ['wisent', 'standalone'])
  if (Boolean(values['oko-root']) !== Boolean(values['oko-product'])) refuseUsage('--oko-root and --oko-product go together')
  return writeProposals(path, {
    out: values.out,
    limit: wholeNumber(values.limit, '--limit', 1),
    owner: values.owner,
    family: values.family,
    evidence: values.evidence,
    catalog: await readCatalog(values.catalog),
    oko: values['oko-root'] ? { root: values['oko-root'], product: values['oko-product'] } : null,
  })
}

async function board(verb, values) {
  const path = registryPath(values.registry)
  if (verb === 'show') {
    const format = oneOf(values.format, '--format', ['json', 'text', 'markdown', 'html']) ?? 'markdown'
    const rows = boardRows(await readRegistry(path))
    if (format === 'markdown') return boardMarkdown(rows)
    if (format === 'html') return boardHtml(rows, path)
    return render({ registry: path, companies: rows }, format === 'text')
  }
  if (!values.catalog) refuseUsage('--catalog <products.json> is required: the file stado product catalog --json writes')
  const port = wholeNumber(values.port, '--port', 0) ?? 0
  if (port > 65535) refuseUsage(`--port must be at most 65535; got ${port}`)
  const { server, url } = await serveBoard({ registry: path, catalog: await readCatalog(values.catalog), port })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close())
  return JSON.stringify({ registry: path, url }, null, '  ')
}

async function discover(values) {
  const input = await jsonFile(values.records, '--records <records.json>')
  const records = Array.isArray(input) ? input : input.records
  if (!Array.isArray(records)) throw new Error('Records input must be an array or {"records": []}')
  const existingCompetitors = values.registry ? (await readRegistry(values.registry)).competitors : []
  const candidates = discoverCompetitorCandidates(records, { ownDomains: values['own-domain'], existingCompetitors })
  return { summary: summarizeDiscoveryCandidates(candidates), candidates }
}

async function compare(values) {
  const product = await jsonFile(values.product, '--product <product.json>')
  const file = values.competitors
  const named = values.registry
  if (Boolean(file) === Boolean(named)) {
    refuseUsage('competitors compare takes exactly one of --competitors <competitors.json> or --registry <file>')
  }
  const format = oneOf(values.format, '--format', ['json', 'markdown']) ?? 'markdown'
  const criteria = criteriaFromValues(values, refuseUsage)
  const filter = describeCriteria(criteria)
  let competitors
  if (file) {
    if (filter) refuseUsage(`competitors compare filters (${filter}) choose from a registry; name --registry <file> instead of --competitors`)
    competitors = competitorList(await jsonFile(file, '--competitors <competitors.json>'), 'Competitors')
  } else {
    const held = (await readRegistry(named)).competitors
    if (!held.length) throw new Error(`competitor registry ${named} holds no competitor; add one with competitors registry add`)
    competitors = filterCompetitors(held, criteria)
    if (!competitors.length) {
      throw new Error(`no competitor of the ${held.length} in ${named} matches ${filter}; competitors registry list --registry ${named} shows them`)
    }
  }
  const comparison = compareProducts(product, competitors)
  if (format === 'json') return JSON.stringify(comparison, null, '  ')
  return comparisonMarkdown(comparison)
}

const VERBS = {
  registry: ['list', 'show', 'add', 'import', 'edit', 'remove'],
  observation: ['list', 'show', 'add', 'import', 'remove', 'measure'],
  mapping: ['list', 'show', 'set', 'import', 'remove'],
  opportunity: ['list'],
  proposal: ['write'],
  board: ['show', 'serve'],
}

async function grouped(group, verb, id, values) {
  if (group === 'registry') return render(await registry(verb, id, values), values.text)
  if (group === 'observation') return render(await observation(verb, id, values), values.text)
  if (group === 'mapping') return render(await mapping(verb, id, values), values.text)
  if (group === 'opportunity') return render(await opportunity(values), values.text)
  if (group === 'proposal') return render(await proposal(values), values.text)
  return board(verb, values)
}

async function main() {
  const [, , ...argv] = process.argv
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    return
  }
  const { values, positionals, tokens } = parse(argv)
  const [command, verb, id] = positionals
  const [, , ...afterVerb] = positionals
  const [, , , ...afterId] = positionals
  const [, ...afterCommand] = positionals
  if (GROUPS.includes(command)) {
    const verbs = VERBS[command].join(', ')
    if (verb === undefined) refuseUsage(`competitors ${command} needs a verb: ${verbs}`)
    const name = `${command} ${verb}`
    if (!FLAGS[name]) refuseUsage(`competitors ${command} takes ${verbs}, not ${verb}`)
    if (TAKES_ID.has(name) && !(name === 'registry edit' && id === undefined)) {
      if (id === undefined) refuseUsage(`competitors ${name} needs the ${command === 'observation' ? 'observation' : 'competitor'} id`)
      refuseSurplus(name, afterId)
    } else {
      refuseSurplus(name, afterVerb)
    }
    refuseUnknown(name, tokens)
    console.log(await grouped(command, verb, id, values))
    return
  }
  if (!FLAGS[command]) refuseUsage(`Unknown command: ${command}`)
  refuseSurplus(command, afterCommand)
  refuseUnknown(command, tokens)
  if (command === 'discover') {
    console.log(render(await discover(values), values.text))
    return
  }
  console.log(await compare(values))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_FAILURE
})
