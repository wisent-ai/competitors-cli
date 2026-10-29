import { createHash } from 'node:crypto'
import { COMPETITOR_SIGNAL_TYPES, COMPETITOR_SOURCE_TYPES, slugify, stableHash } from '../competition/model.js'
import { readRegistry } from '../competition/registry-file.js'
import { recordObservations } from './observations.js'

// Measuring a competitor again from what it declares: each domain's home page
// (title, description and a digest of the page, so a change of positioning is
// a new reading), the Hacker News stories its mention query finds, and the
// stars of each of its public GitHub repositories. Every reading is plain HTTP
// to a public page or a public read-only API; a site whose robots.txt
// disallows its home page is not fetched. A reading is recorded once per day
// and value, so a measurement repeated within the day adds nothing.

// The public read-only APIs the two adapters read: each is the provider's
// published address, which is what the adapter is.
const HACKER_NEWS_SEARCH = 'https://hn.algolia.com/api/v1/search'
const GITHUB_REPOSITORIES = 'https://api.github.com/repos'
const AGENT = 'competitors-cli (+https://github.com/wisent-ai/competitors-cli)'

async function get(url, accept) {
  let response
  try {
    response = await fetch(url, { headers: { 'user-agent': AGENT, accept }, redirect: 'follow' })
  } catch (error) {
    throw new Error(`GET ${url} failed: ${error.cause?.message || error.message}`)
  }
  return response
}

async function json(url) {
  const response = await get(url, 'application/json')
  const body = await response.text()
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}: ${body.slice(0, 300)}`)
  return JSON.parse(body)
}

/** Whether robots.txt at `origin` lets every agent, or this one, read `path`. */
async function robotsAllow(origin, path) {
  const response = await get(`${origin}/robots.txt`, 'text/plain')
  if (response.status >= 400 && response.status < 500) return true
  if (!response.ok) throw new Error(`GET ${origin}/robots.txt answered ${response.status}; the page is not read without knowing its rules`)
  const groups = []
  let current = null
  for (const raw of (await response.text()).split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, '').trim()
    const [field, ...rest] = line.split(':')
    const value = rest.join(':').trim()
    const key = field.trim().toLowerCase()
    if (key === 'user-agent') {
      if (!current || current.rules.length) groups.push((current = { agents: [], rules: [] }))
      current.agents.push(value.toLowerCase())
    } else if (current && (key === 'disallow' || key === 'allow')) {
      current.rules.push({ allow: key === 'allow', prefix: value })
    }
  }
  const ours = groups.filter((group) => group.agents.some((agent) => agent !== '*' && AGENT.toLowerCase().startsWith(agent)))
  const applying = ours.length ? ours : groups.filter((group) => group.agents.includes('*'))
  const matching = applying.flatMap((group) => group.rules).filter((rule) => rule.prefix && path.startsWith(rule.prefix))
  if (!matching.length) return true
  const longest = matching.reduce((best, rule) => (rule.prefix.length > best.prefix.length || (rule.prefix.length === best.prefix.length && rule.allow) ? rule : best))
  return longest.allow
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function tagText(html, pattern) {
  const match = pattern.exec(html)
  if (!match) return null
  return match[1]
    .replace(/&#x([\da-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&([a-z]+);/giu, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/gu, ' ')
    .trim()
}

async function website(competitor, domain, day) {
  const origin = `https://${domain}`
  if (!(await robotsAllow(origin, '/'))) throw new Error(`robots.txt of ${domain} disallows its home page`)
  const response = await get(`${origin}/`, 'text/html')
  const html = await response.text()
  if (!response.ok) throw new Error(`GET ${origin}/ answered ${response.status}`)
  const title = tagText(html, /<title[^>]*>([^<]*)<\/title>/iu)
  const description = tagText(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/iu)
    || tagText(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/iu)
  // The digest is of what the page says it is, not of its bytes: a page that
  // renders a fresh token on every load would otherwise read as a new
  // positioning every day.
  const positioningHash = createHash('sha256').update(JSON.stringify([title, description])).digest('hex')
  return {
    observationId: `website:${stableHash({ id: competitor.id, domain, day, positioningHash })}`,
    competitor: competitor.id,
    signalType: COMPETITOR_SIGNAL_TYPES.POSITIONING,
    sourceType: COMPETITOR_SOURCE_TYPES.WEBSITE,
    url: response.url,
    evidenceUrl: response.url,
    title,
    summary: description,
    attributes: { domain, positioningHash, status: response.status },
    capturedBy: 'competitors observation measure',
  }
}

