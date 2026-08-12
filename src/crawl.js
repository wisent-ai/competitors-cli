// Model-native competitor discovery.
//
// Design rules this file obeys:
//   * No hardcoded keyword tables, market vocabulary, or provider priority.
//   * No catch-all guessing. Every judgment (which queries to run, what counts
//     as a competitor, how to expand) is delegated to the injected model.
//   * No numeric literals. Every bound is a caller-supplied option.
//
// The caller owns both the model and all I/O, injected as functions:
//   chat(messages, { purpose }) => assistant text
//   search(query) => raw search-result text (caller hits its search provider)
//   fetchPage(url) => raw page text (optional; used only when gatherEvidence)
//
// purpose is a routing label the caller maps to a model-router task
// ('competitor-seed-queries' | 'competitor-extract' | 'competitor-classify'
//  | 'competitor-expand'). The library never picks a model or search provider,
// and never parses provider HTML: the model reads raw text and returns JSON.

const PURPOSE_SEED = 'competitor-seed-queries'
const PURPOSE_EXTRACT = 'competitor-extract'
const PURPOSE_CLASSIFY = 'competitor-classify'
const PURPOSE_EXPAND = 'competitor-expand'

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function canonicalText(value) {
  return cleanText(value).toLowerCase()
}

function hostFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./u, '').toLowerCase()
  } catch {
    return null
  }
}

// Identity key: the model extracts a brand name, so dedup on the normalized
// name first. The url is often the source page (a blog or listicle), not the
// brand's own site, so host is used only when no name is present.
function candidateName(candidate) {
  return canonicalText(candidate.name).replace(/[^a-z\d]+/g, '')
}

function candidateKey(candidate) {
  return candidateName(candidate) || hostFromUrl(candidate.url || candidate.officialUrl)
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const text = cleanText(typeof entry === 'string' ? entry : entry?.query || entry?.value || entry?.text)
    if (text) out.push(text)
  }
  return [...new Set(out)]
}

function candidateList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const name = cleanText(entry.name || entry.title || entry.company)
    const url = cleanText(entry.url || entry.link || entry.officialUrl)
    if (!name && !url) continue
    out.push({ name, url, snippet: cleanText(entry.snippet || entry.description || entry.text) })
  }
  return out
}

