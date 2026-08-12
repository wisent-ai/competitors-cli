import {
  DEFAULT_COMPETITORS,
  cleanNullable,
  cleanObject,
  countsFrom,
  createCompetitorRegistry,
  dayKey,
  isoTime,
  normalizeCompetitor,
  numberText,
  slugify,
  stableHash,
  tally,
} from '../competition/model.js';
import { createCompetitorModel } from '../competition-crawl.js';
import {
  candidateSeed,
  canonicalCandidateKey,
  mergeRecord,
  normalizeDiscoveryRecord,
} from './records.js';

// Competitor discovery in two layers:
//   1. discoverCompetitorCandidates (sync): group and merge structured records
//      into candidates, canonicalize against the known registry, drop the
//      caller's own brand. No magic-weight scoring, no keyword/category regex.
//   2. classifyDiscoveredCandidates (async): opt-in refinement that asks the
//      injected model whether each candidate is a genuine competitor.
// Ranking, if wanted, is the caller's job.

export const COMPETITOR_DISCOVERY_EVENTS = {
  CANDIDATE_DISCOVERED: 'competitor_candidate_discovered',
  RUN_RECORDED: 'competitor_discovery_run_recorded',
};

function findExistingCompetitor(candidate, registry) {
  const byId = registry.get(candidate.id);
  if (byId) return byId;
  for (const domain of candidate.domains) {
    const byDomain = registry.findByDomain(domain);
    if (byDomain) return byDomain;
  }
  const candidateName = slugify(candidate.name);
  for (const competitor of registry.all) {
    const competitorName = slugify(competitor.name);
    if (!competitorName || !candidateName) continue;
    if (candidateName === competitorName) {
      return competitor;
    }
  }
  return null;
}

function canonicalizeKnownCandidate(candidate, knownCompetitor) {
  if (!knownCompetitor) return candidate;
  return {
    ...candidate,
    id: knownCompetitor.id,
    name: knownCompetitor.name,
    company: candidate.company || knownCompetitor.company,
    productCategory: knownCompetitor.productCategory || candidate.productCategory,
    domains: [...new Set([...knownCompetitor.domains, ...candidate.domains])],
    appStoreIds: [...new Set([...knownCompetitor.appStoreIds, ...candidate.appStoreIds])],
    playStorePackages: [...new Set([...knownCompetitor.playStorePackages, ...candidate.playStorePackages])],
    regions: [...new Set([...knownCompetitor.regions, ...candidate.regions])],
    tags: [...new Set([...knownCompetitor.tags, ...candidate.tags])],
  };
}

function isOwnCandidate(candidate, ownDomains, ownNames) {
  const domains = new Set(candidate.domains.map((domain) => domain.toLowerCase()));
  for (const ownDomain of ownDomains) {
    const cleaned = String(ownDomain).trim().replace(/^www\./u, '').toLowerCase();
    if (!cleaned) continue;
    if (domains.has(cleaned) || [...domains].some((domain) => domain.endsWith(`.${cleaned}`))) return true;
  }
  const name = `${candidate.id} ${candidate.name}`.toLowerCase();
  return ownNames.some((ownName) => {
    const cleaned = String(ownName).trim().toLowerCase();
    return cleaned && name.includes(cleaned);
  });
}

export function candidateToCompetitor(candidate) {
  return normalizeCompetitor({
    id: candidate.id,
    name: candidate.name,
    company: candidate.company,
    productCategory: candidate.productCategory,
    domains: candidate.domains,
    appStoreIds: candidate.appStoreIds,
    playStorePackages: candidate.playStorePackages,
    regions: candidate.regions,
    tags: candidate.tags,
    active: candidate.status !== 'excluded',
  });
}

