// Shared query execution, schema-bound answers and URL handling for research.
import { cleanStringArray } from '../../competition/model.js';
import { CONTEXT_SURFACE_KINDS } from '../gathering/captures.js';
import { replyObject, schemaFormat } from '../adapters/answer.js';

// The surface kinds research may name: the capture contract's own.
export const SURFACE_KINDS = new Set(Object.values(CONTEXT_SURFACE_KINDS));

/** Text with runs of whitespace collapsed; a value that is not text has none. */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim();
}

export function describeError(error) {
  return cleanText(error instanceof Error ? error.message : String(error));
}

// A bound the caller does not give (maxQueries, maxSearchTextBytes, maxPages)
// is no bound; one that is given but is not a positive number is refused.
export function optionalBound(options, name, caller) {
  const value = options?.[name];
  if (value === undefined || value === null) return Infinity;
  if (typeof value !== 'number' || Number.isNaN(value) || !(value > Number())) {
    throw new Error(`${caller}: options.${name} must be a positive number, got ${value}`);
  }
  return value;
}

/** The longest start of `text` whose UTF-8 encoding fits `maxBytes`, cut only between characters. */
function boundBytes(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(maxBytes));
  return text.slice(Number(), read);
}

const QUERIES_FORMAT = schemaFormat('research_queries', { queries: { type: 'array', items: { type: 'string' } } });

export function parsedHttpUrl(value) {
  const text = cleanText(value);
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
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

/** A stage that failed: its error is recorded, and the stage gives no answer. */
function stageFailed(errors, stage, error) {
  errors.push({ stage, error: describeError(error) });
  return null;
}

// Shared stage: ask the model for the object `format` binds its reply to,
// refused unless `holds` accepts it. Returns null when the stage failed (its
// error recorded), otherwise the object.
export async function askStage({ chat, purpose, stage, messages, format, holds, errors }) {
  try {
    return replyObject(await chat(messages, { purpose, responseFormat: format }), stage, format.json_schema.name, holds);
  } catch (error) {
    return stageFailed(errors, stage, error);
  }
}

// Shared stage: ask the model for search queries, schema-bound and bounded.
// Returns null when the stage failed (error already recorded), otherwise the
// bounded query list (possibly a genuinely answered empty list).
export async function requestQueries({ chat, purpose, stage, messages, maxQueries, errors }) {
  const answer = await askStage({ chat, purpose, stage, messages, format: QUERIES_FORMAT, holds: (object) => Array.isArray(object.queries), errors });
  if (answer === null) return null;
  const queries = cleanStringArray(answer.queries).filter((query, index) => index < maxQueries);
  if (answer.queries.length && !queries.length) {
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
    if (typeof raw !== 'string') {
      errors.push({ stage: 'search', query, error: `search answered ${JSON.stringify(raw)}, not result text` });
      continue;
    }
    const text = cleanText(raw);
    if (text) chunks.push(`[query: ${query}] ${text}`);
  }
  return boundBytes(chunks.join('\n\n'), maxSearchTextBytes);
}
