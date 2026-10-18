// Discover pages only within verified competitor surfaces.
import { cleanNullable, cleanObject } from '../../competition/model.js';
import { strictObject, schemaFormat } from '../adapters/answer.js';
import { SURFACE_KINDS, askStage, cleanText, competitorBlock, gatherSearchText, normalizedHost, parsedHttpUrl, requestQueries, optionalBound } from './shared.js';

const PURPOSE_PAGE_QUERIES = 'competitor-page-queries';
const PURPOSE_PAGE_SELECTION = 'competitor-page-selection';

// The pages the model may select: each its URL, why it merits deep analysis,
// and the role it plays on its surface, in the model's own words.
const PAGES_FORMAT = schemaFormat('competitor_pages', {
  pages: { type: 'array', items: strictObject({ url: { type: 'string' }, reason: { type: 'string' }, role: { type: 'string' } }) },
});

/** The stage's result when it ends without selecting a page. */
function noPages(queries, errors) {
  return { pages: [], queries, errors, status: 'no_pages_selected' };
}

function verifiedSurfaceList(surfaces) {
  if (!Array.isArray(surfaces)) throw new Error('discoverCompetitorPages requires surfaces, a list (empty when none were resolved)');
  const out = [];
  for (const entry of surfaces) {
    if (!entry || typeof entry !== 'object' || entry.verified !== true) continue;
    const kind = cleanText(entry.kind).toLowerCase();
    if (!SURFACE_KINDS.has(kind)) continue;
    const url = parsedHttpUrl(entry.url);
    const domain = cleanText(entry.domain).toLowerCase().replace(/^www\./u, '');
    const host = domain ? domain : url && normalizedHost(url);
    if (!host) continue;
    out.push({ kind, domain: host, url: cleanNullable(entry.url) });
  }
  return out;
}

function surfaceForHost(host, verified) {
  return verified.find((surface) => host === surface.domain || host.endsWith(`.${surface.domain}`));
}

function normalizePages(parsed, verified, maxPages, searchText, errors) {
  const candidates = [];
  const seen = new Set();
  for (const entry of parsed.pages) {
    if (!entry || typeof entry !== 'object') {
      errors.push({ stage: 'page-validation', reason: 'invalid_entry', error: 'page entry is not an object; dropped' });
      continue;
    }
    const url = parsedHttpUrl(entry.url);
    if (!url) {
      errors.push({ stage: 'page-validation', reason: 'invalid_url', error: `invalid or non-http(s) page url: ${JSON.stringify(entry.url)}; dropped` });
      continue;
    }
    const host = normalizedHost(url);
    // A page is accepted only on a verified surface: exact domain match or a
    // subdomain of one. Store-listing hosts enter this list only as verified
    // app surfaces, so they can never be accepted as website pages.
    const surface = surfaceForHost(host, verified);
    if (!surface) {
      errors.push({ stage: 'page-validation', reason: 'host_not_verified', url: url.href, error: `host ${host} is not a verified surface domain or subdomain; dropped` });
      continue;
    }
    if (seen.has(url.href)) {
      errors.push({ stage: 'page-validation', reason: 'duplicate_url', url: url.href, error: 'duplicate page url; dropped' });
      continue;
    }
    seen.add(url.href);
    // The verified-domain check above is the trust boundary. Citation is
    // recorded (not required) so a model-fabricated same-domain URL stays
    // visible downstream and loses to cited pages under the maxPages bound.
    const rawUrl = cleanText(entry.url);
    const cited = Boolean(searchText.includes(url.href) || (rawUrl && searchText.includes(rawUrl)));
    candidates.push({
      ...cleanObject({
        url: url.href,
        reason: cleanNullable(entry.reason),
        role: cleanNullable(entry.role),
        surfaceKind: surface.kind,
      }),
      cited,
    });
  }
  const citedPages = [];
  const uncitedPages = [];
  for (const candidate of candidates) {
    if (candidate.cited) citedPages.push(candidate);
    else uncitedPages.push(candidate);
  }
  const ordered = [...citedPages, ...uncitedPages];
  const pages = ordered.filter((page, index) => index < maxPages);
  for (const dropped of ordered.filter((page, index) => index >= maxPages)) {
    errors.push({ stage: 'page-validation', reason: 'page_budget', url: dropped.url, error: 'maxPages bound reached; dropped (cited pages take precedence)' });
  }
  return pages;
}

// Discover the specific pages on a competitor's verified surfaces that merit
// deep analysis. The model states each page's role in its own words; this
// module enforces the evidence rules: verified domains, bounds, and recorded
// search-evidence citation with cited-first selection under maxPages.
export async function discoverCompetitorPages({ competitor, surfaces, chat, search, options }) {
  if (typeof chat !== 'function') throw new Error('discoverCompetitorPages requires a chat(messages, { purpose, responseFormat }) function');
  if (typeof search !== 'function') throw new Error('discoverCompetitorPages requires a search(query) function');
  const maxQueries = optionalBound(options, 'maxQueries', 'discoverCompetitorPages');
  const maxSearchTextBytes = optionalBound(options, 'maxSearchTextBytes', 'discoverCompetitorPages');
  const maxPages = optionalBound(options, 'maxPages', 'discoverCompetitorPages');
  const name = cleanText(competitor?.name);
  if (!name) throw new Error('discoverCompetitorPages requires a competitor with a name');

  const errors = [];
  const verified = verifiedSurfaceList(surfaces);
  if (!verified.length) {
    errors.push({ stage: 'surfaces', error: 'no verified surfaces provided; page discovery requires at least one verified surface' });
    return noPages([], errors);
  }

  const surfaceLines = verified
    .map((surface) => `- ${surface.kind} ${surface.url === null ? surface.domain : surface.url} (domain: ${surface.domain})`)
    .join('\n');
  const subject = `${competitorBlock(competitor)}\nVerified official surfaces:\n${surfaceLines}`;

  const queries = await requestQueries({
    chat,
    purpose: PURPOSE_PAGE_QUERIES,
    stage: 'page-queries',
    maxQueries,
    errors,
    messages: [
      {
        role: 'system',
        content: 'You plan web searches that surface individual pages on a competitor\'s verified official surfaces (website pages and application store listing pages) that are worth deep competitive analysis. Give short search queries.',
      },
      { role: 'user', content: subject },
    ],
  });
  if (queries === null) return noPages([], errors);

  const searchText = await gatherSearchText({ search, queries, maxSearchTextBytes, errors });
  if (!searchText) {
    errors.push({ stage: 'page-selection', error: 'no search evidence gathered; page selection skipped' });
    return noPages(queries, errors);
  }

  const parsed = await askStage({
    chat,
    purpose: PURPOSE_PAGE_SELECTION,
    stage: 'page-selection',
    format: PAGES_FORMAT,
    holds: (object) => Array.isArray(object.pages),
    errors,
    messages: [
      {
        role: 'system',
        content: 'You select pages worth deep competitive analysis from raw web-search evidence. Prefer page URLs that literally appear in the search results; every URL must belong to the competitor\'s verified official surfaces, and URLs absent from the evidence are deprioritized when the page budget binds. For each page give its url, the reason it merits deep analysis, and the role, in your own words, it plays on the surface.',
      },
      { role: 'user', content: `${subject}\n\nRaw search results:\n${searchText}` },
    ],
  });
  if (parsed === null) return noPages(queries, errors);

  const pages = normalizePages(parsed, verified, maxPages, searchText, errors);
  return { pages, queries, errors, status: pages.length ? 'resolved' : 'no_pages_selected' };
}
