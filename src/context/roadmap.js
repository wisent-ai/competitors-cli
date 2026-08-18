import { createHash } from 'node:crypto';

const PURPOSE_ROADMAP = 'competitor-roadmap';
const DISPOSITIONS = new Set(['roadmap', 'no_action']);
const PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);

function clean(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseReply(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('roadmap reply must be a JSON array');
  return parsed;
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))];
}

function evidenceCatalog(sourceComparisons, observations) {
  const entries = [];
  for (const [comparisonIndex, comparison] of sourceComparisons.entries()) {
    for (const [findingIndex, finding] of (Array.isArray(comparison?.findings) ? comparison.findings : []).entries()) {
      entries.push({
        id: `comparison:${comparisonIndex}:finding:${findingIndex}`,
        type: 'source_comparison',
        competitor: clean(comparison?.competitor?.name),
        capability: clean(finding?.capability),
        assessment: clean(finding?.assessment),
        summary: clean(finding?.summary),
        limitations: stringList(finding?.limitations),
        oursEvidenceIds: stringList(finding?.oursEvidenceIds),
        theirsEvidenceIds: stringList(finding?.theirsEvidenceIds),
      });
    }
  }
  for (const [index, observation] of observations.entries()) {
    entries.push({
      id: `observation:${index}`,
      type: 'market_observation',
      competitor: clean(observation?.competitor?.name),
      signalType: clean(observation?.signalType),
      title: clean(observation?.title),
      summary: clean(observation?.summary),
      evidenceUrl: clean(observation?.evidenceUrl),
    });
  }
  return entries;
}

function stableId(productId, item) {
  const key = [productId, item.disposition, item.title, ...item.evidenceIds].join('\n').toLowerCase();
  return `roadmap:${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

export async function generateCompetitorRoadmap({ product, sourceComparisons = [], observations = [], chat, options = {} } = {}) {
  if (typeof chat !== 'function') throw new Error('generateCompetitorRoadmap requires chat');
  const maxRoadmapItems = positiveInteger(options.maxRoadmapItems, 'maxRoadmapItems');
  const entries = evidenceCatalog(sourceComparisons, observations);
  if (!entries.length) return { status: 'no_evidence', items: [], evidence: [], errors: [] };
  const validIds = new Set(entries.map((entry) => entry.id));
  const messages = [
    {
      role: 'system',
      content: 'Turn competitor evidence into a product roadmap review. Return ONLY a JSON array: [{"disposition":"roadmap|no_action","priority":"critical|high|medium|low","title":"...","rationale":"...","impact":"...","proposedChange":"...","codeAreas":["..."],"acceptanceCriteria":["..."],"evidenceIds":["comparison:0:finding:0"],"competitors":["..."]}]. Use roadmap only when the evidence identifies a concrete gap or problem relevant to the product promise. Use no_action for a deliberate difference, an irrelevant feature, our existing advantage, or evidence too weak to justify work. Every item requires evidence. Do not invent implementation details, user demand, metrics, or code locations. Acceptance criteria must be observable and must not claim superiority unless evidence supplies a measurement.',
    },
    {
      role: 'user',
      content: `Product:\n${JSON.stringify(product)}\n\nEvidence catalog:\n${entries.map((entry) => `[${entry.id}] ${JSON.stringify(entry)}`).join('\n')}`,
    },
  ];
  let parsed;
  try {
    parsed = parseReply(await chat(messages, { purpose: PURPOSE_ROADMAP }));
  } catch (error) {
    return { status: 'failed', items: [], evidence: entries, errors: [{ stage: 'model', error: clean(error?.message || error) }] };
  }
  const items = [];
  const errors = [];
  for (const raw of parsed) {
    if (items.length >= maxRoadmapItems) break;
    const evidenceIds = stringList(raw?.evidenceIds).filter((id) => validIds.has(id));
    const title = clean(raw?.title);
    const rationale = clean(raw?.rationale);
    if (!title || !rationale || !evidenceIds.length) continue;
    const disposition = DISPOSITIONS.has(raw?.disposition) ? raw.disposition : 'no_action';
    const priority = PRIORITIES.has(raw?.priority) ? raw.priority : 'low';
    const item = {
      disposition,
      priority,
      title,
      rationale,
      impact: clean(raw?.impact),
      proposedChange: disposition === 'roadmap' ? clean(raw?.proposedChange) : '',
      codeAreas: disposition === 'roadmap' ? stringList(raw?.codeAreas) : [],
      acceptanceCriteria: disposition === 'roadmap' ? stringList(raw?.acceptanceCriteria) : [],
      evidenceIds,
      competitors: stringList(raw?.competitors),
    };
    if (disposition === 'roadmap' && (!item.proposedChange || !item.acceptanceCriteria.length)) {
      errors.push({ stage: 'validation', title, error: 'roadmap item missing proposed change or acceptance criteria' });
      item.disposition = 'no_action';
      item.priority = 'low';
      item.proposedChange = '';
      item.codeAreas = [];
      item.acceptanceCriteria = [];
    }
    items.push({ id: stableId(clean(product?.id), item), ...item });
  }
  return { status: errors.length ? 'partial' : 'complete', items, evidence: entries, errors };
}
