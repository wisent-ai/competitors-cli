// Evidence-backed capability comparison over caller-supplied source files.
// Repository discovery and file transport remain injected boundaries. This
// module owns bounded catalogs, the model contract, and evidence validation.
import { replyObject, schemaFormat, strictObject } from './adapters/answer.js';

const PURPOSE_SOURCE_COMPARISON = 'competitor-source-comparison';
// The assessments a finding may give, as its schema admits them.
const ASSESSMENTS = { ours_better: 'ours_better', theirs_better: 'theirs_better', different: 'different', equivalent: 'equivalent', unknown: 'unknown' };

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null) return Infinity;
  if (!Number.isInteger(value) || value <= Number()) throw new Error(`${name} must be a positive integer, got ${value}`);
  return value;
}

/** The bound the caller declared under `name`, or null when it declared none. */
function declaredBound(options, name) {
  const value = options?.[name];
  return value === undefined ? null : value;
}

/** Text with runs of whitespace collapsed; a value that is not text has none. */
function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/gu, ' ').trim();
}

/** The longest start of `value` whose UTF-8 encoding fits `maximum`, cut only between characters. */
function truncateUtf8(value, maximum) {
  if (Buffer.byteLength(value, 'utf8') <= maximum) return value;
  const { read } = new TextEncoder().encodeInto(value, new Uint8Array(maximum));
  return value.slice(Number(), read);
}

export function buildSourceEvidenceCatalog(source, options) {
  const maxFiles = optionalPositiveInteger(options?.maxSourceFiles, 'maxSourceFiles');
  const maxBytesPerFile = optionalPositiveInteger(options?.maxSourceBytesPerFile, 'maxSourceBytesPerFile');
  if (!Array.isArray(source?.files)) throw new Error('a source evidence catalog requires the source\'s files, a list (empty when there are none)');
  const entries = [];
  const omitted = [];
  for (const [index, file] of source.files.entries()) {
    if (typeof file?.path !== 'string' || typeof file.content !== 'string') {
      throw new Error(`source file ${index} has no path or content text`);
    }
    const filePath = clean(file.path);
    // An empty file carries no evidence to cite.
    if (!filePath || !file.content) continue;
    if (entries.length >= maxFiles) {
      omitted.push({ path: filePath, reason: 'file_limit' });
      continue;
    }
    const bounded = truncateUtf8(file.content, maxBytesPerFile);
    entries.push({
      id: `src:${entries.length}`,
      path: filePath,
      content: bounded,
      truncated: bounded !== file.content,
      url: clean(file.url),
    });
  }
  return {
    repository: clean(source.repository),
    revision: clean(source.revision),
    entries,
    omitted,
    coverage: {
      maxSourceFiles: declaredBound(options, 'maxSourceFiles'),
      maxSourceBytesPerFile: declaredBound(options, 'maxSourceBytesPerFile'),
      complete: !omitted.length && entries.every(entry => !entry.truncated),
    },
  };
}

function catalogText(label, catalog) {
  const header = [`${label}:`, catalog.repository, catalog.revision && `@ ${catalog.revision}`].filter(Boolean).join(' ');
  return [header, ...catalog.entries.map((entry) =>
    `[${entry.id}] ${[entry.path, entry.url].filter(Boolean).join(' ')}\n${entry.content}`)].join('\n\n');
}

// The findings the model answers, bound as a strict JSON schema whose
// evidence ids are only each catalog's own.
function findingsFormat(oursIds, theirsIds) {
  const text = { type: 'string' };
  return schemaFormat('source_findings', {
    findings: {
      type: 'array',
      items: strictObject({
        capability: text,
        assessment: { type: 'string', enum: Object.values(ASSESSMENTS) },
        summary: text,
        oursEvidenceIds: { type: 'array', items: { type: 'string', enum: oursIds } },
        theirsEvidenceIds: { type: 'array', items: { type: 'string', enum: theirsIds } },
        limitations: { type: 'array', items: text },
      }),
    },
  });
}

function evidenceIds(value, valid) {
  return [...new Set(value.map(clean).filter((id) => valid.has(id)))];
}

