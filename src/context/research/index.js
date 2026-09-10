import { cleanObject } from '../../competition/model.js';
import { SURFACE_KINDS, cleanText, competitorBlock, describeError, gatherSearchText, normalizedHost, parsedHttpUrl, parseJsonObjectStrict, requestQueries, requiredBound } from './shared.js';
export { discoverCompetitorPages } from './pages.js';

// Evidence-first research over a competitor's official surfaces.
//
// Design rules this file obeys (mirroring src/crawl.js):
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