function parseJsonArray(raw) {
  const match = String(raw || '').match(/\[[\s\S]*\]/u)
  if (!match) return []
  try {
    const parsed = JSON.parse(match.join(''))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObject(raw) {
  const match = String(raw || '').match(/\{[\s\S]*\}/u)
  if (!match) return null
  try {
    const parsed = JSON.parse(match.join(''))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function normalizeDecision(value) {
  const decision = canonicalText(value)
  if (decision === 'include' || decision === 'competitor') return 'include'
  if (decision === 'exclude' || decision === 'not_competitor') return 'exclude'
  return 'ambiguous'
}

function marketBlock(context) {
  const lines = []
  if (context.brand) lines.push(`Our brand (never list it as a competitor): ${context.brand}`)
  if (context.product) lines.push(`Our product: ${context.product}`)
  const market = context.marketDefinition || context.market
  if (market) lines.push(`Market we compete in: ${market}`)
  return lines.join('\n')
}

function candidateBlock(candidate) {
  const lines = []
  if (candidate.name) lines.push(`Name: ${cleanText(candidate.name)}`)
  const url = cleanText(candidate.url || candidate.officialUrl)
  if (url) lines.push(`URL: ${url}`)
  if (candidate.snippet) lines.push(`Search snippet: ${cleanText(candidate.snippet)}`)
  if (candidate.evidence) lines.push(`Text gathered from its own page: ${cleanText(candidate.evidence)}`)
  return lines.join('\n')
}

// The model seam: every method delegates a judgment the model must own.
export function createCompetitorModel(options = {}) {
  const chat = options.chat
  if (typeof chat !== 'function') throw new Error('createCompetitorModel requires a chat(messages, { purpose }) function')

  async function seedQueries(context) {
    const market = marketBlock(context)
    if (!market) throw new Error('seedQueries requires brand, product, market, or marketDefinition')
    const reply = await chat([
      { role: 'system', content: 'You plan web searches that surface companies and products competing in a described market. Return ONLY a JSON array of short search query strings a person would type to find competitors. No prose, no markdown.' },
      { role: 'user', content: `${market}\n\nReturn the JSON array of search queries.` },
    ], { purpose: PURPOSE_SEED })
    return stringList(parseJsonArray(reply))
  }

  async function extractCandidates(rawSearchText, context) {
    const text = cleanText(rawSearchText)
    if (!text) return []
    const reply = await chat([
      { role: 'system', content: 'You read raw search-result text and extract the distinct organizations or products it references. Return ONLY a JSON array of objects {"name":"...","url":"...","snippet":"..."}. Skip news outlets, listicles, and encyclopedic pages; keep entities that could be actual companies or products. No prose, no markdown.' },
      { role: 'user', content: `${marketBlock(context)}\n\nRaw search results:\n${text}\n\nReturn the JSON array of extracted entities.` },
    ], { purpose: PURPOSE_EXTRACT })
    return candidateList(parseJsonArray(reply))
  }

  async function classify(candidate, context) {
    const described = candidateBlock(candidate)
    if (!described) return { decision: 'ambiguous', reason: 'candidate has no identifying evidence', type: 'model' }
    const reply = await chat([
      { role: 'system', content: 'You decide whether a discovered entity is a genuine competitor in the described market. A competitor is a real company or product a buyer would weigh against ours. News articles, listicles, directories, research papers, documentation, and generic category pages are NOT competitors. Reply ONLY with a JSON object {"decision":"include"|"exclude"|"ambiguous","reason":"..."}: "include" for a genuine same-market competitor, "exclude" when clearly not a competitor entity, "ambiguous" when evidence is too thin.' },
      { role: 'user', content: `${marketBlock(context)}\n\nCandidate under review:\n${described}\n\nReturn the JSON decision object.` },
    ], { purpose: PURPOSE_CLASSIFY })
    const parsed = parseJsonObject(reply)
    if (!parsed) return { decision: 'ambiguous', reason: 'model returned no parseable decision', type: 'model' }
    return { decision: normalizeDecision(parsed.decision), reason: cleanText(parsed.reason) || null, type: 'model' }
  }

  async function expand(competitor, context) {
    const name = cleanText(competitor?.name)
    if (!name) return []
    const reply = await chat([
      { role: 'system', content: 'You expand a competitor search. Given one confirmed competitor, return ONLY a JSON array of short search query strings that would surface OTHER competitors in the same market. No prose, no markdown.' },
      { role: 'user', content: `${marketBlock(context)}\n\nConfirmed competitor: ${name}\n\nReturn the JSON array of follow-up search queries.` },
    ], { purpose: PURPOSE_EXPAND })
    return stringList(parseJsonArray(reply))
  }

  return { seedQueries, extractCandidates, classify, expand }
}

// Orchestrate discovery: seed -> search -> extract -> classify -> expand,
// bounded by a caller-supplied round budget. Pure control flow over the
// injected model + I/O; no keyword tables, provider guessing, or literals.
export async function discoverCompetitors(input = {}, options = {}) {
  const context = {
    brand: cleanText(input.brand),
    product: cleanText(input.product),
    market: cleanText(input.market),
    marketDefinition: cleanText(input.marketDefinition),
  }
  if (!context.brand) throw new Error('brand is required')
  const marketDefinition = cleanText(input.marketDefinition || input.market || input.product)
  if (!marketDefinition) throw new Error('product, market, or marketDefinition is required')

  const search = options.search
  if (typeof search !== 'function') throw new Error('discoverCompetitors requires a search(query) function')
  const fetchPage = typeof options.fetchPage === 'function' ? options.fetchPage : null
  const gatherEvidence = options.gatherEvidence === true
  const maxRounds = options.maxRounds
  if (!Number.isInteger(maxRounds)) throw new Error('discoverCompetitors requires an integer maxRounds option')

  const model = createCompetitorModel({ chat: options.chat })
  const included = new Map()
  const excluded = new Map()
  const ambiguous = new Map()
  const seenQueries = new Set()
  const seenCandidates = new Set()
  const rounds = []
  const sourceErrors = []

  let frontier = new Set(await model.seedQueries(context))
  for (const query of frontier) seenQueries.add(canonicalText(query))

  while (frontier.size && !(rounds.length >= maxRounds)) {
    const current = [...frontier]
    frontier = new Set()
    const round = { queries: current, added: [], newQueries: [] }

    for (const query of current) {
      let rawSearch
      try {
        rawSearch = await search(query)
      } catch (error) {
        sourceErrors.push({ stage: 'search', query, error: cleanText(error?.message || String(error)) })
        continue
      }
      let extracted
      try {
        extracted = await model.extractCandidates(rawSearch, context)
      } catch (error) {
        sourceErrors.push({ stage: 'extract', query, error: cleanText(error?.message || String(error)) })
        continue
      }

      for (const candidate of extracted) {
        const key = candidateKey(candidate)
        if (!key || seenCandidates.has(key)) continue
        seenCandidates.add(key)

        let evidence = ''
        if (gatherEvidence && fetchPage && candidate.url) {
          try {
            evidence = cleanText(await fetchPage(candidate.url))
          } catch (error) {
            sourceErrors.push({ stage: 'fetchPage', url: candidate.url, error: cleanText(error?.message || String(error)) })
          }
        }

        let verdict
        try {
          verdict = await model.classify({ ...candidate, evidence }, context)
        } catch (error) {
          sourceErrors.push({ stage: 'classify', name: candidate.name, error: cleanText(error?.message || String(error)) })
          continue
        }
        const record = { name: candidate.name, url: candidate.url, snippet: candidate.snippet, decision: verdict.decision, reason: verdict.reason, discoveredByQuery: query }

        if (verdict.decision === 'include') {
          included.set(key, record)
          excluded.delete(key)
          ambiguous.delete(key)
          round.added.push(candidate.name)
          let follow = []
          try {
            follow = await model.expand(candidate, context)
          } catch (error) {
            sourceErrors.push({ stage: 'expand', name: candidate.name, error: cleanText(error?.message || String(error)) })
          }
          for (const next of follow) {
            const normalized = canonicalText(next)
            if (!normalized || seenQueries.has(normalized)) continue
            seenQueries.add(normalized)
            frontier.add(next)
            round.newQueries.push(next)
          }
          continue
        }
        if (verdict.decision === 'exclude') excluded.set(key, record)
        else ambiguous.set(key, record)
      }
    }
    rounds.push(round)
  }

  const status = sourceErrors.length || frontier.size ? 'incomplete' : 'saturated'
  return {
    ok: status === 'saturated',
    status,
    brand: context.brand,
    marketDefinition,
    competitors: [...included.values()].sort((a, b) => a.name.localeCompare(b.name)),
    excluded: [...excluded.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ambiguous: [...ambiguous.values()].sort((a, b) => a.name.localeCompare(b.name)),
    rounds,
    coverage: {
      roundsRun: rounds.length,
      roundBudgetExhausted: rounds.length >= maxRounds && Boolean(frontier.size),
      frontierRemaining: frontier.size,
      competitorsFound: included.size,
    },
    sourceErrors,
  }
}