/** The comparison a model that gave no findings ends in, with its error said. */
function modelFailure(ours, theirs, error) {
  return { status: 'failed', ours, theirs, findings: [], errors: [{ stage: 'model', error: clean(error instanceof Error ? error.message : String(error)) }] };
}

export async function analyzeSourceComparison({ product, competitor, productSource, competitorSource, chat, options }) {
  if (typeof chat !== 'function') throw new Error('analyzeSourceComparison requires chat');
  const maxFindings = optionalPositiveInteger(options?.maxSourceFindings, 'maxSourceFindings');
  const ours = buildSourceEvidenceCatalog(productSource, options);
  const theirs = buildSourceEvidenceCatalog(competitorSource, options);
  const oursIds = new Set(ours.entries.map((entry) => entry.id));
  const theirsIds = new Set(theirs.entries.map((entry) => entry.id));
  if (!ours.entries.length || !theirs.entries.length) {
    return { status: 'no_evidence', ours, theirs, findings: [], errors: [] };
  }
  const messages = [
    {
      role: 'system',
      content: 'Compare product capabilities strictly from the two source evidence catalogs. Identify concrete implemented capabilities, including mechanisms such as CAPTCHA handling, session persistence, fingerprinting, trajectory reuse, retries, recordings, browser engines, and APIs only when the supplied code supports them. For each, give the capability, an assessment, a summary, the evidence ids it rests on from each catalog, and its limitations. A directional assessment requires valid evidence from both sides. Do not infer absence from files that were not supplied.',
    },
    {
      role: 'user',
      content: `Product: ${clean(product?.name)}\nCompetitor: ${clean(competitor?.name)}\n\n${catalogText('OURS', ours)}\n\n${catalogText('THEIRS', theirs)}`,
    },
  ];
  let parsed;
  try {
    const reply = await chat(messages, { purpose: PURPOSE_SOURCE_COMPARISON, responseFormat: findingsFormat([...oursIds], [...theirsIds]) });
    parsed = replyObject(reply, PURPOSE_SOURCE_COMPARISON, 'source_findings', (object) => Array.isArray(object.findings)).findings;
  } catch (error) {
    return modelFailure(ours, theirs, error);
  }
  const findings = [];
  const errors = [];
  let processed = parsed.length;
  for (const [index, item] of parsed.entries()) {
    if (findings.length >= maxFindings) {
      processed = index;
      break;
    }
    const capability = clean(item.capability);
    const summary = clean(item.summary);
    const oursEvidenceIds = evidenceIds(item.oursEvidenceIds, oursIds);
    const theirsEvidenceIds = evidenceIds(item.theirsEvidenceIds, theirsIds);
    if (!capability || !summary || (!oursEvidenceIds.length && !theirsEvidenceIds.length)) {
      errors.push({ stage: 'validation', capability, error: 'finding has no capability, summary or cited evidence' });
      continue;
    }
    let assessment = item.assessment;
    if (!Object.hasOwn(ASSESSMENTS, assessment)) {
      errors.push({ stage: 'validation', capability, error: `assessment ${JSON.stringify(assessment)} is none the schema admits` });
      assessment = ASSESSMENTS.unknown;
    }
    if (assessment !== ASSESSMENTS.unknown && (!oursEvidenceIds.length || !theirsEvidenceIds.length)) {
      errors.push({ stage: 'validation', capability, error: 'directional assessment missing evidence from both repositories' });
      assessment = ASSESSMENTS.unknown;
    }
    findings.push({
      capability,
      assessment,
      summary,
      oursEvidenceIds,
      theirsEvidenceIds,
      limitations: [...new Set(item.limitations.map(clean).filter(Boolean))],
    });
  }
  const unprocessedFindings = parsed.length - processed;
  const coverage = {
    maxSourceFindings: declaredBound(options, 'maxSourceFindings'),
    unprocessedFindings,
    complete: ours.coverage.complete && theirs.coverage.complete && !unprocessedFindings,
  };
  return { status: errors.length || !coverage.complete ? 'partial' : 'complete', ours, theirs, findings, errors, coverage };
}
