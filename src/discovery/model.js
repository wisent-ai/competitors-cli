import { replyObject, schemaFormat as format, strictObject } from '../context/adapters/answer.js'

// The competitor model seam: every judgment discovery delegates to the
// injected model (which queries to run, which entities a search names, what
// counts as a competitor, how to expand), each asked as a strict JSON schema
// (`response_format` `json_schema`) the reply must be. A reply that is not
// that object is the stage's error, said with the reply; it is never searched
// for an object or array inside prose, and never read as "nothing found".
//
// purpose is a routing label the caller maps to a model-router task
// ('competitor-seed-queries' | 'competitor-extract' | 'competitor-classify'
//  | 'competitor-expand').

export const PURPOSE_SEED = 'competitor-seed-queries'
export const PURPOSE_EXTRACT = 'competitor-extract'
export const PURPOSE_CLASSIFY = 'competitor-classify'
export const PURPOSE_EXPAND = 'competitor-expand'

/** Text with runs of whitespace collapsed; an absent value is no text. */
export function cleanText(value) {
  if (value === undefined || value === null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

// Each decision classify may answer, with what it means; the model is told
// these meanings and the schema admits only these decisions.
const DECISION_MEANINGS = {
  include: 'a genuine same-market competitor',
  exclude: 'clearly not a competitor entity',
  ambiguous: 'the evidence is too thin to tell',
}

const TEXT = { type: 'string' }
const QUERIES_FORMAT = format('competitor_queries', { queries: { type: 'array', items: TEXT } })
const ENTITY = strictObject({ name: TEXT, url: TEXT, snippet: TEXT })
const ENTITIES_FORMAT = format('competitor_entities', { entities: { type: 'array', items: ENTITY } })
const DECISION_FORMAT = format('competitor_decision', { decision: { enum: Object.keys(DECISION_MEANINGS) }, reason: TEXT })

function queryList(queries) {
  return [...new Set(queries.map(cleanText).filter(Boolean))]
}

function marketBlock(context) {
  const lines = []
  if (context.brand) lines.push(`Our brand (never list it as a competitor): ${context.brand}`)
  if (context.product) lines.push(`Our product: ${context.product}`)
  const market = context.marketDefinition ? context.marketDefinition : context.market
  if (market) lines.push(`Market we compete in: ${market}`)
  return lines.join('\n')
}

function candidateBlock(candidate) {
  const lines = []
  if (candidate.name) lines.push(`Name: ${cleanText(candidate.name)}`)
  const url = cleanText(candidate.url ? candidate.url : candidate.officialUrl)
  if (url) lines.push(`URL: ${url}`)
  if (candidate.snippet) lines.push(`Search snippet: ${cleanText(candidate.snippet)}`)
  if (candidate.evidence) lines.push(`Text gathered from its own page: ${cleanText(candidate.evidence)}`)
  return lines.join('\n')
}

export function createCompetitorModel(options = {}) {
  const chat = options.chat
  if (typeof chat !== 'function') throw new Error('createCompetitorModel requires a chat(messages, { purpose, responseFormat }) function')

  async function queriesFor(system, user, purpose) {
    const reply = await chat([{ role: 'system', content: system }, { role: 'user', content: user }], { purpose, responseFormat: QUERIES_FORMAT })
    return queryList(replyObject(reply, purpose, 'competitor_queries', (object) => Array.isArray(object.queries)).queries)
  }

  async function seedQueries(context) {
    const market = marketBlock(context)
    if (!market) throw new Error('seedQueries requires brand, product, market, or marketDefinition')
    return queriesFor(
      'You plan web searches that surface companies and products competing in a described market. Answer the competitor_queries object: the short search query strings a person would type to find competitors.',
      market,
      PURPOSE_SEED,
    )
  }

  async function extractCandidates(rawSearchText, context) {
    const text = cleanText(rawSearchText)
    if (!text) return []
    const reply = await chat([
      { role: 'system', content: 'You read raw search-result text and extract the distinct organizations or products it references. Answer the competitor_entities object, each entity with its name, url and snippet (an empty string when the text gives none). Skip news outlets, listicles, and encyclopedic pages; keep entities that could be actual companies or products.' },
      { role: 'user', content: `${marketBlock(context)}\n\nRaw search results:\n${text}` },
    ], { purpose: PURPOSE_EXTRACT, responseFormat: ENTITIES_FORMAT })
    return replyObject(reply, PURPOSE_EXTRACT, 'competitor_entities', (object) => Array.isArray(object.entities)).entities
      .map((entity) => ({ name: cleanText(entity.name), url: cleanText(entity.url), snippet: cleanText(entity.snippet) }))
      .filter((entity) => entity.name || entity.url)
  }

  async function classify(candidate, context) {
    const described = candidateBlock(candidate)
    if (!described) return { decision: 'ambiguous', reason: 'candidate has no identifying evidence', type: 'model' }
    const meanings = Object.entries(DECISION_MEANINGS).map(([decision, meaning]) => `"${decision}" when ${meaning}`).join(', ')
    const reply = await chat([
      { role: 'system', content: `You decide whether a discovered entity is a genuine competitor in the described market. A competitor is a real company or product a buyer would weigh against ours. News articles, listicles, directories, research papers, documentation, and generic category pages are NOT competitors. Answer the competitor_decision object: ${meanings}, with the reason.` },
      { role: 'user', content: `${marketBlock(context)}\n\nCandidate under review:\n${described}` },
    ], { purpose: PURPOSE_CLASSIFY, responseFormat: DECISION_FORMAT })
    const answer = replyObject(reply, PURPOSE_CLASSIFY, 'competitor_decision', (object) => Object.hasOwn(DECISION_MEANINGS, object.decision))
    const reason = cleanText(answer.reason)
    return { decision: answer.decision, reason: reason ? reason : null, type: 'model' }
  }

  async function expand(competitor, context) {
    const name = cleanText(competitor?.name)
    if (!name) return []
    return queriesFor(
      'You expand a competitor search. Given one confirmed competitor, answer the competitor_queries object: short search query strings that would surface OTHER competitors in the same market.',
      `${marketBlock(context)}\n\nConfirmed competitor: ${name}`,
      PURPOSE_EXPAND,
    )
  }

  return { seedQueries, extractCandidates, classify, expand }
}
