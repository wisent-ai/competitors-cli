import { cleanNullable, cleanObject, cleanStringArray } from '../competition/model.js';

// Evidence-first research over a competitor's official surfaces.
//
// Design rules this file obeys (mirroring src/competition-crawl.js):
//   * No hardcoded keyword tables, market vocabulary, or provider priority.
//     Which queries to run, which surfaces are official, and which pages are
//     worth deep analysis are judgments the injected model must own.
//   * No numeric literals as bounds. Every bound (maxQueries,
//     maxSearchTextBytes, maxPages) is a required caller-supplied option and
//     the functions throw when one is missing or not a finite positive number.
//   * The caller owns the model and all I/O, injected as functions:
//       chat(messages, { purpose }) => assistant text
//       search(query) => raw search-result text
//     This module never touches the network or filesystem itself.
//   * Strict JSON: an unparseable or wrong-shape model reply is surfaced as an
//     explicit stage error and never silently degrades to a default. An empty
//     result exists only as a genuinely parsed empty array.
//   * Evidence first: registry-claimed domains are untrusted hints. A surface
//     is verified only when the model cites a search-result URL that is
//     literally present in the gathered search evidence. Page selections are
//     accepted only on verified surface domains; each accepted page records
//     whether its URL is cited in the search evidence, and cited pages win
//     when the maxPages bound binds, so fabricated same-domain URLs stay
//     visible but yield to cited pages.

const PURPOSE_SURFACE_QUERIES = 'competitor-surface-queries';
const PURPOSE_SURFACE_RESOLUTION = 'competitor-surface-resolution';
const PURPOSE_PAGE_QUERIES = 'competitor-page-queries';
const PURPOSE_PAGE_SELECTION = 'competitor-page-selection';

// Mirrors the CONTEXT_SURFACE_KINDS values in ./index.js. These are platform
// surface identifiers required by the capture contract, not market vocabulary.
const SURFACE_KINDS = new Set(['website', 'ios_app', 'android_app']);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function describeError(error) {
  return cleanText(error?.message || String(error));
}

// The zeros below are validity/offset zeros, not bounds: every actual bound
// (maxQueries, maxSearchTextBytes, maxPages) is a caller-supplied option.
function requiredBound(options, name, caller) {
  const value = options?.[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
    throw new Error(`${caller} requires options.${name} to be a finite positive number`);
  }
  return value;
}

function boundBytes(text, maxBytes) {
  const value = String(text || '');
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString('utf8');
}

