// Project gathered context and deep findings into the competition record format.
import { COMPETITOR_SIGNAL_TYPES, COMPETITOR_SOURCE_TYPES, cleanNullable, cleanObject, cleanStringArray } from '../competition/model.js';
import { normalizeCompetitorObservation } from '../competition/observations.js';
import { DEEP_ANALYSIS_AREAS } from './analysis/index.js';
import { CONTEXT_SURFACE_KINDS, cleanText } from './gathering/captures.js';

// Map a gathered context result into competition observations so it flows into
// the existing competition tracker and summaries. Positioning, differentiation
// and target audience become positioning signals; pricing a pricing signal;
// each key feature a feature signal. The caller names the source type the
// context was gathered from; without it the mapping refuses.
export function contextToObservations(contextResult, options = {}) {
  const context = contextResult?.context;
  if (!context) return [];
  if (!options.sourceType) {
    throw new Error('contextToObservations needs options.sourceType, the competitor source the context was gathered from');
  }
  const base = {
    competitor: contextResult.competitor,
    sourceType: options.sourceType,
    observedAt: options.observedAt,
    region: options.region,
  };
  const observations = [];
  const add = (signalType, summary) => {
    const text = cleanText(summary);
    if (text) observations.push(normalizeCompetitorObservation({ ...base, signalType, summary: text }));
  };
  add(COMPETITOR_SIGNAL_TYPES.POSITIONING, context.positioning);
  add(COMPETITOR_SIGNAL_TYPES.POSITIONING, context.differentiation);
  add(COMPETITOR_SIGNAL_TYPES.POSITIONING, context.targetAudience);
  add(COMPETITOR_SIGNAL_TYPES.PRICING, context.pricing);
  for (const feature of cleanStringArray(context.keyFeatures)) add(COMPETITOR_SIGNAL_TYPES.FEATURE, feature);
  return observations;
}

// Map one gathered deep-analysis result into competition observations. Areas
// map onto the closest signal types (funnel onboarding, seo seo, pricing and
// offers pricing, promotions ads, page structure feature, style and design
// system positioning); the source type follows the surface kind of the first
// cited evidence the index holds (website, app_store, play_store). Analysis
// keeps only findings that cite the catalog, so a finding citing nothing the
// index holds, or evidence of a surface kind with no source type, is refused
// naming it rather than recorded as a website observation.
const DEEP_SIGNAL_FOR_AREA = {
  [DEEP_ANALYSIS_AREAS.STYLE]: COMPETITOR_SIGNAL_TYPES.POSITIONING,
  [DEEP_ANALYSIS_AREAS.DESIGN_SYSTEM]: COMPETITOR_SIGNAL_TYPES.POSITIONING,
  [DEEP_ANALYSIS_AREAS.PAGE_STRUCTURE]: COMPETITOR_SIGNAL_TYPES.FEATURE,
  [DEEP_ANALYSIS_AREAS.FUNNEL]: COMPETITOR_SIGNAL_TYPES.ONBOARDING,
  [DEEP_ANALYSIS_AREAS.SEO]: COMPETITOR_SIGNAL_TYPES.SEO,
  [DEEP_ANALYSIS_AREAS.PRICING]: COMPETITOR_SIGNAL_TYPES.PRICING,
  [DEEP_ANALYSIS_AREAS.OFFERS]: COMPETITOR_SIGNAL_TYPES.PRICING,
  [DEEP_ANALYSIS_AREAS.PROMOTIONS]: COMPETITOR_SIGNAL_TYPES.ADS,
};

const DEEP_SOURCE_FOR_SURFACE = {
  [CONTEXT_SURFACE_KINDS.WEBSITE]: COMPETITOR_SOURCE_TYPES.WEBSITE,
  [CONTEXT_SURFACE_KINDS.IOS_APP]: COMPETITOR_SOURCE_TYPES.APP_STORE,
  [CONTEXT_SURFACE_KINDS.ANDROID_APP]: COMPETITOR_SOURCE_TYPES.PLAY_STORE,
};

export function deepAnalysisToObservations(deepResult, options = {}) {
  const areas = deepResult?.deep?.areas;
  if (!areas) return [];
  const competitorName = deepResult.competitor?.name;
  const evidenceIndex = deepResult.evidenceIndex;
  if (!evidenceIndex || typeof evidenceIndex !== 'object') {
    throw new Error(`deep analysis of ${competitorName} carries areas but no evidence index`);
  }
  const observations = [];
  for (const [area, areaResult] of Object.entries(areas)) {
    const signalType = DEEP_SIGNAL_FOR_AREA[area];
    // Every analysis area maps to a signal type; findings of an area outside
    // that map are refused naming it, never dropped from the observations.
    if (!signalType) {
      throw new Error(`deep analysis area ${area} maps to no competitor signal type`);
    }
    if (!Array.isArray(areaResult?.findings)) {
      throw new Error(`deep analysis of ${competitorName} area ${area} carries no findings list`);
    }
    for (const finding of areaResult.findings) {
      const summary = cleanText(finding?.summary);
      if (!summary) continue;
      const evidenceIds = cleanStringArray(finding?.evidenceIds);
      const firstEvidenceId = evidenceIds.find((id) => evidenceIndex[id]);
      if (!firstEvidenceId) {
        throw new Error(`deep analysis of ${competitorName} area ${area} finding "${summary}" cites ${JSON.stringify(evidenceIds)}, none of which the evidence index holds, so its source is unknown`);
      }
      const evidence = evidenceIndex[firstEvidenceId];
      const sourceType = DEEP_SOURCE_FOR_SURFACE[evidence.surfaceKind];
      if (!sourceType) {
        throw new Error(`evidence ${firstEvidenceId} of ${competitorName} names surface kind ${evidence.surfaceKind}, which maps to no competitor source type`);
      }
      observations.push(normalizeCompetitorObservation({
        competitor: deepResult.competitor,
        signalType,
        sourceType,
        observedAt: options.observedAt,
        region: options.region,
        surface: evidence.surfaceKind,
        productArea: area,
        url: evidence.url,
        evidenceUrl: evidence.url,
        evidenceId: firstEvidenceId,
        summary,
        confidence: finding?.confidence,
        attributes: cleanObject({
          detail: cleanNullable(finding?.detail),
          evidenceIds: evidenceIds.join(','),
        }),
        capturedBy: options.capturedBy,
        runId: options.runId,
      }));
    }
  }
  return observations;
}
