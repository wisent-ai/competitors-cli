import { clean, cleanNullable, cleanObject, cleanStringArray } from '../competition/model.js';

// Evidence catalog + eight-area deep competitor analysis.
//
// Design rules this file obeys (see src/competition-crawl.js):
//   * No hardcoded keyword tables or market vocabulary: prompts carry only the
//     analysis-area name; all judgment is the injected model's.
//   * No numeric literal defaults. Every bound (maxTextBytesPerSurface,
//     maxScreenshotsPerCatalog, maxImageBytes, maxFindingsPerArea) is a
//     required caller-supplied option, validated with a clear throw.
//   * Evidence IDs are host-assigned and deterministic (derived from array
//     order only — no randomness, no timestamps). Model-returned evidence
//     references are filtered against the host catalog, never trusted; a
//     finding with no valid evidence reference is dropped and recorded.
//   * A model reply that fails strict JSON parsing surfaces as an explicit
//     per-area error record, never a silent default.
//
// The caller owns the model, injected as chat(messages, { purpose }) =>
// assistant text. purpose is 'competitor-deep-analysis:<area>'.

const PURPOSE_DEEP_ANALYSIS = 'competitor-deep-analysis';

export const DEEP_ANALYSIS_AREAS = {
  STYLE: 'style',
  DESIGN_SYSTEM: 'design_system',
  PAGE_STRUCTURE: 'page_structure',
  FUNNEL: 'funnel',
  SEO: 'seo',
  PRICING: 'pricing',
  OFFERS: 'offers',
  PROMOTIONS: 'promotions',
};

export const VALID_DEEP_ANALYSIS_AREAS = new Set(Object.values(DEEP_ANALYSIS_AREAS));

function requirePositiveNumber(options, name, context) {
  const value = Number(options?.[name]);
  if (!Number.isFinite(value) || value < Number.EPSILON) {
    throw new Error(`${context} requires a finite positive ${name} option`);
  }
  return value;
}

function requirePositiveInteger(options, name, context) {
  const value = Number(options?.[name]);
  if (!Number.isInteger(value) || value < Number.EPSILON) {
    throw new Error(`${context} requires a positive integer ${name} option`);
  }
  return value;
}

// Captures arrive either with a nested surface descriptor ({ surface: { kind,
// target/url } }) or with the surface fields spread onto the capture itself
// (the gatherCompetitorContext shape). Accept both.
function surfaceOf(capture) {
  const surface = capture && typeof capture.surface === 'object' && capture.surface !== null ? capture.surface : capture;
  return {
    surfaceKind: cleanNullable(surface?.kind),
    url: cleanNullable(surface?.url) || cleanNullable(surface?.target),
  };
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return { content: text, bytes: buffer.byteLength, truncated: false };
  }
  const content = buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '');
  return { content, bytes: Buffer.byteLength(content, 'utf8'), truncated: true };
}

// Only self-contained data: payloads count as embedded evidence; a plain
// http(s) reference is a pointer, not captured evidence.
function embeddedImageUrl(shot) {
  const url = cleanNullable(typeof shot === 'string' ? shot : shot?.url || shot?.ref);
  return url && url.startsWith('data:') ? url : null;
}

