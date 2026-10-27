#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { compareProducts, comparisonMarkdown } from './comparison.js'
import { discoverCompetitorCandidates, summarizeDiscoveryCandidates } from './discovery/index.js'
import {
  addCompetitor,
  editCompetitor,
  importCompetitors,
  readRegistry,
  registryPath,
  removeCompetitor,
  showCompetitor,
} from './competition/registry-file.js'
import { criteriaFromValues, describeCriteria, filterCompetitors } from './competition/filter.js'

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
  competitors registry remove <id> [--registry <file>] [--text]
  competitors discover --records <records.json> [--registry <file>] [--own-domain <domain>]... [--text]
  competitors compare --product <product.json> (--competitors <competitors.json> | --registry <file> [--tag <tag>]... [--region <region>]... [--category <category>] [--active | --inactive]) [--format json|markdown]

The registry is one JSON file the CLI owns, {"competitors": [...]}, named by --registry or
COMPETITORS_REGISTRY; it starts empty. A competitor record carries id or name, and optionally
company, productCategory, domains, appStoreIds, playStorePackages, regions, tags and active.
registry import adds every competitor of an array or {"competitors": [...]} in one write, or
none: an id the registry holds or the file names twice is refused. --tag and --region repeat
and keep a competitor carrying any of them; every filter narrows the list or the comparison.
All commands write their result to stdout: as JSON, or with --text as one path: value line per
field. Network and model I/O remain injected library boundaries.`
}

function refuseUsage(message) {
  throw new UsageError(`${message}\n\n${usage()}`)
}

// Every flag the CLI knows. --own-domain, --tag and --region repeat; every
// other flag is refused when given twice, so a second value never silently
// replaces the first (rule 12).
const REPEATABLE = new Set('own-domain tag region'.split(' '))
const OPTIONS = Object.fromEntries([
  ...'records product competitors registry competitor category'.split(' ').map((name) => [name, { type: 'string' }]),
  ['format', { type: 'string', default: 'markdown' }],
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
  'registry edit': 'competitor registry text'.split(' '),
  'registry remove': 'registry text'.split(' '),
  discover: 'records registry own-domain text'.split(' '),
  compare: `product competitors registry format ${FILTERS}`.split(' '),
}
// Verbs whose first word after the verb is the competitor id.
const TAKES_ID = new Set(['registry show', 'registry edit', 'registry remove'])

function parse(argv) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true, tokens: true })
  } catch (error) {
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

async function registry(verb, id, values) {
  const path = registryPath(values.registry)
  if (verb === 'list') {
    const held = await readRegistry(path)
    const criteria = criteriaFromValues(values, refuseUsage)
    const filter = describeCriteria(criteria)
    if (!filter) return { registry: path, ...held }
    return { registry: path, filter, held: held.competitors.length, competitors: filterCompetitors(held.competitors, criteria) }
  }
  if (verb === 'import') {
    const input = await jsonFile(values.competitors, '--competitors <competitors.json>')
    return { registry: path, added: await importCompetitors(path, competitorList(input, 'Competitors')) }
  }
  if (verb === 'show') return { registry: path, competitor: await showCompetitor(path, id) }
  if (verb === 'remove') return { registry: path, removed: await removeCompetitor(path, id) }
  const input = await jsonFile(values.competitor, '--competitor <competitor.json>')
  if (verb === 'add') return { registry: path, added: await addCompetitor(path, input) }
  return { registry: path, changed: await editCompetitor(path, id, input) }
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
  if (values.format === 'json') return JSON.stringify(comparison, null, '  ')
  if (values.format === 'markdown') return comparisonMarkdown(comparison)
  return refuseUsage('--format must be json or markdown')
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
  if (command === 'registry') {
    if (verb === undefined) refuseUsage('competitors registry needs a verb: list, show, add, import, edit or remove')
    const name = `registry ${verb}`
    if (!FLAGS[name]) refuseUsage(`competitors registry takes list, show, add, import, edit or remove, not ${verb}`)
    if (TAKES_ID.has(name)) {
      if (id === undefined) refuseUsage(`competitors ${name} needs the competitor id`)
      refuseSurplus(name, afterId)
    } else {
      refuseSurplus(name, afterVerb)
    }
    refuseUnknown(name, tokens)
    console.log(render(await registry(verb, id, values), values.text))
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
