#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { compareProducts, comparisonMarkdown } from './comparison.js'
import { discoverCompetitorCandidates, summarizeDiscoveryCandidates } from './discovery/index.js'
import {
  addCompetitor,
  editCompetitor,
  readRegistry,
  registryPath,
  removeCompetitor,
  showCompetitor,
} from './competition/registry-file.js'

// The invocation itself is wrong: exit 2 with the usage; any other failure
// exits 1 with its own message (cli.md rule 10).
class UsageError extends Error {}

function usage() {
  return `competitors-cli

Usage:
  competitors registry list [--registry <file>] [--text]
  competitors registry show <id> [--registry <file>] [--text]
  competitors registry add --competitor <competitor.json> [--registry <file>] [--text]
  competitors registry edit <id> --competitor <changes.json> [--registry <file>] [--text]
  competitors registry remove <id> [--registry <file>] [--text]
  competitors discover --records <records.json> [--registry <file>] [--own-domain <domain>] [--text]
  competitors compare --product <product.json> (--competitors <competitors.json> | --registry <file>) [--format json|markdown]

The registry is one JSON file the CLI owns, {"competitors": [...]}, named by --registry or
COMPETITORS_REGISTRY; it starts empty. A competitor record carries id or name, and optionally
company, productCategory, domains, appStoreIds, playStorePackages, regions, tags and active.
All commands write their result to stdout: as JSON, or with --text as one path: value line per
field. Network and model I/O remain injected library boundaries.`
}

function value(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

// The same result for people: one `path: value` line per field (cli.md rule 13).
function render(result, text) {
  if (!text) return JSON.stringify(result, null, 2)
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
  if (!path) throw new UsageError(`${label} is required\n\n${usage()}`)
  return JSON.parse(await readFile(path, 'utf8'))
}

// The flags each command reads; anything else is refused before the command
// runs, so a misspelt flag never silently falls back to a default (rule 12).
const FLAGS = {
  'registry list': '--registry --text'.split(' '),
  'registry show': '--registry --text'.split(' '),
  'registry add': '--competitor --registry --text'.split(' '),
  'registry edit': '--competitor --registry --text'.split(' '),
  'registry remove': '--registry --text'.split(' '),
  discover: '--records --registry --own-domain --text'.split(' '),
  compare: '--product --competitors --registry --format'.split(' '),
}
const VALUED = new Set('--records --own-domain --product --competitors --format --registry --competitor'.split(' '))
// Verbs whose first word after the verb is the competitor id.
const TAKES_ID = new Set(['registry show', 'registry edit', 'registry remove'])

function refuseUnknown(command, args, start) {
  const known = FLAGS[command]
  for (let index = start; index < args.length; index += 1) {
    const arg = args[index]
    if (!known.includes(arg)) throw new UsageError(`competitors ${command} does not take ${arg}; it takes ${known.join(', ')}\n\n${usage()}`)
    if (VALUED.has(arg)) {
      if (index + 1 >= args.length) throw new UsageError(`${arg} needs a value\n\n${usage()}`)
      index += 1
    }
  }
}

async function registry(verb, args, text) {
  const path = registryPath(value(args, '--registry'))
  if (verb === 'list') return { registry: path, ...(await readRegistry(path)) }
  const id = args[2]
  if (verb === 'show') return { registry: path, competitor: await showCompetitor(path, id) }
  if (verb === 'remove') return { registry: path, removed: await removeCompetitor(path, id) }
  const input = await jsonFile(value(args, '--competitor'), '--competitor <competitor.json>')
  if (verb === 'add') return { registry: path, added: await addCompetitor(path, input) }
  return { registry: path, changed: await editCompetitor(path, id, input) }
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  if (!command || args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  const text = args.includes('--text')
  if (command === 'registry') {
    const verb = args[1]
    const name = `registry ${verb}`
    if (!FLAGS[name]) throw new UsageError(`competitors registry takes list, show, add, edit or remove, not ${verb ?? 'nothing'}\n\n${usage()}`)
    if (TAKES_ID.has(name) && (!args[2] || args[2].startsWith('--'))) throw new UsageError(`competitors ${name} needs the competitor id\n\n${usage()}`)
    refuseUnknown(name, args, TAKES_ID.has(name) ? 3 : 2)
    console.log(render(await registry(verb, args, text), text))
    return
  }
  if (!FLAGS[command]) throw new UsageError(`Unknown command: ${command}\n\n${usage()}`)
  refuseUnknown(command, args, 1)
  if (command === 'discover') {
    const input = await jsonFile(value(args, '--records'), '--records <records.json>')
    const records = Array.isArray(input) ? input : input.records
    if (!Array.isArray(records)) throw new Error('Records input must be an array or {"records": []}')
    const ownDomains = args.flatMap((arg, index) => arg === '--own-domain' && args[index + 1] ? [args[index + 1]] : [])
    const existingCompetitors = value(args, '--registry')
      ? (await readRegistry(value(args, '--registry'))).competitors
      : []
    const candidates = discoverCompetitorCandidates(records, { ownDomains, existingCompetitors })
    console.log(render({ summary: summarizeDiscoveryCandidates(candidates), candidates }, text))
    return
  }
  const product = await jsonFile(value(args, '--product'), '--product <product.json>')
  const file = value(args, '--competitors')
  const named = value(args, '--registry')
  if (Boolean(file) === Boolean(named)) {
    throw new UsageError(`competitors compare takes exactly one of --competitors <competitors.json> or --registry <file>\n\n${usage()}`)
  }
  let competitors
  if (file) {
    const input = await jsonFile(file, '--competitors <competitors.json>')
    competitors = Array.isArray(input) ? input : input.competitors
    if (!Array.isArray(competitors)) throw new Error('Competitors input must be an array or {"competitors": []}')
  } else {
    competitors = (await readRegistry(named)).competitors
    if (!competitors.length) throw new Error(`competitor registry ${named} holds no competitor; add one with competitors registry add`)
  }
  const comparison = compareProducts(product, competitors)
  const format = value(args, '--format') || 'markdown'
  if (format === 'json') console.log(JSON.stringify(comparison, null, 2))
  else if (format === 'markdown') console.log(comparisonMarkdown(comparison))
  else throw new UsageError('--format must be json or markdown')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = error instanceof UsageError ? 2 : 1
})
