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

// The host a URL names. A value that does not parse as a URL is read as a bare
// host, optionally followed by a path, which is how records often state one.
function hostFromUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  if (URL.canParse(raw)) return new URL(raw).hostname.replace(/^www\./u, '').toLowerCase();
  const stripped = raw.replace(/^https?:\/\//u, '');
  return firstSegment(stripped, '/').replace(/^www\./u, '').toLowerCase();
}

// A count or score the record states under any of its names, or null when it
// states none. Null, undefined and empty text state nothing; a stated zero
// stays zero, never passed over to the next name or read as absent.
function statedNumber(...values) {
  const value = values.find((candidate) => candidate !== undefined && candidate !== null && candidate !== '');
  if (value === undefined) return null;
  return numberOrNull(value);
}

// A record that names no market is about the global one, the market the
// competitor model gives a competitor that names no region.
const UNSTATED_REGION = 'GLOBAL';

function domainFromRecord(record) {
  const explicit = clean(record.domain || record.websiteDomain || record.host).replace(/^www\./u, '').toLowerCase();
  if (explicit && !STORE_HOSTS.has(explicit)) return explicit;
  const sellerHost = hostFromUrl(record.sellerUrl || record.developerUrl || record.websiteUrl);
  if (sellerHost && !STORE_HOSTS.has(sellerHost)) return sellerHost;
  const evidenceHost = hostFromUrl(record.url || record.evidenceUrl);
  return STORE_HOSTS.has(evidenceHost) ? '' : evidenceHost;
}

// The record's source type. A record that names none is the team's own
// research; one that names a type this model does not know is refused.
export function normalizeSourceType(value) {
  const stated = clean(value);
  if (!stated) return COMPETITOR_SOURCE_TYPES.INTERNAL_RESEARCH;
  if (!Object.values(COMPETITOR_SOURCE_TYPES).includes(stated)) {
    throw new Error(`Discovery record source type ${stated} is not one of ${Object.values(COMPETITOR_SOURCE_TYPES).join(', ')}`);
  }
  return stated;
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
  const statedId = cleanNullable(input.recordId || input.id);
  const recordId = statedId !== null ? statedId : `disc:${stableHash({
    sourceType,
    name,
    company,
    domain,
    url,
    query: input.query,
    observedDay: dayKey(observedAt),
  })}`;
  const region = cleanNullable(input.region || input.country);
  const language = cleanNullable(input.language);

  return {
    recordId,
    sourceType,
    observedAt,
    query: cleanNullable(input.query || input.keyword),
    region: region ? region.toUpperCase() : UNSTATED_REGION,
    language: language && language.toLowerCase(),
    rank: statedNumber(input.rank, input.position, input.searchRank),
    name: name || domain,
    company,
    description: cleanNullable(input.description || input.summary || input.subtitle),
    url,
    // domainFromRecord answers the empty string for a record naming no domain.
    domain: domain === '' ? null : domain,
    appStoreId: cleanNullable(input.appStoreId || input.trackId),
    playStorePackage: cleanNullable(input.playStorePackage || input.packageName || input.appId),
    rating: statedNumber(input.rating, input.averageUserRating, input.score),
    reviewCount: statedNumber(input.reviewCount, input.userRatingCount, input.ratings),
    installCount: statedNumber(input.installCount, input.installs),
    adCount: statedNumber(input.adCount, input.ads),
    traffic: statedNumber(input.traffic, input.visits),
    keywords: cleanStringArray(input.keywords),
    tags: cleanStringArray(input.tags),
    productCategory: cleanNullable(input.productCategory || input.category),
    evidenceUrl: cleanNullable(input.evidenceUrl || url),
    attributes: cleanObject(input.attributes),
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