export function discoverCompetitorCandidates(records = [], options = {}) {
  const existingCompetitors = options.existingCompetitors ? options.existingCompetitors : DEFAULT_COMPETITORS;
  const ownDomains = options.ownDomains ? options.ownDomains : [];
  const ownNames = options.ownNames ? options.ownNames : [];
  const registry = createCompetitorRegistry(existingCompetitors);

  const grouped = new Map();
  for (const input of records) {
    const record = normalizeDiscoveryRecord(input);
    const key = canonicalCandidateKey(record);
    if (!grouped.has(key)) grouped.set(key, candidateSeed(record));
    mergeRecord(grouped.get(key), record);
  }

  const results = [];
  for (const raw of grouped.values()) {
    const known = findExistingCompetitor(raw, registry);
    const candidate = canonicalizeKnownCandidate(raw, known);
    if (isOwnCandidate(candidate, ownDomains, ownNames)) continue;
    results.push({
      ...candidate,
      status: known ? 'known_competitor' : 'candidate',
      competitor: known ? known : candidateToCompetitor(candidate),
    });
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

function candidateEvidenceText(candidate) {
  return candidate.evidence
    .map((record) => [record.name, record.description, record.company].filter(Boolean).join(' '))
    .join(' | ');
}

export async function classifyDiscoveredCandidates(candidates = [], options = {}) {
  const model = createCompetitorModel({ chat: options.chat });
  const context = options.context ? options.context : {};
  const classified = [];
  for (const candidate of candidates) {
    if (candidate.status === 'known_competitor') {
      classified.push({ ...candidate, decision: 'include', reason: 'candidate is in the known competitor registry' });
      continue;
    }
    const [firstDomain] = candidate.domains;
    const verdict = await model.classify({
      name: candidate.name,
      url: firstDomain ? `https://${firstDomain}` : null,
      snippet: candidate.description,
      evidence: candidateEvidenceText(candidate),
    }, context);
    const included = verdict.decision === 'include';
    classified.push({
      ...candidate,
      status: included ? 'candidate' : verdict.decision === 'exclude' ? 'excluded' : 'ambiguous',
      decision: verdict.decision,
      reason: verdict.reason,
      competitor: included ? candidate.competitor : null,
    });
  }
  return classified;
}

function discoveryCandidateProperties(candidate) {
  return cleanObject({
    source: 'deep_analytics_competition_discovery',
    candidate_id: candidate.id,
    candidate_key: candidate.candidateKey,
    candidate_name: candidate.name,
    candidate_company: candidate.company,
    candidate_product_category: candidate.productCategory,
    candidate_domains: candidate.domains.join(','),
    candidate_app_store_ids: candidate.appStoreIds.join(','),
    candidate_play_store_packages: candidate.playStorePackages.join(','),
    candidate_regions: candidate.regions.join(','),
    candidate_tags: candidate.tags.join(','),
    source_types: [...candidate.sourceTypes].sort().join(','),
    queries: [...candidate.queries].sort().join(','),
    status: candidate.status,
    decision: candidate.decision,
    reason: candidate.reason,
    evidence_count: String(candidate.evidence.length),
    best_rank: numberText(candidate.bestRank),
    max_rating: numberText(candidate.maxRating),
    max_review_count: numberText(candidate.maxReviewCount),
    max_ad_count: numberText(candidate.maxAdCount),
    max_traffic: numberText(candidate.maxTraffic),
    evidence_urls: candidate.evidence.map((record) => record.evidenceUrl).filter(Boolean).join(','),
  });
}

export function buildCompetitorDiscoveryEvent(candidate, context = {}) {
  if (!candidate || !(candidate.sourceTypes instanceof Set)) {
    throw new Error('buildCompetitorDiscoveryEvent requires a discovered candidate');
  }
  const [firstEvidence] = candidate.evidence;
  const observedDay = dayKey(firstEvidence?.observedAt);
  const evidenceWithUrl = candidate.evidence.find((record) => record.evidenceUrl);
  return {
    eventId: `${COMPETITOR_DISCOVERY_EVENTS.CANDIDATE_DISCOVERED}:${candidate.id}:${stableHash({
      day: observedDay,
      key: candidate.candidateKey,
      sources: [...candidate.sourceTypes].sort(),
    })}`,
    eventName: COMPETITOR_DISCOVERY_EVENTS.CANDIDATE_DISCOVERED,
    userId: context.userId,
    anonymousId: context.anonymousId || context.userId || 'deep-analytics-competition-discovery',
    sessionId: context.sessionId || `competition-discovery:${observedDay}`,
    path: context.path || '/competition/discovery',
    host: context.host || 'deep-analytics.wisent.ai',
    url: context.url || evidenceWithUrl?.evidenceUrl,
    referrer: context.referrer,
    properties: {
      ...discoveryCandidateProperties(candidate),
      ...(context.properties || {}),
    },
  };
}

export function createCompetitorDiscoveryTracker(options = {}) {
  const trackEvent = options.trackEvent;
  if (typeof trackEvent !== 'function') throw new Error('createCompetitorDiscoveryTracker requires trackEvent');
  const existingCompetitors = options.existingCompetitors ? options.existingCompetitors : DEFAULT_COMPETITORS;
  const defaultContext = options.defaultContext ? options.defaultContext : {};

  async function trackDiscoveryRun(records = [], runOptions = {}, context = {}) {
    const candidates = discoverCompetitorCandidates(records, { existingCompetitors, ...runOptions });
    const runId = cleanNullable(runOptions.runId) || `competition-discovery:${stableHash({
      day: dayKey(runOptions.observedAt),
      candidates: candidates.map((candidate) => candidate.id).sort(),
    })}`;
    const mergedContext = {
      ...defaultContext,
      ...context,
      properties: {
        ...(defaultContext.properties || {}),
        ...(context.properties || {}),
        discovery_run_id: runId,
      },
    };

    const candidateEvents = [];
    for (const candidate of candidates) {
      const event = buildCompetitorDiscoveryEvent(candidate, mergedContext);
      candidateEvents.push({ candidate, event, result: await trackEvent(event) });
    }

    const knownCount = candidates.filter((candidate) => candidate.status === 'known_competitor').length;
    const newCount = candidates.filter((candidate) => candidate.status === 'candidate').length;
    const runEvent = {
      eventId: `${COMPETITOR_DISCOVERY_EVENTS.RUN_RECORDED}:${runId}`,
      eventName: COMPETITOR_DISCOVERY_EVENTS.RUN_RECORDED,
      userId: mergedContext.userId,
      anonymousId: mergedContext.anonymousId || mergedContext.userId || 'deep-analytics-competition-discovery',
      sessionId: mergedContext.sessionId || runId,
      path: mergedContext.path || '/competition/discovery',
      host: mergedContext.host || 'deep-analytics.wisent.ai',
      url: mergedContext.url,
      referrer: mergedContext.referrer,
      properties: cleanObject({
        source: 'deep_analytics_competition_discovery',
        discovery_run_id: runId,
        observed_at: isoTime(runOptions.observedAt),
        observed_day: dayKey(runOptions.observedAt),
        candidate_count: String(candidates.length),
        known_competitor_count: String(knownCount),
        new_candidate_count: String(newCount),
        source_types: [...new Set(candidates.flatMap((candidate) => [...candidate.sourceTypes]))].sort().join(','),
        ...(mergedContext.properties || {}),
      }),
    };
    const runResult = await trackEvent(runEvent);

    return { runId, candidates, candidateEvents, event: runEvent, result: runResult };
  }

  return {
    trackDiscoveryRun,
    discoverCompetitorCandidates: (records, runOptions) => discoverCompetitorCandidates(records, { existingCompetitors, ...runOptions }),
  };
}

export function summarizeDiscoveryCandidates(candidates = []) {
  const byStatus = tally(candidates, (candidate) => candidate.status);
  const byProductCategory = tally(candidates, (candidate) => candidate.productCategory);
  const sourceEntries = candidates.flatMap((candidate) => [...(candidate.sourceTypes || [])].map((sourceType) => ({ sourceType })));
  const bySourceType = tally(sourceEntries, (entry) => entry.sourceType);

  return {
    candidateCount: candidates.length,
    byStatus: countsFrom(byStatus),
    bySourceType: countsFrom(bySourceType),
    byProductCategory: countsFrom(byProductCategory),
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      status: candidate.status,
      sourceTypes: [...candidate.sourceTypes].sort(),
      evidenceCount: candidate.evidence.length,
    })),
  };
}
