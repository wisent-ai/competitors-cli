// Model-native competitor discovery.
//
// Design rules this file obeys:
//   * No hardcoded keyword tables, market vocabulary, or provider priority.
//   * No catch-all guessing. Every judgment (which queries to run, what counts
//     as a competitor, how to expand) is delegated to the injected model
//     through the seam in discovery/model.js, each answer a schema-bound object.
//   * No numeric literals. Every bound is a caller-supplied option.
//
// The caller owns both the model and all I/O, injected as functions:
//   chat(messages, { purpose, responseFormat }) => assistant text
//   search(query) => raw search-result text (caller hits its search provider)
//   fetchPage(url) => raw page text (optional; used only when gatherEvidence)
//
// The library never picks a model or search provider, and never parses
// provider HTML: the model reads raw text and answers the object asked for.
import { cleanText, createCompetitorModel } from './discovery/model.js'

// The model seam is part of crawl's public surface: discovery/index.js and
// the package root read it from here.
export { createCompetitorModel }

function canonicalText(value) {
  return cleanText(value).toLowerCase()
}

// The host a candidate's url names; a url that does not parse names none, and
// the candidate is then known by its name alone.
function hostFromUrl(value) {
  if (!URL.canParse(value)) return null
  return new URL(value).hostname.replace(/^www\./u, '').toLowerCase()
}

// Identity key: the model extracts a brand name, so dedup on the normalized
// name first. The url is often the source page (a blog or listicle), not the
// brand's own site, so host is used only when no name is present.
function candidateName(candidate) {
  return canonicalText(candidate.name).replace(/[^a-z\d]+/g, '')
}

function candidateKey(candidate) {
  const name = candidateName(candidate)
  if (name) return name
  return hostFromUrl(candidate.url ? candidate.url : candidate.officialUrl)
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
