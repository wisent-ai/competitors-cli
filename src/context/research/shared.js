// Shared query execution, strict response parsing and URL handling for research.
import { cleanStringArray } from '../../competition/model.js';

// Mirrors CONTEXT_SURFACE_KINDS in ../gathering/captures.js. These are platform
// surface identifiers required by the capture contract, not market vocabulary.
export const SURFACE_KINDS = new Set(['website', 'ios_app', 'android_app']);

export function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function describeError(error) {
  return cleanText(error?.message || String(error));
}

// The zeros below are validity/offset zeros, not bounds: every actual bound
// (maxQueries, maxSearchTextBytes, maxPages) is a caller-supplied option.
export function requiredBound(options, name, caller) {
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

export function parseJsonObjectStrict(raw, stage) {
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

export function parsedHttpUrl(value) {
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

export function normalizedHost(url) {
  return url.hostname.replace(/^www\./u, '').toLowerCase();
}

export function competitorBlock(competitor) {
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
export async function requestQueries({ chat, purpose, stage, messages, maxQueries, errors }) {
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
export async function gatherSearchText({ search, queries, maxSearchTextBytes, errors }) {
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

