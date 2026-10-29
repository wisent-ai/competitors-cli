import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readRegistry } from '../competition/registry-file.js'
import { selectObservations } from './observations.js'
import { rankOpportunities } from './opportunity.js'

// A proposal is a product plan for one of the strongest gaps: a tracked
// competitor nothing of ours meets, ranked by its opportunity. It is written
// as `<out>/<id>/plan.md` and `<out>/<id>/create-request.json`, the request
// `stado product create --plan` checks and `stado product create --request`
// would provision from. Nothing is created: the product's name is the
// operator's, so the id is a working one (`answer-<competitor>`) until he
// names it. With an Oko root defect, each proposal is also recorded in Oko's
// work queue as an open item under it, through the `oko` command.

const run = promisify(execFile)

const REPOSITORY_SUFFIX = { cli: '', service: '', desktop: '-desktop', web: '-landing', ios: '-ios', android: '-android' }
const FAMILIES = ['wisent', 'standalone']

function identity(competitor) {
  return `answer-${competitor.replaceAll('_', '-')}`
}

/** One repository per surface; a service is served by the cli's repository when both are named. */
function repositories(id, owner, surfaces) {
  const rows = []
  const names = new Set()
  for (const surface of surfaces) {
    const repository = `${owner}/${id}${REPOSITORY_SUFFIX[surface]}`
    if (names.has(repository)) continue
    names.add(repository)
    rows.push({ surface, repository })
  }
  return rows
}

function figureRows(member) {
  return member.observations
    .filter((observation) => observation.metric)
    .map((observation) => `| ${member.competitor.name} | ${observation.metric.key} | ${observation.metric.rawValue || observation.metric.value} | ${observation.attributes?.snapshot || observation.observedAt.slice(0, 10)} | ${observation.attributes?.source || observation.evidenceUrl || observation.sourceType} |`)
}

/**
 * The plan of one proposal. `members` are the competitors whose mappings
 * name the same offer, strongest first; the first one's mapping speaks for
 * the proposal.
 */
function planText({ id, members, catalog, request, requestPath, evidence, family }) {
  const [lead] = members
  const { mapping } = lead
  const uses = mapping.uses.map((product) => `| ${catalog.get(product).name} (\`${product}\`) | ${catalog.get(product).description} |`)
  const names = members.map((member) => member.competitor.name).join(', ')
  const why = members.map((member) => `### ${member.competitor.name}${member.competitor.description ? ` (${member.competitor.description})` : ''}

Opportunity score ${Math.round(member.opportunity.score)}: revenue per employee × revenue growth × ${member.opportunity.advantages} advantages.

${member.opportunity.reasons.map((reason) => `- ${reason}`).join('\n')}
`).join('\n')
  return `# ${id} — product plan

Status: proposed by \`competitors proposal write\` from the tracked
competitors ${names}; nothing built, no repository, no catalog record. The
name is the operator's: \`${id}\` is a working id until he names it.

## Why it is proposed

${why}
Evidence: ${evidence.map((ref) => `\`${ref}\``).join(', ')}.

## What it is

${mapping.offer}

## Who it serves

People who today pay ${names} for this: ${mapping.need}

Purpose: ${mapping.purpose}.

## The market signal

| company | metric | value | snapshot | source |
|---|---|---|---|---|
${members.flatMap(figureRows).join('\n')}

## Overlap with what we have

No catalog product meets this need (mapping by ${mapping.mappedBy}, ${mapping.mappedAt.slice(0, 10)}).

## What we would do better

${mapping.better.map((item) => `- **${item.advantage}**: ${item.reason}`).join('\n')}

## First coherent slice

Each is a real run on the release candidate, raw output retained:

${mapping.slice.map((item, index) => `${index + 1}. ${item}`).join('\n')}

## Surfaces

| surface | repository |
|---|---|
${request.repositories.map((row) => `| ${row.surface} | \`${row.repository}\` |`).join('\n')}
${mapping.surfaces.includes('service') && mapping.surfaces.includes('cli') ? '\nThe service is served by the cli repository.\n' : ''}
## Dependencies on our products

${uses.length ? `| product | what it is |\n|---|---|\n${uses.join('\n')}` : 'None named.'}

## Creation command

\`\`\`sh
stado product create --plan ${requestPath} --json
stado product create --request ${requestPath} --allow-create --json
\`\`\`

The first checks the request with reads only. The second provisions the
repositories and registers a preview product; it runs only after he names it.

## What needs his decision

1. The name (the request carries the working id \`${id}\`).
2. Family: \`${family}\` in the request; \`wisent\` or \`standalone\` is his call.
3. Purpose: ${mapping.purpose}, as mapped.
`
}

async function writeIfChanged(path, text) {
  let held = null
  try {
    held = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`reading ${path}: ${error.message}`)
  }
  if (held === text) return false
  await writeFile(`${path}.pending`, text)
  await rename(`${path}.pending`, path)
  return true
}