// Strict parsers: a reply without the expected JSON shape throws, and callers
// record the failure as an explicit stage error. No silent defaults.
function parseJsonArrayStrict(raw, stage) {
  const match = String(raw || '').match(/\[[\s\S]*\]/u);
  if (!match) throw new Error(`${stage}: model reply contains no JSON array`);
  let parsed;
  try {
    parsed = JSON.parse(match.join(''));
  } catch (cause) {
    throw new Error(`${stage}: model reply is not parseable JSON: ${describeError(cause)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${stage}: model reply JSON is not an array`);
  return parsed;
}

function parseJsonObjectStrict(raw, stage) {
  const match = String(raw || '').match(/\{[\s\S]*\}/u);
  if (!match) throw new Error(`${stage}: model reply contains no JSON object`);
  let parsed;
  try {
    parsed = JSON.parse(match.join(''));
  } catch (cause) {
    throw new Error(`${stage}: model reply is not parseable JSON: ${describeError(cause)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${stage}: model reply JSON is not an object`);
  }
  return parsed;
}

function queryList(value) {
  return cleanStringArray(
    value.map((entry) => cleanText(typeof entry === 'string' ? entry : entry?.query || entry?.value || entry?.text)),
  );
}

function parsedHttpUrl(value) {
  const text = cleanText(value);
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url;
}

function normalizedHost(url) {
  return url.hostname.replace(/^www\./u, '').toLowerCase();
}

function competitorBlock(competitor) {
  const lines = [`Competitor: ${cleanText(competitor.name)}`];
  const hints = cleanStringArray(competitor.domains);
  if (hints.length) {
    lines.push(`Registry-claimed domains (unverified hints; trust only what the search evidence shows): ${hints.join(', ')}`);
  }
  return lines.join('\n');
}

// Shared stage: ask the model for search queries, strictly parsed and bounded.
// Returns null when the stage failed (error already recorded), otherwise the
// bounded query list (possibly a genuinely parsed empty array).
async function requestQueries({ chat, purpose, stage, messages, maxQueries, errors }) {
  let reply;
  try {
    reply = await chat(messages, { purpose });
  } catch (error) {
    errors.push({ stage, error: describeError(error) });
    return null;
  }
  let parsed;
  try {
    parsed = parseJsonArrayStrict(reply, stage);
  } catch (error) {
    errors.push({ stage, error: describeError(error) });
    return null;
  }
  const queries = queryList(parsed).filter((query, index) => index < maxQueries);
  if (parsed.length && !queries.length) {
    errors.push({ stage, error: 'model returned queries but none were usable strings' });
  }
  return queries;
}

// Shared stage: run the injected search per query, accumulating raw result
// text and per-query errors, then bound the combined evidence by bytes.
async function gatherSearchText({ search, queries, maxSearchTextBytes, errors }) {
  const chunks = [];
  for (const query of queries) {
    let raw;
    try {
      raw = await search(query);
    } catch (error) {
      errors.push({ stage: 'search', query, error: describeError(error) });
      continue;
    }
    const text = cleanText(raw);
    if (text) chunks.push(`[query: ${query}] ${text}`);
  }
  return boundBytes(chunks.join('\n\n'), maxSearchTextBytes);
}

function normalizeSurfaces(parsed, searchText, errors) {
  if (!Array.isArray(parsed.surfaces)) {
    errors.push({ stage: 'surface-resolution', reason: 'missing_surfaces_array', error: 'model reply object has no surfaces array' });
    return [];
  }
  const searchTextLower = searchText.toLowerCase();
  const byKey = new Map();
  for (const entry of parsed.surfaces) {
    if (!entry || typeof entry !== 'object') {
      errors.push({ stage: 'surface-validation', reason: 'invalid_entry', error: 'surface entry is not an object; dropped' });
      continue;
    }
    const kind = cleanText(entry.kind).toLowerCase();
    if (!SURFACE_KINDS.has(kind)) {
      errors.push({ stage: 'surface-validation', reason: 'unsupported_kind', error: `unsupported surface kind: ${kind || '(missing)'}; dropped` });
      continue;
    }
    const url = parsedHttpUrl(entry.url);
    if (!url) {
      errors.push({ stage: 'surface-validation', reason: 'invalid_url', error: `invalid or non-http(s) surface url: ${cleanText(entry.url) || '(missing)'}; dropped` });
      continue;
    }
    // A citation counts only when it is a valid http(s) URL that literally
    // appears in the search evidence the model was shown. Model-claimed
    // evidence is filtered against that host-side text, never trusted.
    const evidenceText = cleanText(entry.evidence);
    const verified = Boolean(parsedHttpUrl(evidenceText)) && searchTextLower.includes(evidenceText.toLowerCase());
    if (!verified) {
      errors.push({
        stage: 'surface-validation',
        reason: 'citation_unverified',
        url: url.href,
        error: 'evidence citation missing, invalid, or not present in the gathered search results; surface left unverified',
      });
    }
    const record = { kind, url: url.href, domain: normalizedHost(url), verified, evidence: verified ? evidenceText : null };
    const key = `${kind} ${url.href}`;
    const existing = byKey.get(key);
    if (!existing || (!existing.verified && record.verified)) byKey.set(key, record);
  }
  return [...byKey.values()].map((record) => cleanObject(record));
}

// Resolve a competitor's official surfaces (website, iOS and Android store
// listings) from web-search evidence. Registry-claimed domains are passed to
// the model as untrusted hints only; nothing is verified without a citation.
export async function resolveCompetitorSurfaces({ competitor, chat, search, options } = {}) {
  if (typeof chat !== 'function') throw new Error('resolveCompetitorSurfaces requires a chat(messages, { purpose }) function');
  if (typeof search !== 'function') throw new Error('resolveCompetitorSurfaces requires a search(query) function');
  const maxQueries = requiredBound(options, 'maxQueries', 'resolveCompetitorSurfaces');
  const maxSearchTextBytes = requiredBound(options, 'maxSearchTextBytes', 'resolveCompetitorSurfaces');
  const name = cleanText(competitor?.name);
  if (!name) throw new Error('resolveCompetitorSurfaces requires a competitor with a name');

  const errors = [];
  const subject = competitorBlock(competitor);

  const queries = await requestQueries({
    chat,
    purpose: PURPOSE_SURFACE_QUERIES,
    stage: 'surface-queries',
    maxQueries,
    errors,
    messages: [
      {
        role: 'system',
        content: 'You plan web searches that locate a competitor\'s official web presence: its official website and its official iOS and Android application store listings. Return ONLY a JSON array of short search query strings a person would type. No prose, no markdown.',
      },
      { role: 'user', content: `${subject}\n\nReturn the JSON array of search queries.` },
    ],
  });
  if (queries === null) return { surfaces: [], queries: [], errors, status: 'unresolved' };

  const searchText = await gatherSearchText({ search, queries, maxSearchTextBytes, errors });
  if (!searchText) {
    errors.push({ stage: 'surface-resolution', error: 'no search evidence gathered; surface resolution skipped' });
    return { surfaces: [], queries, errors, status: 'unresolved' };
  }

  let reply;
  try {
    reply = await chat([
      {
        role: 'system',
        content: 'You resolve a competitor\'s official surfaces from raw web-search evidence. Identify the competitor\'s official website and its official iOS and Android application store listings using ONLY the search results provided. Return ONLY a JSON object {"surfaces":[{"kind":"website"|"ios_app"|"android_app","url":"...","evidence":"..."}]} where url is the surface itself and evidence is the search-result URL the claim came from, copied verbatim from the search results. Omit any surface the evidence does not establish. No prose, no markdown.',
      },
      { role: 'user', content: `${subject}\n\nRaw search results:\n${searchText}\n\nReturn the JSON object of resolved surfaces with evidence citations.` },
    ], { purpose: PURPOSE_SURFACE_RESOLUTION });
  } catch (error) {
    errors.push({ stage: 'surface-resolution', error: describeError(error) });
    return { surfaces: [], queries, errors, status: 'unresolved' };
  }

  let parsed;
  try {
    parsed = parseJsonObjectStrict(reply, 'surface-resolution');
  } catch (error) {
    errors.push({ stage: 'surface-resolution', error: describeError(error) });
    return { surfaces: [], queries, errors, status: 'unresolved' };
  }

  const surfaces = normalizeSurfaces(parsed, searchText, errors);
  return {
    surfaces,
    queries,
    errors,
    status: surfaces.some((surface) => surface.verified) ? 'resolved' : 'unresolved',
  };
}

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
  const maxQueries = requiredBound(options, 'maxQueries', 'discoverCompetitorPages');
  const maxSearchTextBytes = requiredBound(options, 'maxSearchTextBytes', 'discoverCompetitorPages');
  const maxPages = requiredBound(options, 'maxPages', 'discoverCompetitorPages');
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
