// Discover pages only within verified competitor surfaces.
import { cleanNullable, cleanObject } from '../../competition/model.js';
import { SURFACE_KINDS, cleanText, competitorBlock, describeError, gatherSearchText, normalizedHost, parsedHttpUrl, parseJsonObjectStrict, requestQueries, optionalBound } from './shared.js';

const PURPOSE_PAGE_QUERIES = 'competitor-page-queries';
const PURPOSE_PAGE_SELECTION = 'competitor-page-selection';

function verifiedSurfaceList(surfaces) {
  if (!Array.isArray(surfaces)) return [];
  const out = [];
  for (const entry of surfaces) {
    if (!entry || typeof entry !== 'object' || entry.verified !== true) continue;
    const kind = cleanText(entry.kind).toLowerCase();
    if (!SURFACE_KINDS.has(kind)) continue;
    let domain = cleanText(entry.domain).toLowerCase().replace(/^www\./u, '');
    if (!domain) {
      const url = parsedHttpUrl(entry.url);
      if (url) domain = normalizedHost(url);
    }
    if (!domain) continue;
    out.push({ kind, domain, url: cleanNullable(entry.url) });
  }
  return out;
}

function surfaceForHost(host, verified) {
  return verified.find((surface) => host === surface.domain || host.endsWith(`.${surface.domain}`)) || null;
}

function normalizePages(parsed, verified, maxPages, searchText, errors) {
  if (!Array.isArray(parsed.pages)) {
    errors.push({ stage: 'page-selection', reason: 'missing_pages_array', error: 'model reply object has no pages array' });
    return [];
  }
  const candidates = [];
  const seen = new Set();
  for (const entry of parsed.pages) {
    if (!entry || typeof entry !== 'object') {
      errors.push({ stage: 'page-validation', reason: 'invalid_entry', error: 'page entry is not an object; dropped' });
      continue;
    }
    const url = parsedHttpUrl(entry.url);
    if (!url) {
      errors.push({ stage: 'page-validation', reason: 'invalid_url', error: `invalid or non-http(s) page url: ${cleanText(entry.url) || '(missing)'}; dropped` });
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
  const pages = ordered.slice(0, maxPages);
  for (const dropped of ordered.slice(maxPages)) {
    errors.push({ stage: 'page-validation', reason: 'page_budget', url: dropped.url, error: 'maxPages bound reached; dropped (cited pages take precedence)' });
  }
  return pages;
}

// Discover the specific pages on a competitor's verified surfaces that merit
// deep analysis. The model states each page's role in its own words; this
// module enforces the evidence rules: verified domains, bounds, and recorded
// search-evidence citation with cited-first selection under maxPages.
export async function discoverCompetitorPages({ competitor, surfaces, chat, search, options } = {}) {
  if (typeof chat !== 'function') throw new Error('discoverCompetitorPages requires a chat(messages, { purpose }) function');
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
    return { pages: [], queries: [], errors, status: 'no_pages_selected' };
  }

  const surfaceLines = verified
    .map((surface) => `- ${surface.kind} ${surface.url || surface.domain} (domain: ${surface.domain})`)
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
        content: 'You plan web searches that surface individual pages on a competitor\'s verified official surfaces (website pages and application store listing pages) that are worth deep competitive analysis. Return ONLY a JSON array of short search query strings. No prose, no markdown.',
      },
      { role: 'user', content: `${subject}\n\nReturn the JSON array of page-discovery search queries.` },
    ],
  });
  if (queries === null) return { pages: [], queries: [], errors, status: 'no_pages_selected' };

  const searchText = await gatherSearchText({ search, queries, maxSearchTextBytes, errors });
  if (!searchText) {
    errors.push({ stage: 'page-selection', error: 'no search evidence gathered; page selection skipped' });
    return { pages: [], queries, errors, status: 'no_pages_selected' };
  }

  let reply;
  try {
    reply = await chat([
      {
        role: 'system',
        content: 'You select pages worth deep competitive analysis from raw web-search evidence. Prefer page URLs that literally appear in the search results; every URL must belong to the competitor\'s verified official surfaces, and URLs absent from the evidence are deprioritized when the page budget binds. Return ONLY a JSON object {"pages":[{"url":"...","reason":"...","role":"..."}]} where reason explains why the page merits deep analysis and role states, in your own words, what role that page plays on the surface. No prose, no markdown.',
      },
      { role: 'user', content: `${subject}\n\nRaw search results:\n${searchText}\n\nReturn the JSON object of selected pages.` },
    ], { purpose: PURPOSE_PAGE_SELECTION });
  } catch (error) {
    errors.push({ stage: 'page-selection', error: describeError(error) });
    return { pages: [], queries, errors, status: 'no_pages_selected' };
  }

  let parsed;
  try {
    parsed = parseJsonObjectStrict(reply, 'page-selection');
  } catch (error) {
    errors.push({ stage: 'page-selection', error: describeError(error) });
    return { pages: [], queries, errors, status: 'no_pages_selected' };
  }

  const pages = normalizePages(parsed, verified, maxPages, searchText, errors);
  return { pages, queries, errors, status: pages.length ? 'resolved' : 'no_pages_selected' };
}
