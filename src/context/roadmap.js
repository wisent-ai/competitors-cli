import { createHash } from 'node:crypto';
import { replyObject, schemaFormat, strictObject } from './adapters/answer.js';

const PURPOSE_ROADMAP = 'competitor-roadmap';
// The kinds of item and the priorities a roadmap review gives, as its schema
// admits them.
const DISPOSITIONS = { roadmap: 'roadmap', no_action: 'no_action' };
const PRIORITIES = { critical: 'critical', high: 'high', medium: 'medium', low: 'low' };

/** `value` with its whitespace collapsed; the caller has checked it is text. */
function clean(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null) return Infinity;
  if (!Number.isInteger(value) || value <= Number()) throw new Error(`${name} must be a positive integer, got ${value}`);
  return value;
}

/** The distinct non-empty texts of a list the schema bound to strings. */
function texts(list) {
  return [...new Set(list.map(clean).filter(Boolean))];
}

// The review the model answers, bound as a strict JSON schema whose evidence
// ids are only the catalog's own.
function roadmapResponseFormat(evidenceIds) {
  const text = { type: 'string' };
  const list = { type: 'array', items: text };
  const item = strictObject({
    disposition: { type: 'string', enum: Object.values(DISPOSITIONS) },
    priority: { type: 'string', enum: Object.values(PRIORITIES) },
    title: text,
    rationale: text,
    impact: text,
    proposedChange: text,
    codeAreas: list,
    acceptanceCriteria: list,
    evidenceIds: { type: 'array', items: { type: 'string', enum: evidenceIds } },
    competitors: list,
  });
  return schemaFormat('competitor_roadmap', { items: { type: 'array', items: item } });
}

/** The items of the model's review, which must be the competitor_roadmap object. */
function parseReply(raw) {
  return replyObject(raw, PURPOSE_ROADMAP, 'competitor_roadmap', (object) => Array.isArray(object.items)).items;
}

// The evidence the model may cite, each entry with the id it cites it by. A
// field its source does not hold is left out of the entry.
function evidenceCatalog(sourceComparisons, observations) {
  const entries = [];
  for (const [comparisonIndex, comparison] of sourceComparisons.entries()) {
    if (!Array.isArray(comparison?.findings)) throw new Error(`source comparison ${comparisonIndex} holds no findings list`);
    for (const [findingIndex, finding] of comparison.findings.entries()) {
      entries.push({
        id: `comparison:${comparisonIndex}:finding:${findingIndex}`,
        type: 'source_comparison',
        competitor: comparison.competitor?.name,
        capability: finding?.capability,
        assessment: finding?.assessment,
        summary: finding?.summary,
        limitations: finding?.limitations,
        oursEvidenceIds: finding?.oursEvidenceIds,
        theirsEvidenceIds: finding?.theirsEvidenceIds,
      });
    }
  }
  for (const [index, observation] of observations.entries()) {
    entries.push({
      id: `observation:${index}`,
      type: 'market_observation',
      competitor: observation?.competitor?.name,
      signalType: observation?.signalType,
      title: observation?.title,
      summary: observation?.summary,
      evidenceUrl: observation?.evidenceUrl,
    });
  }
  return entries;
}

function stableId(productId, item) {
  const key = [productId, item.disposition, item.title, ...item.evidenceIds].join('\n').toLowerCase();
  return `roadmap:${createHash('sha256').update(key).digest('hex')}`;
}

/** An item turned to no action, with the work it proposed cleared. */
function noAction(item) {
  return { ...item, disposition: DISPOSITIONS.no_action, priority: PRIORITIES.low, proposedChange: '', codeAreas: [], acceptanceCriteria: [] };
}

/** The review a model that gave none ends in: no items, and the model's error said. */
function modelFailure(entries, error) {
  return { status: 'failed', items: [], evidence: entries, errors: [{ stage: 'model', error: error instanceof Error ? error.message : String(error) }] };
}

export async function generateCompetitorRoadmap({ product, sourceComparisons, observations, chat, options }) {
  if (typeof chat !== 'function') throw new Error('generateCompetitorRoadmap requires chat');
  if (typeof product?.id !== 'string') throw new Error('generateCompetitorRoadmap requires the product, with its id');
  if (!Array.isArray(sourceComparisons)) throw new Error('generateCompetitorRoadmap requires sourceComparisons, a list (empty when there are none)');
  if (!Array.isArray(observations)) throw new Error('generateCompetitorRoadmap requires observations, a list (empty when there are none)');
  const maxRoadmapItems = optionalPositiveInteger(options?.maxRoadmapItems, 'maxRoadmapItems');
  const entries = evidenceCatalog(sourceComparisons, observations);
  if (!entries.length) return { status: 'no_evidence', items: [], evidence: [], errors: [] };
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const messages = [
    {
      role: 'system',
      content: 'Turn competitor evidence into a product roadmap review. Use roadmap only when the evidence identifies a concrete gap or problem relevant to the product promise. Use no_action for a deliberate difference, an irrelevant feature, our existing advantage, or evidence too weak to justify work. Every item requires evidence, cited by the ids of the catalog. Do not invent implementation details, user demand, metrics, or code locations. Acceptance criteria must be observable and must not claim superiority unless evidence supplies a measurement. A no_action item leaves its proposed change empty and lists no code areas or acceptance criteria.',
    },
    {
      role: 'user',
      content: `Product:\n${JSON.stringify(product)}\n\nEvidence catalog:\n${entries.map((entry) => `[${entry.id}] ${JSON.stringify(entry)}`).join('\n')}`,
    },
  ];
  let parsed;
  try {
    parsed = parseReply(await chat(messages, { purpose: PURPOSE_ROADMAP, responseFormat: roadmapResponseFormat([...entryById.keys()]) }));
  } catch (error) {
    return modelFailure(entries, error);
  }
  const items = [];
  const errors = [];
  for (const raw of parsed.slice(Number(), maxRoadmapItems)) {
    const proposed = {
      disposition: raw.disposition,
      priority: raw.priority,
      title: clean(raw.title),
      rationale: clean(raw.rationale),
      impact: clean(raw.impact),
      proposedChange: clean(raw.proposedChange),
      codeAreas: texts(raw.codeAreas),
      acceptanceCriteria: texts(raw.acceptanceCriteria),
      evidenceIds: texts(raw.evidenceIds),
      competitors: texts(raw.competitors),
    };
    if (!proposed.title || !proposed.rationale || !proposed.evidenceIds.length) {
      errors.push({ stage: 'validation', title: proposed.title, error: 'roadmap item has no title, rationale or cited evidence' });
      continue;
    }
    let item = proposed.disposition === DISPOSITIONS.roadmap ? proposed : noAction(proposed);
    if (item.disposition === DISPOSITIONS.roadmap && (!item.proposedChange || !item.acceptanceCriteria.length)) {
      errors.push({ stage: 'validation', title: item.title, error: 'roadmap item missing proposed change or acceptance criteria' });
      item = noAction(item);
    }
    const cited = item.evidenceIds.map((id) => entryById.get(id));
    const sourceOnly = cited.every((entry) => entry.type === 'source_comparison');
    const supportsGap = cited.some((entry) => entry.assessment === 'theirs_better' || entry.assessment === 'different');
    if (item.disposition === DISPOSITIONS.roadmap && sourceOnly && !supportsGap) {
      errors.push({ stage: 'validation', title: item.title, error: 'source evidence does not identify a competitor advantage or relevant difference' });
      item = noAction(item);
    }
    items.push({ id: stableId(product.id, item), ...item });
  }
  return { status: errors.length ? 'partial' : 'complete', items, evidence: entries, errors };
}
