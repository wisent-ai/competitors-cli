import { hashString } from '../client.js';
import { DEFAULT_COMPETITORS } from './seed.js';
export { DEFAULT_COMPETITORS };

// Competitor domain model: enums, shared shapers, and normalization + registry.
// No arbitrary numeric caps, no invented numeric defaults: callers own bounds.

export const COMPETITOR_EVENTS = {
  OBSERVATION_RECORDED: 'competitor_observation_recorded',
  SNAPSHOT_RECORDED: 'competitor_snapshot_recorded',
  SCRAPE_RUN_RECORDED: 'competitor_scrape_run_recorded',
};

export const COMPETITOR_SIGNAL_TYPES = {
  POSITIONING: 'positioning',
  FEATURE: 'feature',
  ONBOARDING: 'onboarding',
  PAYWALL: 'paywall',
  PRICING: 'pricing',
  ADS: 'ads',
  STORE_RANK: 'store_rank',
  REVIEW: 'review',
  TRAFFIC: 'traffic',
  SEO: 'seo',
  SOCIAL: 'social',
  RELEASE: 'release',
  SAFETY: 'safety',
  RETENTION: 'retention',
};

export const COMPETITOR_SOURCE_TYPES = {
  WEBSITE: 'website',
  SEARCH_ENGINE: 'search_engine',
  SEARCH_ADS: 'search_ads',
  APP_STORE: 'app_store',
  PLAY_STORE: 'play_store',
  META_AD_LIBRARY: 'meta_ad_library',
  GOOGLE_ADS_TRANSPARENCY: 'google_ads_transparency',
  APPLE_SEARCH_ADS: 'apple_search_ads',
  TIKTOK_RESEARCH: 'tiktok_research',
  APIFY_ACTOR: 'apify_actor',
  INSTAGRAM: 'instagram',
  TIKTOK: 'tiktok',
  YOUTUBE: 'youtube',
  TWITTER: 'twitter',
  PINTEREST: 'pinterest',
  SIMILARWEB: 'similarweb',
  SEMRUSH: 'semrush',
  AHREFS: 'ahrefs',
  SENSOR_TOWER: 'sensor_tower',
  INTERNAL_RESEARCH: 'internal_research',
  USER_REPORT: 'user_report',
  MANUAL_REVIEW: 'manual_review',
};

export const COMPETITOR_PRODUCT_CATEGORIES = {
  AI_COMPANION: 'ai_companion',
  AI_CHARACTER_CHAT: 'ai_character_chat',
  ADULT_AI_COMPANION: 'adult_ai_companion',
  MESSAGING_COMPANION: 'messaging_companion',
  CREATOR_CHARACTER_PLATFORM: 'creator_character_platform',
};

export const VALID_SIGNAL_TYPES = new Set(Object.values(COMPETITOR_SIGNAL_TYPES));
export const VALID_SOURCE_TYPES = new Set(Object.values(COMPETITOR_SOURCE_TYPES));

export function clean(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
}

export function cleanNullable(value) {
  const cleaned = clean(value);
  return cleaned ? cleaned : null;
}

export function slugify(value) {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z\d]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item)).filter(Boolean))];
}

export function cleanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => (
        entryValue !== undefined
        && entryValue !== null
        && entryValue !== ''
        && typeof entryValue !== 'function'
      ))
  );
}

export function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function numberText(value) {
  return Number.isFinite(value) ? String(value) : null;
}

export function isoTime(value) {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

export function dayKey(value) {
  const [day] = isoTime(value).split('T');
  return day;
}

export function stableHash(value) {
  return String(hashString(JSON.stringify(value)));
}

export function tally(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.has(key) ? groups.get(key) : [];
    bucket.push(item);
    groups.set(key, bucket);
  }
  return groups;
}

export function countsFrom(groups) {
  return Object.fromEntries([...groups.entries()].map(([key, bucket]) => [key, bucket.length]).sort());
}

export function normalizeCompetitor(input = {}) {
  const name = clean(input.name || input.title || input.id);
  const id = slugify(input.id || name);
  if (!id || !name) {
    throw new Error('Competitor requires id or name');
  }

  const domainSource = input.domains || input.domain
    ? (Array.isArray(input.domains) ? input.domains : [input.domain])
    : [];
  const appStoreSource = input.appStoreIds || input.appStoreId
    ? (Array.isArray(input.appStoreIds) ? input.appStoreIds : [input.appStoreId])
    : [];
  const playStoreSource = input.playStorePackages || input.playStorePackage
    ? (Array.isArray(input.playStorePackages) ? input.playStorePackages : [input.playStorePackage])
    : [];

  return {
    id,
    name,
    company: cleanNullable(input.company),
    productCategory: clean(input.productCategory || input.category || COMPETITOR_PRODUCT_CATEGORIES.AI_COMPANION),
    domains: cleanStringArray(domainSource),
    appStoreIds: cleanStringArray(appStoreSource),
    playStorePackages: cleanStringArray(playStoreSource),
    regions: cleanStringArray(input.regions || ['global']),
    tags: cleanStringArray(input.tags || []),
    priority: numberOrNull(input.priority),
    active: input.active !== false,
  };
}

export function createCompetitorRegistry(competitors = DEFAULT_COMPETITORS) {
  const normalized = competitors.map(normalizeCompetitor);
  const byId = new Map(normalized.map((competitor) => [competitor.id, competitor]));
  const byDomain = new Map();

  for (const competitor of normalized) {
    for (const domain of competitor.domains) byDomain.set(domain.toLowerCase(), competitor);
  }

  return {
    all: normalized,
    byId,
    byDomain,
    get(id) {
      const key = slugify(id);
      return byId.has(key) ? byId.get(key) : null;
    },
    findByDomain(domain) {
      const key = clean(domain).toLowerCase();
      return byDomain.has(key) ? byDomain.get(key) : null;
    },
  };
}

export function normalizeCompetitorMetric(input = {}) {
  if (!input || typeof input !== 'object') return null;
  const key = slugify(input.key || input.name);
  if (!key) return null;

  return {
    key,
    value: numberOrNull(input.value),
    unit: cleanNullable(input.unit),
    period: cleanNullable(input.period),
    currency: cleanNullable(input.currency),
    numerator: numberOrNull(input.numerator),
    denominator: numberOrNull(input.denominator),
    rank: numberOrNull(input.rank),
    rawValue: cleanNullable(input.rawValue),
  };
}
