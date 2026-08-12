#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import { DEFAULT_COMPETITORS } from './competition/seed.js'
import { compareProducts, comparisonMarkdown } from './comparison.js'
import { discoverCompetitorCandidates, summarizeDiscoveryCandidates } from './discovery/index.js'

function usage() {
  return `competitors-cli

Usage:
  competitors registry
  competitors discover --records <records.json> [--own-domain <domain>]
  competitors compare --product <product.json> --competitors <competitors.json> [--format json|markdown]

All commands write their result to stdout. Network and model I/O remain injected library boundaries.`
}

function value(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

async function jsonFile(path, label) {
  if (!path) throw new Error(`${label} is required`)
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  if (!command || command === '--help' || command === '-h') {
    console.log(usage())
    return
  }
  if (command === 'registry') {
    console.log(JSON.stringify({ competitors: DEFAULT_COMPETITORS }, null, 2))
    return
  }
  if (command === 'discover') {
    const input = await jsonFile(value(args, '--records'), '--records <records.json>')
    const records = Array.isArray(input) ? input : input.records
    if (!Array.isArray(records)) throw new Error('Records input must be an array or {"records": []}')
    const ownDomains = args.flatMap((arg, index) => arg === '--own-domain' && args[index + 1] ? [args[index + 1]] : [])
    const candidates = discoverCompetitorCandidates(records, { ownDomains })
    console.log(JSON.stringify({ summary: summarizeDiscoveryCandidates(candidates), candidates }, null, 2))
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
    else throw new Error('--format must be json or markdown')
    return
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
