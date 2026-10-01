#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { DEFAULT_COMPETITORS } from './competition/seed.js'
import { compareProducts, comparisonMarkdown } from './comparison.js'
import { discoverCompetitorCandidates, summarizeDiscoveryCandidates } from './discovery/index.js'

// The invocation itself is wrong: exit 2 with the usage; any other failure
// exits 1 with its own message (cli.md rule 10).
class UsageError extends Error {}

function usage() {
  return `competitors-cli

Usage:
  competitors registry [--text]
  competitors discover --records <records.json> [--own-domain <domain>] [--text]
  competitors compare --product <product.json> --competitors <competitors.json> [--format json|markdown]

All commands write their result to stdout: registry and discover as JSON, or with --text as one
path: value line per field. Network and model I/O remain injected library boundaries.`
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

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  if (!command || args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return
  }
  if (command === 'registry') {
    console.log(render({ competitors: DEFAULT_COMPETITORS }, args.includes('--text')))
    return
  }
  if (command === 'discover') {
    const input = await jsonFile(value(args, '--records'), '--records <records.json>')
    const records = Array.isArray(input) ? input : input.records
    if (!Array.isArray(records)) throw new Error('Records input must be an array or {"records": []}')
    const ownDomains = args.flatMap((arg, index) => arg === '--own-domain' && args[index + 1] ? [args[index + 1]] : [])
    const candidates = discoverCompetitorCandidates(records, { ownDomains })
    console.log(render({ summary: summarizeDiscoveryCandidates(candidates), candidates }, args.includes('--text')))
    return
  }
  if (command === 'compare') {
    const product = await jsonFile(value(args, '--product'), '--product <product.json>')
    const input = await jsonFile(value(args, '--competitors'), '--competitors <competitors.json>')
    const competitors = Array.isArray(input) ? input : input.competitors
    if (!Array.isArray(competitors)) throw new Error('Competitors input must be an array or {"competitors": []}')
    const comparison = compareProducts(product, competitors)
    const format = value(args, '--format') || 'markdown'
    if (format === 'json') console.log(JSON.stringify(comparison, null, 2))
    else if (format === 'markdown') console.log(comparisonMarkdown(comparison))
    else throw new UsageError('--format must be json or markdown')
    return
  }
  throw new UsageError(`Unknown command: ${command}\n\n${usage()}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = error instanceof UsageError ? 2 : 1
})