/** Record one proposal in Oko's work queue, under the root defect it answers. */
async function recordInOko({ oko, id, members, planPath, requestPath }) {
  const [lead] = members
  const names = members.map((member) => member.competitor.name).join(', ')
  const args = [
    'defects', 'record',
    '--product', oko.product,
    '--title', `Proposed product ${id} answering ${names}: ${lead.mapping.offer}`,
    '--surface', 'catalog/products.yml',
    '--evidence', `${planPath}; ${lead.opportunity.reasons.slice(0, 3).join('; ')}`,
    '--impact', `A gap no product of ours meets, opportunity score ${Math.round(lead.opportunity.score)}: ${lead.mapping.need}`,
    '--found-in', 'competitors proposal write',
    '--repair', `The operator names it; then stado product create --plan ${requestPath} and stado product create --request ${requestPath} --allow-create`,
    '--root', oko.root,
    '--json',
  ]
  let output
  try {
    output = await run('oko', args)
  } catch (error) {
    const said = [error.stdout, error.stderr].filter(Boolean).join(' ').trim()
    throw new Error(`oko ${args.slice(0, 2).join(' ')} for ${id} failed (${error.code === 'ENOENT' ? 'no oko program on PATH' : `exit ${error.code}`}): ${said || error.message}`)
  }
  const answer = JSON.parse(output.stdout)
  const defect = answer.defect || answer
  return defect.id || null
}

/**
 * Write a proposal for each of the strongest gaps, at most `limit`: the
 * competitors no product of ours meets, ranked by opportunity. Competitors
 * whose mappings name the same offer are one proposal, named after the
 * strongest of them. Each is written in full or the run stops naming it; a
 * proposal whose files already say the same is left as it is.
 */
export async function writeProposals(path, options) {
  const { out, limit, owner, family, evidence, catalog, oko = null } = options
  if (!out) throw new Error('--out <directory> is required: where each proposal directory is written')
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive whole number of proposals; got ${JSON.stringify(limit)}`)
  if (!owner || !/^[a-z][a-z\d-]*$/u.test(owner)) throw new Error(`--owner must be the GitHub organization the repositories would be created in, lowercase; got ${JSON.stringify(owner)}`)
  if (!FAMILIES.includes(family)) throw new Error(`--family must be ${FAMILIES.join(' or ')}; got ${JSON.stringify(family)}`)
  if (!evidence.length) throw new Error('--evidence <reference> is required at least once: the operator\'s words or the record each proposal answers')
  if (oko && (!oko.root || !oko.product)) throw new Error('--oko-root and --oko-product go together: the open defect the proposals answer and the product it belongs to')
  const registry = await readRegistry(path)
  const mappings = new Map(registry.mappings.map((mapping) => [mapping.competitor, mapping]))
  const competitors = new Map(registry.competitors.map((competitor) => [competitor.id, competitor]))
  const groups = new Map()
  for (const opportunity of rankOpportunities(registry)) {
    if (opportunity.kind !== 'new-product' || opportunity.score === null || opportunity.score <= 0) continue
    const mapping = mappings.get(opportunity.competitor)
    const member = {
      competitor: competitors.get(opportunity.competitor),
      opportunity,
      mapping,
      observations: selectObservations(registry.observations, { competitor: opportunity.competitor }),
    }
    if (!groups.has(mapping.offer)) groups.set(mapping.offer, [])
    groups.get(mapping.offer).push(member)
  }
  const written = []
  for (const members of [...groups.values()].slice(0, limit)) {
    const [lead] = members
    const missing = lead.mapping.uses.filter((product) => !catalog.has(product))
    if (missing.length) throw new Error(`the mapping of ${lead.competitor.id} uses ${missing.join(', ')}, which the product catalog no longer holds; competitors mapping set ${lead.competitor.id} again`)
    const id = identity(lead.competitor.id)
    const directory = resolve(join(out, id))
    const planPath = join(directory, 'plan.md')
    const requestPath = join(directory, 'create-request.json')
    const request = {
      schema_version: 1,
      request_id: `${id}-create`,
      initiative_id: `market-watch-${id}`,
      product: { id, name: `${lead.competitor.name} answer (working name)`, description: lead.mapping.offer, family, visibility: 'private' },
      repositories: repositories(id, owner, lead.mapping.surfaces),
      evidence_refs: [...evidence, ...members.map((member) => `competitors:registry:${member.competitor.id}`)],
    }
    await mkdir(directory, { recursive: true })
    const plan = planText({ id, members, catalog, request, requestPath, evidence, family })
    const planChanged = await writeIfChanged(planPath, plan)
    const requestChanged = await writeIfChanged(requestPath, `${JSON.stringify(request, null, 2)}\n`)
    const entry = {
      id,
      competitors: members.map((member) => member.competitor.id),
      score: lead.opportunity.score,
      plan: planPath,
      request: requestPath,
      changed: planChanged || requestChanged,
      okoDefect: null,
    }
    if (oko) entry.okoDefect = await recordInOko({ oko, id, members, planPath, requestPath })
    written.push(entry)
  }
  return { registry: path, out: resolve(out), proposals: groups.size, written }
}
