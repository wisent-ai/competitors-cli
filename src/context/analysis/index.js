import { cleanNullable, cleanObject, cleanStringArray } from '../../competition/model.js';
import { requirePositiveInteger } from './bounds.js';
export { buildEvidenceCatalog } from './catalog.js';

// Evidence catalog + eight-area deep competitor analysis.
//
// Design rules this file obeys (see src/crawl.js):
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