// Build a deterministic, bounded evidence catalog from per-surface captures.
// IDs: ev:<surfaceIndex>:text:<sliceIndex> | ev:<surfaceIndex>:meta:<n> |
// ev:<surfaceIndex>:shot:<n> — indices follow input array order, so the same
// captures always yield the same catalog.
// Returns { entries, omitted, errors }.
export function buildEvidenceCatalog(captures = [], options = {}) {
  if (!Array.isArray(captures)) throw new Error('buildEvidenceCatalog requires an array of surface captures');
  const maxTextBytesPerSurface = requirePositiveNumber(options, 'maxTextBytesPerSurface', 'buildEvidenceCatalog');
  const maxScreenshotsPerCatalog = requirePositiveInteger(options, 'maxScreenshotsPerCatalog', 'buildEvidenceCatalog');
  const maxImageBytes = requirePositiveNumber(options, 'maxImageBytes', 'buildEvidenceCatalog');

  const entries = [];
  const omitted = [];
  const errors = [];
  let screenshotCount = 0;

  captures.forEach((capture, surfaceIndex) => {
    const { surfaceKind, url } = surfaceOf(capture);
    const tie = { surfaceIndex, surfaceKind, url };

    const textError = cleanNullable(capture?.textError);
    if (textError) errors.push(cleanObject({ ...tie, source: 'text', error: textError }));
    const structuredError = cleanNullable(capture?.structuredError);
    if (structuredError) errors.push(cleanObject({ ...tie, source: 'structured', error: structuredError }));

    const text = clean(capture?.text);
    if (text) {
      const slice = truncateUtf8(text, maxTextBytesPerSurface);
      entries.push(cleanObject({
        id: `ev:${surfaceIndex}:text:0`,
        surfaceKind,
        url,
        type: 'text',
        content: slice.content,
        truncated: slice.truncated ? true : undefined,
        bytes: slice.bytes,
      }));
    }

    const structured = capture?.structured;
    if (structured !== undefined && structured !== null) {
      const items = Array.isArray(structured) ? structured : [structured];
      items.forEach((item, itemIndex) => {
        const id = `ev:${surfaceIndex}:meta:${itemIndex}`;
        let serialized;
        try {
          serialized = JSON.stringify(item);
        } catch (error) {
          errors.push(cleanObject({ ...tie, id, source: 'structured', error: `structured capture is not JSON-serializable: ${error?.message || error}` }));
          return;
        }
        if (serialized === undefined) {
          errors.push(cleanObject({ ...tie, id, source: 'structured', error: 'structured capture is not JSON-serializable' }));
          return;
        }
        const bytes = Buffer.byteLength(serialized, 'utf8');
        if (bytes > maxTextBytesPerSurface) {
          omitted.push(cleanObject({ ...tie, id, type: 'structured', reason: 'structured_size_limit', bytes }));
          return;
        }
        entries.push({ ...cleanObject({ id, surfaceKind, url, type: 'structured', bytes }), content: item });
      });
    }

    const shots = Array.isArray(capture?.screenshots) ? capture.screenshots : [];
    shots.forEach((shot, shotIndex) => {
      const id = `ev:${surfaceIndex}:shot:${shotIndex}`;
      const shotTie = { ...tie, id, type: 'screenshot' };
      const upstreamReason = typeof shot === 'object' && shot !== null ? cleanNullable(shot.omittedReason) : null;
      if (upstreamReason) {
        omitted.push(cleanObject({ ...shotTie, reason: upstreamReason, path: cleanNullable(shot?.path), error: cleanNullable(shot?.error) }));
        return;
      }
      const image = embeddedImageUrl(shot);
      if (!image) {
        omitted.push(cleanObject({ ...shotTie, reason: 'not_embedded', path: cleanNullable(shot?.path) }));
        return;
      }
      const bytes = Number.isFinite(shot?.byteLength) ? shot.byteLength : Buffer.byteLength(image, 'utf8');
      if (bytes > maxImageBytes) {
        omitted.push(cleanObject({ ...shotTie, reason: 'image_size_limit', bytes }));
        return;
      }
      if (screenshotCount >= maxScreenshotsPerCatalog) {
        omitted.push(cleanObject({ ...shotTie, reason: 'catalog_screenshot_limit', bytes }));
        return;
      }
      screenshotCount += 1;
      entries.push(cleanObject({ id, surfaceKind, url, type: 'screenshot', image, bytes }));
    });
  });

  return { entries, omitted, errors };
}

function selectedAreas(options) {
  const all = Object.values(DEEP_ANALYSIS_AREAS);
  if (options?.areas === undefined || options?.areas === null) return all;
  const requested = cleanStringArray(options.areas);
  if (!requested.length) throw new Error('runDeepAnalysis requires at least one analysis area when options.areas is provided');
  for (const area of requested) {
    if (!VALID_DEEP_ANALYSIS_AREAS.has(area)) {
      throw new Error(`runDeepAnalysis received unknown analysis area "${area}"; valid areas: ${all.join(', ')}`);
    }
  }
  return all.filter((area) => requested.includes(area));
}

function evidenceBlocks(entries) {
  const lines = [];
  const images = [];
  for (const entry of entries) {
    const label = `[${entry.id}] ${[entry.surfaceKind, entry.url].filter(Boolean).join(' ')}`.trim();
    if (entry.type === 'screenshot') {
      images.push(entry.image);
      lines.push(`${label} (screenshot: attached as an image below, in listed order)`);
    } else if (entry.type === 'structured') {
      lines.push(`${label} (structured)\n${JSON.stringify(entry.content)}`);
    } else {
      lines.push(`${label} (text${entry.truncated ? ', truncated' : ''})\n${entry.content}`);
    }
  }
  return { lines, images };
}