async function mentions(competitor, day) {
  const query = competitor.mentionQuery
  // Quoted, the words are one phrase: unquoted, the search tolerates typos
  // and prefixes, so a short name counts hundreds of thousands of stories.
  const url = `${HACKER_NEWS_SEARCH}?${new URLSearchParams({ query: `"${query}"`, tags: 'story', hitsPerPage: '0' })}`
  const answer = await json(url)
  if (!Number.isInteger(answer.nbHits)) throw new Error(`${url} answered without a story count: ${JSON.stringify(answer).slice(0, 300)}`)
  return {
    observationId: `hn:${stableHash({ id: competitor.id, query, day, value: answer.nbHits })}`,
    competitor: competitor.id,
    signalType: COMPETITOR_SIGNAL_TYPES.SOCIAL,
    sourceType: COMPETITOR_SOURCE_TYPES.HACKER_NEWS,
    evidenceUrl: `https://hn.algolia.com/?${new URLSearchParams({ q: `"${query}"`, type: 'story' })}`,
    metric: { key: 'hn_stories', value: answer.nbHits, unit: 'stories' },
    attributes: { query },
    capturedBy: 'competitors observation measure',
  }
}

async function stars(competitor, repository, day) {
  const answer = await json(`${GITHUB_REPOSITORIES}/${repository}`)
  if (!Number.isInteger(answer.stargazers_count)) throw new Error(`GitHub answered ${repository} without a star count`)
  return {
    observationId: `github:${stableHash({ id: competitor.id, repository, day, value: answer.stargazers_count })}`,
    competitor: competitor.id,
    signalType: COMPETITOR_SIGNAL_TYPES.SOCIAL,
    sourceType: COMPETITOR_SOURCE_TYPES.GITHUB,
    url: answer.html_url,
    evidenceUrl: answer.html_url,
    metric: { key: 'github_stars', value: answer.stargazers_count, unit: 'stars' },
    attributes: { repository },
    capturedBy: 'competitors observation measure',
  }
}

/** Every reading a competitor declares, each one a named step. */
function readings(competitor, day) {
  return [
    ...competitor.domains.map((domain) => ({ signal: `website ${domain}`, take: () => website(competitor, domain, day) })),
    ...(competitor.mentionQuery ? [{ signal: `hacker news "${competitor.mentionQuery}"`, take: () => mentions(competitor, day) }] : []),
    ...competitor.repositories.map((repository) => ({ signal: `github ${repository}`, take: () => stars(competitor, repository, day) })),
  ]
}

/**
 * Measure every active competitor, or the named ones, from the signals each
 * declares, and record the readings. A signal that cannot be read is named
 * in `failures` with its cause, and every other reading is still recorded.
 */
export async function measureCompetitors(path, { competitors: named = [] } = {}) {
  const registry = await readRegistry(path)
  const wanted = named.map(slugify)
  const unknown = wanted.filter((id) => !registry.competitors.some((competitor) => competitor.id === id))
  if (unknown.length) throw new Error(`competitor ${unknown.join(', ')} is not in ${path}; competitors registry list names the ${registry.competitors.length} it holds`)
  const chosen = registry.competitors.filter((competitor) => (wanted.length ? wanted.includes(competitor.id) : competitor.active))
  const measuredAt = new Date().toISOString()
  const [day] = measuredAt.split('T')
  const taken = []
  const failures = []
  const silent = []
  for (const competitor of chosen) {
    const steps = readings(competitor, day)
    if (!steps.length) silent.push(competitor.id)
    for (const step of steps) {
      try {
        taken.push(await step.take())
      } catch (error) {
        failures.push({ competitor: competitor.id, signal: step.signal, cause: error.message })
      }
    }
  }
  const { recorded, known } = await recordObservations(path, taken)
  return {
    registry: path,
    measuredAt,
    competitors: chosen.length,
    recorded: recorded.length,
    known: known.length,
    // Competitors that declare no domain, mention query or repository: nothing about them can be measured.
    withoutSignals: silent,
    failures,
  }
}
