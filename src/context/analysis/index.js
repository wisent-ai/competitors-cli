import { cleanNullable, cleanObject, cleanStringArray } from '../../competition/model.js';
import { replyObject, schemaFormat, strictObject } from '../adapters/answer.js';
import { optionalPositiveInteger } from './bounds.js';
export { buildEvidenceCatalog } from './catalog.js';

// Evidence catalog + eight-area deep competitor analysis.
//
// Design rules this file obeys (see src/crawl.js):
//   * No hardcoded keyword tables or market vocabulary: prompts carry only the
//     analysis-area name; all judgment is the injected model's.
//   * No numeric literal defaults. Every bound (maxTextBytesPerSurface,
//     maxScreenshotsPerCatalog, maxImageBytes, maxFindingsPerArea) is the
//     caller's: an absent bound means the whole input, a malformed one throws.
//   * Evidence IDs are host-assigned and deterministic (derived from array
//     order only — no randomness, no timestamps). Model-returned evidence
//     references are filtered against the host catalog, never trusted; a
//     finding with no valid evidence reference is dropped and recorded.
//   * Every area's reply is bound to a strict json_schema (`area_findings`);
//     a reply that is not that object surfaces as an explicit per-area error
//     record, never a silent default.
//
// The caller owns the model, injected as chat(messages, { purpose,
// responseFormat }) => assistant text. purpose is
// 'competitor-deep-analysis:<area>'.

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
    const label = [`[${entry.id}]`, entry.surfaceKind, entry.url].filter(Boolean).join(' ');
    if (entry.type === 'screenshot') {
      images.push(entry.image);
      lines.push(`${label} (screenshot: attached as an image below, in listed order)`);
    } else if (entry.type === 'structured') {
      lines.push(`${label} (structured)\n${JSON.stringify(entry.content)}`);
    } else {
      lines.push(`${label} (${['text', entry.truncated && 'truncated'].filter(Boolean).join(', ')})\n${entry.content}`);
    }
  }
  return { lines, images };
}

// The findings an area answers: each a summary, an optional detail and
// confidence, and the evidence ids it rests on, which the schema admits only
// from the catalog.
function findingsFormat(evidenceIds) {
  return schemaFormat('area_findings', {
    findings: {
      type: 'array',
      items: strictObject({
        summary: { type: 'string' },
        detail: { type: ['string', 'null'] },
        evidenceIds: { type: 'array', items: { type: 'string', enum: evidenceIds } },
        confidence: { type: ['number', 'null'] },
      }),
    },
  });
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
      content: `You analyze one aspect of a competitor — the analysis area named in the user message ("${area}") — strictly from the evidence catalog the user provides. Every entry is labeled with an evidence id in [brackets]; screenshot entries are attached as images in the order listed. Give each finding a summary and the evidence ids that appear in the catalog and directly support it; detail and confidence are null when you have none. Never make a claim you cannot tie to at least one evidence id — omit any unsupported claim entirely. Give no findings when the evidence does not support any for this area.`,
    },
    { role: 'user', content },
  ];
}

/** The area's record when its model step failed: no findings, and the failure said. */
function areaFailed(reason, error) {
  return { findings: [], errors: [{ reason, error: error instanceof Error ? error.message : String(error) }], omitted: [] };
}

/** One area's findings, each kept only when it cites the catalog, within `maxFindings`. */
function areaFindings(answered, validIds, maxFindings) {
  const findings = [];
  const omitted = [];
  for (const raw of answered) {
    const summary = cleanNullable(raw.summary);
    if (!summary) {
      omitted.push(cleanObject({ reason: 'invalid_finding', finding: JSON.stringify(raw) }));
      continue;
    }
    const requestedIds = cleanStringArray(raw.evidenceIds);
    const evidenceIds = requestedIds.filter((id) => validIds.has(id));
    if (!evidenceIds.length) {
      omitted.push(cleanObject({ reason: 'no_valid_evidence', summary, requestedEvidenceIds: requestedIds }));
      continue;
    }
    const finding = cleanObject({ summary, detail: cleanNullable(raw.detail), evidenceIds, confidence: raw.confidence });
    if (findings.length >= maxFindings) {
      omitted.push({ reason: 'findings_limit', ...finding });
      continue;
    }
    findings.push(finding);
  }
  return { findings, errors: [], omitted };
}

// Run the per-area deep analysis over a host-built evidence catalog.
// Returns { areas: { [area]: { findings, errors, omitted } }, status } where
// status is 'complete' (no area errored), 'partial' (some did) or 'failed'
// (every area errored).
export async function runDeepAnalysis({ competitor, catalog, chat, options }) {
  if (typeof chat !== 'function') throw new Error('runDeepAnalysis requires a chat(messages, { purpose, responseFormat }) function');
  if (!catalog || !Array.isArray(catalog.entries)) throw new Error('runDeepAnalysis requires a catalog with an entries array (see buildEvidenceCatalog)');
  if (!catalog.entries.length) throw new Error('runDeepAnalysis requires a catalog with at least one evidence entry: a finding must cite one');
  const maxFindingsPerArea = optionalPositiveInteger(options, 'maxFindingsPerArea', 'runDeepAnalysis');
  const areas = selectedAreas(options);
  const validIds = new Set(catalog.entries.map((entry) => entry.id));
  const evidence = evidenceBlocks(catalog.entries);
  const format = findingsFormat([...validIds]);

  const areaResults = {};
  for (const area of areas) {
    const purpose = `${PURPOSE_DEEP_ANALYSIS}:${area}`;
    let reply;
    try {
      reply = await chat(areaMessages(competitor, area, evidence), { purpose, responseFormat: format });
    } catch (error) {
      areaResults[area] = areaFailed('chat_error', error);
      continue;
    }
    let answered;
    try {
      answered = replyObject(reply, purpose, 'area_findings', (object) => Array.isArray(object.findings)).findings;
    } catch (error) {
      areaResults[area] = areaFailed('invalid_response', error);
      continue;
    }
    areaResults[area] = areaFindings(answered, validIds, maxFindingsPerArea);
  }

  const errored = Object.values(areaResults).filter((result) => result.errors.length).length;
  const status = errored === areas.length ? 'failed' : errored ? 'partial' : 'complete';
  return { areas: areaResults, status };
}