function areaMessages(competitor, area, evidence) {
  const headerLines = [];
  const name = cleanNullable(competitor?.name);
  if (name) headerLines.push(`Competitor: ${name}`);
  const domains = cleanStringArray(competitor?.domains);
  if (domains.length) headerLines.push(`Domains: ${domains.join(', ')}`);
  headerLines.push(`Analysis area: ${area}`);
  headerLines.push('Evidence catalog entries follow. Each entry begins with its evidence id in [brackets].');
  const content = [{ type: 'text', text: `${headerLines.join('\n')}\n\n${evidence.lines.join('\n\n')}` }];
  for (const url of evidence.images) {
    content.push({ type: 'image_url', image_url: { url } });
  }
  return [
    {
      role: 'system',
      content: `You analyze one aspect of a competitor — the analysis area named in the user message ("${area}") — strictly from the evidence catalog the user provides. Every entry is labeled with an evidence id in [brackets]; screenshot entries are attached as images in the order listed. Return ONLY a JSON array of findings, no prose and no markdown: [{"summary":"...","detail":"...","evidenceIds":["..."],"confidence":...}]. "summary" is required. "evidenceIds" is required and must list only ids that appear in the evidence catalog and that directly support the finding. Never make a claim you cannot tie to at least one evidence id — omit any unsupported claim entirely. "detail" and "confidence" are optional. Return an empty array when the evidence does not support any finding for this area.`,
    },
    { role: 'user', content },
  ];
}

// Deterministic fence unwrap only: parse failure is still surfaced as an
// explicit per-area error, never swallowed into a default.
function stripCodeFence(raw) {
  const text = String(raw ?? '').trim();
  const fenced = text.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/u);
  return fenced ? fenced[1].trim() : text;
}

function parseFindingsArray(raw) {
  const text = stripCodeFence(raw);
  if (!text) return { findings: null, error: 'empty model response' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { findings: null, error: `invalid JSON: ${error?.message || error}` };
  }
  if (!Array.isArray(parsed)) return { findings: null, error: 'model response is valid JSON but not an array of findings' };
  return { findings: parsed, error: null };
}

function confidenceOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

// Run the per-area deep analysis over a host-built evidence catalog.
// Returns { areas: { [area]: { findings, errors, omitted } }, status } where
// status is 'complete' (no area errored), 'partial' (some did) or 'failed'
// (every area errored).
export async function runDeepAnalysis({ competitor = null, catalog, chat, options = {} } = {}) {
  if (typeof chat !== 'function') throw new Error('runDeepAnalysis requires a chat(messages, { purpose }) function');
  if (!catalog || !Array.isArray(catalog.entries)) throw new Error('runDeepAnalysis requires a catalog with an entries array (see buildEvidenceCatalog)');
  const maxFindingsPerArea = requirePositiveInteger(options, 'maxFindingsPerArea', 'runDeepAnalysis');
  const areas = selectedAreas(options);
  const validIds = new Set(catalog.entries.map((entry) => entry.id));
  const evidence = evidenceBlocks(catalog.entries);

  const areaResults = {};
  let erroredAreas = 0;
  for (const area of areas) {
    const findings = [];
    const errors = [];
    const omitted = [];
    let parsedFindings = null;
    try {
      const reply = await chat(areaMessages(competitor, area, evidence), { purpose: `${PURPOSE_DEEP_ANALYSIS}:${area}` });
      const parsed = parseFindingsArray(reply);
      if (parsed.error) {
        errors.push({ reason: 'invalid_response', error: parsed.error });
      } else {
        parsedFindings = parsed.findings;
      }
    } catch (error) {
      errors.push({ reason: 'chat_error', error: String(error?.message || error) });
    }

    for (const raw of parsedFindings ?? []) {
      const summary = cleanNullable(raw?.summary);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !summary) {
        omitted.push(cleanObject({ reason: 'invalid_finding', finding: JSON.stringify(raw) }));
        continue;
      }
      const requestedIds = cleanStringArray(raw.evidenceIds);
      const evidenceIds = requestedIds.filter((id) => validIds.has(id));
      if (!evidenceIds.length) {
        omitted.push(cleanObject({ reason: 'no_valid_evidence', summary, requestedEvidenceIds: requestedIds }));
        continue;
      }
      const finding = cleanObject({
        summary,
        detail: cleanNullable(raw.detail),
        evidenceIds,
        confidence: confidenceOrNull(raw.confidence),
      });
      if (findings.length >= maxFindingsPerArea) {
        omitted.push({ reason: 'findings_limit', ...finding });
        continue;
      }
      findings.push(finding);
    }

    if (errors.length) erroredAreas += 1;
    areaResults[area] = { findings, errors, omitted };
  }

  const status = erroredAreas === areas.length ? 'failed' : erroredAreas ? 'partial' : 'complete';
  return { areas: areaResults, status };
}
