// Evidence-backed capability comparison over caller-supplied source files.
// Repository discovery and file transport remain injected boundaries. This
// module owns bounded catalogs, the model contract, and evidence validation.

const PURPOSE_SOURCE_COMPARISON = 'competitor-source-comparison';
const ASSESSMENTS = new Set(['ours_better', 'theirs_better', 'different', 'equivalent', 'unknown']);

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function clean(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function truncateUtf8(value, maximum) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  return bytes.length <= maximum ? bytes.toString('utf8') : bytes.subarray(0, maximum).toString('utf8');
}

export function buildSourceEvidenceCatalog(source = {}, options = {}) {
  const maxFiles = positiveInteger(options.maxSourceFiles, 'maxSourceFiles');
  const maxBytesPerFile = positiveInteger(options.maxSourceBytesPerFile, 'maxSourceBytesPerFile');
  const files = Array.isArray(source.files) ? source.files : [];
  const entries = [];
  const omitted = [];
  for (const [index, file] of files.entries()) {
    const filePath = clean(file?.path);
    const content = typeof file?.content === 'string' ? file.content : '';
    if (!filePath || !content) continue;
    if (entries.length >= maxFiles) {
      omitted.push({ path: filePath, reason: 'file_limit' });
      continue;
    }
    const bounded = truncateUtf8(content, maxBytesPerFile);
    entries.push({
      id: `src:${entries.length}`,
      path: filePath,
      content: bounded,
      truncated: Buffer.byteLength(content, 'utf8') > Buffer.byteLength(bounded, 'utf8'),
      url: clean(file.url),
    });
  }
  return {
    repository: clean(source.repository),
    revision: clean(source.revision),
    entries,
    omitted,
  };
}

function catalogText(label, catalog) {
  const header = `${label}: ${catalog.repository || 'unknown'}${catalog.revision ? ` @ ${catalog.revision}` : ''}`;
  return [header, ...catalog.entries.map((entry) =>
    `[${entry.id}] ${entry.path}${entry.url ? ` ${entry.url}` : ''}\n${entry.content}`)].join('\n\n');
}

function parseReply(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('source comparison reply must be a JSON array');
  return parsed;
}

function evidenceIds(value, valid) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter((id) => valid.has(id)))];
}

export async function analyzeSourceComparison({ product, competitor, productSource, competitorSource, chat, options = {} } = {}) {
  if (typeof chat !== 'function') throw new Error('analyzeSourceComparison requires chat');
  const maxFindings = positiveInteger(options.maxSourceFindings, 'maxSourceFindings');
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
      content: 'Compare product capabilities strictly from the two source evidence catalogs. Identify concrete implemented capabilities, including mechanisms such as CAPTCHA handling, session persistence, fingerprinting, trajectory reuse, retries, recordings, browser engines, and APIs only when the supplied code supports them. Return ONLY a JSON array: [{"capability":"...","assessment":"ours_better|theirs_better|different|equivalent|unknown","summary":"...","oursEvidenceIds":["src:0"],"theirsEvidenceIds":["src:0"],"limitations":["..."]}]. A directional assessment requires valid evidence from both sides. Do not infer absence from files that were not supplied.',
    },
    {
      role: 'user',
      content: `Product: ${clean(product?.name)}\nCompetitor: ${clean(competitor?.name)}\n\n${catalogText('OURS', ours)}\n\n${catalogText('THEIRS', theirs)}`,
    },
  ];
  let parsed;
  try {
    parsed = parseReply(await chat(messages, { purpose: PURPOSE_SOURCE_COMPARISON }));
  } catch (error) {
    return { status: 'failed', ours, theirs, findings: [], errors: [{ stage: 'model', error: clean(error?.message || error) }] };
  }
  const findings = [];
  const errors = [];
  for (const item of parsed) {
    if (findings.length >= maxFindings) break;
    const capability = clean(item?.capability);
    const summary = clean(item?.summary);
    const oursEvidenceIds = evidenceIds(item?.oursEvidenceIds, oursIds);
    const theirsEvidenceIds = evidenceIds(item?.theirsEvidenceIds, theirsIds);
    let assessment = ASSESSMENTS.has(item?.assessment) ? item.assessment : 'unknown';
    if (assessment !== 'unknown' && (!oursEvidenceIds.length || !theirsEvidenceIds.length)) {
      errors.push({ stage: 'validation', capability, error: 'directional assessment missing evidence from both repositories' });
      assessment = 'unknown';
    }
    if (!capability || !summary || (!oursEvidenceIds.length && !theirsEvidenceIds.length)) continue;
    findings.push({
      capability,
      assessment,
      summary,
      oursEvidenceIds,
      theirsEvidenceIds,
      limitations: [...new Set((Array.isArray(item?.limitations) ? item.limitations : []).map(clean).filter(Boolean))],
    });
  }
  return { status: errors.length ? 'partial' : 'complete', ours, theirs, findings, errors };
}
