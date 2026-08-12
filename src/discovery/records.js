import {
  COMPETITOR_SOURCE_TYPES,
  clean,
  cleanNullable,
  cleanObject,
  cleanStringArray,
  dayKey,
  isoTime,
  numberOrNull,
  slugify,
  stableHash,
} from '../competition/model.js';

// Structured discovery records: normalize raw source records into a canonical
// shape, derive stable dedup keys and candidate identity, and merge records
// that describe the same entity. Pure data-shaping: no keyword heuristics,
// no magic-weight scoring, no numeric caps.

const STORE_HOSTS = new Set([
  'apps.apple.com',
  'itunes.apple.com',
  'play.google.com',
]);

function firstSegment(value, separator) {
  const [head] = String(value).split(separator);
  return head;
}

function hostFromUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    return new URL(raw).hostname.replace(/^www\./u, '').toLowerCase();
  } catch {
    const stripped = raw.replace(/^https?:\/\//u, '');
    return firstSegment(stripped, '/').replace(/^www\./u, '').toLowerCase();
  }
}

function domainFromRecord(record) {
  const explicit = clean(record.domain || record.websiteDomain || record.host).replace(/^www\./u, '').toLowerCase();
  if (explicit && !STORE_HOSTS.has(explicit)) return explicit;
  const sellerHost = hostFromUrl(record.sellerUrl || record.developerUrl || record.websiteUrl);
  if (sellerHost && !STORE_HOSTS.has(sellerHost)) return sellerHost;
  const evidenceHost = hostFromUrl(record.url || record.evidenceUrl);
  return STORE_HOSTS.has(evidenceHost) ? '' : evidenceHost;
}

export function normalizeSourceType(value) {
  const sourceType = clean(value || COMPETITOR_SOURCE_TYPES.INTERNAL_RESEARCH);
  return Object.values(COMPETITOR_SOURCE_TYPES).includes(sourceType)
    ? sourceType
    : COMPETITOR_SOURCE_TYPES.INTERNAL_RESEARCH;
}

export function canonicalCandidateKey(record) {
  const appStoreId = clean(record.appStoreId || record.trackId);
  if (appStoreId) return `app_store:${appStoreId}`;
  const playStorePackage = clean(record.playStorePackage || record.packageName || record.appId).toLowerCase();
  if (playStorePackage) return `play_store:${playStorePackage}`;
  const domain = domainFromRecord(record);
  if (domain) return `domain:${domain}`;
  return `name:${slugify(record.name || record.title || record.company)}`;
}

export function candidateIdFromRecord(record) {
  const packageName = clean(record.playStorePackage || record.packageName || record.appId);
  if (packageName) return slugify(packageName.split('.').pop());
  const name = slugify(record.name || record.title || record.company);
  if (name) return name;
  const domain = domainFromRecord(record);
  if (domain) return slugify(firstSegment(domain, '.'));
  return slugify(record.competitorId || record.name || record.title || record.company || canonicalCandidateKey(record));
}

export function normalizeDiscoveryRecord(input = {}) {
  const sourceType = normalizeSourceType(input.sourceType || input.source);
  const name = clean(input.name || input.title || input.trackName || input.appName || input.competitorName);
  const company = cleanNullable(input.company || input.sellerName || input.developer || input.artistName);
  const url = cleanNullable(input.url || input.trackViewUrl || input.websiteUrl || input.evidenceUrl);
  const domain = domainFromRecord({ ...input, url });
  const observedAt = isoTime(input.observedAt || input.capturedAt || input.createdAt);

  if (!name && !domain) {
    throw new Error('Discovery record requires name/title or domain/url');
  }

  return {
    recordId: cleanNullable(input.recordId || input.id) || `disc:${stableHash({
      sourceType,
      name,
      company,
      domain,
      url,
      query: input.query,
      observedDay: dayKey(observedAt),
    })}`,
    sourceType,
    observedAt,
    query: cleanNullable(input.query || input.keyword),
    region: clean(input.region || input.country || 'global').toUpperCase(),
    language: clean(input.language || '').toLowerCase() || null,
    rank: numberOrNull(input.rank || input.position || input.searchRank),
    name: name || domain,
    company,
    description: cleanNullable(input.description || input.summary || input.subtitle),
    url,
    domain: domain || null,
    appStoreId: cleanNullable(input.appStoreId || input.trackId),
    playStorePackage: cleanNullable(input.playStorePackage || input.packageName || input.appId),
    rating: numberOrNull(input.rating || input.averageUserRating || input.score),
    reviewCount: numberOrNull(input.reviewCount || input.userRatingCount || input.ratings),
    installCount: numberOrNull(input.installCount || input.installs),
    adCount: numberOrNull(input.adCount || input.ads),
    traffic: numberOrNull(input.traffic || input.visits),
    keywords: cleanStringArray(input.keywords || []),
    tags: cleanStringArray(input.tags || []),
    productCategory: cleanNullable(input.productCategory || input.category),
    evidenceUrl: cleanNullable(input.evidenceUrl || url),
    attributes: cleanObject(input.attributes || {}),
  };
}

export function candidateSeed(record) {
  return {
    candidateKey: canonicalCandidateKey(record),
    id: candidateIdFromRecord(record),
    name: record.name,
    company: record.company,
    productCategory: record.productCategory,
    domains: record.domain ? [record.domain] : [],
    appStoreIds: record.appStoreId ? [record.appStoreId] : [],
    playStorePackages: record.playStorePackage ? [record.playStorePackage] : [],
    regions: [record.region],
    tags: [...record.tags],
    description: record.description,
    evidence: [],
    sourceTypes: new Set(),
    queries: new Set(),
    bestRank: record.rank,
    maxRating: record.rating,
    maxReviewCount: record.reviewCount,
    maxInstallCount: record.installCount,
    maxAdCount: record.adCount,
    maxTraffic: record.traffic,
  };
}

function addUnique(target, values) {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

function lowerOf(current, next) {
  if (next === null) return current;
  if (current === null || current === undefined) return next;
  return next < current ? next : current;
}

function higherOf(current, next) {
  if (next === null) return current;
  if (current === null || current === undefined) return next;
  return next > current ? next : current;
}

export function mergeRecord(candidate, record) {
  candidate.sourceTypes.add(record.sourceType);
  if (record.query) candidate.queries.add(record.query);
  addUnique(candidate.domains, record.domain ? [record.domain] : []);
  addUnique(candidate.appStoreIds, record.appStoreId ? [record.appStoreId] : []);
  addUnique(candidate.playStorePackages, record.playStorePackage ? [record.playStorePackage] : []);
  addUnique(candidate.regions, record.region ? [record.region] : []);
  addUnique(candidate.tags, record.tags);
  if (!candidate.company && record.company) candidate.company = record.company;
  if (!candidate.description && record.description) candidate.description = record.description;
  if (!candidate.productCategory && record.productCategory) candidate.productCategory = record.productCategory;
  candidate.bestRank = lowerOf(candidate.bestRank, record.rank);
  candidate.maxRating = higherOf(candidate.maxRating, record.rating);
  candidate.maxReviewCount = higherOf(candidate.maxReviewCount, record.reviewCount);
  candidate.maxInstallCount = higherOf(candidate.maxInstallCount, record.installCount);
  candidate.maxAdCount = higherOf(candidate.maxAdCount, record.adCount);
  candidate.maxTraffic = higherOf(candidate.maxTraffic, record.traffic);
  candidate.evidence.push(record);
}
